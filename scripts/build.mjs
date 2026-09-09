/**
 * Build the browser half of dsh-artifacts.
 *
 * Output format is the web boot factory the client-module system materializes
 * at `/plugins/<id>/client.js`:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * This mirrors dsh-session-pin's own build.mjs, which is the reference
 * implementation for a tab-registering plugin on this profile.
 *
 * The node half (lib/index.js) is hand-written ESM and needs no build: it has
 * zero imports on purpose.
 *
 * esbuild resolution: this plugin keeps no node_modules of its own, so the
 * bundler is taken from a sibling plugin that already has it installed. That
 * keeps the build offline and deterministic. Override with ESBUILD_MAIN.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ID = 'dsh-artifacts'

/** Platform seed words the shell shares into the module table. The factory's
 * `require` resolves them to the shell's own React — never a bundled duplicate. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

async function loadEsbuild() {
  // esbuild is a devDependency; the env override exists for checkouts that keep
  // a bundler somewhere else (e.g. a sibling plugin's node_modules) so the build
  // stays offline instead of reaching for the network.
  const candidates = [process.env.ESBUILD_MAIN, 'esbuild'].filter(Boolean)
  for (const c of candidates) {
    try { return await import(c) } catch { /* try the next candidate */ }
  }
  throw new Error(
    'esbuild not resolvable.\n'
    + '  fix: pnpm install   (it is a devDependency)\n'
    + '   or: ESBUILD_MAIN=/path/to/esbuild/lib/main.js node scripts/build.mjs')
}

const { build } = await loadEsbuild()

await build({
  entryPoints: [resolve(ROOT, 'src/client.jsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: resolve(ROOT, 'lib/client.js'),
  sourcemap: true,
  external: CLIENT_EXTERNALS,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
})

const bundle = readFileSync(resolve(ROOT, 'lib/client.js'), 'utf8')

/* Build-time purity gate, same as the reference plugin: a `@deepseek-ai/`
 * value import would inline a second runtime instance of a shell package. */
if (bundle.includes('@deepseek-ai/')) {
  throw new Error('client bundle purity: @deepseek-ai value imports must not reach the client bundle')
}
/* Every bare require must be a declared seed word, or the module system throws
 * loudly at materialization. */
const requires = [...bundle.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
const bad = [...new Set(requires)].filter((r) => !CLIENT_EXTERNALS.includes(r))
if (bad.length) {
  throw new Error('client bundle requires non-seed modules: ' + bad.join(', '))
}

console.log(`built lib/client.js (${bundle.length} bytes)`)
console.log(`  requires: ${[...new Set(requires)].join(', ') || '(none)'}`)
