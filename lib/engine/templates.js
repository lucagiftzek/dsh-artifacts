import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, accessSync, constants as FS } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PY_WS, collapseWs, htmlEscape, pyDumps, pyEq, pyLen, pyNum, pyRepr, pyRound, pyStr, pyStrip, pyTitle, wordCount } from "./pyfmt.js";
class TemplateError extends Error {
  code;
  errors;
  constructor(message, code = "ARTIFACT_TEMPLATE_BROKEN", errors) {
    super(message);
    this.name = "TemplateError";
    this.code = code;
    if (errors) this.errors = errors;
  }
}
const HERE = dirname(fileURLToPath(import.meta.url));
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
const PLUGIN = real(resolve(HERE, "..", ".."));
const BUNDLED = join(PLUGIN, "templates");
const KINDS = ["markdown", "react", "motion"];
const META_FILES = /* @__PURE__ */ new Set(["template.json", "README.md", "preview.png", "example"]);
const DASHES = ["\u2014", "\u2013"];
function home(env) {
  return env.HOME || homedir();
}
function expandUser(p, env) {
  if (p === "~") return home(env);
  if (p.startsWith("~/")) return join(home(env), p.slice(2));
  return p;
}
function estateDir(env = process.env) {
  return join(home(env), "estate", "templates", "artifacts");
}
function userDir(env = process.env) {
  const dsh = env.DSH_HOME ? resolve(expandUser(env.DSH_HOME, env)) : join(home(env), ".dsh");
  return join(dsh, "artifacts", "templates");
}
function reportDir(env = process.env) {
  return real(resolve(expandUser(env.ARTIFACT_DIR || join(home(env), "reports"), env)));
}
function baseUrl(env = process.env) {
  return (env.ARTIFACT_BASE_URL || "/report").replace(/\/+$/, "");
}
function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function exists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
function resolveLoose(p) {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
  }
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(resolveLoose(parent), basename(abs));
}
function writable(dir) {
  let d = resolve(dir);
  for (; ; ) {
    if (exists(d)) {
      try {
        accessSync(d, FS.W_OK);
        return isDir(d);
      } catch {
        return false;
      }
    }
    const up = dirname(d);
    if (up === d) return false;
    d = up;
  }
}
function searchDirs(env = process.env, opts = {}) {
  const out = [];
  for (const p of (env.ARTIFACT_TEMPLATES || "").split(":")) {
    if (p.trim()) out.push({ path: expandUser(p, env), source: "custom" });
  }
  out.push({ path: estateDir(env), source: "estate" });
  out.push({ path: userDir(env), source: "user" });
  out.push({ path: BUNDLED, source: "bundled" });
  const seen = /* @__PURE__ */ new Set();
  const res = [];
  for (const d of out) {
    const r = resolveLoose(d.path);
    if (seen.has(r)) continue;
    if (isDir(d.path) || opts.includeMissingUser && d.source === "user") {
      seen.add(r);
      res.push(d);
    }
  }
  return res;
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
function load(folder) {
  const p = join(folder, "template.json");
  let raw;
  try {
    raw = readFileSync(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new TemplateError(`${folder}/template.json is unreadable: ${e && e.message}`);
  }
  let t;
  try {
    t = JSON.parse(raw);
  } catch (e) {
    throw new TemplateError(`${folder}/template.json is not valid JSON: ${e && e.message}`);
  }
  if (!t || typeof t !== "object" || Array.isArray(t)) throw new TemplateError(`${folder}/template.json must hold an object`);
  t.dir = folder;
  if (!("id" in t)) t.id = basename(folder);
  if (!KINDS.includes(t.kind)) throw new TemplateError(`${folder}: kind must be one of ${KINDS.join(", ")}`);
  return t;
}
function sortNames(names) {
  return names.slice().sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function allTemplates(env = process.env) {
  const found = /* @__PURE__ */ new Map();
  for (const d of searchDirs(env)) {
    let names;
    try {
      names = sortNames(readdirSync(d.path));
    } catch {
      continue;
    }
    for (const name of names) {
      const sub = join(d.path, name);
      if (!isDir(sub) || name.startsWith(".") || name.startsWith("_")) continue;
      let t;
      try {
        t = load(sub);
      } catch (e) {
        t = { id: name, error: String(e && e.message), dir: sub, kind: "?", title: name };
      }
      if (t && !found.has(t.id)) {
        t.source = d.source;
        found.set(t.id, t);
      }
    }
  }
  return [...found.keys()].sort().map((k) => found.get(k));
}
function get(tid, env = process.env) {
  const all = allTemplates(env);
  for (const t of all) {
    if (t.id === tid) {
      if (t.error) throw new TemplateError(t.error, "ARTIFACT_TEMPLATE_BROKEN");
      return t;
    }
  }
  const ids = all.map((t) => t.id).join(", ") || "(none)";
  throw new TemplateError(`no template ${pyRepr(String(tid))} (available: ${ids})`, "ARTIFACT_TEMPLATE_NOT_FOUND");
}
function exampleOf(t) {
  const ex = t.example;
  if (typeof ex === "string") {
    const p = join(t.dir, ex);
    try {
      return readJson(p);
    } catch (e) {
      throw new TemplateError(`${t.id}: example file ${p} unreadable: ${e && e.message}`);
    }
  }
  if (ex === null || ex === void 0) throw new TemplateError(`${t.id}: template.json has no example`);
  return structuredClone(ex);
}
function previewRel(t) {
  const stem = "template-preview-" + t.id;
  return t.kind === "react" ? stem + "/" : stem + ".html";
}
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isJsonObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function typeOf(s) {
  if (!isObj(s)) return "any";
  if ("enum" in s && Array.isArray(s.enum)) return s.enum.map((v) => pyStr(v)).join("|");
  const ty = s.type ?? "any";
  return Array.isArray(ty) ? ty.join("|") : String(ty);
}
function summary(schema, depth = 0) {
  const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
  const req = new Set(isObj(schema) && Array.isArray(schema.required) ? schema.required : []);
  const parts = [];
  for (const [k, s] of Object.entries(props)) {
    const mark = req.has(k) ? "*" : "";
    const ty = isObj(s) ? s.type : void 0;
    if (ty === "array" && isObj(s.items) && isObj(s.items.properties) && Object.keys(s.items.properties).length && depth < 2) parts.push(`${k}${mark}[${summary(s.items, depth + 1)}]`);
    else if (ty === "object" && isObj(s.properties) && Object.keys(s.properties).length && depth < 2) parts.push(`${k}${mark}{${summary(s, depth + 1)}}`);
    else if (ty === "array") parts.push(`${k}${mark}[]`);
    else parts.push(k + mark);
  }
  return parts.join(", ");
}
function fields(schema, prefix = "", out = []) {
  const props = isObj(schema.properties) ? schema.properties : {};
  const req = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const [k, s0] of Object.entries(props)) {
    const s = isObj(s0) ? s0 : {};
    const path = prefix + k;
    const extra = s["x-asset"] ? " (local file, copied next to the artifact)" : "";
    out.push({ path, type: typeOf(s), required: req.has(k), description: pyStrip((typeof s.description === "string" ? s.description : "") + extra), default: s.default === void 0 ? null : s.default });
    if (s.type === "object" && isObj(s.properties) && Object.keys(s.properties).length) fields(s, path + ".", out);
    const it = s.items;
    if (s.type === "array" && isObj(it)) {
      if (isObj(it.properties) && Object.keys(it.properties).length) fields(it, path + "[].", out);
      else if (it.type === "array" && isObj(it.items) && isObj(it.items.properties) && Object.keys(it.items.properties).length) fields(it.items, path + "[][].", out);
    }
  }
  return out;
}
function minimal(schema, value) {
  if (!isObj(schema)) return value;
  if (isJsonObj(value) && isObj(schema.properties) && Object.keys(schema.properties).length) {
    const req = Array.isArray(schema.required) ? schema.required : [];
    const out = {};
    for (const k of req) if (k in value) out[k] = minimal(schema.properties[k] ?? {}, value[k]);
    return out;
  }
  if (Array.isArray(value)) {
    const n = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 1);
    return value.slice(0, n).map((v) => minimal(schema.items ?? {}, v));
  }
  return value;
}
function isType(v, ty) {
  switch (ty) {
    case "null":
      return v === null;
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number";
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "object":
      return isObj(v);
    case "array":
      return Array.isArray(v);
    default:
      return true;
  }
}
function nameOf(v) {
  if (v === null || v === void 0) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  return "object";
}
function compilePattern(p) {
  let src = p;
  let flags = "";
  const m = /^\(\?([aiLmsux]+)\)/.exec(src);
  if (m) {
    src = src.slice(m[0].length);
    for (const f of m[1]) if ("ims".includes(f) && !flags.includes(f)) flags += f;
  }
  src = src.replace(/\\A/g, "^").replace(/\\Z/g, "$").replace(/\(\?P</g, "(?<").replace(/\(\?P=(\w+)\)/g, "\\k<$1>");
  try {
    return new RegExp(src, flags + "u");
  } catch {
    return new RegExp(src, flags);
  }
}
function validate(schema, data, path = "data", errors = []) {
  if (!isObj(schema)) return errors;
  const ty = schema.type;
  if (ty) {
    const tys = Array.isArray(ty) ? ty : [ty];
    if (!tys.some((t) => isType(data, t))) {
      errors.push(`${path}: expected ${tys.join(" or ")}, got ${nameOf(data)}`);
      return errors;
    }
  }
  if ("const" in schema && !pyEq(data, schema.const)) errors.push(`${path}: must be ${pyDumps(schema.const)}`);
  if ("enum" in schema && Array.isArray(schema.enum) && !schema.enum.some((e) => pyEq(data, e))) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => pyDumps(v)).join(", ")} (got ${pyDumps(data)})`);
  }
  for (const kw of ["anyOf", "oneOf"]) {
    if (kw in schema && Array.isArray(schema[kw])) {
      const ok = schema[kw].filter((s) => !validate(s, structuredClone(data), path).length);
      if (!ok.length || kw === "oneOf" && ok.length > 1) errors.push(`${path}: does not match ${kw === "anyOf" ? "any" : "exactly one"} of the allowed shapes`);
    }
  }
  if (typeof data === "string") {
    const n = pyLen(data);
    if (n < (typeof schema.minLength === "number" ? schema.minLength : 0)) errors.push(`${path}: too short (min ${Math.trunc(schema.minLength)} characters)`);
    if ("maxLength" in schema && n > schema.maxLength) errors.push(`${path}: too long (${n} characters, max ${Math.trunc(schema.maxLength)})`);
    if ("pattern" in schema && !compilePattern(String(schema.pattern)).test(data)) errors.push(`${path}: does not match the pattern ${schema.pattern}`);
  }
  if (typeof data === "number") {
    if ("minimum" in schema && data < schema.minimum) errors.push(`${path}: ${pyNum(data)} is below the minimum ${pyStr(schema.minimum)}`);
    if ("maximum" in schema && data > schema.maximum) errors.push(`${path}: ${pyNum(data)} is above the maximum ${pyStr(schema.maximum)}`);
  }
  if (Array.isArray(data)) {
    if (data.length < (typeof schema.minItems === "number" ? schema.minItems : 0)) errors.push(`${path}: needs at least ${Math.trunc(schema.minItems)} item(s), has ${data.length}`);
    if ("maxItems" in schema && data.length > schema.maxItems) errors.push(`${path}: at most ${Math.trunc(schema.maxItems)} item(s), has ${data.length}`);
    if (isObj(schema.items)) data.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
  }
  if (isJsonObj(data)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    for (const k of Array.isArray(schema.required) ? schema.required : []) {
      if (!(k in data)) {
        if (isObj(props[k]) && "default" in props[k]) continue;
        errors.push(`${path}: missing required property "${k}"`);
      }
    }
    for (const [k, s] of Object.entries(props)) {
      if (!(k in data) && isObj(s) && "default" in s) data[k] = structuredClone(s.default);
    }
    const extra = "additionalProperties" in schema ? schema.additionalProperties : true;
    for (const [k, v] of Object.entries(data)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) validate(props[k], v, `${path}.${k}`, errors);
      else if (extra === false) errors.push(`${path}.${k}: unknown property (allowed: ${Object.keys(props).join(", ")})`);
      else if (isObj(extra)) validate(extra, v, `${path}.${k}`, errors);
    }
  }
  return errors;
}
function lintText(data, path = "data", out = []) {
  if (typeof data === "string") {
    for (const [ch, nm] of [[DASHES[0], "an em dash"], [DASHES[1], "an en dash"]]) {
      if (data.includes(ch)) out.push(`${path}: contains ${nm}; use a comma, colon or full stop`);
    }
  } else if (Array.isArray(data)) {
    data.forEach((v, i) => lintText(v, `${path}[${i}]`, out));
  } else if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) lintText(v, `${path}.${k}`, out);
  }
  return out;
}
const S = "[" + PY_WS + "]";
const SECRET_PATTERNS = [
  /sk-ant-(oat|api)|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|ghp|gho|xox[baprs])-[A-Za-z0-9]{16,}/,
  new RegExp("(^|" + S + '|")([A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)' + S + "*[=:]" + S + "*[^" + PY_WS + "]{8,}")
];
const SECRET_MESSAGE = "data: contains a credential-shaped string; artifacts are served over HTTP, report status, never values";
function hasSecret(text) {
  return SECRET_PATTERNS.some((p) => p.test(text));
}
function secretCheck(data) {
  return hasSecret(pyDumps(data, { ensureAscii: false })) ? [SECRET_MESSAGE] : [];
}
function check(t, data, base) {
  const errors = validate(t.schema ?? {}, data);
  errors.push(...secretCheck(data));
  if (base !== void 0 && base !== null && !errors.length) collectAssets(t.schema ?? {}, data, base, errors);
  return [errors, lintText(data)];
}
function isUrl(s) {
  return /^([a-z][a-z0-9+.-]*:|\/|#)/i.test(s);
}
function assetSource(data, base, env) {
  const ex = expandUser(data, env);
  if (isAbsolute(ex)) return ex;
  return resolveLoose(join(base, ex));
}
function collectAssets(schema, data, base, errors, path = "data", copied = /* @__PURE__ */ new Map(), env = process.env) {
  if (!isObj(schema)) return copied;
  if (schema["x-asset"] && typeof data === "string" && data && !isUrl(data)) {
    const src = assetSource(data, base, env);
    if (!isFile(src)) {
      errors.push(`${path}: file not found: ${src}`);
      return copied;
    }
    let name = basename(src).replace(/[^A-Za-z0-9._-]+/g, "-");
    if (copied.has(name) && copied.get(name) !== src) {
      const ext = pyExt(name);
      name = `${name.slice(0, name.length - ext.length)}-${copied.size}${ext}`;
    }
    copied.set(name, src);
    return copied;
  }
  if (isObj(data)) {
    for (const [k, v] of Object.entries(data)) collectAssets(isObj(schema.properties) ? schema.properties[k] ?? {} : {}, v, base, errors, `${path}.${k}`, copied, env);
  } else if (Array.isArray(data)) {
    data.forEach((v, i) => collectAssets(schema.items ?? {}, v, base, errors, `${path}[${i}]`, copied, env));
  }
  return copied;
}
function pyExt(name) {
  const e = extname(name);
  return e === name ? "" : e;
}
function rewriteAssets(schema, data, base, prefix, copied, env = process.env) {
  if (!isObj(schema)) return data;
  if (schema["x-asset"] && typeof data === "string" && data && !isUrl(data)) {
    const src = assetSource(data, base, env);
    for (const [name, p] of copied) if (p === src) return prefix + name;
    return data;
  }
  if (isObj(data)) {
    const out = {};
    for (const [k, v] of Object.entries(data)) out[k] = rewriteAssets(isObj(schema.properties) ? schema.properties[k] ?? {} : {}, v, base, prefix, copied, env);
    return out;
  }
  if (Array.isArray(data)) return data.map((v) => rewriteAssets(schema.items ?? {}, v, base, prefix, copied, env));
  return data;
}
function words(v) {
  if (typeof v === "string") return wordCount(v);
  if (Array.isArray(v)) return v.reduce((a, x) => a + words(x), 0);
  if (isObj(v)) return Object.values(v).reduce((a, x) => a + words(x), 0);
  return 0;
}
const NON_WORD = /[^\p{L}\p{N}_]/gu;
function prepare(schema, data) {
  if (Array.isArray(data)) return data.map((v) => prepare(isObj(schema) ? schema.items ?? {} : {}, v));
  if (!isObj(data)) return data;
  const props = isObj(schema) && isObj(schema.properties) ? schema.properties : {};
  const out = {};
  for (const [k, v] of Object.entries(data)) out[k] = prepare(props[k] ?? {}, v);
  for (const k of Object.keys(props)) if (!(k in out)) out[k] = null;
  if (typeof out.type === "string") out["is_" + out.type.replace(NON_WORD, "_")] = true;
  return out;
}
function num(v, d) {
  return typeof v === "number" ? v : d;
}
function derive(t, data) {
  const tm = t.timing;
  if (!tm) return data;
  const list = data[typeof tm.list === "string" ? tm.list : "scenes"];
  const items = Array.isArray(list) ? list : [];
  let start = 0;
  items.forEach((it, i) => {
    if (!isJsonObj(it)) return;
    it.sid = `s${i + 1}`;
    if (!pyTruthy(it.seconds)) {
      const textFields = Array.isArray(tm.text_fields) ? tm.text_fields : [];
      const w = textFields.reduce((a, f) => a + words(it[f]), 0);
      const byType = isObj(tm.min_by_type) ? tm.min_by_type : {};
      const key = pyStr(it.type ?? null);
      const perType = Object.prototype.hasOwnProperty.call(byType, key) ? byType[key] : num(tm.min, 2.5);
      it.seconds = pyRound(Math.min(num(tm.max, 9), Math.max(perType, num(tm.base, 1.5) + w * num(tm.per_word, 0.3))), 2);
    }
    it.start = pyRound(start, 2);
    start += Number(it.seconds);
    it.end = pyRound(start, 2);
  });
  data._duration = pyRound(start, 2);
  return data;
}
const STANDALONE = new RegExp("(?<=^|\\n)[ \\t]*(\\{\\{" + S + "*[#^/!][^}]*\\}\\})[ \\t]*\\r?\\n", "g");
const TAG = new RegExp("\\{\\{\\{" + S + "*(.+?)" + S + "*\\}\\}\\}|\\{\\{" + S + "*([#^/!&]?)" + S + "*(.+?)" + S + "*\\}\\}", "g");
function parse(tpl0) {
  const tpl = tpl0.replace(STANDALONE, "$1");
  const root = [];
  const stack = [["", root]];
  let pos = 0;
  for (const m of tpl.matchAll(TAG)) {
    const at = m.index;
    if (at > pos) stack[stack.length - 1][1].push({ t: "text", s: tpl.slice(pos, at) });
    pos = at + m[0].length;
    if (m[1] !== void 0) {
      stack[stack.length - 1][1].push({ t: "var", name: m[1], raw: true });
      continue;
    }
    const sig = m[2];
    const name = m[3];
    if (sig === "!") continue;
    if (sig === "#" || sig === "^") {
      const node = { t: "sec", name, inv: sig === "^", kids: [] };
      stack[stack.length - 1][1].push(node);
      stack.push([name, node.kids]);
    } else if (sig === "/") {
      if (stack.length === 1 || stack[stack.length - 1][0] !== name) {
        throw new TemplateError(`template: {{/${name}}} closes ${stack.length > 1 ? `{{#${stack[stack.length - 1][0]}}}` : "nothing"}`, "ARTIFACT_RENDER_FAILED");
      }
      stack.pop();
    } else {
      stack[stack.length - 1][1].push({ t: "var", name, raw: sig === "&" });
    }
  }
  if (stack.length > 1) throw new TemplateError(`template: {{#${stack[stack.length - 1][0]}}} is never closed`, "ARTIFACT_RENDER_FAILED");
  if (pos < tpl.length) root.push({ t: "text", s: tpl.slice(pos) });
  return root;
}
function lookup(stack, name) {
  if (name === ".") return stack[stack.length - 1];
  const parts = name.split(".");
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (isObj(frame) && Object.prototype.hasOwnProperty.call(frame, parts[0])) {
      let v = frame[parts[0]];
      for (const p of parts.slice(1)) {
        if (isObj(v)) v = Object.prototype.hasOwnProperty.call(v, p) ? v[p] : null;
        else if (Array.isArray(v) && /^[0-9]+$/.test(p) && Number(p) < v.length) v = v[Number(p)];
        else return null;
      }
      return v;
    }
  }
  return null;
}
function scalar(v) {
  if (v === null || v === void 0) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return pyNum(v);
  if (typeof v === "object") return pyDumps(v, { ensureAscii: false });
  return String(v);
}
function csvCell(v) {
  const s = scalar(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function pyTruthy(v) {
  return !isEmptyValue(v) && v !== 0;
}
function isEmptyValue(v) {
  return v === null || v === void 0 || v === false || v === "" || Array.isArray(v) && v.length === 0 || isObj(v) && Object.keys(v).length === 0;
}
function applyFilter(v, f) {
  const i = f.indexOf(":");
  const name = pyStrip(i < 0 ? f : f.slice(0, i));
  const arg = i < 0 ? "" : f.slice(i + 1);
  const seq = Array.isArray(v) ? v : v === null || v === void 0 ? [] : [v];
  switch (name) {
    case "join":
      return seq.map(scalar).join(arg || ", ");
    case "csv":
      return seq.map(csvCell).join(",");
    case "cells":
      return seq.map((x) => collapseWs(scalar(x)).replace(/\|/g, "\\|")).join(" | ");
    case "sep":
      return seq.map(() => "---").join("|");
    case "json":
      return pyDumps(v, { ensureAscii: false });
    case "oneline":
      return pyStrip(collapseWs(scalar(v)));
    case "lower":
      return scalar(v).toLowerCase();
    case "upper":
      return scalar(v).toUpperCase();
    case "count":
      return seq.length;
    case "default":
      return v === null || v === void 0 || v === "" || Array.isArray(v) && v.length === 0 ? arg : v;
  }
  throw new TemplateError(`template: unknown filter ${pyRepr(name)}`, "ARTIFACT_RENDER_FAILED");
}
function render(nodes, stack, escape) {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.s;
    else if (n.t === "var") {
      const [name, ...filters] = n.name.split("|").map(pyStrip);
      let v = lookup(stack, name);
      for (const f of filters) v = applyFilter(v, f);
      if (Array.isArray(v) && !filters.length) v = v.map(scalar).join(", ");
      const s = scalar(v);
      out += n.raw || !escape ? s : htmlEscape(s);
    } else {
      const v = lookup(stack, n.name);
      const empty = isEmptyValue(v);
      if (n.inv) {
        if (empty) out += render(n.kids, stack, escape);
      } else if (Array.isArray(v)) {
        v.forEach((item, i) => {
          const frame = { "@n": i + 1, "@index": i, "@first": i === 0, "@last": i === v.length - 1 };
          out += render(n.kids, [...stack, frame, item], escape);
        });
      } else if (!empty) {
        out += render(n.kids, [...stack, v], escape);
      }
    }
  }
  return out;
}
function fill(tpl, data, escape) {
  return render(parse(tpl), [data], escape);
}
function today() {
  const d = /* @__PURE__ */ new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function context(t, data, name, title) {
  const ctx = { ...data };
  if (!("title" in ctx)) ctx.title = title;
  ctx._name = name;
  ctx._template = t.id;
  ctx._date = today();
  return ctx;
}
function readText(p) {
  return readFileSync(p, "utf8").replace(/\r\n?/g, "\n");
}
function walk(dir) {
  const out = [];
  const rec = (rel) => {
    let ents;
    try {
      ents = readdirSync(join(dir, ...rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const r = [...rel, e.name];
      out.push(r);
      if (e.isDirectory()) rec(r);
    }
  };
  rec([]);
  out.sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length - b.length;
  });
  return out.map((parts) => parts.join(sep));
}
const MOTION_SIZES = {
  landscape: [1920, 1080],
  "1080p": [1920, 1080],
  portrait: [1080, 1920],
  vertical: [1080, 1920],
  square: [1080, 1080],
  "720p": [1280, 720]
};
function parseSize(s) {
  if (!s) return MOTION_SIZES.landscape;
  const v = String(s).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MOTION_SIZES, v)) return MOTION_SIZES[v];
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(v);
  if (!m) throw new TemplateError("--size must be landscape|portrait|square|720p|WxH", "ARTIFACT_DATA_INVALID");
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}
function motionEsc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function motionScaffold(reportDirPath, stem, title, w, h, warnings) {
  const proj = join(reportDirPath, stem + ".motion");
  const page = join(reportDirPath, stem + ".html");
  for (const p of [proj, page]) if (exists(p)) throw new TemplateError(`${p} already exists: edit it instead`, "ARTIFACT_EXISTS");
  const playerSrc = join(PLUGIN, "contrib", "motion-player.html");
  const player = readText(playerSrc).replaceAll("__TITLE__", motionEsc(title)).replaceAll("__NAME__", stem).replaceAll("__W__", String(w)).replaceAll("__H__", String(h));
  mkdirSync(join(proj, "vendor"), { recursive: true });
  mkdirSync(join(proj, "assets"));
  const gsap = join(PLUGIN, "vendor", "gsap.js");
  if (isFile(gsap)) copyFileSync(gsap, join(proj, "vendor", "gsap.min.js"));
  else warnings.push("motion: vendor/gsap.js is missing in the plugin (run scripts/vendor.sh), the composition will not animate until vendor/gsap.min.js exists");
  writeFileSync(
    join(proj, "vendor", "README.txt"),
    `GSAP core is copied here so the project renders on any machine (local or a remote render host).
Need a plugin (SplitText, MotionPath, DrawSVG, Flip...)? Copy it next to gsap.min.js:
  cp ${join(PLUGIN, "vendor", "gsap")}/<Plugin>.min.js vendor/   and add <script src="vendor/<Plugin>.min.js"></script>
`
  );
  writeFileSync(page, player);
}
function create(t, data, reportDirPath, stem, baseDir, opts = {}) {
  const env = opts.env ?? process.env;
  const force = !!opts.force;
  const [errors, warnings] = check(t, data);
  if (errors.length) throw new TemplateError(`data does not fit template ${t.id}:
  ${errors.join("\n  ")}`, errors.includes(SECRET_MESSAGE) ? "ARTIFACT_SECRET_REFUSED" : "ARTIFACT_DATA_INVALID", errors);
  const tdir = t.dir;
  const kind = t.kind;
  const title = opts.title || (pyTruthy(data.title) ? typeof data.title === "string" ? data.title : scalar(data.title) : "") || pyTitle(stem.replace(/-/g, " "));
  let target, assetDir, prefix;
  if (kind === "markdown") {
    target = join(reportDirPath, stem + ".md");
    assetDir = join(reportDirPath, stem + "-files");
    prefix = stem + "-files/";
  } else if (kind === "react") {
    target = join(reportDirPath, stem);
    assetDir = join(target, "assets");
    prefix = "assets/";
  } else {
    target = join(reportDirPath, stem + ".motion");
    assetDir = join(target, "assets");
    prefix = "assets/";
  }
  if (exists(target) && !force) throw new TemplateError(`${target} already exists: edit it, or pass --force to regenerate it from the data`, "ARTIFACT_EXISTS");
  const aerr = [];
  const copied = collectAssets(t.schema ?? {}, data, baseDir, aerr, "data", /* @__PURE__ */ new Map(), env);
  if (aerr.length) throw new TemplateError(`data does not fit template ${t.id}:
  ${aerr.join("\n  ")}`, "ARTIFACT_DATA_INVALID", aerr);
  const rdata = rewriteAssets(t.schema ?? {}, data, baseDir, prefix, copied, env);
  const view = derive(t, prepare(t.schema ?? {}, structuredClone(rdata)));
  const ctx = context(t, view, stem, title);
  const files = [];
  const putAssets = () => {
    if (copied.size) {
      mkdirSync(assetDir, { recursive: true });
      for (const [nm, src] of copied) {
        copyFileSync(src, join(assetDir, nm));
        files.push(join(assetDir, nm));
      }
    }
  };
  const cleanJson = () => {
    const clean = {};
    for (const [k, v] of Object.entries(rdata)) if (!k.startsWith("_")) clean[k] = v;
    return pyDumps(clean, { ensureAscii: false, indent: 2 }) + "\n";
  };
  mkdirSync(reportDirPath, { recursive: true });
  if (kind === "markdown") {
    const tpl = readText(join(tdir, t.entry || "template.md"));
    let out = fill(tpl, ctx, false);
    out = pyStrip(out.replace(/\n{3,}/g, "\n\n")) + "\n";
    putAssets();
    writeFileSync(target, out);
    files.push(target);
    return { kind, rel: basename(target), files, warnings };
  }
  if (kind === "react") {
    const renderSet = new Set(Array.isArray(t.render) ? t.render : ["index.html"]);
    const skip = new Set(Array.isArray(t.skip) ? t.skip : []);
    const plan = [];
    for (const relp of walk(tdir)) {
      const src = join(tdir, relp);
      const parts = relp.split(sep);
      const name = parts[parts.length - 1];
      if (META_FILES.has(parts[0]) || parts.some((p) => p.startsWith(".")) || skip.has(name) || isDir(src)) continue;
      if (relp === t.example || name.startsWith("data.example")) continue;
      plan.push([src, join(target, relp), renderSet.has(relp) ? fill(readText(src), ctx, true) : null]);
    }
    mkdirSync(target, { recursive: true });
    for (const [src, dst, text] of plan) {
      mkdirSync(dirname(dst), { recursive: true });
      if (text !== null) writeFileSync(dst, text);
      else copyFileSync(src, dst);
      files.push(dst);
    }
    putAssets();
    writeFileSync(join(target, "data.json"), cleanJson());
    files.push(join(target, "data.json"));
    return { kind, rel: stem, files, warnings };
  }
  const size = data.size || t.size;
  const page = join(reportDirPath, stem + ".html");
  const vd = view._duration;
  const dur = Math.max(3, typeof vd === "number" && vd ? vd : 12);
  const [w, h] = parseSize(size);
  Object.assign(ctx, { _w: w, _h: h, _u: w >= h ? h : pyRound(w * 1.5), _duration: dur });
  const comp = fill(readText(join(tdir, t.entry || "composition.html")), ctx, true);
  if (!isFile(join(target, "index.html"))) {
    if (exists(page) && !force) throw new TemplateError(`${page} already exists`, "ARTIFACT_EXISTS");
    if (exists(page)) unlinkSync(page);
    if (exists(target)) rmSync(target, { recursive: true, force: true });
    motionScaffold(reportDirPath, stem, title, w, h, warnings);
  }
  putAssets();
  writeFileSync(join(target, "index.html"), comp);
  files.push(page, join(target, "index.html"));
  writeFileSync(join(target, "data.json"), cleanJson());
  return { kind, rel: basename(page), files, warnings, duration: dur };
}
function urlFor(rel, env = process.env) {
  const base = baseUrl(env);
  if (isDir(join(reportDir(env), rel))) return `${base}/${rel}/`;
  return `${base}/${rel.endsWith(".md") ? rel.slice(0, -3) + ".html" : rel}`;
}
function safeStem(name) {
  if (typeof name !== "string") return null;
  let s = name.trim().replace(/^\/+|\/+$/g, "");
  if (s.endsWith(".md") || s.endsWith(".html")) s = s.slice(0, s.lastIndexOf("."));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(s) || s.includes("..")) return null;
  return s;
}
function readmeSummary(dir, max = 2e3) {
  const p = join(dir, "README.md");
  let txt = "";
  try {
    txt = readText(p);
  } catch {
    return { path: p, summary: "" };
  }
  const cut = txt.search(/^#{1,3}\s+Changes\b/m);
  if (cut > 0) txt = txt.slice(0, cut);
  txt = txt.trim();
  if (txt.length > max) txt = txt.slice(0, max).replace(/\s+\S*$/, "") + " [...]";
  return { path: p, summary: txt };
}
function templateFiles(dir) {
  return walk(dir).filter((r) => {
    try {
      return lstatSync(join(dir, r)).isFile();
    } catch {
      return false;
    }
  }).map((r) => r.split(sep).join("/"));
}
function relTo(base, p) {
  const r = relative(base, p);
  return r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : null;
}
export {
  BUNDLED,
  KINDS,
  PLUGIN,
  SECRET_MESSAGE,
  SECRET_PATTERNS,
  TemplateError,
  allTemplates,
  applyFilter,
  baseUrl,
  check,
  collectAssets,
  compilePattern,
  context,
  create,
  derive,
  estateDir,
  exampleOf,
  existsSync,
  fields,
  fill,
  get,
  hasSecret,
  lintText,
  load,
  minimal,
  parse,
  parseSize,
  prepare,
  previewRel,
  pyTruthy,
  readmeSummary,
  relTo,
  reportDir,
  rewriteAssets,
  safeStem,
  searchDirs,
  secretCheck,
  summary,
  templateFiles,
  urlFor,
  userDir,
  validate,
  writable
};
