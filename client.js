/**
 * dsh-session-trash — Client half.
 *
 * Adds two entries to a Session's context menu (move to trash, delete
 * permanently) and one recovery panel in the frame overlay. All three call the
 * Host route `/session-trash/api`, so the panel and the menu share one
 * implementation with the Host.
 *
 * Styling follows the host: theme tokens with literal fallbacks, host-like
 * spacing and type, no primitive imports (they are not part of a plugin's
 * module table).
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API = '/session-trash/api'
    const NS = 'session-trash'

    /** Bilingual labels resolved from the Client locale service when present. */
    const FALLBACK = {
      menuTrash: '移入回收站',
      menuPurge: '彻底删除…',
      menuOpen: '回收站',
      title: '回收站',
      empty: '回收站是空的。',
      restore: '还原',
      purge: '彻底删除',
      emptyAll: '清空回收站',
      close: '关闭',
      refresh: '刷新',
      loading: '加载中…',
      confirmRestore: '还原「{title}」？对话会回到原来的工作区。',
      confirmPurge: '彻底删除「{title}」？此操作不可撤销。',
      confirmEmpty: '彻底删除回收站里的全部对话？此操作不可撤销。',
      busy: '处理中…',
      failed: '操作失败',
      total: '共 {n} 个，{size}',
    }

    // ------------------------------------------------------------------ theme

    const surface = 'var(--dsw-alias-bg-layer, #ffffff)'
    const surfaceSoft = 'var(--dsw-alias-bg-elevated, rgba(127,127,127,0.10))'
    const hoverBg = 'var(--dsw-alias-bg-hover, rgba(127,127,127,0.16))'
    const borderColor = 'var(--dsw-alias-border-default, rgba(127,127,127,0.32))'
    const textColor = 'var(--dsw-alias-color-text-primary, inherit)'
    const textSoft = 'var(--dsw-alias-color-text-secondary, rgba(127,127,127,0.95))'
    const dangerColor = 'var(--dsw-alias-color-danger, #d9534f)'

    const panelStyle = {
      position: 'fixed', inset: 0, zIndex: 1600,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(0,0,0,0.42)',
    }
    const cardStyle = {
      width: 'min(760px, 92vw)', maxHeight: '82vh', display: 'flex', flexDirection: 'column',
      background: surface, color: textColor, border: `1px solid ${borderColor}`,
      borderRadius: 12, boxShadow: '0 18px 48px rgba(0,0,0,0.28)', overflow: 'hidden',
      font: 'inherit',
    }
    const headStyle = {
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '14px 16px', borderBottom: `1px solid ${borderColor}`,
    }
    const bodyStyle = { padding: '4px 8px 8px', overflowY: 'auto', flex: '1 1 auto' }
    const footStyle = {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      padding: '12px 16px', borderTop: `1px solid ${borderColor}`,
    }
    const buttonStyle = {
      font: 'inherit', fontSize: 13, color: 'inherit', background: surfaceSoft,
      border: `1px solid ${borderColor}`, borderRadius: 8, padding: '5px 12px', cursor: 'pointer',
    }

    function menuItemStyle(hovered) {
      return {
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', boxSizing: 'border-box',
        font: 'inherit', fontSize: 13, color: 'inherit', textAlign: 'left',
        background: hovered ? hoverBg : 'transparent', border: 0, borderRadius: 6,
        padding: '7px 10px', cursor: 'pointer',
      }
    }

    // ---------------------------------------------------------------- helpers

    function formatSize(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function formatTime(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return ''
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function bind(text, values) {
      return String(text).replace(/\{(\w+)\}/gu, (match, key) => (key in values ? String(values[key]) : match))
    }

    async function callApi(path, payload) {
      const response = await fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      let body
      try { body = await response.json() } catch { body = undefined }
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`)
      }
      return body.result
    }

    async function readList() {
      const response = await fetch(`${API}/list`, { method: 'GET' })
      const body = await response.json().catch(() => undefined)
      if (!response.ok || body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
      return body.result
    }

    /** Ask the Client session store to re-read the host list after a restore. */
    function refreshSessions(ctx) {
      try {
        const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
        if (sessions !== undefined && typeof sessions.refresh === 'function') {
          void sessions.refresh()
        }
      } catch { /* the row returns on the next list refresh either way */ }
    }

    // ------------------------------------------------------------- panel state

    const panel = { open: false, listeners: new Set() }

    function setPanelOpen(open) {
      if (panel.open === open) return
      panel.open = open
      for (const listener of panel.listeners) listener()
    }

    function usePanelOpen() {
      return React.useSyncExternalStore(
        (listener) => {
          panel.listeners.add(listener)
          return () => { panel.listeners.delete(listener) }
        },
        () => panel.open,
        () => panel.open,
      )
    }

    // ----------------------------------------------------------------- pieces

    function MenuEntry({ label, danger, onSelect, useMenuOpenState }) {
      const [hovered, setHovered] = React.useState(false)
      const closeSelf = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : undefined
      return h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          style: { ...menuItemStyle(hovered), ...(danger ? { color: dangerColor } : {}) },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
          onFocus: () => setHovered(true),
          onBlur: () => setHovered(false),
          onClick: () => {
            if (typeof closeSelf === 'function') closeSelf(false)
            onSelect()
          },
        },
        label,
      )
    }

    function EntryRow({ entry, busy, onRestore, onPurge }) {
      const [hovered, setHovered] = React.useState(false)
      const title = entry.title || entry.sessionId
      return h(
        'div',
        {
          style: {
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '10px 12px', borderRadius: 8,
            background: hovered ? hoverBg : 'transparent',
          },
          onMouseEnter: () => setHovered(true),
          onMouseLeave: () => setHovered(false),
        },
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', {
            style: {
              fontSize: 13.5, fontWeight: 500, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis',
            },
            title,
          }, title),
          h('div', { style: { fontSize: 12, color: textSoft, marginTop: 3 } },
            [entry.workspace, formatTime(entry.deletedAt), formatSize(entry.sizeBytes)]
              .filter((part) => part !== '' && part !== undefined)
              .join(' · '),
          ),
        ),
        h('div', { style: { display: 'flex', gap: 8, flex: '0 0 auto' } },
          h('button', {
            type: 'button', style: buttonStyle, disabled: busy,
            onClick: () => onRestore(entry),
          }, FALLBACK.restore),
          h('button', {
            type: 'button',
            style: { ...buttonStyle, color: dangerColor, borderColor: dangerColor },
            disabled: busy,
            onClick: () => onPurge(entry),
          }, FALLBACK.purge),
        ),
      )
    }

    function TrashPanel({ ctx }) {
      const open = usePanelOpen()
      const [state, setState] = React.useState({ phase: 'idle', entries: [], totalBytes: 0, error: '' })
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setState((previous) => ({ ...previous, phase: 'loading', error: '' }))
        try {
          const result = await readList()
          setState({ phase: 'ready', entries: result.entries ?? [], totalBytes: result.totalBytes ?? 0, error: '' })
        } catch (error) {
          setState({ phase: 'error', entries: [], totalBytes: 0, error: String(error?.message ?? error) })
        }
      }, [])

      React.useEffect(() => {
        if (open) void load()
      }, [open, load])

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') { event.stopPropagation(); setPanelOpen(false) }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open])

      if (!open) return null

      const withBusy = async (operation) => {
        if (busy) return
        setBusy(true)
        try { await operation() }
        catch (error) {
          setState((previous) => ({ ...previous, error: String(error?.message ?? error) }))
        } finally { setBusy(false) }
      }

      const restoreEntry = (entry) => withBusy(async () => {
        const title = entry.title || entry.sessionId
        if (!window.confirm(bind(FALLBACK.confirmRestore, { title }))) return
        await callApi('/restore', { entryId: entry.id })
        refreshSessions(ctx)
        await load()
      })

      const purgeEntry = (entry) => withBusy(async () => {
        const title = entry.title || entry.sessionId
        if (!window.confirm(bind(FALLBACK.confirmPurge, { title }))) return
        await callApi('/purge', { entryId: entry.id, overwrite: true })
        await load()
      })

      const emptyAll = () => withBusy(async () => {
        if (!window.confirm(FALLBACK.confirmEmpty)) return
        await callApi('/empty', { overwrite: true })
        await load()
      })

      const entries = state.entries
      return h('div', {
        style: panelStyle,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': FALLBACK.title,
        onMouseDown: (event) => { if (event.target === event.currentTarget) setPanelOpen(false) },
      },
      h('div', { style: cardStyle },
        h('div', { style: headStyle },
          h('div', { style: { fontSize: 15, fontWeight: 600, flex: '1 1 auto' } }, FALLBACK.title),
          h('button', {
            type: 'button', style: buttonStyle, onClick: () => { void load() }, disabled: busy || state.phase === 'loading',
          }, FALLBACK.refresh),
          h('button', {
            type: 'button', style: buttonStyle, onClick: () => setPanelOpen(false),
          }, FALLBACK.close),
        ),
        h('div', { style: bodyStyle },
          state.error !== '' && h('div', {
            style: { color: dangerColor, fontSize: 12.5, padding: '8px 12px' },
          }, `${FALLBACK.failed}: ${state.error}`),
          state.phase === 'loading' && entries.length === 0 && h('div', {
            style: { color: textSoft, fontSize: 13, padding: '18px 12px' },
          }, FALLBACK.loading),
          state.phase !== 'loading' && entries.length === 0 && h('div', {
            style: { color: textSoft, fontSize: 13, padding: '18px 12px' },
          }, FALLBACK.empty),
          ...entries.map((entry) => h(EntryRow, {
            key: entry.id,
            entry,
            busy,
            onRestore: restoreEntry,
            onPurge: purgeEntry,
          })),
        ),
        h('div', { style: footStyle },
          h('div', { style: { fontSize: 12, color: textSoft } },
            busy ? FALLBACK.busy : bind(FALLBACK.total, { n: entries.length, size: formatSize(state.totalBytes) }),
          ),
          h('button', {
            type: 'button',
            style: { ...buttonStyle, color: dangerColor, borderColor: dangerColor },
            disabled: busy || entries.length === 0,
            onClick: emptyAll,
          }, FALLBACK.emptyAll),
        ),
      ))
    }

    // ------------------------------------------------------------------ plugin

    return {
      inject: ['slots'],
      apply(ctx) {
        const locate = (key, fallback) => {
          try {
            const bound = ctx.locale.bind(NS)
            const value = bound(key)
            return typeof value === 'string' && value !== '' && value !== key ? value : fallback
          } catch { return fallback }
        }
        const labelTrash = locate('menu.trash', FALLBACK.menuTrash)
        const labelPurge = locate('menu.purge', FALLBACK.menuPurge)
        const labelOpen = locate('menu.open', FALLBACK.menuOpen)

        const run = async (sessionId, path) => {
          try {
            await callApi(path, { sessionId, overwrite: path === '/shred' })
          } catch (error) {
            window.alert(`${FALLBACK.failed}: ${String(error?.message ?? error)}`)
          }
        }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', function* () {
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'session-trash-move', order: 500 },
            ({ sessionId, useMenuOpenState }) => h(MenuEntry, {
              label: labelTrash,
              danger: false,
              useMenuOpenState,
              onSelect: () => { void run(sessionId, '/trash') },
            }),
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'session-trash-shred', order: 510 },
            ({ sessionId, displayTitle, useMenuOpenState }) => h(MenuEntry, {
              label: labelPurge,
              danger: true,
              useMenuOpenState,
              onSelect: () => {
                const title = displayTitle || sessionId
                if (!window.confirm(bind(FALLBACK.confirmPurge, { title }))) return
                void run(sessionId, '/shred')
              },
            }),
          )
          yield ctx.slots.register(
            { name: 'sidebar.workspaces.session.menu.item', id: 'session-trash-open', order: 520 },
            ({ useMenuOpenState }) => h(MenuEntry, {
              label: labelOpen,
              danger: false,
              useMenuOpenState,
              onSelect: () => { setPanelOpen(true) },
            }),
          )
        })

        ctx.slots.inject('shell.overlay', () => ctx.slots.register(
          { name: 'shell.overlay', id: 'session-trash-panel' },
          () => h(TrashPanel, { ctx }),
        ))
      },
    }
  },
})
