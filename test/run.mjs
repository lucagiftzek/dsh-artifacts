/** Run both offline checks. Neither needs a browser, a DSH_HOME, or network. */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
let fail = 0
for (const t of ['render.mjs', 'fetch.mjs']) {
  console.log(`\n===== ${t} =====`)
  const r = spawnSync(process.execPath, [resolve(here, t)], { stdio: 'inherit' })
  if (r.status !== 0) fail++
}
console.log(fail ? `\n${fail} suite(s) FAILED` : '\nboth suites passed')
process.exit(fail ? 1 : 0)
