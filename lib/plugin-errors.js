/**
 * plugin-errors: stable error codes, structured error bodies and a doctor
 * report for DSH plugins. Standard: docs/PLUGIN-DOCS-STANDARD.md.
 *
 * Vendored verbatim into every plugin that uses it (single source:
 * dsh-migrate-0.2/shared/plugin-errors.js). Node builtins only, ESM, no
 * dependency on the harness, so it works in tests, on DSH 0.1.5 and on 0.2.x.
 *
 *   import { defineErrors, doctorReport, hostInfo } from './plugin-errors.js'
 *   const E = defineErrors('PHONE', {
 *     PHONE_SIGNATURE_INVALID: { status: 403, legacy: 'bad-signature',
 *       message: 'Webhook signature did not validate',
 *       hint: 'Check the public URL the provider signs (proxy, scheme, port).' },
 *   })
 *   E.send(res, 'PHONE_SIGNATURE_INVALID')          // HTTP JSON error
 *   return E.tool('PHONE_SIGNATURE_INVALID')        // agent tool result
 *   throw E.raise('PHONE_SIGNATURE_INVALID')        // Error carrying .code/.hint/.docs
 *
 * Every error object has the same shape:
 *   { ok: false, error, code, message, hint, docs, ...details }
 * `error` keeps the field older clients read (a legacy short string when the
 * catalog entry has one, else the message). `docs` is a doc anchor relative to
 * the plugin repository root, e.g. "docs/ERRORS.md#phone_signature_invalid",
 * which is the GitHub anchor of the heading "### PHONE_SIGNATURE_INVALID".
 *
 * Since 1.1.0 every body is passed through toLossless() (DSH 0.2.1 rejects tool results holding
 * undefined, NaN, Date, etc.); toLossless and losslessDefineTool are exported for tool boundaries.
 *
 * Never put a secret into message, hint or details: these bodies reach agent
 * transcripts and logs. Pass dynamic text through the plugin's own scrubber
 * (option `scrub`).
 */

export const PLUGIN_ERRORS_VERSION = '1.1.0'

// ---- lossless: sanitize a tool result for DSH 0.2.1 (identical block in shared/lossless.js and plugin-errors.js) ----
/**
 * DSH 0.2.1 validates every agent tool result with util-values `snapshotJsonValue`
 * and rejects it as `tool "<name>" returned invalid output: value is not lossless JSON`
 * when ANY nested value is: undefined, a function or symbol, bigint, NaN, +-Infinity,
 * -0, a Date/Map/Set/Error/class instance (non-plain prototype), a sparse array, an
 * array with extra props, an object with symbol or non-enumerable keys, or a cycle.
 * toLossless() converts a value into the nearest JSON equivalent with the same rules
 * JSON.stringify applies (undefined/function/symbol keys dropped, in arrays -> null).
 * It never throws.
 */
export function toLossless(value, _seen = new Set(), _depth = 0) {
  if (value === null) return null
  switch (typeof value) {
    case 'string': case 'boolean': return value
    case 'number': return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
    case 'bigint': return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    case 'undefined': case 'function': case 'symbol': return null
  }
  if (_depth > 64) return '[Truncated]'
  if (_seen.has(value)) return '[Circular]'
  _seen.add(value)
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    if (typeof value.toJSON === 'function' && !Array.isArray(value)) {
      let j
      try { j = value.toJSON() } catch { j = undefined }
      if (j !== value) return toLossless(j, _seen, _depth + 1)
    }
    if (Array.isArray(value)) {
      const out = []
      for (let i = 0; i < value.length; i++) out.push(toLossless(value[i], _seen, _depth + 1))
      return out
    }
    if (value instanceof Set) return Array.from(value, (v) => toLossless(v, _seen, _depth + 1))
    if (value instanceof Error) {
      const out = { name: String(value.name), message: String(value.message) }
      if (typeof value.code === 'string') out.code = value.code
      return out
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return Array.from(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength))
    const src = value instanceof Map ? Object.fromEntries(Array.from(value, ([k, v]) => [String(k), v])) : value
    const out = {}
    for (const k of Object.keys(src)) {
      let v
      try { v = src[k] } catch { continue }
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
      Object.defineProperty(out, k, { value: toLossless(v, _seen, _depth + 1), enumerable: true, configurable: true, writable: true })
    }
    return out
  } finally { _seen.delete(value) }
}

