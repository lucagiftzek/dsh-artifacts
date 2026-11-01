/**
 * Build the node half's TypeScript (src/engine/*.ts, src/tools.ts) into lib/, one JavaScript file per source
 * file, no bundling: lib/engine/*.js and lib/tools.js are committed, so installs need no build step and no
 * TypeScript. Type checking is separate: `tsc -p tsconfig.json` (needs @types/node).
 *
 * esbuild is a devDependency; ESBUILD_MAIN points at another copy to keep the build offline.
 */
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [process.env.ESBUILD_MAIN, 'esbuild'].filter(Boolean)
let esbuild
for (const c of candidates) {
  try { esbuild = await import(c); break } catch { /* next */ }
}
if (!esbuild) throw new Error('esbuild not resolvable: pnpm install, or ESBUILD_MAIN=/path/to/esbuild/lib/main.js')
const { build } = esbuild.default && esbuild.default.build ? esbuild.default : esbuild

const engine = readdirSync(join(ROOT, 'src', 'engine')).filter((f) => f.endsWith('.ts')).map((f) => join(ROOT, 'src', 'engine', f))
const common = { bundle: false, format: 'esm', platform: 'node', target: 'node20', sourcemap: false, logLevel: 'warning', legalComments: 'inline' }
await build({ ...common, entryPoints: engine, outdir: join(ROOT, 'lib', 'engine') })
await build({ ...common, entryPoints: [join(ROOT, 'src', 'tools.ts')], outdir: join(ROOT, 'lib') })
console.log('built lib/engine/*.js and lib/tools.js from src/')
