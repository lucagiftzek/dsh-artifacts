/** v2 client smoke test: the bundle registers the tab, server-renders the list
 *  view with the REAL react, and installs the chat open-path redirect. */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { makeRequire } from './react-resolve.mjs'
const here = dirname(fileURLToPath(import.meta.url))
const { require: req } = makeRequire()
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }

const registered = []
globalThis.window = { __ModuleLoader__: { load: (r) => registered.push(r) } }
globalThis.location = { origin: 'https://gui.example.com' }
new Function(readFileSync(resolve(here, '..', 'lib', 'client.js'), 'utf8'))()
ok(registered.length === 1 && registered[0].id === 'dsh-artifacts', 'bundle registers one module')
const React = req('react')
const mod = registered[0].factory((n) => {
  if (n === 'react') return React
  if (n === 'react/jsx-runtime') return req('react/jsx-runtime')
  throw new Error('UNRESOLVED require: ' + n)
})
ok(Array.isArray(mod.inject) && mod.inject.includes('betterSidebar'), 'injects betterSidebar')

let descriptor = null
const opened = []
const ctx = {
  betterSidebar: { registerTab: (d) => { descriptor = d; return () => {} }, openTab: (seed) => opened.push(seed), isTabEnabled: () => true },
  sessions: { list: { getSnapshot: () => ({ current: 'session-1234abcd' }) } },
  effect: (fn) => fn(),
}
mod.apply(ctx)
ok(descriptor && descriptor.id === 'dsh-artifacts:library' && descriptor.single, 'registers the Artifacts tab')
ctx.betterSidebar.openTab({ type: 'editor', path: '/home/u/reports/x.md' })
ctx.betterSidebar.openTab({ type: 'editor', path: '/home/u/project/reports.md' })
ctx.betterSidebar.openTab({ type: 'editor', path: '/home/u/reports/x.md', meta: { raw: true } })
ok(opened[0].type === 'dsh-artifacts:library', 'report .md opens the Artifacts tab')
ok(opened[1].type === 'editor' && opened[2].type === 'editor', 'other files and raw opens pass through')

let server = null
try { server = req('react-dom/server') } catch (e) { /* optional */ }
if (server) {
  const html = server.renderToString(descriptor.component({ visible: false, scope: { sessionId: 'session-1234abcd' }, ctx }))
  ok(html.includes('Artifacts') && html.includes('Search artifacts'), 'list view renders (SSR)')
} else {
  console.log('skip SSR render: react-dom/server not resolvable')
}

/* apply must not throw without the sidebar service */
let threw = false
try { mod.apply({ effect: (f) => f() }) } catch (e) { threw = true }
ok(!threw, 'apply without betterSidebar is non-fatal')
process.exit(fails ? 1 : 0)
