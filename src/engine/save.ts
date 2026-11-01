/**
 * Create or update a template in a writable library (artifact_template_save).
 *
 * The target library is $ARTIFACT_TEMPLATES_WRITE when set, else the first writable $ARTIFACT_TEMPLATES entry,
 * else the user library ${DSH_HOME:-~/.dsh}/artifacts/templates. The bundled copy inside the plugin is never written.
 *
 * Everything is checked in a staging folder first (schema well-formed, example valid, files inside the folder,
 * no credential-shaped strings, size limits, and a trial render of the example), then swapped into place, so a
 * refused save leaves the library untouched.
 */
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  BUNDLED, KINDS, TemplateError, allTemplates, create, hasSecret, lintText, load, searchDirs, templateFiles, userDir, validate, writable, compilePattern,
  type Env, type Json, type Obj, type Schema, type Source, check,
} from './templates.js'
import { realpathSync, existsSync, statSync } from 'node:fs'

export const LIMITS = {
  idMax: 48,
  titleMax: 120,
  textMax: 600,
  readmeMax: 64 * 1024,
  schemaMax: 256 * 1024,
  fileMax: 512 * 1024,
  totalMax: 4 * 1024 * 1024,
  filesMax: 60,
  depthMax: 4,
}

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PART_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/
const RESERVED = new Set(['template.json', 'README.md'])
const SCHEMA_KEYS = new Set([
  'type', 'enum', 'const', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength',
  'maxLength', 'minimum', 'maximum', 'pattern', 'anyOf', 'oneOf', 'default', 'description', 'title', 'examples', 'x-asset',
  'format', '$comment',
])
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'])

export interface SaveArgs {
  id?: unknown
  title?: unknown
  kind?: unknown
  purpose?: unknown
  when?: unknown
  not_for?: unknown
  schema?: unknown
  example?: unknown
  files?: unknown
  readme?: unknown
  entry?: unknown
  render?: unknown
  timing?: unknown
  size?: unknown
  overwrite?: unknown
}

export interface SaveResult {
  ok: true
  id: string
  action: 'created' | 'updated'
  dir: string
  library: string
  source: Source
  overrides: string | null
  files: string[]
  warnings: string[]
}

