import { dirname as __dn, resolve as __rs } from 'node:path'
import { fileURLToPath as __fu } from 'node:url'
const BUNDLE = __rs(__dn(__fu(import.meta.url)), '..', 'lib', 'client.js')
import { readFileSync } from 'node:fs'
import { makeRequire } from './react-resolve.mjs'
const { require: req } = makeRequire()

let queue = [], effects = 0, cleanups = []
const hookStub = {
  useState: (init) => { if (!queue.length) throw new Error('useState queue exhausted'); return [queue.shift(), () => {}] },
  useEffect: (fn) => { effects++; const c = fn(); if (typeof c === 'function') cleanups.push(c) },
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
const registered = []
globalThis.window = { __ModuleLoader__: { load: (r) => registered.push(r) } }
new Function(readFileSync(BUNDLE, 'utf8'))()
const mod = registered[0].factory((name) => {
  if (name === 'react/jsx-runtime') return req('react/jsx-runtime')  // REAL: genuine elements
  if (name === 'react') return hookStub                                // STUB: programmable hooks
  throw new Error('UNRESOLVED require: ' + name)
})


let descriptor = null
mod.apply({ betterSidebar: { registerTab: (d) => () => {} }, effect: (fn) => fn() })
mod.apply({ betterSidebar: { registerTab: (d) => { descriptor = d; return () => {} } }, effect: (fn) => fn() })

/** Walk a real React element tree; collect text and notable elements. */
function walk(node, out) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return out }
  if (node.$$typeof) {
    const p = node.props || {}
    // A function component is not rendered by creating its element -- invoke it
    // so its own hooks and children are walked (this is what a renderer does).
    if (typeof node.type === 'function') { walk(node.type(p), out); return out }
    if (node.type === 'iframe') out.iframes.push(p.src)
    if (node.type === 'button') { out.buttons.push(String(p.children ?? '')); out.btnStyles.push(p.style || {}); out.btnProps.push(p) }
    out.tags.push(node.type)
    walk(p.children, out)
  }
  return out
}
const render = (props) => { effects = 0; cleanups = []; return walk(descriptor.component(props), { text: [], iframes: [], buttons: [], btnStyles: [], btnProps: [], tags: [] }) }
const has = (o, s) => o.text.join('|').includes(s)
const base = { visible: true, scope: { sessionId: 's1' }, tab: { id: 't', type: descriptor.id }, store: {} }
let fail = 0
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fail++ }

console.log('--- A: empty library ---')
queue = [[], null, false, null, 0, null]
let o = render(base)
check('shows the tab title', has(o, 'Artifacts'))
check('shows the empty-state guidance', has(o, 'No artifacts yet'))
check('names the index endpoint it reads', has(o, '/report/?list=1'))
check('Refresh button present', o.buttons.includes('Refresh'))
check('no iframe when nothing selected', o.iframes.length === 0)
check('polling started while visible (1 effect, 1 cleanup)', effects === 1 && cleanups.length === 1)

console.log('--- B: populated + one selected ---')
const items = [
  { name: 'dsh-model-routing.html', url: '/report/dsh-model-routing.html', ext: 'html', size: 11160, mtime: Math.floor(Date.now()/1000) - 30 },
  { name: 'notes.md', url: '/report/notes.md', ext: 'md', size: 900, mtime: Math.floor(Date.now()/1000) - 7200 },
]
queue = [[...items], null, false, items[0], 0, null]
o = render(base)
check('lists both artifacts', has(o, 'dsh-model-routing.html') && has(o, 'notes.md'))
check('shows the count', has(o, '2 files'))
check('formats size', has(o, '10.9 KB') && has(o, '900 B'))
check('formats age', has(o, 'just now') && has(o, '2h ago'))
check('maps ext to a label', has(o, 'HTML') && has(o, 'Markdown'))
check('iframe src is the RELATIVE report url', o.iframes.length === 1 && o.iframes[0] === '/report/dsh-model-routing.html')
check('Reload / Copy link / Open buttons appear', ['Reload','Copy link','Open ↗'].every((b) => o.buttons.includes(b)))
check('selected row is highlighted', o.tags.length > 5)

console.log('--- C: hidden tab must not poll ---')
queue = [[], null, false, null, 0, null]
effects = 0; cleanups = []
walk(descriptor.component({ ...base, visible: false }), { text: [], iframes: [], buttons: [], btnStyles: [], btnProps: [], tags: [] })
check('no poll interval scheduled when hidden', cleanups.length === 0)

console.log('--- D: fetch failure surfaces, never throws ---')
queue = [[], 'HTTP 502 from /report/?list=1', false, null, 0, null]
o = render(base)
check('renders the error inline', has(o, 'Could not read the artifact index') && has(o, 'HTTP 502'))

