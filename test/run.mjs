/** Run every offline suite. None needs a browser, a DSH_HOME, or network. */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
let fail = 0
const suites = [
  [process.execPath, [resolve(here, 'client.mjs')]],
  ['python3', [resolve(here, 'test_server.py')]],
  ['python3', [resolve(here, 'test_artifact_kit.py')]],
]
for (const [cmd, args] of suites) {
  console.log('\n===== ' + args[0].split('/').pop() + ' =====')
  const r = spawnSync(cmd, args, { stdio: 'inherit' })
  if (r.status !== 0) fail++
}
console.log(fail ? '\n' + fail + ' suite(s) FAILED' : '\nall suites passed')
process.exit(fail ? 1 : 0)