function isObj(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function real(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

function inside(child: string, parent: string): boolean {
  const c = real(child)
  const p = real(parent)
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/')
}

/** Where artifact_template_save writes. */
export function writeTarget(env: Env = process.env): { path: string, source: Source } {
  if (env.ARTIFACT_TEMPLATES_WRITE && env.ARTIFACT_TEMPLATES_WRITE.trim()) return { path: resolve(env.ARTIFACT_TEMPLATES_WRITE.trim().replace(/^~(?=\/|$)/, env.HOME || '')), source: 'custom' }
  for (const p of (env.ARTIFACT_TEMPLATES || '').split(':')) {
    const d = p.trim().replace(/^~(?=\/|$)/, env.HOME || '')
    if (d && writable(d) && !inside(d, BUNDLED)) return { path: resolve(d), source: 'custom' }
  }
  return { path: userDir(env), source: 'user' }
}

/** Structural problems of a JSON Schema (errors) and unsupported keywords (warnings). */
export function schemaProblems(s: unknown, path: string, errors: string[], warnings: string[]): void {
  if (!isObj(s)) { errors.push(`${path}: must be an object`); return }
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) warnings.push(`${path}.${k}: keyword not supported by the validator, it is ignored`)
  if ('type' in s) {
    const tys = Array.isArray(s.type) ? s.type : [s.type]
    if (!tys.length || tys.some((t: unknown) => typeof t !== 'string' || !TYPES.has(t))) errors.push(`${path}.type: must be one of ${[...TYPES].join(', ')} (or a list of them)`)
  }
  if ('properties' in s) {
    if (!isObj(s.properties)) errors.push(`${path}.properties: must be an object of schemas`)
    else for (const [k, v] of Object.entries(s.properties)) schemaProblems(v, `${path}.properties.${k}`, errors, warnings)
  }
  if ('required' in s) {
    if (!Array.isArray(s.required) || s.required.some((x: unknown) => typeof x !== 'string')) errors.push(`${path}.required: must be a list of property names`)
    else if (isObj(s.properties)) for (const k of s.required) if (!(k in s.properties)) errors.push(`${path}.required: "${k}" is not in properties`)
  }
  if ('items' in s) {
    if (!isObj(s.items)) errors.push(`${path}.items: must be one schema object`)
    else schemaProblems(s.items, `${path}.items`, errors, warnings)
  }
  if ('additionalProperties' in s && typeof s.additionalProperties !== 'boolean') {
    if (isObj(s.additionalProperties)) schemaProblems(s.additionalProperties, `${path}.additionalProperties`, errors, warnings)
    else errors.push(`${path}.additionalProperties: must be true, false or a schema`)
  }
  if ('enum' in s && (!Array.isArray(s.enum) || !s.enum.length)) errors.push(`${path}.enum: must be a non-empty list`)
  for (const kw of ['anyOf', 'oneOf']) {
    if (kw in s) {
      if (!Array.isArray(s[kw]) || !s[kw].length) errors.push(`${path}.${kw}: must be a non-empty list of schemas`)
      else s[kw].forEach((x: unknown, i: number) => schemaProblems(x, `${path}.${kw}[${i}]`, errors, warnings))
    }
  }
  for (const kw of ['minItems', 'maxItems', 'minLength', 'maxLength']) {
    if (kw in s && !(Number.isInteger(s[kw]) && s[kw] >= 0)) errors.push(`${path}.${kw}: must be a whole number >= 0`)
  }
  for (const kw of ['minimum', 'maximum']) if (kw in s && typeof s[kw] !== 'number') errors.push(`${path}.${kw}: must be a number`)
  if ('pattern' in s) {
    if (typeof s.pattern !== 'string') errors.push(`${path}.pattern: must be a string`)
    else {
      try { compilePattern(s.pattern) } catch (e: any) { errors.push(`${path}.pattern: not a valid regular expression (${e.message})`) }
    }
  }
  if ('x-asset' in s) {
    if (typeof s['x-asset'] !== 'boolean') errors.push(`${path}.x-asset: must be true or false`)
    else if (s['x-asset'] && s.type !== undefined && s.type !== 'string') errors.push(`${path}.x-asset: only string fields can be local files`)
  }
  if ('default' in s) {
    const { default: d, ...rest } = s
    const errs = validate(rest, structuredClone(d), `${path}.default`)
    if (errs.length) errors.push(...errs.map((e) => `${e} (the default does not fit its own schema)`))
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function bytesOf(content: string): Buffer {
  if (content.startsWith('base64:')) return Buffer.from(content.slice(7), 'base64')
  return Buffer.from(content, 'utf8')
}

function refuse(code: string, message: string, errors: string[]): never {
  throw new TemplateError(message, code, errors)
}

/** Validate and write a template. Throws TemplateError (code ARTIFACT_TEMPLATE_*) when refused. */
export function saveTemplate(args: SaveArgs, env: Env = process.env): SaveResult {
  const errors: string[] = []
  const warnings: string[] = []
  const id = str(args.id)
  if (!ID_RE.test(id) || id.length > LIMITS.idMax) errors.push(`id: must be a lower-case slug like "weekly-report" (a-z, 0-9, single hyphens, max ${LIMITS.idMax} characters)`)
  const kind = str(args.kind)
  if (!(KINDS as readonly string[]).includes(kind)) errors.push(`kind: must be one of ${KINDS.join(', ')}`)
  const title = str(args.title)
  if (!title || title.length > LIMITS.titleMax) errors.push(`title: required, max ${LIMITS.titleMax} characters`)
  for (const k of ['purpose', 'when'] as const) {
    const v = str(args[k])
    if (!v || v.length > LIMITS.textMax) errors.push(`${k}: required, max ${LIMITS.textMax} characters`)
  }
  if (args.not_for !== undefined && args.not_for !== null && (typeof args.not_for !== 'string' || args.not_for.length > LIMITS.textMax)) errors.push(`not_for: a string, max ${LIMITS.textMax} characters`)
  const readme = typeof args.readme === 'string' ? args.readme : ''
  if (!readme.trim()) errors.push('readme: required (what the template is for, how to use it, the fields)')
  else if (Buffer.byteLength(readme) > LIMITS.readmeMax) errors.push(`readme: too large (max ${LIMITS.readmeMax} bytes)`)

  const schema = args.schema
  if (!isObj(schema)) errors.push('schema: must be a JSON Schema object')
  else {
    if (schema.type !== 'object' || !isObj(schema.properties)) errors.push('schema: the root must be {"type": "object", "properties": {...}}')
    schemaProblems(schema, 'schema', errors, warnings)
    if (Buffer.byteLength(JSON.stringify(schema)) > LIMITS.schemaMax) errors.push(`schema: too large (max ${LIMITS.schemaMax} bytes)`)
  }
  const example = args.example
  if (!isObj(example)) errors.push('example: must be a data object that fits the schema')
  else if (Buffer.byteLength(JSON.stringify(example)) > LIMITS.schemaMax) errors.push(`example: too large (max ${LIMITS.schemaMax} bytes)`)

  for (const k of ['entry'] as const) if (args[k] !== undefined && args[k] !== null && typeof args[k] !== 'string') errors.push(`${k}: must be a file name`)
  if (args.render !== undefined && args.render !== null && (!Array.isArray(args.render) || args.render.some((x) => typeof x !== 'string'))) errors.push('render: must be a list of file names')
  if (args.timing !== undefined && args.timing !== null && !isObj(args.timing)) errors.push('timing: must be an object')
  if (args.size !== undefined && args.size !== null && typeof args.size !== 'string') errors.push('size: must be a string such as landscape or 1280x720')

  // files
  const files: Record<string, string | null> = {}
  if (args.files !== undefined && args.files !== null && !isObj(args.files)) errors.push('files: must be an object {"relative/path": "content"}')
  const fileEntries = isObj(args.files) ? Object.entries(args.files) : []
  if (fileEntries.length > LIMITS.filesMax) errors.push(`files: at most ${LIMITS.filesMax} files`)
  let total = 0
  for (const [p, c] of fileEntries) {
    const parts = p.split('/')
    if (p.startsWith('/') || p.includes('\\') || parts.length > LIMITS.depthMax || parts.some((x) => !PART_RE.test(x) || x === '..')) {
      errors.push(`files.${p}: must be a relative path inside the template folder (letters, digits, . _ -, max ${LIMITS.depthMax} levels, no hidden or .. parts)`)
      continue
    }
    if (RESERVED.has(p)) { errors.push(`files.${p}: written from the template fields, do not pass it as a file`); continue }
    if (c === null) { files[p] = null; continue }
    if (typeof c !== 'string') { errors.push(`files.${p}: content must be a string (text, or "base64:" followed by base64 for binary files) or null to delete`); continue }
    const b = bytesOf(c)
    if (b.length > LIMITS.fileMax) errors.push(`files.${p}: too large (${b.length} bytes, max ${LIMITS.fileMax})`)
    total += b.length
    if (!c.startsWith('base64:') && hasSecret(c)) errors.push(`files.${p}: contains a credential-shaped string; templates are shared, never put a secret in them`)
    files[p] = c
  }
  if (total > LIMITS.totalMax) errors.push(`files: too large in total (${total} bytes, max ${LIMITS.totalMax})`)
  for (const [k, v] of [['title', title], ['purpose', args.purpose], ['when', args.when], ['not_for', args.not_for], ['readme', readme]] as const) {
    if (typeof v === 'string' && hasSecret(v)) errors.push(`${k}: contains a credential-shaped string`)
  }
  if (isObj(schema) && hasSecret(JSON.stringify(schema))) errors.push('schema: contains a credential-shaped string')

  if (errors.length) {
    const secret = errors.some((e) => e.includes('credential-shaped'))
    refuse(secret ? 'ARTIFACT_SECRET_REFUSED' : errors.some((e) => e.includes('too large') || e.includes('at most')) ? 'ARTIFACT_TOO_LARGE' : 'ARTIFACT_TEMPLATE_INVALID', `template ${id || '(no id)'} refused:\n  ${errors.join('\n  ')}`, errors)
  }

  // where to write, and what it would shadow
  const target = writeTarget(env)
  if (inside(target.path, BUNDLED)) refuse('ARTIFACT_TEMPLATE_READONLY', `the bundled template copy (${BUNDLED}) is read-only; set ARTIFACT_TEMPLATES_WRITE to another folder`, [`library: ${target.path} is the bundled copy`])
  if (!writable(target.path)) refuse('ARTIFACT_TEMPLATE_READONLY', `template library ${target.path} is not writable`, [`library: ${target.path} is not writable`])
  const finalDir = join(target.path, id)
  const order = searchDirs(env, { includeMissingUser: true }).map((d) => real(d.path))
  const targetRank = order.indexOf(real(target.path))
  const existing = allTemplates(env).find((t) => t.id === id)
  let overrides: string | null = null
  let updating = false
  if (existing) {
    const exRank = order.indexOf(real(dirname(existing.dir)))
    if (real(dirname(existing.dir)) === real(target.path)) updating = true
    else if (targetRank === -1 || (exRank !== -1 && exRank < targetRank)) {
      refuse('ARTIFACT_TEMPLATE_SHADOWED', `a template "${id}" already exists in ${dirname(existing.dir)} (${existing.source}), which is searched before ${target.path}; a copy saved there would never be used`, [`id: "${id}" is taken by the ${existing.source} library; pick another id`])
    } else overrides = existing.source ?? null
  } else if (existsSync(finalDir)) updating = true
  if (updating && args.overwrite !== true) {
    refuse('ARTIFACT_TEMPLATE_EXISTS', `template "${id}" already exists in ${target.path}; pass overwrite: true to update it`, [`id: "${id}" exists; pass overwrite: true to update it (files you do not pass are kept)`])
  }

  // stage
  mkdirSync(target.path, { recursive: true })
  const stage = mkdtempSync(join(target.path, `.${id}.staging-`))
  let trial: string | null = null
  try {
    if (updating && existsSync(finalDir)) cpSync(finalDir, stage, { recursive: true })
    for (const [p, c] of Object.entries(files)) {
      const dst = join(stage, p)
      if (c === null) {
        try { unlinkSync(dst) } catch { warnings.push(`files.${p}: nothing to delete`) }
        continue
      }
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, bytesOf(c))
    }
    const tj: Obj = { id, title, kind, purpose: str(args.purpose), when: str(args.when) }
    if (typeof args.not_for === 'string' && args.not_for.trim()) tj.not_for = args.not_for.trim()
    if (typeof args.entry === 'string' && args.entry) tj.entry = args.entry
    if (Array.isArray(args.render)) tj.render = args.render as Json[]
    if (isObj(args.timing)) tj.timing = args.timing as Json
    if (typeof args.size === 'string' && args.size) tj.size = args.size
    tj.schema = schema as Json
    tj.example = example as Json
    writeFileSync(join(stage, 'template.json'), JSON.stringify(tj, null, 2) + '\n')
    writeFileSync(join(stage, 'README.md'), readme.endsWith('\n') ? readme : readme + '\n')

    const errs: string[] = []
    const all = templateFiles(stage)
    const sizeTotal = all.reduce((a, f) => a + statSync(join(stage, f)).size, 0)
    if (sizeTotal > LIMITS.totalMax) errs.push(`files: the template folder would be ${sizeTotal} bytes, max ${LIMITS.totalMax}`)
    const t = load(stage)
    if (!t) throw new TemplateError('staging lost template.json', 'ARTIFACT_INTERNAL')
    t.id = id
    const need = kind === 'react' ? (Array.isArray(args.render) ? args.render as string[] : ['index.html']) : [typeof args.entry === 'string' && args.entry ? args.entry : kind === 'motion' ? 'composition.html' : 'template.md']
    for (const f of need) if (!all.includes(f)) errs.push(`files.${f}: missing (a ${kind} template needs it${kind === 'react' ? ', listed in render' : ' as its entry'})`)
    const ex = structuredClone(example) as Obj
    const [exErrors, exWarnings] = check({ ...t, schema: schema as Schema }, ex, stage)
    errs.push(...exErrors.map((e) => 'example: ' + e))
    warnings.push(...exWarnings.map((w) => 'example: ' + w))
    if (!errs.length) {
      trial = mkdtempSync(join(tmpdir(), 'artifact-template-trial-'))
      try {
        const res = create(t, structuredClone(example) as Obj, trial, 'trial', stage, { env })
        warnings.push(...res.warnings.filter((w) => !w.startsWith('data:')).map((w) => 'trial render: ' + w))
      } catch (e: any) {
        errs.push(`trial render of the example failed: ${e && e.message}`)
      }
    }
    warnings.push(...lintText({ title, purpose: args.purpose, when: args.when, readme }, 'template'))
    if (errs.length) refuse(errs.some((e) => e.includes('credential-shaped')) ? 'ARTIFACT_SECRET_REFUSED' : 'ARTIFACT_TEMPLATE_INVALID', `template ${id} refused:\n  ${errs.join('\n  ')}`, errs)

    // swap into place
    let old: string | null = null
    if (existsSync(finalDir)) {
      old = join(target.path, `.${id}.old-${process.pid}-${Date.now()}`)
      renameSync(finalDir, old)
    }
    try {
      renameSync(stage, finalDir)
    } catch (e) {
      if (old) renameSync(old, finalDir)
      throw e
    }
    if (old) rmSync(old, { recursive: true, force: true })
    return {
      ok: true, id, action: updating ? 'updated' : 'created', dir: finalDir, library: target.path, source: target.source, overrides,
      files: templateFiles(finalDir), warnings,
    }
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true })
    if (trial) rmSync(trial, { recursive: true, force: true })
  }
}
