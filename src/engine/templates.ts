/**
 * Artifact templates: reuse a finished layout and only write the data.
 *
 * TypeScript port of the original Python engine (contrib/templates.py, removed after the port). Output is
 * byte-identical to it on every bundled template; test/parity.mjs proves that against the Python reference
 * taken from git history.
 *
 * A template is a folder with:
 *   template.json   id, title, purpose, when, not_for, kind (markdown|react|motion), schema (JSON Schema),
 *                   example (data object, or the name of a JSON file in the folder), entry / render / timing
 *   README.md       how to use it, what each field does, changes
 *   the files       template.md (markdown), index.html + app.jsx (react), composition.html (motion)
 *
 * Lookup order (first wins per id): $ARTIFACT_TEMPLATES (colon separated), ~/estate/templates/artifacts,
 * the user library ${DSH_HOME:-~/.dsh}/artifacts/templates, then the copy bundled with dsh-artifacts.
 *
 * Filling uses a small Mustache subset, no dependency:
 *   {{x}}  {{a.b}}  {{.}}       value (HTML-escaped for html kinds, verbatim for markdown)
 *   {{{x}}}                     verbatim in every kind
 *   {{#list}}..{{/list}}        repeat per item (dict items push their keys; @n, @first, @last are set)
 *   {{#flag}}..{{/flag}}  {{^x}}..{{/x}}   conditional / inverted
 *   {{x|filter}}                join[:sep] csv cells sep json oneline lower upper count default:text
 * Lines holding only a section tag disappear, so Markdown fences stay intact.
 *
 * Validation is a dependency-free JSON Schema subset: type, enum, const, required, properties,
 * additionalProperties, items, min/maxItems, min/maxLength, minimum, maximum, pattern, anyOf, oneOf,
 * default (filled in), plus x-asset (a local file copied next to the artifact).
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, accessSync, constants as FS } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PY_WS, collapseWs, htmlEscape, pyDumps, pyEq, pyLen, pyNum, pyRepr, pyRound, pyStr, pyStrip, pyTitle, wordCount } from './pyfmt.js'

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
export type Obj = { [k: string]: Json }
export type Schema = { [k: string]: any }
export type Source = 'custom' | 'estate' | 'user' | 'bundled'

export interface Template {
  id: string
  title?: string
  kind: string
  purpose?: string
  when?: string
  not_for?: string
  schema?: Schema
  example?: Json
  entry?: string
  render?: string[]
  skip?: string[]
  timing?: Schema
  size?: string
  dir: string
  source?: Source
  error?: string
  [k: string]: any
}

export class TemplateError extends Error {
  code: string
  errors?: string[]
  constructor(message: string, code = 'ARTIFACT_TEMPLATE_BROKEN', errors?: string[]) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
    if (errors) this.errors = errors
  }
}

const HERE = dirname(fileURLToPath(import.meta.url))
function real(p: string): string {
  try { return realpathSync(p) } catch { return p }
}
/** The plugin root (lib/engine/../..), symlinks resolved like the Python engine did. */
export const PLUGIN = real(resolve(HERE, '..', '..'))
export const BUNDLED = join(PLUGIN, 'templates')
export const KINDS = ['markdown', 'react', 'motion'] as const
const META_FILES = new Set(['template.json', 'README.md', 'preview.png', 'example'])
const DASHES: [string, string] = ['\u2014', '\u2013']

export interface Env { [k: string]: string | undefined }

