/**
 * dsh-artifacts v2 -- browser half.
 *
 * One sidebar tab ("Artifacts") registered through dsh-better-sidebar, plus a
 * thin wrapper on the chat's file-open path so clicking ~/reports/<x> in a chat
 * opens the RENDERED artifact here instead of its Markdown source.
 *
 * All data comes from the artifact server (dsh-artifacts/server, mounted by
 * the DSH proxy under /report/_api/). The tab is a thin client:
 *   list  -> GET  /report/_api/index?session=   (etag/304, polled while visible)
 *   info  -> GET  /report/_api/info?name=        (versions, sessions, public)
 *   view  -> iframe /report/<name>?dsh_session=  (bridge injected server-side)
 *   source/changes -> /report/_api/raw, /report/_api/diff
 *   actions -> restore, public, trash, send (into this chat), inbox
 *   2.2: media and files preview in the server's enclosure page (<url>?view=1), thumbnails (<url>?thumb=1),
 *        downloads (<url>?download=1, Markdown: .md and .html), de-list / list again (/report/_api/listing),
 *        a "Hidden" filter (index?hidden=1). Against an older server these degrade: no thumb (kind icon),
 *        no view field (the old inline players), no hide button.
 *
 * The iframe talks back over postMessage (same origin only): dsh:error,
 * dsh:picked (pick-and-ask), dsh:compose (fill the composer), dsh:sent.
 *
 * Purity: no @deepseek-ai value imports; react stays external.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

const TAB_ID = 'dsh-artifacts:library'
const API = '/report/_api/'
const POLL_MS = 4000
const ACCENT = 'var(--accent, #d8694c)'
const LS_SCOPE = 'dsh-artifacts:scope'
const LS_KIND = 'dsh-artifacts:kind'

/* ---------- cross-component selection bus (path-open intercept -> view) ---------- */
const pending = new Map()           // sessionId -> artifact name to select
const listeners = new Set()
function requestSelect(sessionId, name) {
  pending.set(sessionId || '*', name)
  listeners.forEach((fn) => { try { fn() } catch (e) { /* ignore */ } })
}

/* ---------- helpers ---------- */
function lsGet(k, d) { try { return localStorage.getItem(k) || d } catch (e) { return d } }
function lsSet(k, v) { try { localStorage.setItem(k, v) } catch (e) { /* private mode */ } }
function abs(u) { return /^https?:/i.test(u) ? u : location.origin + u }
function withSession(u, sid) { return sid ? u + (u.indexOf('?') >= 0 ? '&' : '?') + 'dsh_session=' + encodeURIComponent(sid) : u }

