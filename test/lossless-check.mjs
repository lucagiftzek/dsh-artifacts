/**
 * Test helper (vendor into test/): applies DSH 0.2.1's own "lossless JSON" rule to a tool result.
 * Uses the core's exported isJsonValue (@deepseek-ai/dsh-util-values) when it can be found
 * (DSH_GLOBAL_PREFIX or `npm root -g`), else the replica below, which mirrors core walkJsonValue:
 * reject undefined/function/symbol/bigint, non-finite numbers and -0, non-plain prototypes (Date, Map,
 * Set, Error, class instances), sparse arrays and arrays with extra keys, symbol or non-enumerable
 * keys, and cycles. `violations()` returns the JSON paths that break the rule.
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function violations(value) {
  const out = []; const anc = new Set()
  const walk = (v, p) => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) out.push(`${p}: ${Object.is(v, -0) ? '-0' : v}`); return }
    if (typeof v !== 'object') { out.push(`${p}: ${typeof v}`); return }
    if (anc.has(v)) { out.push(`${p}: cycle`); return }
    const proto = Object.getPrototypeOf(v)
    if (Array.isArray(v)) {
      if (proto !== Array.prototype) { out.push(`${p}: non-plain array`); return }
      if (Reflect.ownKeys(v).length !== v.length + 1) { out.push(`${p}: sparse array or extra array keys`); return }
      anc.add(v); v.forEach((x, i) => walk(x, `${p}[${i}]`)); anc.delete(v); return
    }
    if (proto !== null && proto !== Object.prototype) { out.push(`${p}: non-plain object (${(proto && proto.constructor && proto.constructor.name) || 'unknown'})`); return }
    const keys = Reflect.ownKeys(v)
    if (keys.some((k) => typeof k !== 'string' || !Object.prototype.propertyIsEnumerable.call(v, k))) { out.push(`${p}: symbol or non-enumerable key`); return }
    anc.add(v); for (const k of keys) walk(v[k], `${p}.${k}`); anc.delete(v)
  }
  walk(value, '$')
  return out
}

let core
export async function coreIsJsonValue() {
  if (core !== undefined) return core
  core = null
  const roots = []
  if (process.env.DSH_GLOBAL_PREFIX) roots.push(join(process.env.DSH_GLOBAL_PREFIX, 'lib', 'node_modules'), join(process.env.DSH_GLOBAL_PREFIX, 'node_modules'))
  try { roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 8000 }).trim()) } catch { /* no npm */ }
  for (const r of roots) {
    try {
      const req = createRequire(join(r, '@deepseek-ai', 'dsh', 'package.json'))
      const m = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-util-values')).href)
      if (typeof m.isJsonValue === 'function') { core = m.isJsonValue; break }
    } catch { /* next */ }
  }
  return core
}

/** Throws unless `value` is lossless JSON by the core rule (and, when the core is found, by the core's own function). */
export async function assertLossless(value, label = 'result') {
  const v = violations(value)
  const c = await coreIsJsonValue()
  const coreOk = c ? c(value) : null
  if (v.length || coreOk === false) throw new Error(`${label} is not lossless JSON${v.length ? ': ' + v.slice(0, 5).join('; ') : ' (per the core)'}`)
  if (c && v.length === 0 && coreOk !== true) throw new Error(`${label}: replica and core disagree`)
}
