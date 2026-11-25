#!/usr/bin/env node
/**
 * Publish this plugin to GitHub.
 *
 * Two phases, both idempotent:
 *   login   — GitHub OAuth device flow (no PAT to paste, no browser tooling).
 *             The token lands in `.publish-token` (git-ignored).
 *   publish — create the repository if missing, set `origin`, push `main`.
 *
 * Usage:
 *   node scripts/publish.mjs            # login if needed, then publish
 *   node scripts/publish.mjs login      # login only
 *   node scripts/publish.mjs publish    # publish only
 *
 * Environment:
 *   GITHUB_TOKEN   use this token instead of the device flow / token file
 *   GH_PROXY       URL prefix for git push, e.g. https://gh-proxy.com/ (for
 *                  networks where github.com is unreliable)
 *   REPO_NAME      repository name, default dsh-session-trash
 *   VISIBILITY     public (default) or private
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN_FILE = join(ROOT, '.publish-token')
const REPO_NAME = process.env.REPO_NAME ?? 'dsh-session-trash'
const VISIBILITY = (process.env.VISIBILITY ?? 'public').toLowerCase() === 'private'
const GH_PROXY = process.env.GH_PROXY ?? ''
// The GitHub CLI's public OAuth application id, used for the device flow.
const CLIENT_ID = '178c6fc778ccc68e1d6a'
const SCOPE = 'repo'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function log(message) { process.stdout.write(`${message}\n`) }
function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'dsh-session-trash-publish',
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

// --------------------------------------------------------------------- login

async function deviceLogin() {
  const start = await jsonRequest('https://github.com/login/device/code', {
    method: 'POST',
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  })
  if (start.status !== 200 || typeof start.body?.device_code !== 'string') {
    fail(`设备码申请失败 HTTP ${start.status}: ${JSON.stringify(start.body)}`)
  }
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri, interval = 5, expires_in: expiresIn = 900 } = start.body

  log(`::user_code=${userCode}`)
  log(`::verification_uri=${uri ?? 'https://github.com/login/device'}`)
  log('')
  log(`请在浏览器打开 ${uri ?? 'https://github.com/login/device'} 并输入一次性代码：${userCode}`)
  log(`等待授权（最长 ${Math.round(expiresIn / 60)} 分钟）…`)

  const deadline = Date.now() + expiresIn * 1000
  let waitMs = Math.max(interval, 5) * 1000
  while (Date.now() < deadline) {
    await sleep(waitMs)
    const poll = await jsonRequest('https://github.com/login/oauth/access_token', {
      method: 'POST',
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const error = poll.body?.error
    if (typeof poll.body?.access_token === 'string') {
      writeFileSync(TOKEN_FILE, poll.body.access_token, { mode: 0o600 })
      log('::access_token=received')
      log('授权完成，令牌已保存到 .publish-token')
      return poll.body.access_token
    }
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') { waitMs += 5000; continue }
    if (error === 'expired_token') fail('设备码已过期，请重新运行脚本。')
    if (error === 'access_denied') fail('授权被拒绝。')
    fail(`授权轮询失败: ${JSON.stringify(poll.body)}`)
  }
  fail('等待授权超时，请重新运行脚本。')
}

function resolveToken() {
  if (typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.trim() !== '') {
    return process.env.GITHUB_TOKEN.trim()
  }
  if (existsSync(TOKEN_FILE)) {
    const saved = readFileSync(TOKEN_FILE, 'utf8').trim()
    if (saved !== '') return saved
  }
  return undefined
}

// ------------------------------------------------------------------- publish

async function whoAmI(token) {
  const { status, body } = await jsonRequest('https://api.github.com/user', {
    headers: { authorization: `Bearer ${token}` },
  })
  if (status !== 200) fail(`读取账号失败 HTTP ${status}: ${JSON.stringify(body)}`)
  return body.login
}

async function createRepo(token, login) {
  const { status, body } = await jsonRequest('https://api.github.com/user/repos', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({
      name: REPO_NAME,
      description: 'DSH 会话回收站：把对话删进可恢复的回收站，或彻底粉碎。Session trash plugin for DeepSeek Harness.',
      private: VISIBILITY,
      has_issues: true,
      has_wiki: false,
      has_discussions: false,
      auto_init: false,
    }),
  })
  if (status === 201) {
    log(`已创建仓库 ${login}/${REPO_NAME}`)
    return
  }
  const alreadyExists = status === 422
    && Array.isArray(body?.errors)
    && body.errors.some((entry) => entry?.message?.includes('already exists'))
  if (alreadyExists) {
    log(`仓库 ${login}/${REPO_NAME} 已存在，直接推送`)
    return
  }
  fail(`创建仓库失败 HTTP ${status}: ${JSON.stringify(body)}`)
}

function git(args, options = {}) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(`git ${args.join(' ')} 失败:\n${result.stderr || result.stdout}`)
  }
  return (result.stdout ?? '').trim()
}

/** Best-effort git call for steps whose absence is not a failure. */
function gitTry(args) {
  spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: 'ignore' })
}

function push(token, login) {
  const hosted = `https://github.com/${login}/${REPO_NAME}.git`
  const remote = GH_PROXY === '' ? hosted : `${GH_PROXY.replace(/\/$/u, '')}/${hosted}`
  const authenticated = remote.replace('https://', `https://x-access-token:${token}@`)
  // A first publish has no `origin` yet, so removal is best-effort.
  gitTry(['remote', 'remove', 'origin'])
  git(['remote', 'add', 'origin', remote])
  git(['push', '-u', authenticated, 'HEAD:refs/heads/main'])
  // Keep the token out of .git/config once the push is done.
  git(['remote', 'set-url', 'origin', remote])
  log(`已推送到 ${hosted}`)
  log(`仓库地址: https://github.com/${login}/${REPO_NAME}`)
}

async function main() {
  const phase = process.argv[2] ?? 'all'
  let token = resolveToken()
  if (token === undefined && phase !== 'publish') {
    token = await deviceLogin()
  }
  if (token === undefined) fail('没有可用令牌：先运行 node scripts/publish.mjs login，或设置 GITHUB_TOKEN。')
  if (phase === 'login') {
    log('登录阶段结束。')
    return
  }
  const login = await whoAmI(token)
  log(`账号: ${login}`)
  await createRepo(token, login)
  push(token, login)
}

await main()