async function api(route, body) {
  const opts = { credentials: 'same-origin', cache: 'no-store', headers: {} }
  if (body) {
    opts.method = 'POST'
    opts.headers['content-type'] = 'application/json'
    opts.headers['X-Artifact-Api'] = '1'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(API + route, opts)
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return res.text()
  }
  const j = await res.json()
  if (!res.ok || j.error) throw new Error(j.error || ('HTTP ' + res.status))
  return j
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1048576).toFixed(1) + ' MB'
}
function fmtAge(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts))
  if (s < 45) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + 'm ago'
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'
  if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago'
  return new Date(ts * 1000).toLocaleDateString()
}
function dayBucket(ts) {
  const d = new Date(ts * 1000), now = new Date()
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000
  if (ts >= start) return 'Today'
  if (ts >= start - 86400) return 'Yesterday'
  if (ts >= start - 86400 * 6) return 'This week'
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

const KIND_LABEL = { doc: 'Doc', page: 'Page', app: 'App', image: 'Image', audio: 'Audio', video: 'Video', data: 'Data', pdf: 'PDF', code: 'Code', file: 'File' }
const KIND_FILTERS = [
  ['all', 'All kinds'], ['doc', 'Docs'], ['page', 'Pages'], ['app', 'Apps'],
  ['media', 'Media'], ['pdf', 'PDFs'], ['data', 'Data'], ['code', 'Code'], ['file', 'Files'], ['hidden', 'Hidden'],
]
const MEDIA = { image: 1, audio: 1, video: 1 }
const BINARY = { image: 1, audio: 1, video: 1, pdf: 1, file: 1 }   // no Source / Changes view

/* ---------- styles (inline, theme-neutral) ---------- */
const line = '1px solid rgba(128,128,128,.25)'
const S = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'hidden', font: 'inherit', fontSize: 13 },
  bar: { display: 'flex', alignItems: 'center', gap: 6, padding: '7px 8px', borderBottom: line, flex: '0 0 auto', minWidth: 0 },
  title: { fontWeight: 600, whiteSpace: 'nowrap' },
  muted: { opacity: 0.62 },
  spacer: { flex: 1 },
  input: { flex: 1, minWidth: 60, font: 'inherit', fontSize: 12.5, padding: '4px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit' },
  select: { font: 'inherit', fontSize: 12, padding: '3px 4px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', maxWidth: 104 },
  btn: { font: 'inherit', fontSize: 12, padding: '3px 8px', cursor: 'pointer', border: '1px solid rgba(128,128,128,.4)', borderRadius: 6, background: 'transparent', color: 'inherit', whiteSpace: 'nowrap', lineHeight: '18px' },
  ibtn: { font: 'inherit', fontSize: 13, width: 26, height: 24, padding: 0, cursor: 'pointer', border: '1px solid transparent', borderRadius: 6, background: 'transparent', color: 'inherit', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' },
  ibtnOn: { border: '1px solid ' + ACCENT, color: ACCENT },
  primary: { background: ACCENT, color: '#fff', border: '1px solid ' + ACCENT },
  seg: { display: 'inline-flex', flex: '0 0 auto' },
  segBtn: { font: 'inherit', fontSize: 11.5, lineHeight: '20px', padding: '0 8px', border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit', cursor: 'pointer', opacity: 0.65, whiteSpace: 'nowrap' },
  segOn: { opacity: 1, fontWeight: 600, boxShadow: 'inset 0 -2px 0 ' + ACCENT },
  list: { flex: '1 1 auto', overflowY: 'auto', minHeight: 0 },
  group: { padding: '10px 10px 4px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.55 },
  row: { display: 'flex', alignItems: 'center', gap: 9, padding: '7px 10px', cursor: 'pointer', borderBottom: '1px solid rgba(128,128,128,.10)' },
  rowOn: { background: 'rgba(128,128,128,.16)' },
  icon: { flex: '0 0 auto', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.5, fontWeight: 700, letterSpacing: '.03em', border: '1px solid rgba(128,128,128,.35)', textTransform: 'uppercase', opacity: 0.85 },
  rowMain: { flex: 1, minWidth: 0 },
  rowTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 500 },
  rowSub: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11.5, opacity: 0.6, fontVariantNumeric: 'tabular-nums' },
  dot: { color: ACCENT, fontSize: 9 },
  note: { padding: '16px 12px', lineHeight: 1.6, opacity: 0.8 },
  banner: { margin: '8px', padding: '8px 10px', borderRadius: 8, border: '1px solid ' + ACCENT, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5 },
  err: { padding: '8px 10px', borderTop: line, background: 'rgba(200,60,40,.10)', display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 },
  detailHead: { display: 'flex', alignItems: 'center', gap: 4, padding: '6px 6px', borderBottom: line, flex: '0 0 auto', minWidth: 0 },
  detailTitle: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600, padding: '0 4px' },
  tools: { display: 'flex', alignItems: 'center', gap: 4, padding: '5px 6px', borderBottom: line, flex: '0 0 auto', flexWrap: 'wrap' },
  body: { flex: '1 1 auto', minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' },
  frame: { flex: 1, width: '100%', border: 0, minHeight: 0, background: '#fff' },
  pre: { margin: 0, flex: 1, overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.55, padding: '8px 0', whiteSpace: 'pre', tabSize: 2 },
  ln: { display: 'inline-block', width: 40, textAlign: 'right', paddingRight: 10, opacity: 0.4, userSelect: 'none' },
  media: { flex: 1, overflow: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 12, minHeight: 0 },
  ask: { borderTop: line, padding: 8, display: 'grid', gap: 6, flex: '0 0 auto' },
  chip: { fontFamily: 'ui-monospace, monospace', fontSize: 11.5, padding: '2px 6px', borderRadius: 5, background: 'rgba(128,128,128,.16)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  textarea: { font: 'inherit', fontSize: 13, padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(128,128,128,.4)', background: 'transparent', color: 'inherit', resize: 'vertical', minHeight: 54 },
  toast: { position: 'absolute', right: 10, bottom: 10, zIndex: 5, background: 'rgba(30,26,24,.92)', color: '#f4efe9', padding: '6px 10px', borderRadius: 7, fontSize: 12.5, pointerEvents: 'none' },
}

