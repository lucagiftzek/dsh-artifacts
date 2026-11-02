/**
 * node test/listing.mjs: listing control (2.2), offline in a temp folder.
 *
 *  - parity: lib/listing.js buildIndex == server/artifacts_server.py build_index on the same folder (items, order,
 *    titles, kinds, URLs, hidden handling, attribution), and the two type tables are identical
 *  - the four listing tools through the registered definitions: success and error paths, lossless JSON,
 *    argument validation, copy / link / in-place / re-list / de-list / retitle, sandbox flag for foreign HTML,
 *    secrets refused, size limit, claims for the calling chat
 *  - the CLI wrapper lib/listing-cli.js (exit codes, JSON)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertLossless } from './lossless-check.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'artifact-listing-'))
const R = join(work, 'reports')
const OUT = join(work, 'outside')
mkdirSync(R); mkdirSync(OUT)
Object.assign(process.env, { HOME: work, ARTIFACT_DIR: R, ARTIFACT_BASE_URL: 'https://gui.example/report', DSH_HOME: join(work, 'dsh') })
delete process.env.DSH_SESSION_ID
const SID = 'session-0123456789abcdef'

// fixture: every listing rule the index has
const w = (rel, body, t) => { const p = join(R, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); if (t) utimesSync(p, t, t) }
w('alpha.md', '# Alpha &amp; report\n\nhi\n', 1790000000)
w('beta.html', '<html><head><title>Bee\n page &amp; more</title></head></html>', 1790000100)
w('cee.md', '---\ntitle: "Front title"\n---\nbody\n', 1790000200)
w('cee.html', '<html><head><title>hand made</title></head></html>', 1790000200)
w('dee.md', '# Dee\n', 1790000300)
w('dee.html', '<!doctype html><meta name="generator" content="artifact-kit 2"><title>Dee</title>', 1790000300)
w('app1/index.html', '<title>My app</title>', 1790000400)
w('media/x.png', Buffer.from('89504e470d0a1a0a', 'hex'), 1790000500)
w('media/.hidden.png', 'x')
w('table.csv', 'a,b\n1,2\n', 1790000600)
w('bundle.zip', 'PK', 1790000600)
w('notes.txt', 'n', 1790000700)
w('weird name (1).pdf', '%PDF', 1790000800)
w('skip.exe', 'x', 1790000900)
w('.dot.md', 'x')
w('pic.svg', '<svg/>', 1790001000)
w('greek.html', '<html><head><title>\u03a0\u03c1\u03cc\u03c4\u03b1\u03c3\u03b7 &mdash; \u03a6\u03a0\u0391\n x</title></head></html>', 1790001100)
w('beta.html.public', '')
writeFileSync(join(R, '.artifacts-placeholder'), '')
mkdirSync(join(R, '.artifacts'), { recursive: true })
writeFileSync(join(R, '.artifacts', 'registry.json'), JSON.stringify({ artifacts: { 'table.csv': { sessions: ['0123456789abcdef'] } }, parents: { 'child-aaaaaaaa': '0123456789abcdef' } }))
writeFileSync(join(R, '.artifacts', 'claims.jsonl'), JSON.stringify({ name: 'bundle.zip', session: 'child-aaaaaaaa' }) + '\n')
writeFileSync(join(R, '.artifacts', 'listing.jsonl'), [
  { op: 'hide', name: 'notes.txt' }, { op: 'meta', name: 'alpha.html', title: 'Custom alpha', description: 'why' },
].map((x) => JSON.stringify(x)).join('\n') + '\n')

const L = await import(join(ROOT, 'lib', 'listing.js'))

function pyIndex(session, hidden) {
  const code = `import json,sys,os\nsys.path.insert(0, ${JSON.stringify(join(ROOT, 'server'))})\nimport artifacts_server as S\n` +
    `o = S.build_index(${session ? JSON.stringify(session) : 'None'}, include_hidden=${hidden ? 'True' : 'False'})\no.pop('indexer', None); o.pop('etag', None)\n` +
    `print(json.dumps({'index': o, 'types': S.TYPES, 'kind': S.KIND, 'view': sorted(S.VIEW_KINDS), 'listed': sorted(S.LISTED_KINDS)}))`
  const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', env: process.env })
  if (r.status !== 0) throw new Error('python index failed: ' + r.stderr)
  return JSON.parse(r.stdout)
}
const norm = (o) => JSON.parse(JSON.stringify(o))

try {
  // ---- 1. parity with the Python server ------------------------------------------------------------
  for (const [session, hidden] of [[null, false], [SID, false], [null, true], ['0123456789abcdef', true]]) {
    const py = pyIndex(session, hidden)
    const ts = norm(L.buildIndex(session, hidden))
    const same = JSON.stringify(ts) === JSON.stringify(py.index)
    ok(same, `index parity (session ${session || 'none'}, hidden ${hidden}): ${ts.count} items`)
    if (!same) {
      for (let i = 0; i < Math.max(ts.items.length, py.index.items.length); i++) {
        if (JSON.stringify(ts.items[i]) !== JSON.stringify(py.index.items[i])) { console.log('  ts', JSON.stringify(ts.items[i]), '\n  py', JSON.stringify(py.index.items[i])); break }
      }
      if (ts.items.length === py.index.items.length) console.log('  other keys differ', JSON.stringify({ ...ts, items: 0 }), JSON.stringify({ ...py.index, items: 0 }))
    }
  }
  const py = pyIndex(null, false)
  ok(JSON.stringify(Object.entries(L.TYPES).sort()) === JSON.stringify(Object.entries(py.types).sort()), 'TYPES identical in TypeScript and Python')
  ok(JSON.stringify(Object.entries(L.KIND).sort()) === JSON.stringify(Object.entries(py.kind).sort()), 'KIND identical in TypeScript and Python')
  ok(JSON.stringify([...L.VIEW_KINDS].sort()) === JSON.stringify(py.view) && JSON.stringify([...L.LISTED_KINDS].sort()) === JSON.stringify(py.listed), 'VIEW_KINDS and LISTED_KINDS identical')
  const idx = L.buildIndex()
  const by = Object.fromEntries(idx.items.map((i) => [i.name, i]))
  ok(!by['notes.txt'] && idx.hidden === 1, 'hidden item is not listed and counted')
  ok(by['alpha.html'].title === 'Custom alpha' && by['alpha.html'].description === 'why', 'listing title and description override')
  ok(by['weird name (1).pdf'].url === '/report/weird%20name%20%281%29.pdf', 'URL quoting matches Python quote')
  ok(!by['skip.exe'] && !by['.dot.md'] && !by['media/.hidden.png'], 'unknown types and dot files never listed')

  // ---- 2. the tools ---------------------------------------------------------------------------------
  const index = await import(join(ROOT, 'lib', 'index.js'))
  const tools = new Map()
  const ctx = { inject(deps, cb) { const c = {}; if (deps.includes('tools')) c.tools = { register(d) { tools.set(d.name, d) } }; if (deps.includes('skills')) c.skills = { registerProvider() {} }; cb(c) } }
  const origErr = console.error; console.error = () => {}
  index.apply(ctx, {}, { defineTool: (d) => d }); await index.apply.ready
  console.error = origErr
  ok(['artifact_list', 'artifact_add', 'artifact_remove', 'artifact_update'].every((n) => tools.has(n)), 'listing tools registered')
  const exec = { agent: { session: { id: SID } } }
  const call = async (n, a, e = exec) => { const v = await tools.get(n).execute(a, e); try { await assertLossless(v, n) } catch (x) { ok(false, x.message) } return v }
  const code = async (n, a, c, label, e) => {
    const v = await call(n, a, e)
    ok(v.ok === false && v.code === c && typeof v.hint === 'string' && /^docs\/ERRORS\.md#artifact_/.test(v.docs), `${n} ${label}: ${c}${v.code !== c ? ' got ' + JSON.stringify(v).slice(0, 240) : ''}`)
    return v
  }

  let v = await call('artifact_list', {})
  ok(v.ok && v.scope === 'all' && v.total === idx.count && v.hidden_count === 1, `artifact_list all: ${v.total} items, 1 hidden`)
  const a = v.items.find((i) => i.name === 'alpha.html')
  ok(a.url === 'https://gui.example/report/alpha.html' && a.download_url === 'https://gui.example/report/alpha.html?download=1' && a.downloads.length === 2 && a.path === join(R, 'alpha.md'), 'items carry absolute URLs, downloads and the source path')
  ok(v.items.find((i) => i.name === 'beta.html').public_url === 'https://gui.example/report-public/beta.html', 'public_url for public artifacts')
  v = await call('artifact_list', { scope: 'chat' })
  ok(v.ok && v.items.map((i) => i.name).sort().join() === 'bundle.zip,table.csv', 'scope chat: the calling chat and its subagents (' + v.items.map((i) => i.name).join(', ') + ')')
  v = await call('artifact_list', { kind: 'media' })
  ok(v.ok && v.items.every((i) => ['image', 'audio', 'video'].includes(i.kind)) && v.total === 2, 'kind media')
  v = await call('artifact_list', { query: 'custom' })
  ok(v.ok && v.total === 1 && v.items[0].name === 'alpha.html', 'query matches the listing title')
  v = await call('artifact_list', { include_hidden: true, kind: 'data' })
  ok(v.ok && v.items.some((i) => i.name === 'notes.txt' && i.listed === false), 'include_hidden shows de-listed items with listed false')
  await code('artifact_list', { scope: 'chat' }, 'ARTIFACT_ARGS_INVALID', 'chat without a session', {})
  await code('artifact_list', { kind: 'movies' }, 'ARTIFACT_ARGS_INVALID', 'unknown kind')
  await code('artifact_list', { scope: 'mine' }, 'ARTIFACT_ARGS_INVALID', 'bad scope')
  await code('artifact_list', { limit: 0 }, 'ARTIFACT_ARGS_INVALID', 'limit 0')

  // add: copy from outside, attached to the chat
  writeFileSync(join(OUT, 'Chart Q3.png'), Buffer.from('89504e470d0a1a0a00', 'hex'))
  v = await call('artifact_add', { path: join(OUT, 'Chart Q3.png'), title: 'Q3 chart', description: 'Revenue by month' })
  ok(v.ok && v.action === 'copied' && v.name === 'Chart-Q3.png' && existsSync(join(R, 'Chart-Q3.png')), 'add copies under a safe slug: ' + v.name)
  ok(v.title === 'Q3 chart' && v.this_chat === undefined && v.view_url.endsWith('?view=1') && v.thumbnail_url.includes('?thumb=1'), 'add returns title, view and thumbnail URLs')
  v = await call('artifact_list', { scope: 'chat', kind: 'image' })
  ok(v.ok && v.items.some((i) => i.name === 'Chart-Q3.png' && i.this_chat), 'the added file shows under This chat')
  v = await call('artifact_add', { path: join(OUT, 'Chart Q3.png') })
  ok(v.ok && /identical/.test(v.action), 'adding the same file again is a no-op re-list')
  writeFileSync(join(OUT, 'Chart Q3.png'), Buffer.from('89504e470d0a1a0a0102', 'hex'))
  await code('artifact_add', { path: join(OUT, 'Chart Q3.png') }, 'ARTIFACT_EXISTS', 'different content, same name')
  v = await call('artifact_add', { path: join(OUT, 'Chart Q3.png'), force: true })
  ok(v.ok && v.action === 'copied' && statSync(join(R, 'Chart-Q3.png')).size === 10, 'force replaces it')
  // link mode
  writeFileSync(join(OUT, 'big.mp4'), 'not really a video')
  v = await call('artifact_add', { path: join(OUT, 'big.mp4'), slug: 'demo-video', mode: 'link' })
  ok(v.ok && v.action === 'linked' && statSync(join(R, 'demo-video.mp4')).ino === statSync(join(OUT, 'big.mp4')).ino, 'link mode hardlinks (same inode)')
  // in place
  v = await call('artifact_add', { path: join(R, 'table.csv'), title: 'The table' })
  ok(v.ok && v.action === 'listed in place' && v.title === 'The table', 'a file already in the folder is listed in place')
  // foreign HTML is sandboxed unless trusted
  writeFileSync(join(OUT, 'page.html'), '<html><head><title>T</title></head><body><script>1</script></body></html>')
  v = await call('artifact_add', { path: join(OUT, 'page.html') })
  ok(v.ok && /sandboxed/.test(v.note) && L.readListing()['page.html'].sandbox === true, 'HTML from outside is flagged sandbox')
  v = await call('artifact_add', { path: join(OUT, 'page.html'), slug: 'page2', trusted: true })
  ok(v.ok && !v.note && L.readListing()['page2.html'].sandbox === false, 'trusted: true lifts the sandbox')
  // markdown goes in as a doc pair
  writeFileSync(join(OUT, 'memo.md'), '# Memo\n')
  v = await call('artifact_add', { path: join(OUT, 'memo.md') })
  ok(v.ok && v.name === 'memo.html' && v.kind === 'doc' && v.path === join(R, 'memo.md'), 'Markdown lists as its rendered page')
  // refusals
  await code('artifact_add', {}, 'ARTIFACT_ARGS_INVALID', 'neither path nor name')
  await code('artifact_add', { path: join(OUT, 'missing.png') }, 'ARTIFACT_SOURCE_INVALID', 'missing file')
  await code('artifact_add', { path: OUT }, 'ARTIFACT_SOURCE_INVALID', 'a folder')
  writeFileSync(join(OUT, 'tool.exe'), 'x')
  v = await code('artifact_add', { path: join(OUT, 'tool.exe') }, 'ARTIFACT_TYPE_UNSUPPORTED', 'unknown type')
  ok(Array.isArray(v.supported) && v.supported.includes('.png'), 'the refusal lists the supported extensions')
  writeFileSync(join(OUT, 'creds.txt'), 'SERVICE_API_TOKEN = ' + 'x1'.repeat(10) + '\n')
  await code('artifact_add', { path: join(OUT, 'creds.txt') }, 'ARTIFACT_SECRET_REFUSED', 'credential-shaped text')
  await code('artifact_add', { path: join(OUT, 'page.html'), slug: '../x' }, 'ARTIFACT_BAD_NAME', 'bad slug')
  await code('artifact_add', { path: join(OUT, 'page.html'), mode: 'move' }, 'ARTIFACT_ARGS_INVALID', 'bad mode')
  await code('artifact_add', { path: join(OUT, 'page.html'), title: 7 }, 'ARTIFACT_ARGS_INVALID', 'title not a string')
  process.env.ARTIFACT_MAX_ADD_MB = '1'
  writeFileSync(join(OUT, 'huge.bin.csv'), Buffer.alloc(1048577, 65))
  await code('artifact_add', { path: join(OUT, 'huge.bin.csv') }, 'ARTIFACT_FILE_TOO_LARGE', 'over ARTIFACT_MAX_ADD_MB')
  delete process.env.ARTIFACT_MAX_ADD_MB

  // remove / re-list / update
  v = await call('artifact_remove', { name: 'Chart-Q3' })
  ok(v.ok && v.name === 'Chart-Q3.png' && v.listed === false && existsSync(join(R, 'Chart-Q3.png')), 'remove de-lists by stem, the file stays')
  v = await call('artifact_list', {})
  ok(!v.items.some((i) => i.name === 'Chart-Q3.png'), 'de-listed item gone from the list')
  ok(!pyIndex(null, false).index.items.some((i) => i.name === 'Chart-Q3.png'), 'the Python server hides it too')
  v = await call('artifact_remove', { name: 'https://gui.example/report/Chart-Q3.png' })
  ok(v.ok && v.already_hidden === true, 'remove by URL, idempotent')
  v = await call('artifact_add', { name: 'Chart-Q3.png' })
  ok(v.ok && v.action === 'listed again' && v.listed === true, 're-list with artifact_add({ name })')
  v = await call('artifact_remove', { name: join(R, 'alpha.md') })
  ok(v.ok && v.name === 'alpha.html', 'remove by path of the Markdown source')
  await call('artifact_add', { name: '~/reports/alpha.md' })
  await code('artifact_remove', { name: 'nothing-like-this' }, 'ARTIFACT_NOT_FOUND', 'unknown name')
  w('dup.csv', 'x'); w('dup.json', '{}')
  v = await code('artifact_remove', { name: 'dup' }, 'ARTIFACT_AMBIGUOUS', 'two files with one stem')
  ok(Array.isArray(v.candidates) && v.candidates.length === 2, 'ambiguity lists candidates')
  await code('artifact_remove', {}, 'ARTIFACT_ARGS_INVALID', 'no name')
  v = await call('artifact_update', { name: 'demo-video.mp4', title: 'Demo', description: 'A short demo' })
  ok(v.ok && v.title === 'Demo' && v.description === 'A short demo', 'update sets title and description')
  v = await call('artifact_update', { name: 'demo-video.mp4', description: '' })
  ok(v.ok && v.title === 'Demo' && v.description === '', 'update with "" clears one field and keeps the other')
  await code('artifact_update', { name: 'demo-video.mp4' }, 'ARTIFACT_ARGS_INVALID', 'nothing to update')
  await code('artifact_update', { name: 'demo-video.mp4', title: 'x'.repeat(301) }, 'ARTIFACT_ARGS_INVALID', 'title too long')
  const claims = readFileSync(join(R, '.artifacts', 'claims.jsonl'), 'utf8')
  ok(claims.includes('"name":"Chart-Q3.png","session":"' + SID + '"'), 'added files are claimed for the calling chat')
  const lines = readFileSync(join(R, '.artifacts', 'listing.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  ok(lines.slice(2).every((l) => typeof l.time === 'number' && l.op && l.name), 'listing.jsonl rows are well formed (' + lines.length + ')')

  // final parity after all the writes
  const pyEnd = pyIndex(SID, true).index
  ok(JSON.stringify(norm(L.buildIndex(SID, true))) === JSON.stringify(pyEnd), 'index parity after adds, removes and updates')

  // ---- 3. CLI wrapper -------------------------------------------------------------------------------
  const cli = (cmd, payload) => spawnSync(process.execPath, [join(ROOT, 'lib', 'listing-cli.js'), cmd], { input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, DSH_SESSION_ID: SID } })
  let r = cli('list', { kind: 'video' })
  ok(r.status === 0 && JSON.parse(r.stdout).items[0].name === 'demo-video.mp4', 'listing-cli list')
  r = cli('remove', { name: 'nope' })
  ok(r.status === 2 && JSON.parse(r.stdout).code === 'ARTIFACT_NOT_FOUND', 'listing-cli exit 2 on refused input')
  r = cli('frobnicate', {})
  ok(r.status === 2 && JSON.parse(r.stdout).code === 'ARTIFACT_ARGS_INVALID', 'listing-cli unknown command')
  r = spawnSync('python3', [join(ROOT, 'contrib', 'artifact'), 'add', join(OUT, 'big.mp4'), '--name', 'cli-video', '--json'], { encoding: 'utf8', env: process.env })
  ok(r.status === 0 && JSON.parse(r.stdout).name === 'cli-video.mp4', 'artifact add (Python CLI) through the node half')
  r = spawnSync('python3', [join(ROOT, 'contrib', 'artifact'), 'remove', 'cli-video.mp4'], { encoding: 'utf8', env: process.env })
  ok(r.status === 0 && /de-listed: cli-video.mp4/.test(r.stdout), 'artifact remove (Python CLI)')
} catch (e) {
  ok(false, 'unexpected: ' + (e && e.stack || e))
} finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} listing check(s) FAILED` : '\nlisting: all checks passed')
process.exit(fails ? 1 : 0)
