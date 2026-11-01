/**
 * node test/tools.mjs: the node half on a mock host and every agent tool, success and error paths.
 *
 *  - lib/index.js registers the 4 tools and the packaged skill on a mock host (runtime ctx.inject only)
 *  - negative: no defineTool (tools package missing) -> the plugin loads, registers nothing, logs one line
 *  - the real defineTool of an installed DSH core accepts every definition (when a core is found)
 *  - every result (ok and error) is lossless JSON by the core rule (test/lossless-check.mjs)
 *  - template save validation: refused saves write nothing, accepted ones show up at once
 * Offline: temp HOME, temp reports folder, no network.
 */
import { spawnSync, execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLossless } from './lossless-check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'artifact-tools-'))
const HOME = join(work, 'home')
mkdirSync(HOME)
Object.assign(process.env, { HOME, ARTIFACT_DIR: join(work, 'reports'), DSH_HOME: join(work, 'dsh') })
for (const k of ['ARTIFACT_TEMPLATES', 'ARTIFACT_TEMPLATES_WRITE', 'ARTIFACT_BASE_URL', 'DSH_ARTIFACTS_TOOLS', 'DSH_SESSION_ID']) delete process.env[k]

const lossless = async (v, label) => {
  try { await assertLossless(v, label); return true } catch (e) { ok(false, e.message); return false }
}