function home(env: Env): string {
  return env.HOME || homedir()
}
function expandUser(p: string, env: Env): string {
  if (p === '~') return home(env)
  if (p.startsWith('~/')) return join(home(env), p.slice(2))
  return p
}
export function estateDir(env: Env = process.env): string {
  return join(home(env), 'estate', 'templates', 'artifacts')
}
/** The user library: where agents write templates by default. */
export function userDir(env: Env = process.env): string {
  const dsh = env.DSH_HOME ? resolve(expandUser(env.DSH_HOME, env)) : join(home(env), '.dsh')
  return join(dsh, 'artifacts', 'templates')
}
export function reportDir(env: Env = process.env): string {
  return real(resolve(expandUser(env.ARTIFACT_DIR || join(home(env), 'reports'), env)))
}
export function baseUrl(env: Env = process.env): string {
  return (env.ARTIFACT_BASE_URL || '/report').replace(/\/+$/, '')
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}
function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}
function exists(p: string): boolean {
  try { statSync(p); return true } catch { return false }
}
/** Path.resolve(strict=False): resolve symlinks of the part that exists. */
function resolveLoose(p: string): string {
  const abs = resolve(p)
  try { return realpathSync(abs) } catch { /* resolve the existing prefix */ }
  const parent = dirname(abs)
  if (parent === abs) return abs
  return join(resolveLoose(parent), basename(abs))
}
export function writable(dir: string): boolean {
  let d = resolve(dir)
  for (;;) {
    if (exists(d)) {
      try { accessSync(d, FS.W_OK); return isDir(d) } catch { return false }
    }
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
}

// -- discovery -------------------------------------------------------------------

export interface SearchDir { path: string, source: Source }

/** Every template folder in lookup order. Missing folders are left out (the user library is kept when writable). */
export function searchDirs(env: Env = process.env, opts: { includeMissingUser?: boolean } = {}): SearchDir[] {
  const out: SearchDir[] = []
  for (const p of (env.ARTIFACT_TEMPLATES || '').split(':')) {
    if (p.trim()) out.push({ path: expandUser(p, env), source: 'custom' })
  }
  out.push({ path: estateDir(env), source: 'estate' })
  out.push({ path: userDir(env), source: 'user' })
  out.push({ path: BUNDLED, source: 'bundled' })
  const seen = new Set<string>()
  const res: SearchDir[] = []
  for (const d of out) {
    const r = resolveLoose(d.path)
    if (seen.has(r)) continue
    if (isDir(d.path) || (opts.includeMissingUser && d.source === 'user')) {
      seen.add(r)
      res.push(d)
    }
  }
  return res
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function load(folder: string): Template | null {
  const p = join(folder, 'template.json')
  let raw: string
  try { raw = readFileSync(p, 'utf8') } catch (e: any) {
    if (e && e.code === 'ENOENT') return null
    throw new TemplateError(`${folder}/template.json is unreadable: ${e && e.message}`)
  }
  let t: any
  try { t = JSON.parse(raw) } catch (e: any) {
    throw new TemplateError(`${folder}/template.json is not valid JSON: ${e && e.message}`)
  }
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new TemplateError(`${folder}/template.json must hold an object`)
  t.dir = folder
  if (!('id' in t)) t.id = basename(folder)
  if (!(KINDS as readonly string[]).includes(t.kind)) throw new TemplateError(`${folder}: kind must be one of ${KINDS.join(', ')}`)
  return t as Template
}

/** Python's sorted(Path.iterdir()) order for names in one folder. */
function sortNames(names: string[]): string[] {
  return names.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export function allTemplates(env: Env = process.env): Template[] {
  const found = new Map<string, Template>()
  for (const d of searchDirs(env)) {
    let names: string[]
    try { names = sortNames(readdirSync(d.path)) } catch { continue }
    for (const name of names) {
      const sub = join(d.path, name)
      if (!isDir(sub) || name.startsWith('.') || name.startsWith('_')) continue
      let t: Template | null
      try { t = load(sub) } catch (e: any) {
        t = { id: name, error: String(e && e.message), dir: sub, kind: '?', title: name }
      }
      if (t && !found.has(t.id)) {
        t.source = d.source
        found.set(t.id, t)
      }
    }
  }
  return [...found.keys()].sort().map((k) => found.get(k) as Template)
}

export function get(tid: string, env: Env = process.env): Template {
  const all = allTemplates(env)
  for (const t of all) {
    if (t.id === tid) {
      if (t.error) throw new TemplateError(t.error, 'ARTIFACT_TEMPLATE_BROKEN')
      return t
    }
  }
  const ids = all.map((t) => t.id).join(', ') || '(none)'
  throw new TemplateError(`no template ${pyRepr(String(tid))} (available: ${ids})`, 'ARTIFACT_TEMPLATE_NOT_FOUND')
}

export function exampleOf(t: Template): Json {
  const ex = t.example
  if (typeof ex === 'string') {
    const p = join(t.dir, ex)
    try { return readJson(p) as Json } catch (e: any) {
      throw new TemplateError(`${t.id}: example file ${p} unreadable: ${e && e.message}`)
    }
  }
  if (ex === null || ex === undefined) throw new TemplateError(`${t.id}: template.json has no example`)
  return structuredClone(ex)
}

export function previewRel(t: Template): string {
  const stem = 'template-preview-' + t.id
  return t.kind === 'react' ? stem + '/' : stem + '.html'
}

// -- schema summary + minimal example ---------------------------------------------

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function isJsonObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function typeOf(s: unknown): string {
  if (!isObj(s)) return 'any'
  if ('enum' in s && Array.isArray(s.enum)) return s.enum.map((v: unknown) => pyStr(v)).join('|')
  const ty = s.type ?? 'any'
  return Array.isArray(ty) ? ty.join('|') : String(ty)
}

/** One line: title*, sections*[heading*, body*], kpis[label*, value*] */
export function summary(schema: unknown, depth = 0): string {
  const props: Record<string, any> = isObj(schema) && isObj(schema.properties) ? schema.properties : {}
  const req = new Set<string>(isObj(schema) && Array.isArray(schema.required) ? schema.required : [])
  const parts: string[] = []
  for (const [k, s] of Object.entries(props)) {
    const mark = req.has(k) ? '*' : ''
    const ty = isObj(s) ? s.type : undefined
    if (ty === 'array' && isObj(s.items) && isObj(s.items.properties) && Object.keys(s.items.properties).length && depth < 2) parts.push(`${k}${mark}[${summary(s.items, depth + 1)}]`)
    else if (ty === 'object' && isObj(s.properties) && Object.keys(s.properties).length && depth < 2) parts.push(`${k}${mark}{${summary(s, depth + 1)}}`)
    else if (ty === 'array') parts.push(`${k}${mark}[]`)
    else parts.push(k + mark)
  }
  return parts.join(', ')
}

export interface Field { path: string, type: string, required: boolean, description: string, default: Json | null }

/** Flat field table. */
export function fields(schema: Schema, prefix = '', out: Field[] = []): Field[] {
  const props: Record<string, any> = isObj(schema.properties) ? schema.properties : {}
  const req = new Set<string>(Array.isArray(schema.required) ? schema.required : [])
  for (const [k, s0] of Object.entries(props)) {
    const s = isObj(s0) ? s0 : {}
    const path = prefix + k
    const extra = s['x-asset'] ? ' (local file, copied next to the artifact)' : ''
    out.push({ path, type: typeOf(s), required: req.has(k), description: pyStrip((typeof s.description === 'string' ? s.description : '') + extra), default: s.default === undefined ? null : s.default })
    if (s.type === 'object' && isObj(s.properties) && Object.keys(s.properties).length) fields(s, path + '.', out)
    const it = s.items
    if (s.type === 'array' && isObj(it)) {
      if (isObj(it.properties) && Object.keys(it.properties).length) fields(it, path + '[].', out)
      else if (it.type === 'array' && isObj(it.items) && isObj(it.items.properties) && Object.keys(it.items.properties).length) fields(it.items, path + '[][].', out)
    }
  }
  return out
}

/** Prune an example to what the schema requires (arrays keep one item). */
export function minimal(schema: unknown, value: Json): Json {
  if (!isObj(schema)) return value
  if (isJsonObj(value) && isObj(schema.properties) && Object.keys(schema.properties).length) {
    const req: string[] = Array.isArray(schema.required) ? schema.required : []
    const out: Obj = {}
    for (const k of req) if (k in value) out[k] = minimal(schema.properties[k] ?? {}, value[k])
    return out
  }
  if (Array.isArray(value)) {
    const n = Math.max(1, typeof schema.minItems === 'number' ? schema.minItems : 1)
    return value.slice(0, n).map((v) => minimal(schema.items ?? {}, v))
  }
  return value
}

// -- validation ------------------------------------------------------------------

function isType(v: unknown, ty: string): boolean {
  switch (ty) {
    case 'null': return v === null
    case 'integer': return typeof v === 'number' && Number.isInteger(v)
    case 'number': return typeof v === 'number'
    case 'boolean': return typeof v === 'boolean'
    case 'string': return typeof v === 'string'
    case 'object': return isObj(v)
    case 'array': return Array.isArray(v)
    default: return true
  }
}

function nameOf(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number') return 'number'
  if (typeof v === 'string') return 'string'
  if (Array.isArray(v)) return 'array'
  return 'object'
}

/** A Python `re` pattern as a JavaScript RegExp: leading inline flags, \A \Z, named groups. Throws when invalid. */
export function compilePattern(p: string): RegExp {
  let src = p
  let flags = ''
  const m = /^\(\?([aiLmsux]+)\)/.exec(src)
  if (m) {
    src = src.slice(m[0].length)
    for (const f of m[1]) if ('ims'.includes(f) && !flags.includes(f)) flags += f
  }
  src = src.replace(/\\A/g, '^').replace(/\\Z/g, '$').replace(/\(\?P</g, '(?<').replace(/\(\?P=(\w+)\)/g, '\\k<$1>')
  try { return new RegExp(src, flags + 'u') } catch { return new RegExp(src, flags) }
}

/** Return a list of 'path: problem' strings. Fills schema defaults into data in place. */
export function validate(schema: unknown, data: Json, path = 'data', errors: string[] = []): string[] {
  if (!isObj(schema)) return errors
  const ty = schema.type
  if (ty) {
    const tys: string[] = Array.isArray(ty) ? ty : [ty]
    if (!tys.some((t) => isType(data, t))) {
      errors.push(`${path}: expected ${tys.join(' or ')}, got ${nameOf(data)}`)
      return errors
    }
  }
  if ('const' in schema && !pyEq(data, schema.const)) errors.push(`${path}: must be ${pyDumps(schema.const)}`)
  if ('enum' in schema && Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => pyEq(data, e))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v: unknown) => pyDumps(v)).join(', ')} (got ${pyDumps(data)})`)
  }
  for (const kw of ['anyOf', 'oneOf']) {
    if (kw in schema && Array.isArray(schema[kw])) {
      const ok = schema[kw].filter((s: unknown) => !validate(s, structuredClone(data), path).length)
      if (!ok.length || (kw === 'oneOf' && ok.length > 1)) errors.push(`${path}: does not match ${kw === 'anyOf' ? 'any' : 'exactly one'} of the allowed shapes`)
    }
  }
  if (typeof data === 'string') {
    const n = pyLen(data)
    if (n < (typeof schema.minLength === 'number' ? schema.minLength : 0)) errors.push(`${path}: too short (min ${Math.trunc(schema.minLength)} characters)`)
    if ('maxLength' in schema && n > schema.maxLength) errors.push(`${path}: too long (${n} characters, max ${Math.trunc(schema.maxLength)})`)
    if ('pattern' in schema && !compilePattern(String(schema.pattern)).test(data)) errors.push(`${path}: does not match the pattern ${schema.pattern}`)
  }
  if (typeof data === 'number') {
    if ('minimum' in schema && data < schema.minimum) errors.push(`${path}: ${pyNum(data)} is below the minimum ${pyStr(schema.minimum)}`)
    if ('maximum' in schema && data > schema.maximum) errors.push(`${path}: ${pyNum(data)} is above the maximum ${pyStr(schema.maximum)}`)
  }
  if (Array.isArray(data)) {
    if (data.length < (typeof schema.minItems === 'number' ? schema.minItems : 0)) errors.push(`${path}: needs at least ${Math.trunc(schema.minItems)} item(s), has ${data.length}`)
    if ('maxItems' in schema && data.length > schema.maxItems) errors.push(`${path}: at most ${Math.trunc(schema.maxItems)} item(s), has ${data.length}`)
    if (isObj(schema.items)) data.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors))
  }
  if (isJsonObj(data)) {
    const props: Record<string, any> = isObj(schema.properties) ? schema.properties : {}
    for (const k of Array.isArray(schema.required) ? schema.required : []) {
      if (!(k in data)) {
        if (isObj(props[k]) && 'default' in props[k]) continue
        errors.push(`${path}: missing required property "${k}"`)
      }
    }
    for (const [k, s] of Object.entries(props)) {
      if (!(k in data) && isObj(s) && 'default' in s) data[k] = structuredClone(s.default)
    }
    const extra = 'additionalProperties' in schema ? schema.additionalProperties : true
    for (const [k, v] of Object.entries(data)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(props[k], v, `${path}.${k}`, errors)
      else if (extra === false) errors.push(`${path}.${k}: unknown property (allowed: ${Object.keys(props).join(', ')})`)
      else if (isObj(extra)) validate(extra, v, `${path}.${k}`, errors)
    }
  }
  return errors
}

/** House-style warnings: em and en dashes. Not fatal. */
export function lintText(data: unknown, path = 'data', out: string[] = []): string[] {
  if (typeof data === 'string') {
    for (const [ch, nm] of [[DASHES[0], 'an em dash'], [DASHES[1], 'an en dash']]) {
      if (data.includes(ch)) out.push(`${path}: contains ${nm}; use a comma, colon or full stop`)
    }
  } else if (Array.isArray(data)) {
    data.forEach((v, i) => lintText(v, `${path}[${i}]`, out))
  } else if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) lintText(v, `${path}.${k}`, out)
  }
  return out
}

const S = '[' + PY_WS + ']'
export const SECRET_PATTERNS = [
  /sk-ant-(oat|api)|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|ghp|gho|xox[baprs])-[A-Za-z0-9]{16,}/,
  new RegExp('(^|' + S + '|")([A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)' + S + '*[=:]' + S + '*[^' + PY_WS + ']{8,}'),
]
export const SECRET_MESSAGE = 'data: contains a credential-shaped string; artifacts are served over HTTP, report status, never values'

export function hasSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text))
}

export function secretCheck(data: unknown): string[] {
  return hasSecret(pyDumps(data, { ensureAscii: false })) ? [SECRET_MESSAGE] : []
}

/** [errors, warnings] for data against template t. Fills defaults in place.
 *  With base (the data file's folder) local asset files are checked too. */
export function check(t: Template, data: Obj, base?: string | null): [string[], string[]] {
  const errors = validate(t.schema ?? {}, data)
  errors.push(...secretCheck(data))
  if (base !== undefined && base !== null && !errors.length) collectAssets(t.schema ?? {}, data, base, errors)
  return [errors, lintText(data)]
}

// -- assets ----------------------------------------------------------------------

function isUrl(s: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(s)
}

function assetSource(data: string, base: string, env: Env): string {
  const ex = expandUser(data, env)
  if (isAbsolute(ex)) return ex
  return resolveLoose(join(base, ex))
}

/** Map of copied file name to source path, in insertion order. */
export function collectAssets(schema: unknown, data: Json, base: string, errors: string[], path = 'data', copied: Map<string, string> = new Map(), env: Env = process.env): Map<string, string> {
  if (!isObj(schema)) return copied
  if (schema['x-asset'] && typeof data === 'string' && data && !isUrl(data)) {
    const src = assetSource(data, base, env)
    if (!isFile(src)) {
      errors.push(`${path}: file not found: ${src}`)
      return copied
    }
    let name = basename(src).replace(/[^A-Za-z0-9._-]+/g, '-')
    if (copied.has(name) && copied.get(name) !== src) {
      const ext = pyExt(name)
      name = `${name.slice(0, name.length - ext.length)}-${copied.size}${ext}`
    }
    copied.set(name, src)
    return copied
  }
  if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) collectAssets(isObj(schema.properties) ? schema.properties[k] ?? {} : {}, v, base, errors, `${path}.${k}`, copied, env)
  } else if (Array.isArray(data)) {
    data.forEach((v, i) => collectAssets(schema.items ?? {}, v, base, errors, `${path}[${i}]`, copied, env))
  }
  return copied
}

/** os.path.splitext(name)[1]: leading dots do not start an extension. */
function pyExt(name: string): string {
  const e = extname(name)
  return e === name ? '' : e
}

export function rewriteAssets(schema: unknown, data: Json, base: string, prefix: string, copied: Map<string, string>, env: Env = process.env): Json {
  if (!isObj(schema)) return data
  if (schema['x-asset'] && typeof data === 'string' && data && !isUrl(data)) {
    const src = assetSource(data, base, env)
    for (const [name, p] of copied) if (p === src) return prefix + name
    return data
  }
  if (isObj(data)) {
    const out: Obj = {}
    for (const [k, v] of Object.entries(data)) out[k] = rewriteAssets(isObj(schema.properties) ? schema.properties[k] ?? {} : {}, v, base, prefix, copied, env)
    return out
  }
  if (Array.isArray(data)) return data.map((v) => rewriteAssets(schema.items ?? {}, v, base, prefix, copied, env))
  return data
}

// -- derived fields (declared in template.json "timing") ---------------------------

function words(v: unknown): number {
  if (typeof v === 'string') return wordCount(v)
  if (Array.isArray(v)) return v.reduce((a: number, x) => a + words(x), 0)
  if (isObj(v)) return Object.values(v).reduce((a: number, x) => a + words(x), 0)
  return 0
}

const NON_WORD = /[^\p{L}\p{N}_]/gu

/** Declared but missing properties become null, so {{x}} inside an item never falls back to an outer value
 *  with the same name; every object with a string "type" gets an is_<type> flag. */
export function prepare(schema: unknown, data: Json): Json {
  if (Array.isArray(data)) return data.map((v) => prepare(isObj(schema) ? schema.items ?? {} : {}, v))
  if (!isObj(data)) return data
  const props: Record<string, any> = isObj(schema) && isObj(schema.properties) ? schema.properties : {}
  const out: Obj = {}
  for (const [k, v] of Object.entries(data)) out[k] = prepare(props[k] ?? {}, v)
  for (const k of Object.keys(props)) if (!(k in out)) out[k] = null
  if (typeof out.type === 'string') out['is_' + out.type.replace(NON_WORD, '_')] = true
  return out
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' ? v : d
}

/** Scene timing for templates that declare "timing" in template.json. */
export function derive(t: Template, data: Obj): Obj {
  const tm = t.timing
  if (!tm) return data
  const list = data[typeof tm.list === 'string' ? tm.list : 'scenes']
  const items = Array.isArray(list) ? list : []
  let start = 0
  items.forEach((it, i) => {
    if (!isJsonObj(it)) return
    it.sid = `s${i + 1}`
    if (!pyTruthy(it.seconds)) {
      const textFields: string[] = Array.isArray(tm.text_fields) ? tm.text_fields : []
      const w = textFields.reduce((a, f) => a + words(it[f]), 0)
      const byType = isObj(tm.min_by_type) ? tm.min_by_type : {}
      const key = pyStr(it.type ?? null)
      const perType = Object.prototype.hasOwnProperty.call(byType, key) ? byType[key] : num(tm.min, 2.5)
      it.seconds = pyRound(Math.min(num(tm.max, 9), Math.max(perType, num(tm.base, 1.5) + w * num(tm.per_word, 0.3))), 2)
    }
    it.start = pyRound(start, 2)
    start += Number(it.seconds)
    it.end = pyRound(start, 2)
  })
  data._duration = pyRound(start, 2)
  return data
}

// -- mustache subset ---------------------------------------------------------------

type Node = { t: 'text', s: string } | { t: 'var', name: string, raw: boolean } | { t: 'sec', name: string, inv: boolean, kids: Node[] }

const STANDALONE = new RegExp('(?<=^|\\n)[ \\t]*(\\{\\{' + S + '*[#^/!][^}]*\\}\\})[ \\t]*\\r?\\n', 'g')
const TAG = new RegExp('\\{\\{\\{' + S + '*(.+?)' + S + '*\\}\\}\\}|\\{\\{' + S + '*([#^/!&]?)' + S + '*(.+?)' + S + '*\\}\\}', 'g')

export function parse(tpl0: string): Node[] {
  const tpl = tpl0.replace(STANDALONE, '$1')
  const root: Node[] = []
  const stack: [string, Node[]][] = [['', root]]
  let pos = 0
  for (const m of tpl.matchAll(TAG)) {
    const at = m.index as number
    if (at > pos) stack[stack.length - 1][1].push({ t: 'text', s: tpl.slice(pos, at) })
    pos = at + m[0].length
    if (m[1] !== undefined) {
      stack[stack.length - 1][1].push({ t: 'var', name: m[1], raw: true })
      continue
    }
    const sig = m[2]
    const name = m[3]
    if (sig === '!') continue
    if (sig === '#' || sig === '^') {
      const node: Node = { t: 'sec', name, inv: sig === '^', kids: [] }
      stack[stack.length - 1][1].push(node)
      stack.push([name, node.kids])
    } else if (sig === '/') {
      if (stack.length === 1 || stack[stack.length - 1][0] !== name) {
        throw new TemplateError(`template: {{/${name}}} closes ${stack.length > 1 ? `{{#${stack[stack.length - 1][0]}}}` : 'nothing'}`, 'ARTIFACT_RENDER_FAILED')
      }
      stack.pop()
    } else {
      stack[stack.length - 1][1].push({ t: 'var', name, raw: sig === '&' })
    }
  }
  if (stack.length > 1) throw new TemplateError(`template: {{#${stack[stack.length - 1][0]}}} is never closed`, 'ARTIFACT_RENDER_FAILED')
  if (pos < tpl.length) root.push({ t: 'text', s: tpl.slice(pos) })
  return root
}

function lookup(stack: unknown[], name: string): unknown {
  if (name === '.') return stack[stack.length - 1]
  const parts = name.split('.')
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i]
    if (isObj(frame) && Object.prototype.hasOwnProperty.call(frame, parts[0])) {
      let v: unknown = frame[parts[0]]
      for (const p of parts.slice(1)) {
        if (isObj(v)) v = Object.prototype.hasOwnProperty.call(v, p) ? v[p] : null
        else if (Array.isArray(v) && /^[0-9]+$/.test(p) && Number(p) < v.length) v = v[Number(p)]
        else return null
      }
      return v
    }
  }
  return null
}

function scalar(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return pyNum(v)
  if (typeof v === 'object') return pyDumps(v, { ensureAscii: false })
  return String(v)
}

function csvCell(v: unknown): string {
  const s = scalar(v)
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Python truthiness of a JSON value. */
export function pyTruthy(v: unknown): boolean {
  return !isEmptyValue(v) && v !== 0
}

function isEmptyValue(v: unknown): boolean {
  return v === null || v === undefined || v === false || v === '' || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0)
}

export function applyFilter(v: unknown, f: string): unknown {
  const i = f.indexOf(':')
  const name = pyStrip(i < 0 ? f : f.slice(0, i))
  const arg = i < 0 ? '' : f.slice(i + 1)
  const seq: unknown[] = Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]
  switch (name) {
    case 'join': return seq.map(scalar).join(arg || ', ')
    case 'csv': return seq.map(csvCell).join(',')
    case 'cells': return seq.map((x) => collapseWs(scalar(x)).replace(/\|/g, '\\|')).join(' | ')
    case 'sep': return seq.map(() => '---').join('|')
    case 'json': return pyDumps(v, { ensureAscii: false })
    case 'oneline': return pyStrip(collapseWs(scalar(v)))
    case 'lower': return scalar(v).toLowerCase()
    case 'upper': return scalar(v).toUpperCase()
    case 'count': return seq.length
    case 'default': return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) ? arg : v
  }
  throw new TemplateError(`template: unknown filter ${pyRepr(name)}`, 'ARTIFACT_RENDER_FAILED')
}

