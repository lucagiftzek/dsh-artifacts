/**
 * Listing commands for the artifact CLI (contrib/artifact): `node lib/listing-cli.js list|add|remove|update`
 * with the arguments as a JSON object on stdin, the same object the agent tools take. Prints the tool result
 * (lossless JSON); exit 0 = ok, 2 = refused input, 1 = other failure. The calling chat is $DSH_SESSION_ID.
 */
import { readFileSync } from 'node:fs'
import { failure } from './tools.js'
import { addArtifact, listArtifacts, removeArtifact, updateArtifact } from './listing.js'

const cmds: Record<string, (a: any, s?: string) => Record<string, unknown>> = {
  list: listArtifacts, add: addArtifact, remove: removeArtifact, update: updateArtifact,
}
const cmd = process.argv[2] || ''
let res: Record<string, unknown>
if (!cmds[cmd]) {
  res = { ok: false, code: 'ARTIFACT_ARGS_INVALID', message: `unknown listing command "${cmd}" (list, add, remove, update)` }
} else {
  let args: unknown = {}
  try {
    const text = readFileSync(0, 'utf8')
    args = text.trim() ? JSON.parse(text) : {}
  } catch (e: any) {
    args = null
    res = { ok: false, code: 'ARTIFACT_ARGS_INVALID', message: 'stdin is not a JSON object: ' + e.message }
  }
  if (args !== null) {
    try { res = cmds[cmd](args, process.env.DSH_SESSION_ID || undefined) } catch (e) { res = failure(e) }
  }
}
process.stdout.write(JSON.stringify(res!, null, 2) + '\n')
const code = String(res!.code || '')
process.exitCode = res!.ok ? 0 : /ARGS_INVALID|SOURCE_INVALID|TYPE_UNSUPPORTED|TOO_LARGE|SECRET|BAD_NAME|EXISTS|AMBIGUOUS|NOT_FOUND/.test(code) ? 2 : 1
