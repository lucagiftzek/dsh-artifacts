/**
 * dsh-artifacts — browser half.
 *
 * Registers ONE sidebar tab, "Artifacts", through dsh-better-sidebar's public
 * extension point (`ctx.betterSidebar.registerTab`). That registry is the same
 * API the sidebar's own eight built-in tabs use, so this tab is a peer of
 * explorer/editor/terminal/browser rather than a bolt-on overlay.
 *
 * Where the data comes from: an index endpoint (default `/report/?list=1`)
 * answering the JSON contract in docs/artifact-index-endpoint.md. It lists the
 * artifact directory behind the same auth as the artifacts themselves and
 * returns metadata only - never file contents. That keeps this plugin free of
 * any host-side service, filesystem access, or settings namespace, which is the
 * whole reason its node half is empty. Override the URL per browser with
 * localStorage['dsh-artifacts:indexUrl'].
 *
 * Previewing reuses the same route: each item's `url` is used verbatim as the
 * iframe src, so a relative one is same-origin with the GUI and loads with the
 * browser's existing session cookie. If the server injects a live-reload snippet
 * into served HTML - the reference implementation in contrib/ does - the preview
 * refreshes itself when the file is regenerated. Nothing here needs to know
 * about that; it just works.
 *
 * Purity: no `@deepseek-ai/*` value imports (they would inline a duplicate
 * runtime instance and fail the build gate). `react` and `react/jsx-runtime`
 * stay external and resolve to the shell's own instances. Cross-plugin
 * collaboration goes through the cordis service, exactly as the sidebar's
 * README prescribes.
 */
import { useCallback, useEffect, useState } from 'react'

const TAB_ID = 'dsh-artifacts:library'

/**
 * Where the artifact index is read from.
 *
 * DSH itself does not define an artifact directory or an index route, so this
 * plugin expects *some* same-origin endpoint answering the small JSON contract
 * in `docs/artifact-index-endpoint.md` (a reference implementation ships in
 * `contrib/`). The default matches the `/report/` route that route documents.
 *
 * Override per browser without a rebuild:
 *   localStorage['dsh-artifacts:indexUrl'] = '/artifacts/index.json'
 */
const LS_INDEX_KEY = 'dsh-artifacts:indexUrl'
const DEFAULT_LIST_URL = '/report/?list=1'

function listUrl() {
  try {
    const v = typeof localStorage !== 'undefined' && localStorage.getItem(LS_INDEX_KEY)
    if (v && v.trim()) return v.trim()
  } catch {
    /* storage can be blocked (private mode, sandboxed frame) - fall back */
  }
  return DEFAULT_LIST_URL
}

/** Absolute form of an item url, for "open in new tab" and "copy link". */
function absoluteUrl(u) {
  return /^https?:\/\//i.test(u) ? u : (typeof location !== 'undefined' ? location.origin : '') + u
}
/** List poll interval. The preview itself self-refreshes via the injected snippet. */
const POLL_MS = 5000

const EXT_LABEL = {
  html: 'HTML', md: 'Markdown', txt: 'Text', json: 'JSON', csv: 'CSV', svg: 'SVG',
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

function fmtAge(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ts * 1000).toLocaleString()
}

/* Inline styles only: no stylesheet to inject, and every colour is either
 * inherited or a translucent grey so the tab reads correctly in both the light
 * and the dark theme without hardcoding either palette. */
