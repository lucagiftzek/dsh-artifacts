import { dirname as __dn, resolve as __rs } from 'node:path'
import { fileURLToPath as __fu } from 'node:url'
const BUNDLE = __rs(__dn(__fu(import.meta.url)), '..', 'lib', 'client.js')
/** Exercise the tab's fetch path: capture `load` from the poll interval and
 *  drive it against stubbed responses, checking which state setters fire. */
import { readFileSync } from 'node:fs'
import { makeRequire } from './react-resolve.mjs'
const { require: req } = makeRequire()

let queue = [], sets = [], captured = null, hookIdx = 0
const hookStub = {
  useState: (init) => {
    // An explicit counter, not `N - queue.length`: the component's state count
    // changes as features are added, and deriving the index from the remaining
    // queue silently mislabels setters once it does.
    const idx = hookIdx++
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

const NAMES = ['items', 'error', 'busy', 'selected', 'reloadKey', 'scopePref']

async function run(label, fetchImpl, expect) {
  queue = [[], null, false, null, 0]; sets = []; captured = null; hookIdx = 0
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
console.log('--- index URL shape ---')
{
  // The scope filter only works if the request actually carries the session id,
  // and only when there is one to carry.
  let seen = []
  const rec = async (u) => { seen.push(String(u)); return {
    ok: true, status: 200,
    headers: { get: () => 'application/json; charset=utf-8' },
    json: async () => ({ count: 0, items: [] }) } }
  const drive = async (props) => {
    seen = []; queue = [[], null, false, null, 0]; sets = []; captured = null; hookIdx = 0
    globalThis.fetch = rec
    const el = descriptor.component(props)
    if (typeof el.type === 'function') el.type(el.props)
    await captured()
    return seen
  }
  const withSession = await drive({ visible: true, scope: { sessionId: 'session-abc-123' }, tab: {}, store: {} })
  const noScope = await drive({ visible: true, tab: {}, store: {} })
  const emptySid = await drive({ visible: true, scope: { sessionId: '' }, tab: {}, store: {} })
  const ck = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) { fail++; console.log('        seen:', JSON.stringify(withSession), JSON.stringify(noScope)) } }
  ck('appends session= when a session id is present',
    withSession.length > 0 && withSession.every((u) => u.includes('session=session-abc-123')))
  ck('joins with & because the default index already has a query',
    withSession.every((u) => u.includes('?list=1&session=')))
  ck('no session param when scope is absent', noScope.every((u) => !u.includes('session=')))
  ck('no session param for an empty session id', emptySid.every((u) => !u.includes('session=')))
  ck('a session id is URL-encoded, never interpolated raw',
    (await drive({ visible: true, scope: { sessionId: 'a b&c=d' }, tab: {}, store: {} }))
      .every((u) => u.includes('session=a%20b%26c%3Dd') && !u.includes('a b&c=d')))
}

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