try {
  // ---- 1. registration on a mock host --------------------------------------------------------------
  const index = await import(join(ROOT, 'lib', 'index.js'))
  ok(Array.isArray(index.inject) && index.inject.length === 0, 'static inject stays empty')
  ok(index.default && index.default.apply === index.apply && index.default.name === 'dsh-artifacts', 'default export object { name, inject, apply }')

  function mockHost() {
    const host = { tools: new Map(), providers: [], injected: [], logs: [] }
    host.ctx = {
      inject(deps, cb) {
        host.injected.push(deps.join(','))
        const c = {}
        if (deps.includes('tools')) c.tools = { register(def) { if (host.tools.has(def.name)) throw new Error('duplicate ' + def.name); host.tools.set(def.name, def); return () => host.tools.delete(def.name) } }
        if (deps.includes('skills')) c.skills = { registerProvider(f) { host.providers.push(f()) } }
        cb(c)
      },
    }
    return host
  }
  const origErr = console.error
  const captured = []
  console.error = (...a) => { const s = a.join(' '); if (s.startsWith('dsh-artifacts:')) captured.push(s); else origErr(...a) }

  const host = mockHost()
  index.apply(host.ctx, {}, { defineTool: (def) => def })
  await index.apply.ready
  ok(['artifact_templates', 'artifact_template_info', 'artifact_from_template', 'artifact_template_save'].every((n) => host.tools.has(n)) && host.tools.size === 4, 'four tools registered: ' + [...host.tools.keys()].join(', '))
  ok(host.injected.includes('tools') && host.injected.includes('skills'), 'tools and skills reached through runtime ctx.inject')
  const prov = host.providers[0]
  const skills = prov ? await prov.list() : []
  ok(skills.some((s) => s.name === 'publish-artifact'), 'packaged skill publish-artifact registered as provider ' + (prov && prov.name))
  if (prov) {
    const full = await prov.get(skills.find((s) => s.name === 'publish-artifact'))
    ok(/artifact_templates/.test(full.content) && /artifact_template_save/.test(full.content), 'the skill tells agents about the template tools')
  }
  for (const d of host.tools.values()) ok(typeof d.description === 'string' && d.description.length > 120 && /artifact/.test(d.description), `${d.name}: discoverable description (${d.description.length} chars)`)

  // negative: tools package missing
  const neg = mockHost()
  captured.length = 0
  let threw = false
  try { index.apply(neg.ctx, {}, { defineTool: null }); await index.apply.ready } catch { threw = true }
  ok(!threw && neg.tools.size === 0, 'no defineTool: apply does not throw and registers no tool')
  ok(captured.filter((l) => l.includes('ARTIFACT_TOOLS_UNAVAILABLE')).length === 1, 'no defineTool: exactly one ARTIFACT_TOOLS_UNAVAILABLE log line')
  ok(neg.providers.length === 1, 'no defineTool: the skill is still registered')
  // a host without inject at all
  threw = false
  try { index.apply({}, {}, { defineTool: (d) => d }); await index.apply.ready } catch { threw = true }
  ok(!threw, 'a context without inject(): no throw')
  // a real process where the tools package cannot be resolved
  const iso = join(work, 'iso')
  mkdirSync(iso)
  const probe = join(iso, 'probe.mjs')
  writeFileSync(probe, `const m = await import(${JSON.stringify(join(ROOT, 'lib', 'index.js'))});
const reg = []; const ctx = { inject(d, cb) { cb({ tools: { register: (x) => reg.push(x.name) }, skills: { registerProvider() {} } }) } };
m.apply(ctx, {}); await m.apply.ready; console.log('REGISTERED=' + reg.length)`)
  const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, DSH_HOME: join(iso, 'dsh'), HOME: iso, DSH_ARTIFACTS_TOOLS_MAIN: '' } })
  ok(r.status === 0 && /REGISTERED=0/.test(r.stdout) && /ARTIFACT_TOOLS_UNAVAILABLE/.test(r.stderr) && !/dsh-artifacts:/.test(r.stdout), 'separate process without a resolvable dsh-tools: loads, registers 0, one log line on stderr (stdout stays clean)')
  const off = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, DSH_ARTIFACTS_TOOLS: '0' } })
  ok(off.status === 0 && /REGISTERED=0/.test(off.stdout) && /disabled/.test(off.stderr), 'kill switch DSH_ARTIFACTS_TOOLS=0')
  console.error = origErr

  // the real defineTool from an installed core
  let realDefine = null
  try {
    const root = process.env.DSH_GLOBAL_PREFIX ? join(process.env.DSH_GLOBAL_PREFIX, 'lib', 'node_modules') : execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 8000 }).trim()
    const main = join(root, '@deepseek-ai', 'dsh', 'package.json')
    if (existsSync(main)) {
      process.env.DSH_ARTIFACTS_TOOLS_MAIN = main
      realDefine = await index.loadDefineTool()
      delete process.env.DSH_ARTIFACTS_TOOLS_MAIN
    }
  } catch { /* no core */ }
  if (realDefine) {
    const real = mockHost()
    index.apply(real.ctx, {}, { defineTool: realDefine })
    await index.apply.ready
    ok(real.tools.size === 4, 'the real core defineTool accepts all four definitions')
    for (const d of real.tools.values()) ok(typeof d.execute === 'function' && d.output && typeof d.output.render === 'function', `${d.name}: compiled by the core defineTool`)
  } else console.log('SKIP real defineTool: no installed DSH core found')

  // ---- 2. every tool, success and error paths ---------------------------------------------------------
  const tool = (n) => host.tools.get(n)
  const call = async (n, args, exec) => {
    const v = await tool(n).execute(args, exec || { agent: { session: { id: 'session-0123456789abcdef' } } })
    await lossless(v, `${n} result`)
    return v
  }
  const expectCode = async (n, args, code, label) => {
    const v = await call(n, args)
    ok(v.ok === false && v.code === code && typeof v.hint === 'string' && /^docs\/ERRORS\.md#artifact_/.test(v.docs), `${n} ${label}: ${code}${v.code !== code ? ' (got ' + JSON.stringify(v).slice(0, 300) + ')' : ''}`)
    return v
  }

  let v = await call('artifact_templates', {})
  ok(v.ok && v.count >= 6 && v.templates.every((t) => t.source === 'bundled' && t.purpose && t.when && Array.isArray(t.required)), `artifact_templates: ${v.count} bundled templates with purpose, when, required`)
  ok(v.save_to === join(work, 'dsh', 'artifacts', 'templates'), 'artifact_templates: save_to is the user library')
  v = await call('artifact_templates', { query: 'dashboard' })
  ok(v.ok && v.templates.some((t) => t.id === 'dashboard'), 'artifact_templates: query filter')

  v = await call('artifact_template_info', { id: 'dashboard' })
  ok(v.ok && v.schema.type === 'object' && v.example && v.minimal_example && v.field_table.length && v.readme_summary.length > 50, 'artifact_template_info: schema, example, minimal example, fields, README summary')
  await expectCode('artifact_template_info', { id: 'nope' }, 'ARTIFACT_TEMPLATE_NOT_FOUND', 'unknown id')

  v = await call('artifact_from_template', { name: 'd1', template: 'dashboard', data: { title: 'Sales', kpis: [{ label: 'Revenue', value: 12 }] } })
  ok(v.ok && v.url === '/report/d1.html' && v.path === join(work, 'reports', 'd1.md') && existsSync(v.path), 'artifact_from_template markdown: path and URL')
  const claims = readFileSync(join(work, 'reports', '.artifacts', 'claims.jsonl'), 'utf8')
  ok(claims.includes('"name":"d1.md"') && claims.includes('session-0123456789abcdef'), 'artifact_from_template: attributed to the calling chat (claims.jsonl)')
  v = await call('artifact_from_template', { name: 'rq', template: 'review-queue' })
  ok(v.ok && v.url === '/report/rq/' && existsSync(join(v.path, 'data.json')), 'artifact_from_template react with the example data')
  v = await call('artifact_from_template', { name: 'mv', template: 'video-explainer' })
  ok(v.ok && v.url === '/report/mv.html' && typeof v.duration === 'number', 'artifact_from_template motion')
  v = await call('artifact_from_template', { name: 'ds', template: 'dashboard', data: JSON.stringify({ title: 'S', kpis: [{ label: 'a', value: 1 }] }) })
  ok(v.ok, 'artifact_from_template: data given as a JSON string')
  v = await call('artifact_from_template', { name: 'chk', template: 'dashboard', data: { title: 'S', kpis: [{ label: 'a', value: 1 }] }, check: true })
  ok(v.ok && v.checked && !existsSync(join(work, 'reports', 'chk.md')), 'artifact_from_template check: true writes nothing')
  v = await expectCode('artifact_from_template', { name: 'bad', template: 'dashboard', data: { title: 'x', kpis: [{ label: 'a', value: { n: 1 }, verdict: 'great' }] } }, 'ARTIFACT_DATA_INVALID', 'bad data')
  ok(v.errors.some((e) => e.field === 'data.kpis[0].value' && /expected string or number/.test(e.problem)) && v.errors.some((e) => e.field === 'data.kpis[0].verdict'), 'artifact_from_template: errors listed per field')
  ok(!existsSync(join(work, 'reports', 'bad.md')), 'artifact_from_template: nothing written on bad data')
  await expectCode('artifact_from_template', { name: 'sec', template: 'report-text', data: { title: 'x', sections: [{ heading: 'h', body: 'OPENAI_API_KEY=abcdefghijk12345' }] } }, 'ARTIFACT_SECRET_REFUSED', 'secret in data')
  await expectCode('artifact_from_template', { name: 'd1', template: 'dashboard', data: { title: 'Sales', kpis: [{ label: 'R', value: 1 }] } }, 'ARTIFACT_EXISTS', 'existing name')
  v = await call('artifact_from_template', { name: 'd1', template: 'dashboard', data: { title: 'Sales 2', kpis: [{ label: 'R', value: 1 }] }, force: true })
  ok(v.ok && readFileSync(join(work, 'reports', 'd1.md'), 'utf8').includes('Sales 2'), 'artifact_from_template force: true regenerates')
  await expectCode('artifact_from_template', { name: '../x', template: 'dashboard' }, 'ARTIFACT_BAD_NAME', 'path in name')
  await expectCode('artifact_from_template', { name: 'x', template: 'nope' }, 'ARTIFACT_TEMPLATE_NOT_FOUND', 'unknown template')
  await expectCode('artifact_from_template', { name: 'x', template: 'dashboard', data: '{"title": ' }, 'ARTIFACT_DATA_INVALID', 'data string not JSON')
  await expectCode('artifact_from_template', { name: 'x', template: 'dashboard', data: [1, 2] }, 'ARTIFACT_DATA_INVALID', 'data not an object')
  await expectCode('artifact_from_template', { name: 'x', template: 'article', data: { title: 'x', hero: { src: 'nope.jpg' }, blocks: [{ type: 'text', text: 't' }] } }, 'ARTIFACT_DATA_INVALID', 'missing local image')
  // a broken template folder in a custom library
  const custom = join(work, 'custom')
  mkdirSync(join(custom, 'broken'), { recursive: true })
  writeFileSync(join(custom, 'broken', 'template.json'), '{ not json')
  process.env.ARTIFACT_TEMPLATES = custom
  v = await call('artifact_templates', {})
  ok(v.ok && v.templates.some((t) => t.id === 'broken' && t.error), 'artifact_templates: a broken folder is listed with its error')
  await expectCode('artifact_template_info', { id: 'broken' }, 'ARTIFACT_TEMPLATE_BROKEN', 'broken folder')
  await expectCode('artifact_from_template', { name: 'x', template: 'broken' }, 'ARTIFACT_TEMPLATE_BROKEN', 'broken folder')
  delete process.env.ARTIFACT_TEMPLATES
  // write failure: the reports folder is a file
  process.env.ARTIFACT_DIR = join(work, 'not-a-dir')
  writeFileSync(process.env.ARTIFACT_DIR, 'x')
  await expectCode('artifact_from_template', { name: 'w', template: 'dashboard' }, 'ARTIFACT_WRITE_FAILED', 'reports path is a file')
  process.env.ARTIFACT_DIR = join(work, 'reports')

  // ---- 3. artifact_template_save -------------------------------------------------------------------------
  const userLib = join(work, 'dsh', 'artifacts', 'templates')
  const spec = {
    id: 'weekly-status', title: 'Weekly status', kind: 'markdown', purpose: 'One page weekly status with highlights and risks.',
    when: 'A recurring status update for a team or a project.', not_for: 'Long reports (use report-text).',
    schema: { type: 'object', required: ['title', 'highlights'], additionalProperties: false, properties: {
      title: { type: 'string', minLength: 1 }, week: { type: 'string', description: 'For example 2026-W44' },
      highlights: { type: 'array', minItems: 1, items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'object', required: ['text'], properties: { text: { type: 'string' }, level: { enum: ['low', 'high'], default: 'low' } } } },
    } },
    example: { title: 'Example data: team status', week: '2026-W44', highlights: ['Shipped the importer', 'Two new customers'], risks: [{ text: 'Vacation week', level: 'low' }] },
    files: { 'template.md': '# {{title|oneline}}\n\n{{#week}}Week {{week}}{{/week}}\n\n## Highlights\n\n{{#highlights}}\n- {{.}}\n{{/highlights}}\n\n{{#risks}}\n> {{level}}: {{text}}\n{{/risks}}\n' },
    readme: '# weekly-status\n\nOne page weekly status.\n\nFields: title, week, highlights, risks.\n\n## Changes\n\n- created\n',
  }
  v = await call('artifact_template_save', spec)
  ok(v.ok && v.action === 'created' && v.source === 'user' && v.dir === join(userLib, 'weekly-status'), 'artifact_template_save: created in the user library')
  v = await call('artifact_templates', {})
  ok(v.templates.some((t) => t.id === 'weekly-status' && t.source === 'user'), 'artifact_template_save: shows up at once in artifact_templates')
  v = await call('artifact_from_template', { name: 'ws1', template: 'weekly-status', data: { title: 'Ops', highlights: ['a'] } })
  ok(v.ok && readFileSync(v.path, 'utf8').startsWith('# Ops\n'), 'a saved template is usable with artifact_from_template')
  await expectCode('artifact_template_save', spec, 'ARTIFACT_TEMPLATE_EXISTS', 'same id again')
  v = await call('artifact_template_save', { ...spec, title: 'Weekly status v2', overwrite: true, files: { 'extra.txt': 'kept' } })
  ok(v.ok && v.action === 'updated' && v.files.includes('template.md') && v.files.includes('extra.txt'), 'overwrite: true updates and keeps files that were not passed')
  v = await call('artifact_template_save', { ...spec, overwrite: true, files: { 'extra.txt': null } })
  ok(v.ok && !v.files.includes('extra.txt'), 'overwrite: null deletes a file')
  ok(!readdirSync(userLib).some((n) => n.startsWith('.')), 'no staging or backup folders left behind')

  const refused = async (label, patch, code) => {
    const before = existsSync(join(userLib, 'bad-one'))
    const r = await expectCode('artifact_template_save', { ...spec, id: 'bad-one', ...patch }, code, label)
    ok(!before && !existsSync(join(userLib, 'bad-one')), `${label}: nothing written`)
    return r
  }
  let rr = await refused('bad id', { id: 'Bad_ID' }, 'ARTIFACT_TEMPLATE_INVALID')
  ok(rr.errors.some((e) => e.field === 'id'), 'bad id: listed as field id')
  rr = await refused('schema not an object root', { schema: { type: 'array' } }, 'ARTIFACT_TEMPLATE_INVALID')
  rr = await refused('malformed schema', { schema: { type: 'object', properties: { a: { type: 'strng' }, b: { type: 'string', pattern: '(' } }, required: ['zzz'] }, example: {} }, 'ARTIFACT_TEMPLATE_INVALID')
  ok(rr.error_lines.some((e) => e.includes('schema.properties.a.type')) && rr.error_lines.some((e) => e.includes('pattern')) && rr.error_lines.some((e) => e.includes('"zzz" is not in properties')), 'malformed schema: type, pattern and required problems listed')
  rr = await refused('example does not fit', { example: { title: 'x' } }, 'ARTIFACT_TEMPLATE_INVALID')
  ok(rr.error_lines.some((e) => e.includes('missing required property "highlights"')), 'example does not fit: the field is named')
  await refused('path escapes the folder', { files: { '../evil.md': 'x', 'template.md': spec.files['template.md'] } }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('absolute path', { files: { '/tmp/x.md': 'x', 'template.md': spec.files['template.md'] } }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('reserved file', { files: { 'template.json': '{}', 'template.md': 'x' } }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('entry file missing', { files: { 'other.md': 'x' } }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('unbalanced template', { files: { 'template.md': '{{#highlights}}x' } }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('secret in a file', { files: { 'template.md': '# {{title}}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n' } }, 'ARTIFACT_SECRET_REFUSED')
  await refused('secret in the example', { example: { title: 'x', highlights: ['PASSWORD: hunter2hunter2'] } }, 'ARTIFACT_SECRET_REFUSED')
  await refused('file too large', { files: { 'template.md': '# {{title}}\n', 'big.txt': 'x'.repeat(600 * 1024) } }, 'ARTIFACT_TOO_LARGE')
  await refused('bad kind', { kind: 'pdf' }, 'ARTIFACT_TEMPLATE_INVALID')
  await refused('no readme', { readme: '' }, 'ARTIFACT_TEMPLATE_INVALID')

  // an id taken by a library searched first (estate) -> shadowed; bundled id -> user override allowed
  const estate = join(HOME, 'estate', 'templates', 'artifacts')
  mkdirSync(estate, { recursive: true })
  cpSync(join(ROOT, 'templates', 'dashboard'), join(estate, 'dashboard'), { recursive: true })
  const dashInfo = await call('artifact_template_info', { id: 'dashboard' })
  ok(dashInfo.source === 'estate', 'the estate library is searched before the user library')
  const dashSpec = { ...spec, id: 'dashboard' }
  await expectCode('artifact_template_save', dashSpec, 'ARTIFACT_TEMPLATE_SHADOWED', 'id taken by the estate library')
  rmSync(join(HOME, 'estate'), { recursive: true, force: true })
  v = await call('artifact_template_save', { ...spec, id: 'article' })
  ok(v.ok && v.overrides === 'bundled', 'a bundled id can be overridden in the user library')
  v = await call('artifact_template_info', { id: 'article' })
  ok(v.source === 'user', 'the user copy now wins over the bundled one')
  // never write into the bundled copy
  process.env.ARTIFACT_TEMPLATES_WRITE = join(ROOT, 'templates')
  await expectCode('artifact_template_save', { ...spec, id: 'never-here' }, 'ARTIFACT_TEMPLATE_READONLY', 'write target is the bundled copy')
  ok(!existsSync(join(ROOT, 'templates', 'never-here')), 'the bundled copy is untouched')
  delete process.env.ARTIFACT_TEMPLATES_WRITE
  // read-only library
  const ro = join(work, 'ro')
  mkdirSync(ro)
  chmodSync(ro, 0o555)
  process.env.ARTIFACT_TEMPLATES_WRITE = ro
  if (process.getuid && process.getuid() !== 0) await expectCode('artifact_template_save', { ...spec, id: 'ro-one' }, 'ARTIFACT_TEMPLATE_READONLY', 'library not writable')
  delete process.env.ARTIFACT_TEMPLATES_WRITE
  chmodSync(ro, 0o755)
  // first writable ARTIFACT_TEMPLATES entry is the target
  const mine = join(work, 'mine')
  process.env.ARTIFACT_TEMPLATES = mine + ':' + custom
  v = await call('artifact_template_save', { ...spec, id: 'in-mine' })
  ok(v.ok && v.source === 'custom' && v.dir === join(mine, 'in-mine'), 'the first writable ARTIFACT_TEMPLATES entry is the target')
  delete process.env.ARTIFACT_TEMPLATES
  // react and motion kinds
  const react = await call('artifact_template_save', {
    id: 'mini-app', title: 'Mini app', kind: 'react', purpose: 'A tiny React page reading data.json.', when: 'Testing the react kind.',
    schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'string' } } } },
    example: { title: 'Example data', items: ['a'] },
    files: { 'index.html': '<!doctype html><title>{{title}}</title><div id="root"></div><script type="text/babel" src="app.jsx"></script>\n', 'app.jsx': 'fetch("data.json").then(r => r.json()).then(d => { document.getElementById("root").textContent = d.title })\n' },
    readme: '# mini-app\n\nA tiny page.\n',
  })
  ok(react.ok && react.files.includes('app.jsx'), 'artifact_template_save: react kind')
  v = await call('artifact_from_template', { name: 'ma', template: 'mini-app', data: { title: 'Hi <you>' } })
  ok(v.ok && readFileSync(join(v.path, 'index.html'), 'utf8').includes('<title>Hi &lt;you&gt;</title>'), 'a saved react template renders (HTML-escaped)')
  const motion = await call('artifact_template_save', {
    id: 'mini-motion', title: 'Mini motion', kind: 'motion', purpose: 'One title card.', when: 'Testing the motion kind.',
    schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } }, example: { title: 'Example data' },
    files: { 'composition.html': '<div data-composition-id="main" data-width="{{_w}}" data-height="{{_h}}" data-duration="{{_duration}}"><h1>{{title}}</h1></div>\n' },
    readme: '# mini-motion\n',
  })
  ok(motion.ok, 'artifact_template_save: motion kind')
  // a binary file and an asset field
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')
  v = await call('artifact_template_save', {
    id: 'with-logo', title: 'With logo', kind: 'markdown', purpose: 'A page with a logo file.', when: 'Testing assets.',
    schema: { type: 'object', required: ['title', 'logo'], properties: { title: { type: 'string' }, logo: { type: 'string', 'x-asset': true } } },
    example: { title: 'Example data', logo: 'example/logo.png' },
    files: { 'template.md': '# {{title}}\n\n![logo]({{logo}})\n', 'example/logo.png': 'base64:' + png },
    readme: '# with-logo\n',
  })
  ok(v.ok && v.files.includes('example/logo.png'), 'artifact_template_save: binary example asset (base64:)')
  v = await call('artifact_from_template', { name: 'wl', template: 'with-logo' })
  ok(v.ok && existsSync(join(work, 'reports', 'wl-files', 'logo.png')), 'the saved asset is copied next to the artifact')
  await refused('example asset missing', { schema: { type: 'object', properties: { title: { type: 'string' }, logo: { type: 'string', 'x-asset': true } } }, example: { title: 'x', logo: 'example/none.png' }, files: { 'template.md': '# {{title}}\n' } }, 'ARTIFACT_TEMPLATE_INVALID')

  // ---- 4. docs drift: every code has a row and a heading in docs/ERRORS.md ---------------------------------
  const { E } = await import(join(ROOT, 'lib', 'tools.js'))
  const missing = E.missingFromDoc(readFileSync(join(ROOT, 'docs', 'ERRORS.md'), 'utf8'))
  ok(missing.length === 0, 'docs/ERRORS.md documents every ARTIFACT_* code' + (missing.length ? ': missing ' + missing.join(', ') : ''))
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} tool check(s) FAILED` : '\ntools: all checks passed')
process.exit(fails ? 1 : 0)