/* ---------- icons ---------- */
function Svg(props) {
  return (
    <svg width={props.size || 14} height={props.size || 14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{props.children}</svg>
  )
}
const I = {
  back: <Svg><path d="M10 3L5 8l5 5" /></Svg>,
  reload: <Svg><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" /></Svg>,
  ext: <Svg><path d="M9 3h4v4M13 3L7.5 8.5M12 9.5V13H3V4h3.5" /></Svg>,
  link: <Svg><path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" /></Svg>,
  globe: <Svg><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z" /></Svg>,
  trash: <Svg><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5" /></Svg>,
  pick: <Svg><circle cx="8" cy="8" r="4.5" /><path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" /></Svg>,
  left: <Svg><path d="M9.5 4L5.5 8l4 4" /></Svg>,
  right: <Svg><path d="M6.5 4l4 4-4 4" /></Svg>,
  refresh: <Svg><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" /></Svg>,
  download: <Svg><path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10" /></Svg>,
  hide: <Svg><path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /><path d="M2.5 13.5l11-11" /></Svg>,
  show: <Svg><path d="M2 8s2.3-4 6-4 6 4 6 4-2.3 4-6 4-6-4-6-4z" /><circle cx="8" cy="8" r="1.8" /></Svg>,
}

function KindIcon({ item, thumbs }) {
  const [bad, setBad] = useState(false)
  const k = item.kind
  if (thumbs && item.thumb && !bad) {
    return <img src={item.thumb} alt="" loading="lazy" decoding="async" onError={() => setBad(true)}
      style={{ ...S.icon, objectFit: 'cover', padding: 0, background: 'rgba(128,128,128,.12)', width: 38 }} />
  }
  const label = k === 'doc' ? 'MD' : k === 'page' ? 'HTML' : k === 'app' ? 'APP' : (item.ext || k).slice(0, 4)
  const tint = k === 'app' ? { borderColor: ACCENT, color: ACCENT } : MEDIA[k] ? { borderStyle: 'dashed' } : null
  return <span style={{ ...S.icon, ...tint }}>{label}</span>
}

/** The main download of an item: Markdown docs download their .md source, everything else its own bytes. */
function mainDownload(item) {
  if (item.downloads && item.downloads.length) return item.downloads[0]
  return item.download ? { label: 'file', url: item.download } : null
}
/**
 * Start a download without the anchor `download` attribute: Chrome sends <a download> straight to the network,
 * past the service worker, so on a dsh-seal sealed GUI it would travel in plain. A hidden iframe navigation is
 * answered by the worker (sealed); the server's Content-Disposition: attachment turns it into a download.
 */
function startDownload(url) {
  try {
    const f = document.createElement('iframe')
    f.style.display = 'none'
    f.setAttribute('aria-hidden', 'true')
    f.src = url
    document.body.appendChild(f)
    setTimeout(() => { try { f.remove() } catch (e) { /* gone */ } }, 120000)
  } catch (e) { window.open(url, '_blank', 'noopener') }
}
function onDownloadClick(e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  e.preventDefault()
  e.stopPropagation()
  startDownload(e.currentTarget.getAttribute('href'))
}

function fileNameOf(item, url) {
  const m = /\/([^/?]+)\?download=1$/.exec(url || '')
  try { return decodeURIComponent(m ? m[1] : (item.name.split('/').pop() || 'download')) } catch (e) { return item.name }
}

/* ---------- composer access (best effort; falls back to sending) ---------- */
function setComposerDraft(ctx, sessionId, text) {
  try {
    const actx = ctx.sessions && ctx.sessions.scope ? ctx.sessions.scope(sessionId) : null
    const conv = ctx.get ? ctx.get('conversation') : null
    if (!actx || !conv || !conv.input) return false
    const input = conv.input.for(actx)
    let cur = ''
    try { cur = (input.state.getSnapshot() || {}).draft || '' } catch (e) { /* ignore */ }
    input.setDraft(cur ? cur + '\n\n' + text : text)
    return true
  } catch (e) {
    return false
  }
}

/* ======================================================================== */

function ArtifactsView({ visible, scope, ctx }) {
  const sessionId = scope && typeof scope.sessionId === 'string' ? scope.sessionId : ''
  const [items, setItems] = useState([])
  const [meta, setMeta] = useState({})
  const [error, setError] = useState(null)
  const [scopePref, setScopePref] = useState(() => lsGet(LS_SCOPE, ''))
  const [kind, setKind] = useState(() => lsGet(LS_KIND, 'all'))
  const [query, setQuery] = useState('')
  const [selName, setSelName] = useState(null)
  const [inbox, setInbox] = useState([])
  const [toast, setToast] = useState(null)
  const etagRef = useRef(null)

  const flash = useCallback((t) => {
    setToast(t)
    clearTimeout(flash._t)
    flash._t = setTimeout(() => setToast(null), 2400)
  }, [])

  const load = useCallback(async (force) => {
    try {
      const headers = {}
      if (etagRef.current && !force) headers['If-None-Match'] = etagRef.current
      const qs = [sessionId ? 'session=' + encodeURIComponent(sessionId) : '', kind === 'hidden' ? 'hidden=1' : ''].filter(Boolean).join('&')
      const res = await fetch(API + 'index' + (qs ? '?' + qs : ''),
        { credentials: 'same-origin', cache: 'no-store', headers })
      if (res.status === 304) { setError(null); return }
      const ct = res.headers.get('content-type') || ''
      if (!res.ok || !ct.includes('json')) {
        throw new Error(res.ok ? 'expected JSON from the artifact server (is the GUI authenticated?)' : 'HTTP ' + res.status)
      }
      const data = await res.json()
      etagRef.current = res.headers.get('ETag')
      setItems(Array.isArray(data.items) ? data.items : [])
      setMeta({ attributed: data.attributed, indexer: data.indexer, hidden: data.hidden })
      setError(null)
    } catch (e) {
      setError((e && e.message) || String(e))
    }
    if (sessionId) {
      try { const ib = await api('inbox?session=' + encodeURIComponent(sessionId)); setInbox(ib.items || []) } catch (e) { /* optional */ }
    }
  }, [sessionId, kind])

  useEffect(() => { etagRef.current = null }, [kind])

  useEffect(() => {
    if (!visible) return undefined
    load(true)
    const t = setInterval(() => load(false), POLL_MS)
    return () => clearInterval(t)
  }, [visible, load])

  /* selections requested by the chat path-open intercept */
  useEffect(() => {
    const fn = () => {
      const want = pending.get(sessionId) || pending.get('*')
      if (want) { pending.delete(sessionId); pending.delete('*'); setSelName(want); load(true) }
    }
    listeners.add(fn)
    fn()
    return () => { listeners.delete(fn) }
  }, [sessionId, load])

  const mineCount = items.filter((i) => i.mine && !i.hidden).length
  const scopeKnown = !!sessionId && items.some((i) => typeof i.mine === 'boolean')
  const effScope = scopeKnown ? (scopePref || (mineCount ? 'mine' : 'all')) : 'all'

  const shown = useMemo(() => {
    const ql = query.trim().toLowerCase()
    return items.filter((i) => {
      if (effScope === 'mine' && !i.mine) return false
      if (kind === 'hidden') { if (!i.hidden) return false }
      else if (kind !== 'all') {
        if (kind === 'media' ? !MEDIA[i.kind] : i.kind !== kind) return false
      }
      if (ql && (i.name + ' ' + (i.title || '')).toLowerCase().indexOf(ql) < 0) return false
      return true
    })
  }, [items, effScope, kind, query])

  const selected = selName ? items.find((i) => i.name === selName || (i.files || []).indexOf(selName) >= 0) : null

  const sendToChat = useCallback(async (text, name) => {
    if (!sessionId) { flash('No chat to send to'); return false }
    try {
      await api('send', { session: sessionId, text, name: name || 'artifacts-sidebar' })
      flash('Sent to chat')
      return true
    } catch (e) { flash('Not sent: ' + e.message); return false }
  }, [sessionId, flash])

  if (selected) {
    return (
      <div style={S.root}>
        <Detail key={selected.name} item={selected} sessionId={sessionId} ctx={ctx}
          onBack={() => setSelName(null)} onChanged={() => load(true)} sendToChat={sendToChat} flash={flash} />
        {toast && <div style={S.toast}>{toast}</div>}
      </div>
    )
  }

  let lastGroup = null
  return (
    <div style={{ ...S.root, position: 'relative' }}>
      <div style={S.bar}>
        <span style={S.title}>Artifacts</span>
        {scopeKnown && (
          <span style={S.seg} role="group" aria-label="Which artifacts to list">
            <button type="button" aria-pressed={effScope === 'mine'} title="Artifacts this chat (and its subagents) produced"
              style={{ ...S.segBtn, borderRadius: '6px 0 0 6px', ...(effScope === 'mine' ? S.segOn : null) }}
              onClick={() => { setScopePref('mine'); lsSet(LS_SCOPE, 'mine') }}>This chat {mineCount ? '(' + mineCount + ')' : ''}</button>
            <button type="button" aria-pressed={effScope === 'all'} title="Every artifact on this host"
              style={{ ...S.segBtn, borderRadius: '0 6px 6px 0', borderLeft: 0, ...(effScope === 'all' ? S.segOn : null) }}
              onClick={() => { setScopePref('all'); lsSet(LS_SCOPE, 'all') }}>All</button>
          </span>
        )}
        <span style={S.spacer} />
        <button type="button" style={S.ibtn} title="Refresh" onClick={() => load(true)}>{I.refresh}</button>
      </div>
      <div style={{ ...S.bar, paddingTop: 5, paddingBottom: 5 }}>
        <input style={S.input} placeholder="Search artifacts" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select style={S.select} value={kind} onChange={(e) => { setKind(e.target.value); lsSet(LS_KIND, e.target.value) }} aria-label="Kind">
          {KIND_FILTERS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {inbox.length > 0 && (
        <div style={S.banner}>
          <span style={{ flex: 1, minWidth: 140 }}>
            <b>{inbox.length}</b> update{inbox.length === 1 ? '' : 's'} from artifacts waiting for the agent
            {inbox.some((x) => x.kind === 'error') ? ' (includes errors)' : ''}.
          </span>
          <button type="button" style={{ ...S.btn, ...S.primary }}
            onClick={async () => { if (await sendToChat('I left updates in the artifacts. Run artifact inbox to read them, then act on them.')) { /* keep until the agent clears */ } }}>Tell the agent</button>
          <button type="button" style={S.btn} onClick={async () => { await api('inbox', { session: sessionId, clear: true }); setInbox([]) }}>Dismiss</button>
        </div>
      )}

      <div style={S.list}>
        {error && <div style={{ ...S.err, borderTop: 0 }}><span><b>Could not read the artifact index.</b><br />{error}</span></div>}
        {!error && items.length === 0 && (
          <div style={S.note}>No artifacts yet. Agents publish them into ~/reports/ (see the publish-artifact skill) and they appear here within seconds.</div>
        )}
        {!error && items.length > 0 && shown.length === 0 && (
          <div style={S.note}>
            {kind === 'hidden' && !query ? 'Nothing is de-listed.' : effScope === 'mine' && !query && kind === 'all'
              ? <>Nothing from this chat yet{meta.indexer && !meta.indexer.alive ? ' (the attribution indexer is not running)' : ''}. Switch to <b>All</b> to see every artifact on the host.</>
              : 'No artifact matches.'}
          </div>
        )}
        {shown.slice(0, 400).map((it) => {
          const g = dayBucket(it.mtime)
          const head = g !== lastGroup ? <div style={S.group}>{g}</div> : null
          lastGroup = g
          return (
            <div key={it.name}>
              {head}
              <div style={S.row} onClick={() => setSelName(it.name)} title={it.name}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,.10)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '' }}>
                <KindIcon item={it} thumbs />
                <div style={S.rowMain}>
                  <div style={S.rowTitle}>{it.title || it.name}</div>
                  <div style={S.rowSub}>
                    {effScope === 'all' && it.mine && <span style={S.dot} title="from this chat">{'\u25cf '}</span>}
                    {it.public && <span title="public link enabled">{'\u{1F310} '}</span>}
                    {it.hidden && <span title="de-listed: hidden from the list">{'(hidden) '}</span>}
                    {it.title ? it.name + ' \u00b7 ' : ''}{fmtAge(it.mtime)} {'\u00b7'} {fmtSize(it.size)}
                  </div>
                </div>
                {mainDownload(it) && (
                  <a style={{ ...S.ibtn, textDecoration: 'none' }} href={mainDownload(it).url} data-dl="1"
                    title={'Download ' + fileNameOf(it, mainDownload(it).url)} aria-label={'Download ' + it.name}
                    onClick={onDownloadClick}>{I.download}</a>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {toast && <div style={S.toast}>{toast}</div>}
    </div>
  )
}

/* ======================================================================== */

function Detail({ item, sessionId, ctx, onBack, onChanged, sendToChat, flash }) {
  const [mode, setMode] = useState('preview')   // preview | source | changes
  const [info, setInfo] = useState(null)
  const [vIdx, setVIdx] = useState(-1)           // -1 = current
  const [text, setText] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [errs, setErrs] = useState([])
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState(null)
  const [question, setQuestion] = useState('')
  const frameRef = useRef(null)
  const isMedia = !!MEDIA[item.kind]
  const enclosure = !!item.view                       // 2.2 server: media and files open in the enclosure page
  const textModes = !BINARY[item.kind]                 // Source / Changes make sense for text only
  const previewable = !isMedia                         // pick-and-ask and the Preview/Source/Changes switch
  const pickable = !enclosure && !isMedia

  const loadInfo = useCallback(async () => {
    try { setInfo(await api('info?name=' + encodeURIComponent(item.name))) } catch (e) { setInfo({ error: e.message, versions: [] }) }
  }, [item.name])
  useEffect(() => { loadInfo() }, [loadInfo, item.mtime])

  const versions = (info && info.versions) || []
  const vSel = vIdx >= 0 && vIdx < versions.length ? versions[vIdx] : null
  const vLabel = versions.length ? (vSel ? 'v' + (vIdx + 1) : 'v' + versions.length) + '/' + versions.length : ''

  /* source / changes text */
  useEffect(() => {
    let dead = false
    setText(null)
    if (mode === 'source') {
      api('raw?name=' + encodeURIComponent(item.name) + (vSel ? '&v=' + vSel.id : ''))
        .then((t) => { if (!dead) setText(typeof t === 'string' ? t : JSON.stringify(t, null, 2)) })
        .catch((e) => { if (!dead) setText('Could not load the source: ' + e.message) })
    } else if (mode === 'changes') {
      api('diff?name=' + encodeURIComponent(item.name) + (vSel ? '&b=' + vSel.id : ''))
        .then((d) => { if (!dead) setText(d.diff || d.note || 'No changes recorded yet.') })
        .catch((e) => { if (!dead) setText('Could not load changes: ' + e.message) })
    }
    return () => { dead = true }
  }, [mode, vSel && vSel.id, item.name, item.mtime])

  /* messages from the artifact iframe */
  useEffect(() => {
    const onMsg = (e) => {
      if (e.origin !== location.origin) return
      const fr = frameRef.current
      if (!fr || e.source !== fr.contentWindow) return
      const d = e.data || {}
      if (d.source !== 'dsh-artifact') return
      if (d.type === 'dsh:error') setErrs((x) => x.length > 4 ? x : x.concat([{ message: d.message, stack: d.stack, where: d.where }]))
      else if (d.type === 'dsh:picked') { setPicking(false); if (!d.cancelled) setPicked(d) }
      else if (d.type === 'dsh:compose') { if (setComposerDraft(ctx, sessionId, d.text)) flash('Added to the composer'); else sendToChat(d.text, item.name) }
      else if (d.type === 'dsh:sent') flash('Sent to chat')
      else if (d.type === 'dsh:ready') { setPicking(false); try { fr.contentWindow.postMessage({ type: 'dsh:session', session: sessionId }, location.origin) } catch (x) { /* ignore */ } }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [ctx, sessionId, item.name, flash, sendToChat])

  const togglePick = () => {
    const fr = frameRef.current
    if (!fr || mode !== 'preview') { setMode('preview'); return }
    const on = !picking
    setPicking(on)
    try { fr.contentWindow.postMessage({ type: 'dsh:pick', on }, location.origin) } catch (e) { setPicking(false) }
  }

  const ref = picked
    ? '[artifact ' + item.name + ' \u00b7 element ' + picked.selector + (picked.heading ? ' under "' + picked.heading + '"' : '') + (picked.text ? ' \u00b7 text: "' + picked.text.slice(0, 200) + '"' : '') + ']'
    : ''
  const ask = async (toComposer) => {
    const msg = ref + '\n' + (question.trim() || 'Look at this element.')
    if (toComposer && setComposerDraft(ctx, sessionId, msg)) { flash('Added to the composer'); setPicked(null); setQuestion(''); return }
    if (await sendToChat(msg, item.name)) { setPicked(null); setQuestion('') }
  }

  const fixErrors = async () => {
    const body = errs.map((x) => '- ' + x.message + (x.where ? ' (' + x.where + ')' : '') + (x.stack ? '\n  ' + String(x.stack).split('\n').slice(0, 3).join('\n  ') : '')).join('\n')
    if (await sendToChat('The artifact ' + item.name + ' throws in the browser:\n' + body + '\nPlease fix it with a targeted edit.', item.name)) setErrs([])
  }

  const restore = async () => {
    if (!vSel) return
    if (!window.confirm('Restore ' + item.name + ' to ' + vLabel + '? The current content stays in the history.')) return
    try { await api('restore', { name: item.name, v: vSel.id }); flash('Restored'); setVIdx(-1); onChanged(); loadInfo(); setReloadKey((k) => k + 1) } catch (e) { flash(e.message) }
  }
  const togglePublic = async () => {
    const on = !(info && info.public)
    if (on && !window.confirm('Make ' + item.name + ' readable by anyone with the link (no login)? Never do this for anything containing secrets or private data.')) return
    try {
      const r = await api('public', { name: item.name, on })
      await loadInfo(); onChanged()
      if (on) { try { await navigator.clipboard.writeText(abs(r.url)) } catch (e) { /* ignore */ } flash('Public link copied') } else flash('Link is private again')
    } catch (e) { flash(e.message) }
  }
  const toggleListed = async () => {
    const hide = !item.hidden
    if (hide && !window.confirm('Remove ' + item.name + ' from the list? The file, its versions and its link stay; the Hidden filter lists it again.')) return
    try { await api('listing', { name: item.name, op: hide ? 'hide' : 'show', session: sessionId || undefined }); flash(hide ? 'Removed from the list' : 'Listed again'); onChanged(); if (hide) onBack() } catch (e) { flash(e.message) }
  }
  const trash = async () => {
    if (!window.confirm('Move ' + item.name + ' to the artifact trash (~/reports/.artifacts/trash)?')) return
    try { await api('trash', { name: item.name }); flash('Moved to trash'); onChanged(); onBack() } catch (e) { flash(e.message) }
  }
  const copyLink = async () => { try { await navigator.clipboard.writeText(abs(item.url)); flash('Link copied') } catch (e) { flash('Clipboard blocked') } }

  const src = withSession(enclosure ? item.view : item.url, sessionId)
  const dls = item.downloads && item.downloads.length ? item.downloads : (item.download ? [{ label: 'Download', url: item.download }] : [])
  const lines = typeof text === 'string' ? text.split('\n') : []

  return (
    <>
      <div style={S.detailHead}>
        <button type="button" style={S.ibtn} title="Back to the list" onClick={onBack}>{I.back}</button>
        <KindIcon item={item} />
        <span style={S.detailTitle} title={item.name}>{item.title || item.name}</span>
        {info && info.source && info.home && !BINARY[item.kind] && (
          <button type="button" style={S.btn} title="Open the source file in the sidebar editor"
            onClick={() => { if (!openSourceInEditor(ctx, info.home + '/' + info.source, sessionId ? { sessionId } : undefined)) flash('Editor unavailable') }}>Edit</button>
        )}
        {dls.map((d) => (
          <a key={d.url} style={{ ...S.btn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }} href={d.url}
            data-dl="1" onClick={onDownloadClick} title={'Download ' + fileNameOf(item, d.url)}>{I.download}{dls.length > 1 ? d.label.replace(' source', '').replace(' page', '') : ''}</a>
        ))}
        <button type="button" style={S.ibtn} title="Copy link" onClick={copyLink}>{I.link}</button>
        <button type="button" style={S.ibtn} title="Open in a browser tab" onClick={() => window.open(item.url, '_blank', 'noopener')}>{I.ext}</button>
      </div>
      <div style={S.tools}>
        {previewable && textModes && (
          <span style={S.seg} role="group">
            {[['preview', 'Preview'], ['source', 'Source'], ['changes', 'Changes']].map(([m, l], i, a) => (
              <button key={m} type="button" style={{ ...S.segBtn, borderRadius: i === 0 ? '6px 0 0 6px' : i === a.length - 1 ? '0 6px 6px 0' : 0, borderLeft: i ? 0 : undefined, ...(mode === m ? S.segOn : null) }}
                onClick={() => setMode(m)}>{l}</button>
            ))}
          </span>
        )}
        {versions.length > 1 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }} title="Automatic snapshots: every change is kept">
            <button type="button" style={S.ibtn} disabled={(vIdx < 0 ? versions.length - 1 : vIdx) <= 0}
              onClick={() => { const cur = vIdx < 0 ? versions.length - 1 : vIdx; setVIdx(cur - 1); if (mode === 'preview' && textModes) setMode('changes') }}>{I.left}</button>
            <span style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12, minWidth: 34, textAlign: 'center' }}>{vLabel}</span>
            <button type="button" style={S.ibtn} disabled={vIdx < 0}
              onClick={() => setVIdx(vIdx + 1 >= versions.length - 1 ? -1 : vIdx + 1)}>{I.right}</button>
          </span>
        )}
        {vSel && <button type="button" style={{ ...S.btn, ...S.primary }} onClick={restore}>Restore</button>}
        <span style={S.spacer} />
        {pickable && <button type="button" style={{ ...S.ibtn, ...(picking ? S.ibtnOn : null) }} title="Pick an element and ask the agent about it" onClick={togglePick}>{I.pick}</button>}
        <button type="button" style={S.ibtn} title="Reload" onClick={() => setReloadKey((k) => k + 1)}>{I.reload}</button>
        <button type="button" style={{ ...S.ibtn, ...(info && info.public ? S.ibtnOn : null) }} title={info && info.public ? 'Public link ON (click to make private)' : 'Make a public no-login link'} onClick={togglePublic}>{I.globe}</button>
        {info && typeof info.hidden === 'boolean' && (
          <button type="button" style={S.ibtn} title={item.hidden ? 'List it again' : 'Remove from the list (the file stays)'} onClick={toggleListed}>{item.hidden ? I.show : I.hide}</button>
        )}
        <button type="button" style={S.ibtn} title="Move to trash" onClick={trash}>{I.trash}</button>
      </div>

      <div style={S.body}>
        {item.description && mode === 'preview' && !enclosure && (
          <div style={{ padding: '6px 10px', fontSize: 12.5, opacity: 0.75, borderBottom: line }}>{item.description}</div>
        )}
        {mode === 'preview' && (!isMedia || enclosure) && (
          <iframe ref={frameRef} key={item.name + ':' + reloadKey} style={S.frame} src={src} title={item.name}
            referrerPolicy="no-referrer" allow="clipboard-write; autoplay; microphone; fullscreen" />
        )}
        {mode === 'preview' && isMedia && !enclosure && (
          <div style={S.media}>
            {item.kind === 'image' && <img src={item.url} alt={item.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />}
            {item.kind === 'audio' && <audio controls src={item.url} style={{ width: '100%' }} />}
            {item.kind === 'video' && <video controls playsInline src={item.url} style={{ maxWidth: '100%', maxHeight: '100%' }} />}
          </div>
        )}
        {mode !== 'preview' && (
          <pre style={S.pre}>
            {text === null ? <span style={{ padding: 10, opacity: 0.6 }}>Loading...</span> : lines.map((l, i) => {
              let st = null
              if (mode === 'changes') {
                if (l.startsWith('+') && !l.startsWith('+++')) st = { background: 'rgba(60,160,80,.16)' }
                else if (l.startsWith('-') && !l.startsWith('---')) st = { background: 'rgba(210,70,50,.16)' }
                else if (l.startsWith('@@')) st = { opacity: 0.55 }
              }
              return <div key={i} style={st}>{mode === 'source' && <span style={S.ln}>{i + 1}</span>}{l || ' '}</div>
            })}
          </pre>
        )}
      </div>

      {errs.length > 0 && (
        <div style={S.err}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}><b>{errs.length} error{errs.length === 1 ? '' : 's'}:</b> {errs[0].message}</span>
          <button type="button" style={{ ...S.btn, ...S.primary }} onClick={fixErrors}>Fix with agent</button>
          <button type="button" style={S.btn} onClick={() => setErrs([])}>Dismiss</button>
        </div>
      )}

      {picked && (
        <div style={S.ask}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
            <span style={S.chip} title={picked.selector}>{picked.tag} {picked.selector}</span>
            <span style={{ ...S.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{picked.text}</span>
          </div>
          <textarea style={S.textarea} autoFocus placeholder="Ask or instruct about this element, e.g. make this chart a line chart"
            value={question} onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(false) }} />
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" style={S.btn} onClick={() => { setPicked(null); setQuestion('') }}>Cancel</button>
            <button type="button" style={S.btn} onClick={() => ask(true)} title="Put the reference into the chat composer">To composer</button>
            <button type="button" style={{ ...S.btn, ...S.primary }} onClick={() => ask(false)}>Ask agent</button>
          </div>
        </div>
      )}
    </>
  )
}

/* ======================================================================== */

const tabIcon = (size) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.2 1.8h6.1L12.8 5.3v8.9H3.2z" />
    <path d="M9.3 1.8v3.5h3.5" />
    <path d="M5.4 9h5.2M5.4 11.4h3.2" strokeLinecap="round" />
  </svg>
)

/* Chat file links under ~/reports/ open the rendered artifact in this tab. */
const REPORTS_RX = /^(?:\/?home\/[^/]+\/|\/root\/|~\/)reports\/([^?#]+)$/
function artifactNameFor(path) {
  const m = REPORTS_RX.exec(String(path || ''))
  if (!m) return null
  const rel = m[1].replace(/\/+$/, '')
  if (!rel || rel.split('/').some((p) => !p || p.charAt(0) === '.')) return null
  if (/\.md$/i.test(rel)) return rel.replace(/\.md$/i, '.html')
  return rel
}

/**
 * Every chat-side file open (tool-row links, produced-files chips, prose paths,
 * the openWorkspacePath shadow, agent opens) ends in
 * betterSidebar.openTab({ type: 'editor', path }). Wrapping that one call is
 * what turns "click ~/reports/x.md" into "show the rendered x.html in the
 * Artifacts tab". Seeds carrying meta.raw (our own "Edit source" button) and
 * folder reveals pass through untouched.
 */
function installOpenTabRedirect(ctx) {
  const bs = ctx.betterSidebar
  if (!bs || typeof bs.openTab !== 'function') return () => {}
  const original = bs.openTab
  const wrapped = function (seed, scope) {
    try {
      if (seed && seed.type === 'editor' && typeof seed.path === 'string' && !(seed.meta && (seed.meta.raw || seed.meta.dir))) {
        const name = artifactNameFor(seed.path)
        if (name && (!bs.isTabEnabled || bs.isTabEnabled(TAB_ID))) {
          let sid = scope && scope.sessionId
          if (!sid) { try { sid = ctx.sessions.list.getSnapshot().current } catch (e) { sid = undefined } }
          requestSelect(sid, name)
          return original.call(this, { type: TAB_ID }, scope)
        }
      }
    } catch (e) {
      console.warn('[dsh-artifacts] open redirect failed; falling back', e)
    }
    return original.call(this, seed, scope)
  }
  bs.openTab = wrapped
  return () => { if (bs.openTab === wrapped) bs.openTab = original }
}

/**
 * Chats whose layout does not let better-sidebar take file opens over still
 * call remote.session.openWorkspacePath, which falls through to DSH's built-in
 * document preview (raw Markdown). Shadow it too, ahead of better-sidebar's own
 * shadow, and send report paths to the Artifacts tab.
 */
function installOpenPathRedirect(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['remote.session'], (fctx) => {
    fctx.effect(() => {
      let service = null
      try { service = fctx.get('remote.session') } catch (e) { service = null }
      if (!service || typeof service.openWorkspacePath !== 'function') return () => {}
      const desc = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath')
      const original = service.openWorkspacePath
      const wrapped = function (request, signal) {
        try {
          const name = artifactNameFor(request && request.path)
          const bs = ctx.betterSidebar
          if (name && bs && typeof bs.openTab === 'function' && (!bs.isTabEnabled || bs.isTabEnabled(TAB_ID))) {
            let sid
            try { sid = ctx.sessions.list.getSnapshot().current } catch (e) { sid = undefined }
            requestSelect(sid, name)
            bs.openTab({ type: TAB_ID }, sid ? { sessionId: sid } : undefined)
            return Promise.resolve({ ok: true, value: { opened: true } })
          }
        } catch (e) {
          console.warn('[dsh-artifacts] open-path redirect failed; falling back', e)
        }
        return original.call(service, request, signal)
      }
      Object.defineProperty(service, 'openWorkspacePath', { configurable: true, enumerable: true, writable: true, value: wrapped })
      return () => {
        if (service.openWorkspacePath !== wrapped) return
        if (desc) Object.defineProperty(service, 'openWorkspacePath', desc)
        else delete service.openWorkspacePath
      }
    }, 'dsh-artifacts: open ~/reports paths as rendered artifacts')
  })
}

/**
 * DSH's own right sidebar: tool-row file links call
 * ctx.sidebarRight.openResource('dsh-resource://file/session/<sid>/<path>')
 * (or file/absolute/<path>), which renders raw Markdown in the built-in text
 * preview. Report paths go to the Artifacts tab instead.
 */
function reportNameFromAddress(ctx, address) {
  const m = /^dsh-resource:\/\/file\/(?:session\/([^/]+)\/|absolute\/)(.+)$/.exec(String(address || ''))
  if (!m) return null
  let path = m[2]
  try { path = decodeURIComponent(path) } catch (e) { /* keep raw */ }
  let name = artifactNameFor(path)
  if (!name && m[1] && !path.startsWith('/')) {
    try {
      const cwd = ((ctx.sessions.list.getSnapshot().byId || {})[m[1]] || {}).cwd
      if (cwd) name = artifactNameFor(cwd.replace(/\/+$/, '') + '/' + path.replace(/^\.\//, ''))
    } catch (e) { /* no cwd: leave it */ }
  }
  return name ? { name, sessionId: m[1] } : null
}

function installSidebarRightRedirect(ctx) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['sidebarRight'], (fctx) => {
    fctx.effect(() => {
      let sr = null
      try { sr = fctx.get('sidebarRight') } catch (e) { sr = null }
      if (!sr) return () => {}
      const undo = []
      const divert = (address, sessionId) => {
        const hit = reportNameFromAddress(ctx, address)
        const bs = ctx.betterSidebar
        if (!hit || !bs || typeof bs.openTab !== 'function' || (bs.isTabEnabled && !bs.isTabEnabled(TAB_ID))) return false
        let sid = sessionId || hit.sessionId
        if (!sid) { try { sid = ctx.sessions.list.getSnapshot().current } catch (e) { sid = undefined } }
        requestSelect(sid, hit.name)
        bs.openTab({ type: TAB_ID }, sid ? { sessionId: sid } : undefined)
        return true
      }
      for (const key of ['openResource', 'openResourceIn']) {
        const original = sr[key]
        if (typeof original !== 'function') continue
        const wrapped = key === 'openResource'
          ? function (address, options) {
            try { if (!(options && options.kind) && divert(address)) return } catch (e) { console.warn('[dsh-artifacts] redirect failed', e) }
            return original.apply(this, arguments)
          }
          : function (sessionId, address, options) {
            try { if (!(options && options.kind) && divert(address, sessionId)) return } catch (e) { console.warn('[dsh-artifacts] redirect failed', e) }
            return original.apply(this, arguments)
          }
        sr[key] = wrapped
        undo.push(() => { if (sr[key] === wrapped) sr[key] = original })
      }
      return () => undo.forEach((f) => f())
    }, 'dsh-artifacts: open ~/reports resources as rendered artifacts')
  })
}

/** Open an artifact's source file in the sidebar editor (bypasses the redirect). */
function openSourceInEditor(ctx, path, scope) {
  const bs = ctx.get ? ctx.get('betterSidebar') : ctx.betterSidebar
  if (!bs || typeof bs.openTab !== 'function') return false
  const title = path.split('/').pop()
  bs.openTab({ type: 'editor', title, path, id: 'editor:' + path, meta: { raw: true } }, scope)
  return true
}

export const inject = ['betterSidebar']

export function apply(ctx) {
  if (!ctx.betterSidebar || typeof ctx.betterSidebar.registerTab !== 'function') {
    console.error('[dsh-artifacts] ctx.betterSidebar.registerTab is unavailable; tab not registered')
    return
  }
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title: 'Artifacts',
    order: 92,
    single: true,
    icon: tabIcon,
    component: (props) => <ArtifactsView visible={props.visible} scope={props.scope} ctx={props.ctx || ctx} />,
  }), 'dsh-artifacts: register the Artifacts sidebar tab')
  ctx.effect(() => { try { return installOpenTabRedirect(ctx) } catch (e) { console.warn('[dsh-artifacts] open redirect not installed', e); return () => {} } },
    'dsh-artifacts: open ~/reports links as rendered artifacts')
  try { installOpenPathRedirect(ctx) } catch (e) { console.warn('[dsh-artifacts] open-path redirect not installed', e) }
  try { installSidebarRightRedirect(ctx) } catch (e) { console.warn('[dsh-artifacts] sidebar-right redirect not installed', e) }
}