function render(nodes: Node[], stack: unknown[], escape: boolean): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') out += n.s
    else if (n.t === 'var') {
      const [name, ...filters] = n.name.split('|').map(pyStrip)
      let v = lookup(stack, name)
      for (const f of filters) v = applyFilter(v, f)
      if (Array.isArray(v) && !filters.length) v = v.map(scalar).join(', ')
      const s = scalar(v)
      out += n.raw || !escape ? s : htmlEscape(s)
    } else {
      const v = lookup(stack, n.name)
      const empty = isEmptyValue(v)
      if (n.inv) {
        if (empty) out += render(n.kids, stack, escape)
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          const frame = { '@n': i + 1, '@index': i, '@first': i === 0, '@last': i === v.length - 1 }
          out += render(n.kids, [...stack, frame, item], escape)
        })
      } else if (!empty) {
        out += render(n.kids, [...stack, v], escape)
      }
    }
  }
  return out
}

export function fill(tpl: string, data: unknown, escape: boolean): string {
  return render(parse(tpl), [data], escape)
}

// -- create ------------------------------------------------------------------------

function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function context(t: Template, data: Obj, name: string, title: string): Obj {
  const ctx: Obj = { ...data }
  if (!('title' in ctx)) ctx.title = title
  ctx._name = name
  ctx._template = t.id
  ctx._date = today()
  return ctx
}