/** Wrap a harness defineTool so every execute() result (success AND error returns) is sanitized. */
export function losslessDefineTool(defineTool) {
  if (typeof defineTool !== 'function') return defineTool
  const wrapped = (def) => {
    if (!def || typeof def.execute !== 'function') return defineTool(def)
    const execute = def.execute
    return defineTool({ ...def, execute: async function (...a) { return toLossless(await execute.apply(this, a)) } })
  }
  return wrapped
}
// ---- end lossless ----


const CODE_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const STATUS_RANK = { ok: 0, skip: 0, info: 0, warn: 1, fail: 2 }

/** GitHub-style anchor for a code heading ("### PHONE_X" -> "phone_x"). */
export function anchorFor(code) {
  return String(code).toLowerCase().replace(/[^a-z0-9_-]/g, '')
}

/**
 * Define a plugin's error catalog.
 * @param {string} prefix  upper-case plugin prefix, e.g. 'PHONE'
 * @param {Record<string, {status?: number, message: string, hint?: string, legacy?: string, docs?: string}>} catalog
 * @param {{ docsFile?: string, scrub?: (s: string) => string }} [opts]
 */
export function defineErrors(prefix, catalog, opts = {}) {
  if (!/^[A-Z][A-Z0-9]*$/.test(String(prefix))) throw new Error(`plugin-errors: bad prefix ${prefix}`)
  const docsFile = opts.docsFile || 'docs/ERRORS.md'
  const scrub = typeof opts.scrub === 'function' ? opts.scrub : (s) => s
  const entries = {}
  for (const [code, def] of Object.entries(catalog || {})) {
    if (!CODE_RE.test(code) || !code.startsWith(prefix + '_')) throw new Error(`plugin-errors: code ${code} must be ${prefix}_UPPER_SNAKE`)
    if (!def || typeof def.message !== 'string' || !def.message) throw new Error(`plugin-errors: ${code} needs a message`)
    entries[code] = Object.freeze({
      status: Number.isInteger(def.status) ? def.status : 500,
      message: def.message,
      hint: def.hint || '',
      legacy: def.legacy,
      docs: def.docs || `${docsFile}#${anchorFor(code)}`,
    })
  }
  Object.freeze(entries)
  const unknown = `${prefix}_INTERNAL`

  /** Build the error object. `extra.message` / `extra.hint` override; `extra.detail` is scrubbed and appended. */
  function make(code, extra = {}) {
    const def = entries[code] || entries[unknown] || { status: 500, message: 'Unexpected error', hint: '', docs: `${docsFile}#${anchorFor(unknown)}` }
    const realCode = entries[code] ? code : (entries[unknown] ? unknown : code)
    const { message, hint, detail, status, ...rest } = extra || {}
    let msg = typeof message === 'string' && message ? scrub(message) : def.message
    if (detail !== undefined && detail !== null && detail !== '') msg += `: ${scrub(String(detail instanceof Error ? detail.message : detail))}`
    return toLossless({
      ok: false,
      error: def.legacy || msg,
      code: realCode,
      message: msg,
      hint: typeof hint === 'string' && hint ? scrub(hint) : def.hint,
      docs: def.docs,
      ...rest,
    })
  }

  return Object.freeze({
    prefix,
    codes: entries,
    has: (code) => Object.prototype.hasOwnProperty.call(entries, code),
    status: (code) => (entries[code] ? entries[code].status : 500),
    body: make,
    /** Agent tool result: { ok:false, error, code, message, hint, docs }. */
    tool: make,
    /** Error instance carrying code/hint/docs/status (for code that throws). */
    raise(code, extra = {}) {
      const b = make(code, extra)
      const e = new Error(b.message)
      e.code = b.code; e.hint = b.hint; e.docs = b.docs; e.status = extra.status || (entries[b.code] ? entries[b.code].status : 500); e.body = b
      return e
    },
    /** Turn anything caught into a structured body (keeps a known .code, else fallback). */
    from(err, fallback = unknown, extra = {}) {
      if (err && typeof err.code === 'string' && entries[err.code]) return err.body ? toLossless(err.body) : make(err.code, extra)
      return make(fallback, { ...extra, detail: err && err.message ? err.message : String(err) })
    },
    /** Write an HTTP JSON error. Works with node:http ServerResponse. */
    send(res, code, extra = {}) {
      const b = make(code, extra)
      const status = extra.status || (entries[b.code] ? entries[b.code].status : 500)
      if (!res.headersSent) {
        res.statusCode = status
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
      }
      res.end(JSON.stringify(b))
      return b
    },
    /** Log line with the stable code first, so `grep CODE` finds it. */
    logLine(code, detail) {
      const d = detail === undefined ? '' : ' ' + scrub(String(detail instanceof Error ? detail.message : detail))
      return `${code}${d}`
    },
    /** Codes missing from an ERRORS.md text (for a docs drift test). */
    missingFromDoc(markdown) {
      const text = String(markdown || '')
      const heading = (c) => new RegExp(`^#{2,4}\\s+\`?${c}\`?\\s*$`, 'm').test(text)
      const row = (c) => new RegExp(`^\\|.*\\b${c}\\b.*\\|`, 'm').test(text)
      return Object.keys(entries).filter((c) => !heading(c) || !row(c))
    },
  })
}