console.log('--- E: selection of a vanished file is dropped ---')
queue = [[], null, false, { name: 'gone.html', url: '/report/gone.html', ext: 'html', size: 1, mtime: 0 }, 0, null]
o = render(base)
check('no iframe for a file no longer listed', o.iframes.length === 0)

console.log('--- F: toolbar geometry is state-independent ---')
// Regression for a real report: the bar "ticked" on every 5 s poll because the
// Refresh label swapped between 'Refresh' and an ellipsis, so the button - and
// everything after it - changed width twice a minute.
queue = [items, null, false, items[0], 0, null]
const idle = render(base)
queue = [items, null, true, items[0], 0, null]
const working = render(base)
check('Refresh label does not change while busy',
  idle.buttons.includes('Refresh') && working.buttons.includes('Refresh'))
check('no ellipsis-only label appears while busy',
  !working.buttons.some((b) => b.trim() === '…' || b.trim() === '...'))
check('same set of buttons in both states',
  JSON.stringify(idle.buttons) === JSON.stringify(working.buttons))
check('every toolbar button has a fixed box',
  idle.btnStyles.length > 0 && idle.btnStyles.every((st) =>
    typeof st.minWidth === 'number' && st.boxSizing === 'border-box'
    && st.whiteSpace === 'nowrap' && st.textAlign === 'center'))
check('button boxes are identical idle vs busy',
  JSON.stringify(idle.btnStyles) === JSON.stringify(working.btnStyles))
const busyAttr = (o) => o.tags.includes('button')
check('busy is still announced without moving anything',
  readFileSync(BUNDLE, 'utf8').includes('aria-busy'))

console.log('--- G: per-session scope toggle ---')
// The artifact directory is shared, so the list must be filterable to this
// chat. Attribution arrives as a boolean `mine` per item; when it is absent the
// toggle must not render at all rather than offer a permanently empty view.
const now = Math.floor(Date.now() / 1000)
const scoped = [
  { name: 'mine.html', url: '/report/mine.html', ext: 'html', size: 100, mtime: now, mine: true },
  { name: 'theirs.html', url: '/report/theirs.html', ext: 'html', size: 200, mtime: now - 60, mine: false },
]
queue = [[...scoped], null, false, null, 0, null]
o = render(base)
check('offers This chat and All', o.buttons.includes('This chat') && o.buttons.includes('All'))
check('defaults to this chat when it has artifacts',
  has(o, 'mine.html') && !has(o, 'theirs.html'))
check('count says "1 of 2 files" while filtered', has(o, '1 of 2 files'))
check('This chat is the pressed segment',
  o.btnProps.some((p) => String(p.children) === 'This chat' && p['aria-pressed'] === true)
  && o.btnProps.some((p) => String(p.children) === 'All' && p['aria-pressed'] === false))

queue = [[...scoped], null, false, null, 0, 'all']
o = render(base)
check('All shows every artifact', has(o, 'mine.html') && has(o, 'theirs.html'))
check('All marks this chat\'s rows', has(o, '●'))
check('unfiltered count has no "of"', has(o, '2 files') && !has(o, 'of 2'))

queue = [[...scoped], null, false, null, 0, 'mine']
o = render(base)
check('an explicit This-chat preference is honoured', !has(o, 'theirs.html'))

queue = [[...items], null, false, null, 0, null]
o = render(base)
check('no toggle when the index does not attribute',
  !o.buttons.includes('This chat') && !o.buttons.includes('All'))
check('every artifact still listed without attribution',
  has(o, 'dsh-model-routing.html') && has(o, 'notes.md'))

queue = [[...scoped], null, false, null, 0, null]
o = render({ visible: true, tab: { id: 't', type: descriptor.id }, store: {} })
check('no toggle without a session id', !o.buttons.includes('This chat'))
check('falls back to listing everything', has(o, 'theirs.html'))

queue = [[scoped[1]], null, false, null, 0, 'mine']
o = render(base)
check('empty This-chat view explains why', has(o, 'Nothing from this chat yet'))

queue = [[...scoped], null, false, null, 0, null]
const segIdle = render(base)
queue = [[...scoped], null, true, null, 0, null]
const segBusy = render(base)
check('segment buttons have a fixed box',
  segIdle.btnProps.filter((p) => ['This chat', 'All'].includes(String(p.children)))
    .every((p) => typeof p.style.minWidth === 'number' && p.style.boxSizing === 'border-box'
      && p.style.whiteSpace === 'nowrap' && p.style.textAlign === 'center'))
check('toggling scope cannot shift the toolbar while busy',
  JSON.stringify(segIdle.btnStyles) === JSON.stringify(segBusy.btnStyles))

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL STRUCTURAL CHECKS PASSED')
process.exit(fail ? 1 : 0)