/** Text as Python's read_text() returns it: universal newlines. */
function readText(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')
}

/** Every path under dir (files and folders), in Python's sorted(Path.rglob("*")) order. */
function walk(dir: string): string[] {
  const out: string[][] = []
  const rec = (rel: string[]) => {
    let ents
    try { ents = readdirSync(join(dir, ...rel), { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const r = [...rel, e.name]
      out.push(r)
      if (e.isDirectory()) rec(r)
    }
  }
  rec([])
  out.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
    return a.length - b.length
  })
  return out.map((parts) => parts.join(sep))
}

const MOTION_SIZES: Record<string, [number, number]> = {
  landscape: [1920, 1080], '1080p': [1920, 1080], portrait: [1080, 1920], vertical: [1080, 1920], square: [1080, 1080], '720p': [1280, 720],
}

export function parseSize(s: unknown): [number, number] {
  if (!s) return MOTION_SIZES.landscape
  const v = String(s).toLowerCase()
  if (Object.prototype.hasOwnProperty.call(MOTION_SIZES, v)) return MOTION_SIZES[v]
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(v)
  if (!m) throw new TemplateError('--size must be landscape|portrait|square|720p|WxH', 'ARTIFACT_DATA_INVALID')
  return [parseInt(m[1], 10), parseInt(m[2], 10)]
}

function motionEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The motion player page + project skeleton (the part of the motion scaffold a template keeps). */
function motionScaffold(reportDirPath: string, stem: string, title: string, w: number, h: number, warnings: string[]): void {
  const proj = join(reportDirPath, stem + '.motion')
  const page = join(reportDirPath, stem + '.html')
  for (const p of [proj, page]) if (exists(p)) throw new TemplateError(`${p} already exists: edit it instead`, 'ARTIFACT_EXISTS')
  const playerSrc = join(PLUGIN, 'contrib', 'motion-player.html')
  const player = readText(playerSrc).replaceAll('__TITLE__', motionEsc(title)).replaceAll('__NAME__', stem).replaceAll('__W__', String(w)).replaceAll('__H__', String(h))
  mkdirSync(join(proj, 'vendor'), { recursive: true })
  mkdirSync(join(proj, 'assets'))
  const gsap = join(PLUGIN, 'vendor', 'gsap.js')
  if (isFile(gsap)) copyFileSync(gsap, join(proj, 'vendor', 'gsap.min.js'))
  else warnings.push('motion: vendor/gsap.js is missing in the plugin (run scripts/vendor.sh), the composition will not animate until vendor/gsap.min.js exists')
  writeFileSync(join(proj, 'vendor', 'README.txt'),
    'GSAP core is copied here so the project renders on any machine (local or a remote render host).\n'
    + 'Need a plugin (SplitText, MotionPath, DrawSVG, Flip...)? Copy it next to gsap.min.js:\n'
    + `  cp ${join(PLUGIN, 'vendor', 'gsap')}/<Plugin>.min.js vendor/   and add <script src="vendor/<Plugin>.min.js"></script>\n`)
  // the scaffold composition is replaced right away by the filled template, so it is not written here
  writeFileSync(page, player)
}

