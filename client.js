/**
 * Conversation lock — browser half.
 *
 * Registers three surfaces into the running page:
 *
 * - a lock chip in the composer tool row of the current conversation: it shows
 *   the state and toggles it;
 * - a small lock glyph on every Session row, so the state of every conversation
 *   is readable at a glance;
 * - a row in a Session's "..." menu, so the lock can be changed from the
 *   conversation list as well.
 *
 * All three read one in-page store and write through the package's private
 * Host route, which admits only the page's own browser credential. Nothing here
 * unlocks a conversation on its own: every change is the user's click.
 */

window.__ModuleLoader__.load({
  id: 'dsh-conversation-lock',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this package registers and binds. */
    const NS = 'conversationLock'
    /** Host route prefix, document-relative like the framework's own `/api`. */
    const CHANNEL = 'conversation-lock'
    /** Cross-window notification channel, so every open window agrees. */
    const BROADCAST = 'dsh-conversation-lock'

    const EN = {
      'state.locked': 'Locked',
      'state.unlocked': 'Unlocked',
      'state.failed': 'Not saved',
      'state.unavailable': 'Unavailable',
      'chip.label': 'Conversation lock',
      'chip.title.locked': 'Other agents cannot send messages into this conversation. Click to unlock it.',
      'chip.title.unlocked': 'Any agent may send a message into this conversation. Click to lock it.',
      'chip.title.unavailable': 'This lock is unavailable because the Harness Host did not answer. Click to retry.',
      'error.transport': 'The Harness Host did not accept the change.',
      'badge.title.locked': 'Locked: other agents cannot send messages here',
      'badge.title.unlocked': 'Unlocked: agents can send messages here',
      'badge.label': 'Conversation lock: {state}',
      'menu.setting': 'Allow other agents to send messages here',
    }

    const ZH = {
      'state.locked': '已锁定',
      'state.unlocked': '已解锁',
      'state.failed': '未保存',
      'state.unavailable': '不可用',
      'chip.label': '对话锁',
      'chip.title.locked': '其他 agent 无法向这个对话发送消息。点击解锁。',
      'chip.title.unlocked': '任何 agent 都可以向这个对话发送消息。点击锁定。',
      'chip.title.unavailable': 'Harness Host 没有响应，这个锁暂时不可用。点击重试。',
      'error.transport': 'Harness Host 没有接受这次修改。',
      'badge.title.locked': '已锁定：其他 agent 无法向这里发送消息',
      'badge.title.unlocked': '已解锁：agent 可以向这里发送消息',
      'badge.label': '对话锁：{state}',
      'menu.setting': '允许其他 agent 向这里发送消息',
    }

    /**
     * Component-local styles.
     *
     * Geometry, hover fill, focus treatment, and type follow the composer's own
     * controls (`ui-permission-presets`, `ui-conversation`) so the contributed
     * chip does not read as a foreign pill; every color is a theme token, with
     * the inspected token as the fallback where a token was not in the exposed
     * catalog.
     */
    const CSS = `
.cvl-chip{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .1s,color .1s}
.cvl-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}
.cvl-chip[data-open=true]{color:var(--dsw-alias-state-success-primary)}
.cvl-chip[data-failed=true]{color:var(--dsw-alias-state-error-primary)}
.cvl-chip:disabled{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-secondary));cursor:default}
.cvl-chip:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:2px}
.cvl-badge{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.cvl-badge[data-open=true]{color:var(--dsw-alias-state-success-primary)}
.cvl-menu{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:0;border-radius:12px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
.cvl-menu:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}
.cvl-menu:focus-visible{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));outline:none}
.cvl-menu:disabled{cursor:default;opacity:.7}
.cvl-menu svg{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.cvl-menu[data-open=true] svg{color:var(--dsw-alias-state-success-primary)}
.cvl-menu-state{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px}
.cvl-menu[data-open=true] .cvl-menu-state{color:var(--dsw-alias-state-success-primary)}
.cvl-menu[data-failed=true] .cvl-menu-state{color:var(--dsw-alias-state-error-primary)}
.cvl-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
`

    /** Resolve the caller's translate function, falling back to the English copy. */
    function makeT(ctx) {
      let bound
      try {
        bound = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NS) : undefined
      } catch {
        bound = undefined
      }
      return (key, params) => {
        let text
        try {
          text = bound === undefined ? undefined : bound(key, params)
        } catch {
          text = undefined
        }
        if (typeof text !== 'string' || text === key) text = EN[key] ?? key
        return interpolate(text, params)
      }
    }

    /** Replace `{name}` placeholders in one already-translated string. */
    function interpolate(template, params) {
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** One tiny lock glyph; `open` draws the shackle lifted clear of the body. */
    function LockGlyph({ open, size = 14 }) {
      const shackle = open ? 'M5 7V5.3a3 3 0 0 1 5.6-1.5' : 'M5 7V5.3a3 3 0 0 1 6 0V7'
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true, focusable: 'false',
        style: { display: 'block', flex: 'none' },
      },
      h('path', {
        d: shackle, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round',
      }),
      h('rect', {
        x: 3.25, y: 7, width: 9.5, height: 6.5, rx: 1.75,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      }),
      h('circle', { cx: 8, cy: 10.3, r: 0.95, fill: 'currentColor' }))
    }

    /**
     * The page-side mirror of the Host records.
     *
     * It starts in the `unknown` state — nothing is claimed before the Host has
     * answered — loads the unlock set once, and re-reads on window focus. A
     * failed read stays `failed` until a retry succeeds, so the controls can say
     * "unavailable" instead of showing a state they never learned. Every write
     * is republished to other windows, so two open windows cannot disagree.
     */
    function createStore() {
      const unlocked = new Set()
      const listeners = new Set()
      let status = 'unknown'
      let channel
      try {
        channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(BROADCAST) : undefined
      } catch {
        channel = undefined
      }
      if (channel !== undefined) {
        channel.addEventListener('message', (event) => {
          const ids = event.data?.unlocked
          if (Array.isArray(ids)) apply(ids, 'ready')
        })
      }

      function notify() {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // A broken subscriber must not stop the others.
          }
        }
      }

      function apply(ids, nextStatus) {
        const next = new Set(ids.filter(id => typeof id === 'string' && id !== ''))
        const same = next.size === unlocked.size && [...next].every(id => unlocked.has(id))
        const statusChanged = status !== nextStatus
        if (same && !statusChanged) return
        unlocked.clear()
        for (const id of next) unlocked.add(id)
        status = nextStatus
        notify()
      }

      /** Post one operation to the Host route and return its value. */
      async function call(endpoint, payload) {
        let response
        try {
          response = await fetch(`${CHANNEL}/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          })
        } catch (error) {
          throw new Error(`transport: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const result = await response.json()
        if (result?.ok === true) return result.value
        throw new Error(result?.error?.message ?? 'request failed')
      }

      return {
        get status() {
          return status
        },
        isUnlocked(sessionId) {
          return typeof sessionId === 'string' && unlocked.has(sessionId)
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        async refresh() {
          try {
            const value = await call('list')
            apply(Array.isArray(value?.unlocked) ? value.unlocked : [], 'ready')
          } catch (error) {
            status = 'failed'
            notify()
            console.warn('conversation-lock: could not read the lock state', error)
          }
        },
        async setUnlocked(sessionId, next) {
          const value = await call('set', { sessionId, unlocked: next })
          if (typeof value?.unlocked !== 'boolean') throw new Error('malformed response')
          const ids = new Set(unlocked)
          if (value.unlocked) ids.add(sessionId)
          else ids.delete(sessionId)
          apply([...ids], 'ready')
          try {
            channel?.postMessage({ unlocked: [...ids] })
          } catch {
            // Cross-window refresh is best effort.
          }
          return value.unlocked
        },
      }
    }

    /** Read the store's load status, re-rendering when it changes. */
    function useStoreStatus(store) {
      const [status, setStatus] = React.useState(store.status)
      React.useEffect(() => {
        setStatus(store.status)
        return store.subscribe(() => setStatus(store.status))
      }, [])
      return status
    }

    /** Read one conversation's state, re-rendering when the store changes. */
    function useLockState(store, sessionId) {
      const read = () => store.isUnlocked(sessionId)
      const [unlocked, setUnlocked] = React.useState(read)
      React.useEffect(() => {
        setUnlocked(read())
        return store.subscribe(() => setUnlocked(read()))
      }, [sessionId])
      return unlocked
    }

    /** Session id of the conversation the slot is rendering; every host slot here supplies one. */
    function sessionIdOf(props) {
      return typeof props?.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : undefined
    }

    /** Keep the composer's draft focused when a toolbar control is clicked. */
    function keepFocus(event) {
      event.preventDefault()
    }

    /** The composer-row chip: visible state plus the toggle. */
    function LockChip(props) {
      const sessionId = sessionIdOf(props)
      const status = useStoreStatus(props.store)
      const unlocked = useLockState(props.store, sessionId)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const timer = React.useRef(undefined)
      const t = props.t ?? makeT({})

      React.useEffect(() => () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
      }, [])
      if (sessionId === undefined || status === 'unknown') return null

      const showFailure = (error) => {
        setBusy(false)
        setFailure(error instanceof Error && error.message !== '' ? error.message : t('error.transport'))
        if (timer.current !== undefined) clearTimeout(timer.current)
        timer.current = setTimeout(() => setFailure(''), 4000)
      }

      const toggle = () => {
        if (busy) return
        if (status === 'failed') {
          void props.store.refresh()
          return
        }
        setBusy(true)
        setFailure('')
        props.store.setUnlocked(sessionId, !unlocked).then(() => setBusy(false), showFailure)
      }

      const state = unlocked ? t('state.unlocked') : t('state.locked')
      const label = status === 'failed' ? t('state.unavailable') : failure !== '' ? t('state.failed') : state
      const title = status === 'failed'
        ? t('chip.title.unavailable')
        : failure !== ''
          ? `${t('error.transport')} (${failure})`
          : unlocked ? t('chip.title.unlocked') : t('chip.title.locked')

      return h(React.Fragment, null,
        h('style', { key: 'cvl-style' }, CSS),
        h('button', {
          key: 'cvl-chip',
          type: 'button',
          className: 'cvl-chip',
          'data-open': String(unlocked),
          'data-failed': String(status === 'failed' || failure !== ''),
          disabled: busy,
          'aria-busy': busy,
          'aria-pressed': status === 'ready' ? unlocked : undefined,
          'aria-label': `${t('chip.label')}: ${status === 'ready' ? state : label}`,
          title,
          onMouseDown: keepFocus,
          onClick: toggle,
        },
        h(LockGlyph, { open: unlocked, size: 13 }),
        h('span', { className: 'cvl-chip-label' }, label),
        failure === ''
          ? null
          : h('span', { key: 'cvl-status', className: 'cvl-sr', role: 'status' }, `${t('state.failed')}: ${failure}`)))
    }

    /** The Session-row glyph: state only, never a control. */
    function RowLockBadge(props) {
      const sessionId = sessionIdOf(props)
      const status = useStoreStatus(props.store)
      const unlocked = useLockState(props.store, sessionId)
      const t = props.t ?? makeT({})
      if (sessionId === undefined || status !== 'ready') return null
      const state = unlocked ? t('state.unlocked') : t('state.locked')
      return h(React.Fragment, null,
        h('style', { key: 'cvl-style' }, CSS),
        h('span', {
          key: 'cvl-badge',
          className: 'cvl-badge',
          'data-open': String(unlocked),
          title: unlocked ? t('badge.title.unlocked') : t('badge.title.locked'),
          'aria-label': t('badge.label', { state }),
          role: 'img',
        }, h(LockGlyph, { open: unlocked, size: 13 })))
    }

    /** The Session menu row: the same toggle, reachable from the list. */
    function SessionLockMenuItem(props) {
      const sessionId = sessionIdOf(props)
      const status = useStoreStatus(props.store)
      const unlocked = useLockState(props.store, sessionId)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const timer = React.useRef(undefined)
      const t = props.t ?? makeT({})
      // The shared menu owns dismissal; the hook factory is fixed for this
      // registration, so reading it unconditionally keeps hook order stable.
      const menuState = typeof props.useMenuOpenState === 'function' ? props.useMenuOpenState() : undefined
      const closeMenu = menuState?.[1]

      React.useEffect(() => () => {
        if (timer.current !== undefined) clearTimeout(timer.current)
      }, [])
      if (sessionId === undefined || status === 'unknown') return null

      const toggle = () => {
        if (busy) return
        setBusy(true)
        setFailure('')
        closeMenu?.(false)
        props.store.setUnlocked(sessionId, !unlocked).then(() => setBusy(false), (error) => {
          setBusy(false)
          setFailure(error instanceof Error && error.message !== '' ? error.message : t('error.transport'))
          if (timer.current !== undefined) clearTimeout(timer.current)
          timer.current = setTimeout(() => setFailure(''), 4000)
        })
      }

      const suffix = failure !== ''
        ? t('state.failed')
        : status === 'failed' ? t('state.unavailable') : unlocked ? t('state.unlocked') : t('state.locked')

      return h(React.Fragment, null,
        h('style', { key: 'cvl-style' }, CSS),
        h('button', {
          key: 'cvl-menu',
          type: 'button',
          role: 'menuitem',
          className: 'cvl-menu',
          'data-open': String(unlocked),
          'data-failed': String(status === 'failed' || failure !== ''),
          disabled: busy,
          title: failure !== '' ? `${t('error.transport')} (${failure})` : undefined,
          onMouseDown: keepFocus,
          onClick: toggle,
        },
        h(LockGlyph, { open: unlocked, size: 14 }),
        h('span', null, t('menu.setting')),
        h('span', { className: 'cvl-menu-state' }, suffix)))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const store = createStore()
        const t = makeT(ctx)

        ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'conversation-lock: English dictionary')
        ctx.effect(() => ctx.locale.register(NS, 'zh', ZH), 'conversation-lock: Chinese dictionary')

        // One baseline read, then re-read whenever the page becomes active again;
        // the Host stays authoritative for windows opened before this one.
        void store.refresh()
        ctx.effect(() => {
          const onFocus = () => {
            void store.refresh()
          }
          window.addEventListener('focus', onFocus)
          return () => window.removeEventListener('focus', onFocus)
        }, 'conversation-lock: focus refresh')

        ctx.effect(() => ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'conversation-lock',
          order: 40,
          locale: NS,
          label: () => t('chip.label'),
          inject: () => ({ store }),
        }, LockChip)), 'conversation-lock: composer chip')

        ctx.effect(() => ctx.slots.inject('sidebar.session.row.trailing', () => ctx.slots.register({
          name: 'sidebar.session.row.trailing',
          id: 'conversation-lock',
          order: 5,
          locale: NS,
          inject: () => ({ store }),
        }, RowLockBadge)), 'conversation-lock: Session row badge')

        ctx.effect(() => ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'conversation-lock',
          order: 400,
          locale: NS,
          inject: () => ({ store }),
        }, SessionLockMenuItem)), 'conversation-lock: Session menu row')
      },
    }
  },
})
