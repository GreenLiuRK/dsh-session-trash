/**
 * dsh-session-trash — Host half.
 *
 * DSH ships no way to delete a conversation: the workspace registry can only
 * archive one, and neither `sessions` nor `sessionPersistence` exposes a
 * delete. This plugin adds the missing operation on top of the public internals
 * DSH itself uses when it tears a session down, and splits it in two modes:
 *
 *   - trash:  quiesce the session, drop it from the workspace registry, project
 *             cache and client list, then MOVE its artifact directory into
 *             `<dsh home>/session-trash/<entry>/session`. Nothing is destroyed,
 *             so `restore` puts it back byte for byte.
 *   - shred:  the same teardown, but the artifact is overwritten with random
 *             bytes before it is unlinked and no trash entry is written, so no
 *             conversation content survives on disk.
 *
 * The HTTP surface under `/session-trash/api` is what the Client half calls;
 * the same code paths back the recovery panel, so both callers share one
 * implementation.
 *
 * Everything touching host internals is feature-detected: a renamed internal
 * degrades one step (for example the projection cache is left for the host to
 * rebuild) instead of breaking the whole delete.
 *
 * @module dsh-session-trash
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-trash'

/** Services the plugin needs; `webServer` is the UI transport, the rest are optional. */
export const inject = ['webServer']

const API_PREFIX = '/session-trash/api'
const TRASH_DIRNAME = 'session-trash'
const INDEX_FILENAME = 'index.json'
const INDEX_VERSION = 1
const STEP_TIMEOUT_MS = 8000
const OVERWRITE_CHUNK = 256 * 1024

/** Absolute DSH data root. `DSH_HOME` wins so a redirected profile stays in one tree. */
function dshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured.trim() !== '' ? resolve(configured) : join(homedir(), '.dsh')
}

function errorMessage(error) {
  if (error === null || error === undefined) return String(error)
  if (typeof error === 'string') return error
  if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message
  try { return JSON.stringify(error) } catch { return String(error) }
}

function warn(ctx, message) {
  try { ctx.logger?.warn?.(`session-trash: ${message}`) } catch { /* logging must never throw */ }
}