export interface CreateResult {
  kind: string
  rel: string
  files: string[]
  warnings: string[]
  duration?: number
}

export interface CreateOptions {
  force?: boolean
  title?: string | null
  env?: Env
}

/** Validate, copy assets, fill and write. */
export function create(t: Template, data: Obj, reportDirPath: string, stem: string, baseDir: string, opts: CreateOptions = {}): CreateResult {
  const env = opts.env ?? process.env
  const force = !!opts.force
  const [errors, warnings] = check(t, data)
  if (errors.length) throw new TemplateError(`data does not fit template ${t.id}:\n  ${errors.join('\n  ')}`, errors.includes(SECRET_MESSAGE) ? 'ARTIFACT_SECRET_REFUSED' : 'ARTIFACT_DATA_INVALID', errors)
  const tdir = t.dir
  const kind = t.kind
  const title = opts.title || (pyTruthy(data.title) ? (typeof data.title === 'string' ? data.title : scalar(data.title)) : '') || pyTitle(stem.replace(/-/g, ' '))
  let target: string, assetDir: string, prefix: string
  if (kind === 'markdown') {
    target = join(reportDirPath, stem + '.md')
    assetDir = join(reportDirPath, stem + '-files')
    prefix = stem + '-files/'
  } else if (kind === 'react') {
    target = join(reportDirPath, stem)
    assetDir = join(target, 'assets')
    prefix = 'assets/'
  } else {
    target = join(reportDirPath, stem + '.motion')
    assetDir = join(target, 'assets')
    prefix = 'assets/'
  }
  if (exists(target) && !force) throw new TemplateError(`${target} already exists: edit it, or pass --force to regenerate it from the data`, 'ARTIFACT_EXISTS')
  const aerr: string[] = []
  const copied = collectAssets(t.schema ?? {}, data, baseDir, aerr, 'data', new Map(), env)
  if (aerr.length) throw new TemplateError(`data does not fit template ${t.id}:\n  ${aerr.join('\n  ')}`, 'ARTIFACT_DATA_INVALID', aerr)
  const rdata = rewriteAssets(t.schema ?? {}, data, baseDir, prefix, copied, env) as Obj
  const view = derive(t, prepare(t.schema ?? {}, structuredClone(rdata)) as Obj)
  const ctx = context(t, view, stem, title)
  const files: string[] = []
  const putAssets = () => {
    if (copied.size) {
      mkdirSync(assetDir, { recursive: true })
      for (const [nm, src] of copied) {
        copyFileSync(src, join(assetDir, nm))
        files.push(join(assetDir, nm))
      }
    }
  }
  const cleanJson = () => {
    const clean: Obj = {}
    for (const [k, v] of Object.entries(rdata)) if (!k.startsWith('_')) clean[k] = v
    return pyDumps(clean, { ensureAscii: false, indent: 2 }) + '\n'
  }
  mkdirSync(reportDirPath, { recursive: true })

  if (kind === 'markdown') {
    const tpl = readText(join(tdir, t.entry || 'template.md'))
    let out = fill(tpl, ctx, false)
    out = pyStrip(out.replace(/\n{3,}/g, '\n\n')) + '\n'
    putAssets()
    writeFileSync(target, out)
    files.push(target)
    return { kind, rel: basename(target), files, warnings }
  }
  if (kind === 'react') {
    const renderSet = new Set<string>(Array.isArray(t.render) ? t.render : ['index.html'])
    const skip = new Set<string>(Array.isArray(t.skip) ? t.skip : [])
    // fill every rendered file first, so a broken template writes nothing
    const plan: [string, string, string | null][] = []
    for (const relp of walk(tdir)) {
      const src = join(tdir, relp)
      const parts = relp.split(sep)
      const name = parts[parts.length - 1]
      if (META_FILES.has(parts[0]) || parts.some((p) => p.startsWith('.')) || skip.has(name) || isDir(src)) continue
      if (relp === t.example || name.startsWith('data.example')) continue
      plan.push([src, join(target, relp), renderSet.has(relp) ? fill(readText(src), ctx, true) : null])
    }
    mkdirSync(target, { recursive: true })
    for (const [src, dst, text] of plan) {
      mkdirSync(dirname(dst), { recursive: true })
      if (text !== null) writeFileSync(dst, text)
      else copyFileSync(src, dst)
      files.push(dst)
    }
    putAssets()
    writeFileSync(join(target, 'data.json'), cleanJson())
    files.push(join(target, 'data.json'))
    return { kind, rel: stem, files, warnings }
  }
  // motion: the player page and project skeleton, then the filled composition
  const size = (data.size || t.size) as string | undefined
  const page = join(reportDirPath, stem + '.html')
  const vd = view._duration
  const dur = Math.max(3, (typeof vd === 'number' && vd) ? vd : 12)
  const [w, h] = parseSize(size)
  Object.assign(ctx, { _w: w, _h: h, _u: w >= h ? h : pyRound(w * 1.5), _duration: dur })
  const comp = fill(readText(join(tdir, t.entry || 'composition.html')), ctx, true)
  if (!isFile(join(target, 'index.html'))) {
    if (exists(page) && !force) throw new TemplateError(`${page} already exists`, 'ARTIFACT_EXISTS')
    if (exists(page)) unlinkSync(page)
    if (exists(target)) rmSync(target, { recursive: true, force: true })
    motionScaffold(reportDirPath, stem, title, w, h, warnings)
  }
  putAssets()
  writeFileSync(join(target, 'index.html'), comp)
  files.push(page, join(target, 'index.html'))
  writeFileSync(join(target, 'data.json'), cleanJson())
  return { kind, rel: basename(page), files, warnings, duration: dur }
}

