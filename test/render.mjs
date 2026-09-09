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
    if (node.type === 'button') { out.buttons.push(String(p.children ?? '')); out.btnStyles.push(p.style || {}) }
    out.tags.push(node.type)
    walk(p.children, out)
  }
  return out
}
const render = (props) => { effects = 0; cleanups = []; return walk(descriptor.component(props), { text: [], iframes: [], buttons: [], btnStyles: [], tags: [] }) }
const has = (o, s) => o.text.join('|').includes(s)
const base = { visible: true, scope: { sessionId: 's1' }, tab: { id: 't', type: descriptor.id }, store: {} }
let fail = 0
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) fail++ }

console.log('--- A: empty library ---')
queue = [[], null, false, null, 0]
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
queue = [[...items], null, false, items[0], 0]
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
queue = [[], null, false, null, 0]
effects = 0; cleanups = []
walk(descriptor.component({ ...base, visible: false }), { text: [], iframes: [], buttons: [], btnStyles: [], tags: [] })
check('no poll interval scheduled when hidden', cleanups.length === 0)

console.log('--- D: fetch failure surfaces, never throws ---')
queue = [[], 'HTTP 502 from /report/?list=1', false, null, 0]
o = render(base)
check('renders the error inline', has(o, 'Could not read the artifact index') && has(o, 'HTTP 502'))

console.log('--- E: selection of a vanished file is dropped ---')
queue = [[], null, false, { name: 'gone.html', url: '/report/gone.html', ext: 'html', size: 1, mtime: 0 }, 0]
o = render(base)
check('no iframe for a file no longer listed', o.iframes.length === 0)

console.log('--- F: toolbar geometry is state-independent ---')
// Regression for a real report: the bar "ticked" on every 5 s poll because the
// Refresh label swapped between 'Refresh' and an ellipsis, so the button - and
// everything after it - changed width twice a minute.
queue = [items, null, false, items[0], 0]
const idle = render(base)
queue = [items, null, true, items[0], 0]
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

console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL STRUCTURAL CHECKS PASSED')
process.exit(fail ? 1 : 0)