const S = {
  root: {
    display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
    overflow: 'hidden', font: 'inherit', fontSize: 13,
  },
  bar: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
    borderBottom: '1px solid rgba(128,128,128,.28)', flex: '0 0 auto',
  },
  title: { fontWeight: 600, letterSpacing: '.01em' },
  count: { opacity: .62, fontSize: 12 },
  spacer: { flex: 1 },
  btn: {
    font: 'inherit', fontSize: 12, padding: '3px 9px', cursor: 'pointer',
    border: '1px solid rgba(128,128,128,.4)', borderRadius: 5,
    background: 'transparent', color: 'inherit',
    // Fixed box on purpose: toolbar labels must never change with state, or
    // every poll re-render shifts the buttons and the bar visibly "ticks".
    // Busy is conveyed through aria-busy and the tooltip only - nothing
    // that can change a box.
    minWidth: 74, boxSizing: 'border-box', textAlign: 'center',
    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
  },
  list: {
    flex: '0 1 auto', maxHeight: '38%', overflowY: 'auto',
    borderBottom: '1px solid rgba(128,128,128,.28)',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
    cursor: 'pointer', borderBottom: '1px solid rgba(128,128,128,.12)',
  },
  rowOn: { background: 'rgba(128,128,128,.18)' },
  name: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: {
    fontSize: 11.5, opacity: .62, flex: '0 0 auto',
    // Same rule as the toolbar - an age string changing length must not move
    // anything, so the box is fixed and the numerals are tabular.
    minWidth: 104, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  badge: {
    fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em',
    border: '1px solid rgba(128,128,128,.4)', borderRadius: 4, padding: '0 4px',
    opacity: .78,
  },
  /* Segmented scope toggle. Both halves are fixed-width and only their
   * border/weight change when selected, so clicking one cannot shift the
   * toolbar -- the same rule the Refresh button follows. */
  seg: { display: 'flex', gap: 0, flex: '0 0 auto' },
  segBtn: {
    minWidth: 66, boxSizing: 'border-box', textAlign: 'center',
    whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
    font: 'inherit', fontSize: 11.5, lineHeight: '20px', padding: '0 8px',
    border: '1px solid rgba(128,128,128,.45)', background: 'transparent',
    borderRadius: 0, cursor: 'pointer', opacity: .68,
  },
  segBtnFirst: { borderRadius: '5px 0 0 5px' },
  segBtnLast: { borderRadius: '0 5px 5px 0', borderLeft: 0 },
  segBtnOn: { opacity: 1, fontWeight: 600 },
  /* A glyph marker, not a colour: currentColor keeps it theme-neutral. */
  mineDot: { flex: '0 0 auto', fontSize: 8, lineHeight: '20px', opacity: .75, paddingRight: 5 },
  preview: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column' },
  frame: { flex: 1, width: '100%', border: 0, minHeight: 0, background: 'transparent' },
  note: { padding: '14px 12px', lineHeight: 1.6, opacity: .78 },
  err: {
    padding: '10px 12px', lineHeight: 1.55, whiteSpace: 'pre-wrap',
    borderTop: '1px solid rgba(128,128,128,.28)',
  },
  code: { fontFamily: 'ui-monospace, monospace', fontSize: 12 },
}

/* The artifact directory is shared by every session, so an unfiltered list
 * mixes this chat's output with everyone else's. `scope.sessionId` comes from
 * better-sidebar; the index endpoint joins it against this session's transcript
 * and marks each item `mine`. */
const SCOPE_PREF_KEY = 'dsh-artifacts:scope'

function readScopePref() {
  try {
    const v = typeof localStorage !== 'undefined' && localStorage.getItem(SCOPE_PREF_KEY)
    return v === 'mine' || v === 'all' ? v : null
  } catch { return null }
}