/** Reject anything that could escape the session root through a path segment. */
function assertSessionId(id) {
  if (typeof id !== 'string' || id.trim() === '' || id === '.' || id === '..'
    || /[\\/\x00-\x1f<>"|?*]/.test(id) || /[. ]$/.test(id)) {
    throw Object.assign(new Error('会话标识不合法'), { code: 'bad-request' })
  }
  return id
}

function withTimeout(promise, label, timeoutMs = STEP_TIMEOUT_MS) {
  let timer
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs)
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * The plugin's own operations, bound to one host context.
 * @param ctx - host plugin context.
 * @param config - the row's config.
 */
export function apply(ctx, config) {
  const home = dshHome()
  const sessionsRoot = join(home, 'sessions')
  const trashRoot = join(home, TRASH_DIRNAME)
  const indexPath = join(trashRoot, INDEX_FILENAME)
  const overwriteDefault = config?.overwriteOnShred !== false
  const locks = new Map()

  // ---------------------------------------------------------------- utilities

  async function treeSize(path) {
    let total = 0
    let entries
    try { entries = await fsp.readdir(path, { withFileTypes: true }) }
    catch { return 0 }
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) total += await treeSize(child)
      else if (entry.isFile()) {
        try { total += (await fsp.stat(child)).size } catch { /* skip */ }
      }
    }
    return total
  }

  /** Serialize every mutation on one session id / trash entry. */
  function mutate(key, operation) {
    const previous = locks.get(key) ?? Promise.resolve()
    const next = previous.then(operation, operation)
    const settled = next.catch(() => {}).finally(() => {
      if (locks.get(key) === settled) locks.delete(key)
    })
    locks.set(key, settled)
    return next
  }

  async function readIndex() {
    try {
      const raw = await fsp.readFile(indexPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) return parsed
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(ctx, `读取回收站索引失败: ${errorMessage(error)}`)
    }
    return { version: INDEX_VERSION, entries: [] }
  }

  async function writeIndex(index) {
    await fsp.mkdir(trashRoot, { recursive: true })
    const payload = JSON.stringify({ version: INDEX_VERSION, entries: index.entries }, null, 2)
    const temporary = `${indexPath}.${randomBytes(6).toString('hex')}.tmp`
    await fsp.writeFile(temporary, payload, 'utf8')
    await fsp.rename(temporary, indexPath)
  }

  /**
   * Locate a session's artifact directory through the host's own persistence
   * index, which is authoritative for the current layout. The directory is
   * rejected unless it really is `<sessions>/<project>/<session>`.
   */
  async function sessionDirOf(sessionId) {
    assertSessionId(sessionId)
    const persistence = ctx.get('sessionPersistence')
    let artifactPath
    if (persistence !== undefined && typeof persistence.stat === 'function') {
      try {
        const snapshot = await persistence.stat(sessionId)
        artifactPath = snapshot?.location?.path
      } catch { /* fall through */ }
    }
    if (typeof artifactPath !== 'string' || artifactPath === '') return undefined
    const directory = dirname(artifactPath)
    const rel = relative(resolve(sessionsRoot), resolve(directory))
    const parts = rel.split(sep)
    if (isAbsolute(rel) || parts.length !== 2 || parts.some(part => part === '' || part === '.' || part === '..')) {
      return undefined
    }
    const info = await fsp.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) return undefined
    return directory
  }

  /** Workspace that currently accounts for the session, if any. */
  function workspaceOf(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return undefined
    let entities = []
    try { entities = registry.list() } catch { return undefined }
    for (const entity of entities) {
      let ids = []
      try { ids = entity?.record?.sessionIds ?? [] } catch { ids = [] }
      if (Array.isArray(ids) && ids.includes(sessionId)) {
        return { id: entity.id, title: entity.title ?? entity.id, path: entity.path, entity }
      }
    }
    return undefined
  }

  /** Title from the projection cache; falls back to nothing so callers localize. */
  async function titleOf(sessionId) {
    const file = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
    try {
      const document = JSON.parse(await fsp.readFile(file, 'utf8'))
      const value = document?.record?.rows?.title?.val
      if (typeof value === 'string' && value !== '') return value
    } catch { /* no cache */ }
    const session = ctx.get('sessions')?.get?.(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
    return ''
  }

  /** DSH's own teardown order: stop work, flush, detach from the store, release writers. */
  async function quiesce(sessionId) {
    const sessions = ctx.get('sessions')
    const agents = ctx.get('agents')
    const persistence = ctx.get('sessionPersistence')
    const session = sessions?.get?.(sessionId)

    let agent
    try { agent = agents?.get?.(sessionId) } catch { agent = undefined }
    if (agent !== undefined) {
      if (typeof agent.cancel === 'function') {
        try { await withTimeout(agent.cancel({ kind: 'disposed' }), `停止会话 ${sessionId}`) }
        catch (error) { warn(ctx, `停止会话失败: ${errorMessage(error)}`) }
      }
      if (typeof agent.whenIdle === 'function') {
        try { await withTimeout(agent.whenIdle(), `等待会话 ${sessionId} 空闲`) }
        catch (error) { warn(ctx, `等待空闲失败: ${errorMessage(error)}`) }
      }
      try {
        const store = agents?.store
        const entry = store?.get?.(sessionId)
        if (entry?.agent === agent && typeof agents?.detachEntered === 'function') agents.detachEntered(entry)
        else store?.delete?.(sessionId)
      } catch (error) { warn(ctx, `移除 Agent 注册失败: ${errorMessage(error)}`) }
    }

    if (session !== undefined) {
      if (typeof sessions?.flush === 'function') {
        try { await withTimeout(sessions.flush(session), `刷新会话 ${sessionId}`) }
        catch (error) { warn(ctx, `刷新会话失败: ${errorMessage(error)}`) }
      }
      try {
        const entry = sessions?.store?.get?.(sessionId)
        if (entry !== undefined && typeof entry.detach === 'function') {
          await withTimeout(entry.detach(), `分离会话 ${sessionId}`)
        }
      } catch (error) { warn(ctx, `分离会话失败: ${errorMessage(error)}`) }
    }

    // Writers may still hold the file open on Windows; close them explicitly.
    const writers = new Set()
    try {
      const direct = persistence?.tracker?.writers?.get?.(sessionId)
      if (direct !== undefined) writers.add(direct)
      const handles = persistence?.tracker?.openHandles
      if (handles !== undefined && typeof handles[Symbol.iterator] === 'function') {
        for (const handle of handles) {
          if (handle?.id === sessionId && handle?.access === 'write') writers.add(handle)
        }
      }
    } catch { /* tracker is internal */ }
    for (const writer of writers) {
      if (typeof writer?.close !== 'function') continue
      try { await withTimeout(writer.close(), `关闭会话写入`) }
      catch (error) { warn(ctx, `关闭会话写入失败: ${errorMessage(error)}`) }
    }
    try {
      const retirement = persistence?.coordinator?.retirements?.get?.(sessionId)
      if (retirement !== undefined) await withTimeout(retirement, `等待会话持久化收尾`)
    } catch (error) { warn(ctx, `等待持久化收尾失败: ${errorMessage(error)}`) }
  }

  /** Drop the session from every workspace's accounting, the archive set and the pin set. */
  async function detachFromRegistry(sessionId) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return
    let entities = []
    try { entities = registry.list() } catch { entities = [] }
    for (const entity of entities) {
      let ids = []
      try { ids = entity?.record?.sessionIds ?? [] } catch { ids = [] }
      if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
      if (typeof entity.detachSession !== 'function') continue
      try { await withTimeout(entity.detachSession(sessionId), `解除工作区登记`) }
      catch (error) { warn(ctx, `解除工作区登记失败: ${errorMessage(error)}`) }
    }

    const setState = typeof registry.setState === 'function'
    const requireState = typeof registry.requireState === 'function'
    const enqueue = typeof registry.enqueueOperation === 'function'
    if (!setState || !requireState) return
    const apply = async () => {
      const state = registry.requireState()
      const archived = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []
      const pinned = Array.isArray(state?.pinnedSessionIds) ? state.pinnedSessionIds : []
      if (!archived.includes(sessionId) && !pinned.includes(sessionId)) return
      await registry.setState({
        ...state,
        archivedSessionIds: archived.filter(id => id !== sessionId),
        pinnedSessionIds: pinned.filter(id => id !== sessionId),
      })
    }
    try {
      if (enqueue) await withTimeout(registry.enqueueOperation(apply), `更新工作区状态`)
      else await withTimeout(apply(), `更新工作区状态`)
    } catch (error) { warn(ctx, `更新工作区状态失败: ${errorMessage(error)}`) }
  }

  function projectionFileOf(sessionId) {
    return join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  }

  /**
   * Take the projection checkpoint out of the host, optionally keeping a copy.
   *
   * The checkpoint is derived state, but it also carries the generated title
   * and recent activity the sidebar shows, so a trashed conversation keeps a
   * copy and a restored one gets it back. Only a shred throws it away.
   * @param sessionId - session whose checkpoint leaves the cache.
   * @param keepCopyTo - when set, the checkpoint bytes are written here first.
   */
  async function dropProjection(sessionId, keepCopyTo) {
    const file = projectionFileOf(sessionId)
    let bytes
    if (keepCopyTo !== undefined) {
      try { bytes = await fsp.readFile(file) } catch { bytes = undefined }
    }
    const cache = ctx.get('sessionProjectionCache')
    let table
    try {
      table = typeof cache?.requireTable === 'function' ? cache.requireTable() : cache?.table
    } catch { table = undefined }
    if (table !== undefined && typeof table.delete === 'function') {
      try { await withTimeout(table.delete(sessionId), `删除投影缓存`) }
      catch (error) { warn(ctx, `删除投影缓存失败: ${errorMessage(error)}`) }
    }
    if (bytes !== undefined && keepCopyTo !== undefined) {
      try {
        await fsp.mkdir(dirname(keepCopyTo), { recursive: true })
        await fsp.writeFile(keepCopyTo, bytes)
      } catch (error) { warn(ctx, `备份投影缓存失败: ${errorMessage(error)}`) }
    }
    try { await fsp.rm(file, { force: true }) } catch (error) { warn(ctx, `删除投影缓存文件失败: ${errorMessage(error)}`) }
  }

  /** Put a kept checkpoint back so the conversation keeps its title and status. */
  async function restoreProjection(sessionId, from) {
    try {
      await fsp.lstat(from)
    } catch { return }
    try {
      await fsp.mkdir(dirname(projectionFileOf(sessionId)), { recursive: true })
      await fsp.copyFile(from, projectionFileOf(sessionId))
    } catch (error) { warn(ctx, `恢复投影缓存失败: ${errorMessage(error)}`) }
  }

  /** Move a directory, falling back to copy+delete across volumes. */
  async function moveDirectory(from, to) {
    await fsp.mkdir(dirname(to), { recursive: true })
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    await fsp.cp(from, to, { recursive: true })
    await fsp.rm(from, { recursive: true, force: true })
  }

  /** Overwrite every file in place with random bytes, then unlink the tree. */
  async function shred(path, overwrite) {
    if (overwrite) {
      const stack = [path]
      while (stack.length > 0) {
        const current = stack.pop()
        let entries
        try { entries = await fsp.readdir(current, { withFileTypes: true }) }
        catch { continue }
        for (const entry of entries) {
          const child = join(current, entry.name)
          if (entry.isDirectory()) { stack.push(child); continue }
          if (!entry.isFile()) continue
          try {
            const { size } = await fsp.stat(child)
            if (size <= 0) continue
            const handle = await fsp.open(child, 'r+')
            try {
              let written = 0
              while (written < size) {
                const length = Math.min(OVERWRITE_CHUNK, size - written)
                await handle.write(randomBytes(length), 0, length, written)
                written += length
              }
              await handle.sync()
            } finally { await handle.close() }
          } catch (error) { warn(ctx, `覆写文件失败 ${child}: ${errorMessage(error)}`) }
        }
      }
    }
    await fsp.rm(path, { recursive: true, force: true })
  }

  function entryDir(entryId) {
    if (typeof entryId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(entryId)) {
      throw Object.assign(new Error('回收站条目标识不合法'), { code: 'bad-request' })
    }
    return join(trashRoot, entryId)
  }

  // ---------------------------------------------------------------- operations

  /** Public view of one trash entry. */
  function present(entry) {
    return {
      id: entry.id,
      sessionId: entry.sessionId,
      title: entry.title ?? '',
      deletedAt: entry.deletedAt,
      sizeBytes: entry.sizeBytes ?? 0,
      workspace: entry.workspaceTitle ?? '',
      originalDir: entry.originalDir,
      mode: entry.mode ?? 'trash',
    }
  }

  async function list() {
    const index = await readIndex()
    const entries = []
    for (const entry of index.entries) {
      let alive = true
      try { await fsp.lstat(join(trashRoot, entry.id, 'session')) } catch { alive = false }
      if (!alive) continue
      entries.push(present(entry))
    }
    entries.sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0))
    return { entries, totalBytes: entries.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0) }
  }

  /**
   * Delete one conversation.
   * @param sessionId - the conversation to delete.
   * @param options - `keepCopy` moves it to the trash; `overwrite` wipes bytes before unlinking.
   */
  async function removeSession(sessionId, options = {}) {
    assertSessionId(sessionId)
    const keepCopy = options.keepCopy !== false
    const overwrite = options.overwrite === true || (!keepCopy && overwriteDefault)

    const directory = await sessionDirOf(sessionId)
    if (directory === undefined) {
      throw Object.assign(new Error('找不到该会话的磁盘文件，可能已被删除'), { code: 'session-not-found' })
    }
    const title = await titleOf(sessionId)
    const workspace = workspaceOf(sessionId)
    const sizeBytes = await treeSize(directory)

    await quiesce(sessionId)
    await detachFromRegistry(sessionId)
    const entryId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${sessionId.replace(/^session-/u, '')}`
    const target = join(trashRoot, entryId, 'session')

    if (!keepCopy) {
      await dropProjection(sessionId)
      await shred(directory, overwrite)
      return { mode: 'shred', sessionId, title, sizeBytes, overwrite }
    }

    await dropProjection(sessionId, join(trashRoot, entryId, 'projection.json'))
    await moveDirectory(directory, target)

    const index = await readIndex()
    index.entries = index.entries.filter(entry => entry.id !== entryId && entry.sessionId !== sessionId)
    index.entries.push({
      id: entryId,
      sessionId,
      title,
      deletedAt: Date.now(),
      sizeBytes,
      originalDir: directory,
      workspaceId: workspace?.id,
      workspaceTitle: workspace?.title,
      mode: 'trash',
    })
    await writeIndex(index)
    return { mode: 'trash', entryId, sessionId, title, sizeBytes }
  }

  async function restore(entryId) {
    const index = await readIndex()
    const entry = index.entries.find(candidate => candidate.id === entryId)
    if (entry === undefined) throw Object.assign(new Error('回收站里没有这个条目'), { code: 'entry-not-found' })
    const source = join(trashRoot, entryId, 'session')
    try { await fsp.lstat(source) } catch { throw Object.assign(new Error('回收站条目缺少会话文件'), { code: 'entry-incomplete' }) }

    const destination = entry.originalDir
    const rel = relative(resolve(sessionsRoot), resolve(destination ?? ''))
    const parts = rel.split(sep)
    if (typeof destination !== 'string' || isAbsolute(rel) || parts.length !== 2
      || parts.some(part => part === '' || part === '.' || part === '..')) {
      throw Object.assign(new Error('记录的原始路径不安全，已停止恢复'), { code: 'unsafe-path' })
    }
    if (existsSync(destination)) {
      throw Object.assign(new Error('原始目录已被占用，无法恢复'), { code: 'target-exists' })
    }

    await moveDirectory(source, destination)
    await restoreProjection(entry.sessionId, join(trashRoot, entryId, 'projection.json'))

    const registry = ctx.get('workspaceRegistry')
    let workspace
    try {
      workspace = entry.workspaceId !== undefined ? registry?.get?.(entry.workspaceId) : undefined
    } catch { workspace = undefined }
    if (workspace === undefined) {
      // The workspace may have been re-created under another id; match by path.
      try {
        workspace = registry?.list?.().find(entity => entity.path === dirname(destination))
      } catch { workspace = undefined }
    }
    if (workspace !== undefined && typeof workspace.attachSession === 'function') {
      try { await withTimeout(workspace.attachSession(entry.sessionId), `恢复工作区登记`) }
      catch (error) { warn(ctx, `恢复工作区登记失败: ${errorMessage(error)}`) }
    }

    await fsp.rm(join(trashRoot, entryId), { recursive: true, force: true })
    index.entries = index.entries.filter(candidate => candidate.id !== entryId)
    await writeIndex(index)
    return { sessionId: entry.sessionId, title: entry.title ?? '', workspaceId: workspace?.id }
  }

  async function purge(entryId, options = {}) {
    const index = await readIndex()
    const entry = index.entries.find(candidate => candidate.id === entryId)
    if (entry === undefined) throw Object.assign(new Error('回收站里没有这个条目'), { code: 'entry-not-found' })
    const directory = join(trashRoot, entryId)
    await shred(directory, options.overwrite !== false)
    index.entries = index.entries.filter(candidate => candidate.id !== entryId)
    await writeIndex(index)
    return { sessionId: entry.sessionId, title: entry.title ?? '' }
  }

  async function empty(options = {}) {
    const index = await readIndex()
    let removed = 0
    for (const entry of index.entries) {
      try {
        await shred(join(trashRoot, entry.id), options.overwrite !== false)
        removed += 1
      } catch (error) { warn(ctx, `清空条目失败 ${entry.id}: ${errorMessage(error)}`) }
    }
    await writeIndex({ version: INDEX_VERSION, entries: [] })
    return { removed }
  }

  // ---------------------------------------------------------------- HTTP

  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > 64 * 1024) throw Object.assign(new Error('请求体过大'), { code: 'body-too-large' })
      chunks.push(bytes)
    }
    if (size === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text === '') return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'bad-request' })
    }
    return parsed
  }

  function send(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  function handleFailure(res, error) {
    const code = typeof error?.code === 'string' ? error.code : undefined
    const status = code === 'bad-request' ? 400
      : code === 'session-not-found' || code === 'entry-not-found' ? 404
        : code === 'target-exists' || code === 'unsafe-path' || code === 'entry-incomplete' ? 409
          : 500
    send(res, status, { ok: false, error: errorMessage(error), ...(code === undefined ? {} : { code }) })
  }

  /** The transport: one prefix route, JSON in and out. */
  async function route(req, res) {
    let path = '/'
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : '/'
      const method = req.method ?? 'GET'

      if (method === 'GET' && path === '/list') {
        return send(res, 200, { ok: true, result: await list() })
      }
      if (method === 'POST') {
        const body = await readBody(req)
        if (path === '/trash') {
          assertSessionId(body.sessionId)
          const result = await mutate(`session:${body.sessionId}`, () => removeSession(body.sessionId, {
            keepCopy: true,
            overwrite: false,
          }))
          return send(res, 200, { ok: true, result })
        }
        if (path === '/shred') {
          assertSessionId(body.sessionId)
          const result = await mutate(`session:${body.sessionId}`, () => removeSession(body.sessionId, {
            keepCopy: false,
            overwrite: body.overwrite !== false,
          }))
          return send(res, 200, { ok: true, result })
        }
        if (path === '/restore') {
          const result = await mutate(`entry:${body.entryId}`, () => restore(body.entryId))
          return send(res, 200, { ok: true, result })
        }
        if (path === '/purge') {
          const result = await mutate(`entry:${body.entryId}`, () => purge(body.entryId, {
            overwrite: body.overwrite !== false,
          }))
          return send(res, 200, { ok: true, result })
        }
        if (path === '/empty') {
          const result = await mutate('trash', () => empty({ overwrite: body.overwrite !== false }))
          return send(res, 200, { ok: true, result })
        }
      }
      return send(res, 404, { ok: false, error: '未知接口', code: 'not-found' })
    } catch (error) {
      return handleFailure(res, error)
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: route }), 'session-trash: api route')

  ctx.logger?.info?.(`session-trash ready (home: ${home}, trash: ${trashRoot})`)
}