// -- helpers shared by the CLI and the agent tools -----------------------------------

/** The URL-facing name of a created artifact (x.md is served rendered as x.html, folders end in /). */
export function urlFor(rel: string, env: Env = process.env): string {
  const base = baseUrl(env)
  if (isDir(join(reportDir(env), rel))) return `${base}/${rel}/`
  return `${base}/${rel.endsWith('.md') ? rel.slice(0, -3) + '.html' : rel}`
}

/** A safe artifact stem (no folders, no dot files), or null. A trailing .md or .html is dropped. */
export function safeStem(name: unknown): string | null {
  if (typeof name !== 'string') return null
  let s = name.trim().replace(/^\/+|\/+$/g, '')
  if (s.endsWith('.md') || s.endsWith('.html')) s = s.slice(0, s.lastIndexOf('.'))
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) || s.includes('..')) return null
  return s
}

/** The README text without the trailing Changes list, capped. */
export function readmeSummary(dir: string, max = 2000): { path: string, summary: string } {
  const p = join(dir, 'README.md')
  let txt = ''
  try { txt = readText(p) } catch { return { path: p, summary: '' } }
  const cut = txt.search(/^#{1,3}\s+Changes\b/m)
  if (cut > 0) txt = txt.slice(0, cut)
  txt = txt.trim()
  if (txt.length > max) txt = txt.slice(0, max).replace(/\s+\S*$/, '') + ' [...]'
  return { path: p, summary: txt }
}

/** Every file of a template folder, relative, sorted. */
export function templateFiles(dir: string): string[] {
  return walk(dir).filter((r) => {
    try { return lstatSync(join(dir, r)).isFile() } catch { return false }
  }).map((r) => r.split(sep).join('/'))
}

export function relTo(base: string, p: string): string | null {
  const r = relative(base, p)
  return r && !r.startsWith('..') && !isAbsolute(r) ? r.split(sep).join('/') : null
}

export { existsSync }
