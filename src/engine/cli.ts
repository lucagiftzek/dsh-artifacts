#!/usr/bin/env node
/**
 * JSON bridge between the `artifact` CLI and the TypeScript template engine.
 *
 *   node lib/engine/cli.js list
 *   node lib/engine/cli.js info <id>
 *   node lib/engine/cli.js new  < {"stem", "template", "data"|null, "base"|null, "force", "check", "title", "report_dir"}
 *   node lib/engine/cli.js save < {template_save arguments}
 *
 * Every command prints one JSON object on stdout. Exit 0 = ok, 2 = the data or template was refused, 1 = other error.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateError, allTemplates, check, create, exampleOf, fields, get, minimal, previewRel, readmeSummary, reportDir, searchDirs, summary, templateFiles, writable, type Obj, type Template } from './templates.js'
import { saveTemplate, writeTarget } from './save.js'

function out(obj: unknown, code = 0): never {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
  process.exit(code)
}

function row(t: Template) {
  const r: Record<string, unknown> = {
    id: t.id, title: t.title ?? t.id, kind: t.kind, purpose: t.purpose ?? '', when: t.when ?? '', not_for: t.not_for ?? '',
    source: t.source, dir: t.dir,
  }
  if (t.error) return { ...r, error: t.error }
  const schema = t.schema ?? {}
  r.fields = summary(schema)
  r.required = Array.isArray(schema.required) ? schema.required : []
  r.preview_rel = previewRel(t)
  return r
}

function fail(e: any): never {
  const code = e instanceof TemplateError ? e.code : 'ARTIFACT_INTERNAL'
  out({ ok: false, code, error: String(e && e.message), errors: e && e.errors ? e.errors : [String(e && e.message)] }, code === 'ARTIFACT_DATA_INVALID' || code === 'ARTIFACT_SECRET_REFUSED' || code === 'ARTIFACT_TEMPLATE_INVALID' ? 2 : 1)
}

function stdinJson(): any {
  try { return JSON.parse(readFileSync(0, 'utf8')) } catch (e: any) { return fail(new Error('engine: stdin is not JSON: ' + e.message)) }
}

const [cmd, ...args] = process.argv.slice(2)
try {
  if (cmd === 'list') {
    out({
      ok: true,
      dirs: searchDirs().map((d) => ({ path: d.path, source: d.source, writable: writable(d.path) })),
      write_dir: writeTarget().path,
      templates: allTemplates().map(row),
    })
  } else if (cmd === 'info') {
    const t = get(args[0] ?? '')
    const ex = exampleOf(t)
    const schema = t.schema ?? {}
    out({
      ok: true, ...row(t), schema, example: ex, minimal_example: minimal(schema, ex), field_table: fields(schema),
      readme: join(t.dir, 'README.md'), readme_summary: readmeSummary(t.dir).summary, files: templateFiles(t.dir),
    })
  } else if (cmd === 'new') {
    const a = stdinJson()
    const t = get(String(a.template))
    let data: Obj
    let base: string
    if (a.data === null || a.data === undefined) {
      data = exampleOf(t) as Obj
      base = t.dir
    } else {
      data = a.data
      base = String(a.base)
    }
    const [errors, warnings] = check(t, data, base)
    if (errors.length) out({ ok: false, code: errors.some((x) => x.includes('credential-shaped')) ? 'ARTIFACT_SECRET_REFUSED' : 'ARTIFACT_DATA_INVALID', template: t.id, errors, warnings }, 2)
    if (a.check) out({ ok: true, template: t.id, errors: [], warnings })
    const res = create(t, data, a.report_dir ? String(a.report_dir) : reportDir(), String(a.stem), base, { force: !!a.force, title: a.title || null })
    out({ ok: true, template: t.id, ...res })
  } else if (cmd === 'save') {
    const res = saveTemplate(stdinJson())
    out(res, res.ok ? 0 : 2)
  } else {
    out({ ok: false, code: 'ARTIFACT_INTERNAL', error: 'usage: cli.js list | info <id> | new | save' }, 1)
  }
} catch (e) {
  fail(e)
}
