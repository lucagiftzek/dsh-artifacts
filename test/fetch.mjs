import { dirname as __dn, resolve as __rs } from 'node:path'
import { fileURLToPath as __fu } from 'node:url'
const BUNDLE = __rs(__dn(__fu(import.meta.url)), '..', 'lib', 'client.js')
/** Exercise the tab's fetch path: capture `load` from the poll interval and
 *  drive it against stubbed responses, checking which state setters fire. */
import { readFileSync } from 'node:fs'
import { makeRequire } from './react-resolve.mjs'
const { require: req } = makeRequire()

let queue = [], sets = [], captured = null
const hookStub = {
  useState: (init) => {
    const idx = 5 - queue.length            // 0 items, 1 error, 2 busy, 3 selected, 4 reloadKey
    const v = queue.length ? queue.shift() : (typeof init === 'function' ? init() : init)
    return [v, (nv) => sets.push({ idx, nv })]
  },
  useEffect: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}
const registered = []
globalThis.window = { __ModuleLoader__: { load: (r) => registered.push(r) } }
globalThis.setInterval = (fn) => { captured = fn; return 1 }
globalThis.clearInterval = () => {}
globalThis.location = { origin: 'https://gui.example.com' }

new Function(readFileSync(BUNDLE, 'utf8'))()
const mod = registered[0].factory((n) => {
  if (n === 'react/jsx-runtime') return req('react/jsx-runtime')
  if (n === 'react') return hookStub
  throw new Error('UNRESOLVED require: ' + n)
})
let descriptor = null
mod.apply({ betterSidebar: { registerTab: (d) => { descriptor = d; return () => {} } }, effect: (f) => f() })

const NAMES = ['items', 'error', 'busy', 'selected', 'reloadKey']

async function run(label, fetchImpl, expect) {
  queue = [[], null, false, null, 0]; sets = []; captured = null
  // Install the stub BEFORE rendering: the effect calls load() immediately (as
  // it should -- immediate plus periodic), so assigning later would leave that
  // first in-flight call resolving against the previous scenario's stub.
  globalThis.fetch = fetchImpl
  const el = descriptor.component({ visible: true, scope: { sessionId: 's' }, tab: {}, store: {} })
  if (typeof el.type === 'function') el.type(el.props)   // invoke ArtifactsView itself
  const load = captured
  if (typeof load !== 'function') throw new Error('poll interval never captured load()')
  let threw = null
  try { await load() } catch (e) { threw = e }
  await new Promise((r) => setTimeout(r, 0))            // let the effect's own call settle
  const got = (n) => sets.filter((s) => s.idx === NAMES.indexOf(n)).map((s) => s.nv)
  const ok = expect(got, threw)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log('        sets:', JSON.stringify(sets.map((s) => [NAMES[s.idx], String(s.nv).slice(0, 80)])))
  return ok
}
const json = (obj, status = 200) => async () => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json; charset=utf-8' },
  json: async () => obj,
})
const someErr = (got, sub) => got('error').some((e) => String(e).includes(sub))
const itemsPopulated = (got) => got('items').some((v) => Array.isArray(v) && v.length > 0)

let fail = 0
console.log('--- fetch path ---')
if (!await run('happy path stores items and clears the error',
  json({ count: 1, items: [{ name: 'a.html', url: '/report/a.html', ext: 'html', size: 10, mtime: 1 }] }),
  (g, t) => !t && itemsPopulated(g) && g('items')[0][0].name === 'a.html' && g('error').includes(null) && g('busy').includes(false))) fail++
if (!await run('HTTP 502 surfaces and the list stays empty', json({}, 502),
  (g, t) => !t && someErr(g, 'HTTP 502') && !itemsPopulated(g))) fail++
if (!await run('auth redirect (HTML not JSON) is explained',
  async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, json: async () => { throw new Error('not json') } }),
  (g, t) => !t && someErr(g, 'expected a JSON index') && someErr(g, 'authenticated'))) fail++
if (!await run('proxy index-level error is surfaced',
  json({ error: 'cannot list artifact directory: EACCES', count: 0, items: [] }),
  (g, t) => !t && someErr(g, 'EACCES'))) fail++
if (!await run('network rejection never escapes as a throw',
  async () => { throw new TypeError('Failed to fetch') },
  (g, t) => !t && someErr(g, 'Failed to fetch') && g('busy').includes(false))) fail++
if (!await run('malformed payload (no items array) degrades to empty', json({ count: 1 }),
  (g, t) => !t && g('items').some((v) => Array.isArray(v) && v.length === 0))) fail++
if (!await run('busy is set true then false around the call', json({ count: 0, items: [] }),
  (g, t) => !t && g('busy').includes(true) && g('busy').includes(false))) fail++
console.log(fail ? `\n${fail} FAILED` : '\nALL FETCH-PATH CHECKS PASSED')
process.exit(fail ? 1 : 0)
