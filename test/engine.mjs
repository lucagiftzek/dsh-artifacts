/** node test/engine.mjs: unit tests of the TypeScript template engine (Mustache subset, Python-compatible formatting). */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const T = await import(join(ROOT, 'lib', 'engine', 'templates.js'))
const P = await import(join(ROOT, 'lib', 'engine', 'pyfmt.js'))
let fails = 0
const eq = (a, b, m) => { const c = JSON.stringify(a) === JSON.stringify(b); console.log((c ? 'ok   ' : 'FAIL ') + m + (c ? '' : `\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`)); if (!c) fails++ }
const throws = (f, code, m) => { let e = null; try { f() } catch (x) { e = x } eq(!!e && e.code, code, m) }

// Mustache (moved from the Python suite)
eq(T.fill('a\n{{#xs}}\n- {{.}}{{^@last}},{{/@last}}\n{{/xs}}\n{{^ys}}\nnone\n{{/ys}}\n{{row|csv}}|{{row|cells}}|{{row|sep}}\n{{{h}}} {{h}}\n', { xs: [1, 2], ys: [], row: ['a,b', 2], h: '<b>' }, true),
  'a\n- 1,\n- 2\nnone\n&quot;a,b&quot;,2|a,b | 2|---|---\n<b> &lt;b&gt;\n', 'sections, filters, standalone lines')
const schema = { type: 'object', properties: { date: { type: 'string' }, src: { type: 'array', items: { type: 'object', properties: { date: { type: 'string' } } } } } }
eq(T.fill('{{#src}}[{{date}}]{{/src}}', T.prepare(schema, { date: 'outer', src: [{}] }), false), '[]', 'declared item keys do not fall back to outer values')
throws(() => T.fill('{{#a}}x{{/b}}', {}, false), 'ARTIFACT_RENDER_FAILED', 'unbalanced close')
throws(() => T.fill('{{#a}}x', {}, false), 'ARTIFACT_RENDER_FAILED', 'never closed')
throws(() => T.fill('{{x|nope}}', { x: 1 }, false), 'ARTIFACT_RENDER_FAILED', 'unknown filter')
eq(T.fill('{{a.b.1}} {{n|count}} {{m|default:none}}', { a: { b: ['x', 'y'] }, n: [1, 2, 3], m: '' }, false), 'y 3 none', 'dotted lookup, count, default')

// Python-compatible formatting
eq([P.pyRound(2.675, 2), P.pyRound(0.125, 2), P.pyRound(0.375, 2), P.pyRound(1.6 + 3 * 0.3, 2), P.pyRound(1621.5), P.pyRound(1622.5)], [2.67, 0.12, 0.38, 2.5, 1622, 1622], 'round(): exact value, ties to even')
eq([P.pyFloatRepr(0.1), P.pyFloatRepr(1e-5), P.pyFloatRepr(1.5e16), P.pyFloatRepr(123.456), P.pyNum(10)], ['0.1', '1e-05', '1.5e+16', '123.456', '10'], 'float repr')
eq(P.pyDumps({ a: [1, 'é'], b: null }), '{"a": [1, "\\u00e9"], "b": null}', 'json.dumps default separators and ensure_ascii')
eq(P.pyDumps({ a: [] , b: { c: 1 } }, { ensureAscii: false, indent: 2 }), '{\n  "a": [],\n  "b": {\n    "c": 1\n  }\n}', 'json.dumps indent=2')
eq([P.pyTitle('smoke-report a1b'.replace(/-/g, ' ')), P.htmlEscape(`<a href="x">'&`)], ['Smoke Report A1B', '&lt;a href=&quot;x&quot;&gt;&#x27;&amp;'], 'str.title and html.escape')
eq(T.validate({ type: 'object', properties: { n: { enum: [1] } } }, { n: true }), [], 'enum compares like Python (True == 1)')
eq(T.compilePattern('(?i)^ab\\Z').test('AB'), true, 'Python inline flags and \\Z in patterns')
eq(T.safeStem('../x'), null, 'safeStem refuses paths')
eq(T.safeStem('report.md'), 'report', 'safeStem drops .md')

console.log(fails ? `\n${fails} engine check(s) FAILED` : '\nengine: all checks passed')
process.exit(fails ? 1 : 0)