/**
 * Settings mode of the running host, by capability (same rule as dual-settings):
 * 'register' = DSH 0.1.5 line, 'forms' = DSH 0.1.7+ / 0.2.x, 'config' = neither.
 */
export function settingsMode(ctx) {
  let s
  try { s = ctx && ctx.settings } catch { return 'config' } // 0.2.x throws without inject 'settings'
  if (s && typeof s.register === 'function') return 'register'
  if (s && typeof s.update === 'function' && typeof s.describe === 'function') return 'forms'
  return 'config'
}

/** Best effort harness version from the running process (never throws). */
export async function hostVersion() {
  try {
    const { realpathSync, readFileSync, existsSync } = await import('node:fs')
    const { dirname, join } = await import('node:path')
    let dir = dirname(realpathSync(process.argv[1] || ''))
    for (let i = 0; i < 8 && dir && dir !== dirname(dir); i++, dir = dirname(dir)) {
      const p = join(dir, 'package.json')
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, 'utf8'))
        if (pkg && pkg.name === '@deepseek-ai/dsh') return pkg.version || null
      }
    }
  } catch { /* unknown */ }
  return null
}

/** Host facts for a doctor report: never secrets, only versions and modes. */
export async function hostInfo(ctx) {
  const dsh = await hostVersion()
  return {
    dsh,
    dshLine: dsh ? (/^0\.1\./.test(dsh) ? '0.1.x' : /^0\.2\./.test(dsh) ? '0.2.x' : 'other') : 'unknown',
    settingsMode: settingsMode(ctx),
    node: process.version,
    platform: process.platform,
  }
}

/**
 * Doctor report. checks: [{ id, label, status: 'ok'|'warn'|'fail'|'skip'|'info', detail?, code?, hint?, docs?, human? }]
 * `human: true` marks a fix only the human can do (router, provider console, restart).
 * Values are reduced to booleans, numbers and short strings: pass `configured: true`, never the value.
 */
export function doctorReport({ plugin, version, host, checks = [], docs = 'docs/TROUBLESHOOTING.md' }) {
  const clean = checks.map((c) => {
    const status = STATUS_RANK[c.status] === undefined ? 'info' : c.status
    const out = { id: String(c.id), label: String(c.label || c.id), status }
    if (c.detail !== undefined) out.detail = typeof c.detail === 'string' ? c.detail.slice(0, 300) : c.detail
    for (const k of ['code', 'hint', 'docs']) if (c[k]) out[k] = String(c[k])
    if (c.human) out.human = true
    return out
  })
  const worst = clean.reduce((w, c) => Math.max(w, STATUS_RANK[c.status] || 0), 0)
  return toLossless({
    plugin,
    version,
    status: worst === 2 ? 'fail' : worst === 1 ? 'warn' : 'ok',
    host: host || null,
    checks: clean,
    docs,
    generatedAt: new Date().toISOString(),
  })
}

/** Run one async check and turn a throw into a fail row (a doctor never throws). */
export async function check(id, label, fn) {
  try {
    const r = await fn()
    if (r && typeof r === 'object' && r.status) return { id, label, ...r }
    return { id, label, status: r ? 'ok' : 'fail' }
  } catch (e) {
    return { id, label, status: 'fail', detail: String(e && e.message ? e.message : e).slice(0, 200) }
  }
}
