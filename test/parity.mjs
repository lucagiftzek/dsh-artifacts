/**
 * node test/parity.mjs: the TypeScript template engine (lib/engine) against the original Python engine.
 *
 * The Python engine was removed when the CLI switched to the TypeScript one; this test takes the reference
 * from git history (contrib/templates.py at REF) and runs both engines on the same inputs:
 *   - every template's example data -> every generated file must be byte-identical
 *   - extra data cases (derived motion timing, missing optional fields, filters)
 *   - validation errors and warnings for bad data (same lines, same order)
 *   - Mustache fill of tricky snippets
 * It needs git, python3 and a git checkout; without them it prints SKIP and passes (installs from a package).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REF = process.env.PARITY_REF || 'a52a73a'
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }

const py = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const ref = spawnSync('git', ['-C', ROOT, 'show', `${REF}:contrib/templates.py`], { encoding: 'utf8', maxBuffer: 8 << 20 })
if (py.status !== 0 || ref.status !== 0) {
  console.log(`SKIP parity: needs python3 and a git checkout with ${REF} (${py.status !== 0 ? 'no python3' : 'no git history'})`)
  process.exit(0)
}

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'artifact-parity-'))
const refDir = join(work, 'ref')
mkdirSync(refDir)
writeFileSync(join(refDir, 'templates.py'), ref.stdout)
const HOME = join(work, 'home')
mkdirSync(HOME)
process.env.HOME = HOME
process.env.ARTIFACT_TEMPLATES = join(ROOT, 'templates')
delete process.env.ARTIFACT_TEMPLATES_WRITE
delete process.env.DSH_HOME

const T = await import(join(ROOT, 'lib', 'engine', 'templates.js'))

const PY = `
import json, sys, copy
sys.path[:0] = [${JSON.stringify(refDir)}, ${JSON.stringify(join(ROOT, 'contrib'))}]
import templates as T
from pathlib import Path
T.BUNDLED = Path(${JSON.stringify(join(ROOT, 'templates'))})
T.PLUGIN = Path(${JSON.stringify(ROOT)})
jobs = json.load(sys.stdin)
out = []
for j in jobs:
    try:
        if j["op"] == "create":
            t = T.get(j["tid"])
            data = T.example_of(t) if j.get("data") is None else j["data"]
            base = t["dir"] if j.get("data") is None else j["base"]
            r = T.create(t, data, j["dir"], j["stem"], base, force=j.get("force", False), title=j.get("title"))
            out.append({"ok": True, "res": r})
        elif j["op"] == "check":
            t = T.get(j["tid"])
            e, w = T.check(t, j["data"], j.get("base"))
            out.append({"ok": True, "errors": e, "warnings": w, "data": j["data"]})
        elif j["op"] == "fill":
            out.append({"ok": True, "text": T.fill(j["tpl"], T.prepare(j.get("schema", {}), j["data"]), j["escape"])})
        elif j["op"] == "info":
            t = T.get(j["tid"])
            ex = T.example_of(t)
            s = t.get("schema", {})
            out.append({"ok": True, "summary": T.summary(s), "fields": [list(f) for f in T.fields(s)], "minimal": T.minimal(s, ex), "ids": [x["id"] for x in T.all_templates()]})
    except Exception as e:
        out.append({"ok": False, "error": str(e)})
print(json.dumps(out, ensure_ascii=False))
`

function runPy(jobs) {
  const r = spawnSync('python3', ['-c', PY], { input: JSON.stringify(jobs), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error('python reference failed: ' + r.stderr)
  return JSON.parse(r.stdout)
}

function runTs(j) {
  try {
    if (j.op === 'create') {
      const t = T.get(j.tid)
      const data = j.data == null ? T.exampleOf(t) : structuredClone(j.data)
      const base = j.data == null ? t.dir : j.base
      return { ok: true, res: T.create(t, data, j.dir, j.stem, base, { force: !!j.force, title: j.title || null }) }
    }
    if (j.op === 'check') {
      const t = T.get(j.tid)
      const data = structuredClone(j.data)
      const [e, w] = T.check(t, data, j.base ?? null)
      return { ok: true, errors: e, warnings: w, data }
    }
    if (j.op === 'fill') return { ok: true, text: T.fill(j.tpl, T.prepare(j.schema || {}, structuredClone(j.data)), j.escape) }
    if (j.op === 'info') {
      const t = T.get(j.tid)
      const ex = T.exampleOf(t)
      const s = t.schema || {}
      return { ok: true, summary: T.summary(s), fields: T.fields(s).map((f) => [f.path, f.type, f.required, f.description, f.default]), minimal: T.minimal(s, ex), ids: T.allTemplates().map((x) => x.id) }
    }
  } catch (e) {
    return { ok: false, error: String(e.message) }
  }
}

function tree(dir) {
  const out = []
  const rec = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) rec(p)
      else out.push(relative(dir, p))
    }
  }
  if (existsSync(dir)) rec(dir)
  return out
}

function sameTree(a, b, label) {
  const ta = tree(a)
  const tb = tree(b)
  if (JSON.stringify(ta) !== JSON.stringify(tb)) {
    ok(false, `${label}: same file list (python ${ta.length}: ${ta.join(' ')} | ts ${tb.length}: ${tb.join(' ')})`)
    return
  }
  const diff = ta.filter((f) => !readFileSync(join(a, f)).equals(readFileSync(join(b, f))))
  ok(!diff.length, `${label}: ${ta.length} files byte-identical${diff.length ? ' (differ: ' + diff.join(', ') + ')' : ''}`)
}

const norm = (r, dir) => r && r.res ? { ...r.res, files: r.res.files.map((f) => relative(dir, f)) } : r

try {
  const ids = T.allTemplates().map((t) => t.id)
  ok(ids.length >= 6, `bundled templates found: ${ids.join(', ')}`)

  // 1. info: summary, field table, minimal example, discovery order
  const info = ids.map((tid) => ({ op: 'info', tid }))
  const pi = runPy(info)
  info.forEach((j, i) => ok(JSON.stringify(pi[i]) === JSON.stringify(runTs(j)), `info ${j.tid}: summary, fields, minimal example identical`))

  // 2. create: every example, plus extra data cases, into two report folders
  const pyDir = join(work, 'py')
  const tsDir = join(work, 'ts')
  const assets = join(work, 'assets')
  mkdirSync(assets)
  writeFileSync(join(assets, 'pic one.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]))
  writeFileSync(join(assets, 'clip.mp4'), Buffer.from([0, 0, 0, 24, 102, 116]))
  const extra = [
    { tid: 'video-explainer', stem: 'timing', data: { title: 'T', scenes: [{ type: 'title', title: 'One two three' }, { type: 'chart', bars: [{ label: 'a', value: 1 }, { label: 'b', value: 2.5 }] }, { type: 'outro', title: 'Bye', seconds: 4 }] } },
    { tid: 'video-explainer', stem: 'portrait', data: { title: 'P & "q" <x>', size: 'portrait', scenes: [{ type: 'bullets', title: 'Why', bullets: ['a b c d e f g h i j k l m n o p q r s t u v w x y z', 'second'] }, { type: 'stat', value: 42, label: 'up' }] } },
    { tid: 'report-text', stem: 'minimal-report', data: { title: 'Only required', sections: [{ heading: 'One', body: 'Body | with pipe\n\n\n\nand gaps' }] } },
    { tid: 'report-text', stem: 'unicode', data: { title: 'Caf\u00e9 \u00fcber \u4e2d\u6587 \ud83d\ude00', sections: [{ heading: 'H\u00e9', body: 'x', callout: { text: 'note' } }], footnotes: [{ id: 'a', text: 'f' }], width: 'wide', toc: false, key_points: ['k1', 'k2'] } },
    { tid: 'dashboard', stem: 'dash-floats', data: { title: 'Floats', kpis: [{ label: 'a', value: 1.5 }, { label: 'b', value: 3 }, { label: 'c', value: 0.1 }] } },
    { tid: 'article', stem: 'article-local', base: assets, data: { title: 'Local', hero: { src: 'pic one.jpg' }, blocks: [{ type: 'text', text: 'Hello' }, { type: 'figure', src: 'pic one.jpg', caption: 'same file twice' }] } },
    { tid: 'video-page', stem: 'vp-local', base: assets, data: { title: 'Clip', src: 'clip.mp4' } },
    { tid: 'review-queue', stem: 'rq-title', title: 'Given title', data: null },
  ]
  const creates = [
    ...ids.map((tid) => ({ op: 'create', tid, stem: 'ex-' + tid, data: null })),
    ...extra.map((x) => ({ op: 'create', base: work, ...x })),
  ]
  const pr = runPy(creates.map((j) => ({ ...j, dir: pyDir })))
  creates.forEach((j, i) => {
    const tr = runTs({ ...j, dir: tsDir })
    const a = JSON.stringify(norm(pr[i], pyDir))
    const b = JSON.stringify(norm(tr, tsDir))
    ok(a === b, `create ${j.stem} (${j.tid}): result identical${a === b ? '' : '\n  python ' + a.slice(0, 600) + '\n  ts     ' + b.slice(0, 600)}`)
  })
  sameTree(pyDir, tsDir, 'all generated artifacts')

  // 3. validation: errors and warnings line by line
  const bad = [
    ['dashboard', { title: 'x' }],
    ['dashboard', { title: 'x', kpis: [{ label: 'a', value: { n: 1 }, verdict: 'great' }] }],
    ['report-text', { title: 'x', sections: [{ heading: 'h', body: 'b' }], colour: 'red', footnotes: [{ id: 'a b', text: 't' }] }],
    ['report-text', { title: 'x', sections: [] }],
    ['report-text', { title: '', sections: [{ heading: 'h', body: 'b', callout: { tone: 'loud', text: 't' } }] }],
    ['report-text', { title: 'x', sections: [{ heading: 'h', body: 'OPENAI_API_KEY=abcdefghijk12345' }] }],
    ['report-text', { title: 'a \u2014 b', sections: [{ heading: 'h \u2013 i', body: 'b' }] }],
    ['article', { title: 'x', hero: { src: 'nope.jpg' }, blocks: [{ type: 'text', text: 't' }] }],
    ['video-explainer', { title: 't', scenes: [{ type: 'nope' }], size: 'huge' }],
    ['video-page', { title: 3, src: 'https://example.com/v.mp4', chapters: [{ t: -1, title: 'x' }] }],
    ['review-queue', { title: 't', items: 'none' }],
    ['dashboard', { title: '\u00e9', kpis: [{ label: 'a', value: true, verdict: '\u00fc' }] }],
  ]
  const checks = bad.map(([tid, data]) => ({ op: 'check', tid, data, base: assets }))
  const pc = runPy(checks)
  checks.forEach((j, i) => {
    const a = JSON.stringify(pc[i])
    const b = JSON.stringify(runTs(j))
    ok(a === b, `check ${j.tid} #${i}: same errors, warnings and filled defaults${a === b ? '' : '\n  python ' + a.slice(0, 500) + '\n  ts     ' + b.slice(0, 500)}`)
  })

  // 4. Mustache snippets
  const fills = [
    ['a\n{{#xs}}\n- {{.}}{{^@last}},{{/@last}}\n{{/xs}}\n{{^ys}}\nnone\n{{/ys}}\n{{row|csv}}|{{row|cells}}|{{row|sep}}\n{{{h}}} {{h}}\n', { xs: [1, 2], ys: [], row: ['a,b', 2], h: "<b>'" }, true],
    ['{{n}} {{f}} {{big}} {{tiny}} {{neg}} {{obj}} {{list}} {{list|json}} {{obj|json}} {{t}} {{nul}}|{{missing|default:dflt}}|{{list|count}}|{{s|upper}}{{s|lower}}', { n: 3, f: 2.5, big: 1e17, tiny: 0.00001, neg: -0.5, obj: { a: [1, 'x'], b: null }, list: ['a', 2, true], t: false, nul: null, s: '\u00dfMix' }, false],
    ['{{#o}}{{a.b}} {{a.c.0}} {{x}}{{/o}} {{#flag}}yes{{/flag}}{{^flag}}no{{/flag}} {{#zero}}z{{.}}{{/zero}}', { o: { a: { b: 'B', c: ['C0'] } }, x: 'outer', flag: true, zero: 0 }, false],
    ['  {{#items}}  \n{{name|oneline}}:{{@n}}/{{@index}}{{#@first}}F{{/@first}}\n  {{/items}}  \n{{! comment }}end', { items: [{ name: ' a \n b ' }, { name: 'c', type: 'big kind' }] }, false],
    ['{{#items}}[{{is_big_kind}}{{date}}]{{/items}} {{join_me|join: / }}', { date: 'outer', items: [{ type: 'big kind' }, {}], join_me: ['p', 'q'] }, false, { type: 'object', properties: { date: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' }, type: { type: 'string' } } } } } }],
    ['{{#a}}x{{/b}}', {}, false],
    ['{{#a}}x', {}, false],
    ['{{x|nope}}', { x: 1 }, false],
  ]
  const fj = fills.map(([tpl, data, escape, schema]) => ({ op: 'fill', tpl, data, escape, schema: schema || {} }))
  const pf = runPy(fj)
  fj.forEach((j, i) => {
    const a = JSON.stringify(pf[i])
    const b = JSON.stringify(runTs(j))
    ok(a === b, `fill snippet #${i}${a === b ? '' : '\n  python ' + a + '\n  ts     ' + b}`)
  })
} finally {
  if (!process.env.PARITY_KEEP) rmSync(work, { recursive: true, force: true }); else console.log("kept " + work)
}
console.log(fails ? `\n${fails} parity check(s) FAILED` : '\nparity: the TypeScript engine matches the Python reference')
process.exit(fails ? 1 : 0)