function ArtifactsView({ visible, scope }) {
  const [items, setItems] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [scopePref, setScopePref] = useState(readScopePref)

  const sessionId = scope && typeof scope.sessionId === 'string' ? scope.sessionId : ''

  const load = useCallback(async () => {
    setBusy(true)
    try {
      /* Ask for attribution only when there is a session to attribute to. The
       * endpoint stays a plain list without it, so a host whose index does not
       * implement `session=` keeps working. */
      const base = listUrl()
      const url = sessionId
        ? base + (base.includes('?') ? '&' : '?') + 'session=' + encodeURIComponent(sessionId)
        : base
      const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
      const ct = res.headers.get('content-type') || ''
      if (!ct.includes('application/json')) {
        throw new Error('expected a JSON index but got ' + (ct || 'no content-type')
          + ' — the GUI session may not be authenticated against the artifact server.')
      }
      const data = await res.json()
      if (data && data.error) throw new Error(data.error)
      setItems(Array.isArray(data && data.items) ? data.items : [])
      setError(null)
    } catch (e) {
      // Never throw out of a render/poll path: one failed poll must not take
      // the sidebar down. Surface it in the pane and keep the last good list.
      setError((e && e.message) || String(e))
    } finally {
      setBusy(false)
    }
  }, [sessionId])

  /* Poll only while the tab is the active one AND the panel is open — the
   * `visible` prop exists precisely so live views pause when hidden. */
  useEffect(() => {
    if (!visible) return undefined
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [visible, load])

  /* Derive the effective selection during render instead of syncing it in an
   * effect. A file can be deleted or renamed between polls, and effect-driven
   * `setSelected(null)` would still paint one frame with an iframe pointing at a
   * path that now 404s before the re-render removed it. Deriving it means a
   * vanished selection is simply not current: no flash, no extra state, no
   * second effect. */
  const current = selected && items.some((i) => i.name === selected.name) ? selected : null

  /* Attribution is a host capability, not a guarantee. If no item carries a
   * boolean `mine`, the index does not support it and the toggle would only
   * offer an empty view -- so do not render it. */
  const scopeKnown = !!sessionId && items.some((i) => typeof i.mine === 'boolean')
  const mineCount = scopeKnown ? items.filter((i) => i.mine).length : 0
  const effective = scopePref || (mineCount > 0 ? 'mine' : 'all')
  const shown = scopeKnown && effective === 'mine' ? items.filter((i) => i.mine) : items

  const chooseScope = (next) => {
    setScopePref(next)
    try { typeof localStorage !== 'undefined' && localStorage.setItem(SCOPE_PREF_KEY, next) } catch { /* private mode */ }
  }

  const openExternal = (item) => {
    if (item) window.open(item.url, '_blank', 'noopener,noreferrer')
  }
  const copyLink = async (item) => {
    if (!item) return
    try { await navigator.clipboard.writeText(absoluteUrl(item.url)) } catch { /* clipboard may be blocked; not worth surfacing */ }
  }

  return (
    <div style={S.root}>
      <div style={S.bar}>
        <span style={S.title}>Artifacts</span>
        <span style={S.count}>
          {!items.length ? ''
            : scopeKnown && effective === 'mine'
              ? `${mineCount} of ${items.length} file${items.length === 1 ? '' : 's'}`
              : `${items.length} file${items.length === 1 ? '' : 's'}`}
        </span>
        {scopeKnown && (
          <span style={S.seg} role="group" aria-label="Which artifacts to list">
            <button type="button" aria-pressed={effective === 'mine'}
              style={{ ...S.segBtn, ...S.segBtnFirst, ...(effective === 'mine' ? S.segBtnOn : null) }}
              title="Only artifacts this chat produced"
              onClick={() => chooseScope('mine')}>This chat</button>
            <button type="button" aria-pressed={effective === 'all'}
              style={{ ...S.segBtn, ...S.segBtnLast, ...(effective === 'all' ? S.segBtnOn : null) }}
              title={`All ${items.length} artifacts on this host`}
              onClick={() => chooseScope('all')}>All</button>
          </span>
        )}
        <span style={S.spacer} />
        {current && (
          <>
            <button type="button" style={S.btn} title="Reload this preview"
              onClick={() => setReloadKey((k) => k + 1)}>Reload</button>
            <button type="button" style={S.btn} title="Copy the shareable link"
              onClick={() => copyLink(current)}>Copy link</button>
            <button type="button" style={S.btn} title="Open in a real browser tab"
              onClick={() => openExternal(current)}>Open ↗</button>
          </>
        )}
        <button type="button" style={S.btn} onClick={load} aria-busy={busy}
          title={busy ? 'Reading the artifact directory…' : 'Re-read the artifact directory'}
          // The label is constant and busy is exposed only through aria-busy
          // and the tooltip, so a poll re-render cannot change this button's
          // box. A swapping label or a disabled flip every 5 s is what made
          // the toolbar tick.
          >Refresh</button>
      </div>

      <div style={S.list}>
        {scopeKnown && effective === 'mine' && items.length > 0 && mineCount === 0 && !error && (
          <div style={S.note}>
            Nothing from this chat yet.
            <br /><br />
            Attribution is read from this session's transcript, so an artifact
            only appears here once a tool call in <em>this</em> chat has written
            it. Switch to <strong>All</strong> to see every artifact on the host.
          </div>
        )}
        {items.length === 0 && !error && (
          <div style={S.note}>
            No artifacts yet.
            <br /><br />
            This tab lists whatever the index endpoint returns. Drop a file into
            the artifact directory your endpoint serves and it appears here
            within {POLL_MS / 1000}s.
            <br /><br />
            <span style={S.code}>{listUrl()}</span>
          </div>
        )}
        {shown.map((it) => {
          const on = current && current.name === it.name
          return (
            <div key={it.name} style={{ ...S.row, ...(on ? S.rowOn : null) }}
              onClick={() => setSelected(it)}
              title={it.mine ? `${it.name} — from this chat` : it.name}>
              {/* In All mode, mark the ones this chat produced. In This-chat
                  mode every row is mine, so the marker would be noise. */}
              {scopeKnown && it.mine && effective === 'all' && (
                <span style={S.mineDot} aria-label="from this chat">●</span>
              )}
              <span style={S.badge}>{EXT_LABEL[it.ext] || it.ext}</span>
              <span style={S.name}>{it.name}</span>
              <span style={S.meta}>{fmtSize(it.size)} · {fmtAge(it.mtime)}</span>
            </div>
          )
        })}
      </div>

      <div style={S.preview}>
        {current ? (
          <iframe key={current.name + ':' + reloadKey} style={S.frame} src={current.url}
            title={current.name} referrerPolicy="no-referrer" />
        ) : (
          <div style={S.note}>
            {shown.length
              ? 'Select an artifact above to preview it here. HTML previews refresh themselves when the file is regenerated.'
              : ''}
          </div>
        )}
      </div>

      {error && (
        <div style={S.err}>
          <strong>Could not read the artifact index.</strong>
          <br /><span style={S.code}>{error}</span>
        </div>
      )}
    </div>
  )
}

const icon = (size) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none"
    stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.2 1.8h6.1L12.8 5.3v8.9H3.2z" />
    <path d="M9.3 1.8v3.5h3.5" />
    <path d="M5.4 9h5.2M5.4 11.4h3.2" strokeLinecap="round" />
  </svg>
)

/** Cordis services this half waits for. `betterSidebar` is the registry. */
export const inject = ['betterSidebar']

export function apply(ctx) {
  if (!ctx.betterSidebar || typeof ctx.betterSidebar.registerTab !== 'function') {
    // Loud but non-fatal: a missing registry must never break the sidebar or
    // the boot. dsh-better-sidebar provides it, and cordis `inject` above makes
    // this half wait for the service before applying.
    console.error('[dsh-artifacts] ctx.betterSidebar.registerTab is unavailable; tab not registered')
    return
  }
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title: 'Artifacts',
    order: 92,
    single: true,
    icon,
    /* Forward `scope` explicitly rather than spreading props: the view needs
     * the session id to ask the index which artifacts belong to this chat, and
     * a silent omission here degrades to "list everything" with no error. */
    component: (props) => <ArtifactsView visible={props.visible} scope={props.scope} />,
  }), 'dsh-artifacts: register the Artifacts sidebar tab')
}
