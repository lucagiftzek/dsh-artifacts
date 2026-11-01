import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  BUNDLED,
  KINDS,
  TemplateError,
  allTemplates,
  create,
  hasSecret,
  lintText,
  load,
  searchDirs,
  templateFiles,
  userDir,
  validate,
  writable,
  compilePattern,
  check
} from "./templates.js";
import { realpathSync, existsSync, statSync } from "node:fs";
const LIMITS = {
  idMax: 48,
  titleMax: 120,
  textMax: 600,
  readmeMax: 64 * 1024,
  schemaMax: 256 * 1024,
  fileMax: 512 * 1024,
  totalMax: 4 * 1024 * 1024,
  filesMax: 60,
  depthMax: 4
};
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PART_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const RESERVED = /* @__PURE__ */ new Set(["template.json", "README.md"]);
const SCHEMA_KEYS = /* @__PURE__ */ new Set([
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "anyOf",
  "oneOf",
  "default",
  "description",
  "title",
  "examples",
  "x-asset",
  "format",
  "$comment"
]);
const TYPES = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}
function inside(child, parent) {
  const c = real(child);
  const p = real(parent);
  return c === p || c.startsWith(p.endsWith("/") ? p : p + "/");
}
function writeTarget(env = process.env) {
  if (env.ARTIFACT_TEMPLATES_WRITE && env.ARTIFACT_TEMPLATES_WRITE.trim()) return { path: resolve(env.ARTIFACT_TEMPLATES_WRITE.trim().replace(/^~(?=\/|$)/, env.HOME || "")), source: "custom" };
  for (const p of (env.ARTIFACT_TEMPLATES || "").split(":")) {
    const d = p.trim().replace(/^~(?=\/|$)/, env.HOME || "");
    if (d && writable(d) && !inside(d, BUNDLED)) return { path: resolve(d), source: "custom" };
  }
  return { path: userDir(env), source: "user" };
}
function schemaProblems(s, path, errors, warnings) {
  if (!isObj(s)) {
    errors.push(`${path}: must be an object`);
    return;
  }
  for (const k of Object.keys(s)) if (!SCHEMA_KEYS.has(k)) warnings.push(`${path}.${k}: keyword not supported by the validator, it is ignored`);
  if ("type" in s) {
    const tys = Array.isArray(s.type) ? s.type : [s.type];
    if (!tys.length || tys.some((t) => typeof t !== "string" || !TYPES.has(t))) errors.push(`${path}.type: must be one of ${[...TYPES].join(", ")} (or a list of them)`);
  }
  if ("properties" in s) {
    if (!isObj(s.properties)) errors.push(`${path}.properties: must be an object of schemas`);
    else for (const [k, v] of Object.entries(s.properties)) schemaProblems(v, `${path}.properties.${k}`, errors, warnings);
  }
  if ("required" in s) {
    if (!Array.isArray(s.required) || s.required.some((x) => typeof x !== "string")) errors.push(`${path}.required: must be a list of property names`);
    else if (isObj(s.properties)) {
      for (const k of s.required) if (!(k in s.properties)) errors.push(`${path}.required: "${k}" is not in properties`);
    }
  }
  if ("items" in s) {
    if (!isObj(s.items)) errors.push(`${path}.items: must be one schema object`);
    else schemaProblems(s.items, `${path}.items`, errors, warnings);
  }
  if ("additionalProperties" in s && typeof s.additionalProperties !== "boolean") {
    if (isObj(s.additionalProperties)) schemaProblems(s.additionalProperties, `${path}.additionalProperties`, errors, warnings);
    else errors.push(`${path}.additionalProperties: must be true, false or a schema`);
  }
  if ("enum" in s && (!Array.isArray(s.enum) || !s.enum.length)) errors.push(`${path}.enum: must be a non-empty list`);
  for (const kw of ["anyOf", "oneOf"]) {
    if (kw in s) {
      if (!Array.isArray(s[kw]) || !s[kw].length) errors.push(`${path}.${kw}: must be a non-empty list of schemas`);
      else s[kw].forEach((x, i) => schemaProblems(x, `${path}.${kw}[${i}]`, errors, warnings));
    }
  }
  for (const kw of ["minItems", "maxItems", "minLength", "maxLength"]) {
    if (kw in s && !(Number.isInteger(s[kw]) && s[kw] >= 0)) errors.push(`${path}.${kw}: must be a whole number >= 0`);
  }
  for (const kw of ["minimum", "maximum"]) if (kw in s && typeof s[kw] !== "number") errors.push(`${path}.${kw}: must be a number`);
  if ("pattern" in s) {
    if (typeof s.pattern !== "string") errors.push(`${path}.pattern: must be a string`);
    else {
      try {
        compilePattern(s.pattern);
      } catch (e) {
        errors.push(`${path}.pattern: not a valid regular expression (${e.message})`);
      }
    }
  }
  if ("x-asset" in s) {
    if (typeof s["x-asset"] !== "boolean") errors.push(`${path}.x-asset: must be true or false`);
    else if (s["x-asset"] && s.type !== void 0 && s.type !== "string") errors.push(`${path}.x-asset: only string fields can be local files`);
  }
  if ("default" in s) {
    const { default: d, ...rest } = s;
    const errs = validate(rest, structuredClone(d), `${path}.default`);
    if (errs.length) errors.push(...errs.map((e) => `${e} (the default does not fit its own schema)`));
  }
}
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function bytesOf(content) {
  if (content.startsWith("base64:")) return Buffer.from(content.slice(7), "base64");
  return Buffer.from(content, "utf8");
}
function refuse(code, message, errors) {
  throw new TemplateError(message, code, errors);
}
function saveTemplate(args, env = process.env) {
  const errors = [];
  const warnings = [];
  const id = str(args.id);
  if (!ID_RE.test(id) || id.length > LIMITS.idMax) errors.push(`id: must be a lower-case slug like "weekly-report" (a-z, 0-9, single hyphens, max ${LIMITS.idMax} characters)`);
  const kind = str(args.kind);
  if (!KINDS.includes(kind)) errors.push(`kind: must be one of ${KINDS.join(", ")}`);
  const title = str(args.title);
  if (!title || title.length > LIMITS.titleMax) errors.push(`title: required, max ${LIMITS.titleMax} characters`);
  for (const k of ["purpose", "when"]) {
    const v = str(args[k]);
    if (!v || v.length > LIMITS.textMax) errors.push(`${k}: required, max ${LIMITS.textMax} characters`);
  }
  if (args.not_for !== void 0 && args.not_for !== null && (typeof args.not_for !== "string" || args.not_for.length > LIMITS.textMax)) errors.push(`not_for: a string, max ${LIMITS.textMax} characters`);
  const readme = typeof args.readme === "string" ? args.readme : "";
  if (!readme.trim()) errors.push("readme: required (what the template is for, how to use it, the fields)");
  else if (Buffer.byteLength(readme) > LIMITS.readmeMax) errors.push(`readme: too large (max ${LIMITS.readmeMax} bytes)`);
  const schema = args.schema;
  if (!isObj(schema)) errors.push("schema: must be a JSON Schema object");
  else {
    if (schema.type !== "object" || !isObj(schema.properties)) errors.push('schema: the root must be {"type": "object", "properties": {...}}');
    schemaProblems(schema, "schema", errors, warnings);
    if (Buffer.byteLength(JSON.stringify(schema)) > LIMITS.schemaMax) errors.push(`schema: too large (max ${LIMITS.schemaMax} bytes)`);
  }
  const example = args.example;
  if (!isObj(example)) errors.push("example: must be a data object that fits the schema");
  else if (Buffer.byteLength(JSON.stringify(example)) > LIMITS.schemaMax) errors.push(`example: too large (max ${LIMITS.schemaMax} bytes)`);
  for (const k of ["entry"]) if (args[k] !== void 0 && args[k] !== null && typeof args[k] !== "string") errors.push(`${k}: must be a file name`);
  if (args.render !== void 0 && args.render !== null && (!Array.isArray(args.render) || args.render.some((x) => typeof x !== "string"))) errors.push("render: must be a list of file names");
  if (args.timing !== void 0 && args.timing !== null && !isObj(args.timing)) errors.push("timing: must be an object");
  if (args.size !== void 0 && args.size !== null && typeof args.size !== "string") errors.push("size: must be a string such as landscape or 1280x720");
  const files = {};
  if (args.files !== void 0 && args.files !== null && !isObj(args.files)) errors.push('files: must be an object {"relative/path": "content"}');
  const fileEntries = isObj(args.files) ? Object.entries(args.files) : [];
  if (fileEntries.length > LIMITS.filesMax) errors.push(`files: at most ${LIMITS.filesMax} files`);
  let total = 0;
  for (const [p, c] of fileEntries) {
    const parts = p.split("/");
    if (p.startsWith("/") || p.includes("\\") || parts.length > LIMITS.depthMax || parts.some((x) => !PART_RE.test(x) || x === "..")) {
      errors.push(`files.${p}: must be a relative path inside the template folder (letters, digits, . _ -, max ${LIMITS.depthMax} levels, no hidden or .. parts)`);
      continue;
    }
    if (RESERVED.has(p)) {
      errors.push(`files.${p}: written from the template fields, do not pass it as a file`);
      continue;
    }
    if (c === null) {
      files[p] = null;
      continue;
    }
    if (typeof c !== "string") {
      errors.push(`files.${p}: content must be a string (text, or "base64:" followed by base64 for binary files) or null to delete`);
      continue;
    }
    const b = bytesOf(c);
    if (b.length > LIMITS.fileMax) errors.push(`files.${p}: too large (${b.length} bytes, max ${LIMITS.fileMax})`);
    total += b.length;
    if (!c.startsWith("base64:") && hasSecret(c)) errors.push(`files.${p}: contains a credential-shaped string; templates are shared, never put a secret in them`);
    files[p] = c;
  }
  if (total > LIMITS.totalMax) errors.push(`files: too large in total (${total} bytes, max ${LIMITS.totalMax})`);
  for (const [k, v] of [["title", title], ["purpose", args.purpose], ["when", args.when], ["not_for", args.not_for], ["readme", readme]]) {
    if (typeof v === "string" && hasSecret(v)) errors.push(`${k}: contains a credential-shaped string`);
  }
  if (isObj(schema) && hasSecret(JSON.stringify(schema))) errors.push("schema: contains a credential-shaped string");
  if (errors.length) {
    const secret = errors.some((e) => e.includes("credential-shaped"));
    refuse(secret ? "ARTIFACT_SECRET_REFUSED" : errors.some((e) => e.includes("too large") || e.includes("at most")) ? "ARTIFACT_TOO_LARGE" : "ARTIFACT_TEMPLATE_INVALID", `template ${id || "(no id)"} refused:
  ${errors.join("\n  ")}`, errors);
  }
  const target = writeTarget(env);
  if (inside(target.path, BUNDLED)) refuse("ARTIFACT_TEMPLATE_READONLY", `the bundled template copy (${BUNDLED}) is read-only; set ARTIFACT_TEMPLATES_WRITE to another folder`, [`library: ${target.path} is the bundled copy`]);
  if (!writable(target.path)) refuse("ARTIFACT_TEMPLATE_READONLY", `template library ${target.path} is not writable`, [`library: ${target.path} is not writable`]);
  const finalDir = join(target.path, id);
  const order = searchDirs(env, { includeMissingUser: true }).map((d) => real(d.path));
  const targetRank = order.indexOf(real(target.path));
  const existing = allTemplates(env).find((t) => t.id === id);
  let overrides = null;
  let updating = false;
  if (existing) {
    const exRank = order.indexOf(real(dirname(existing.dir)));
    if (real(dirname(existing.dir)) === real(target.path)) updating = true;
    else if (targetRank === -1 || exRank !== -1 && exRank < targetRank) {
      refuse("ARTIFACT_TEMPLATE_SHADOWED", `a template "${id}" already exists in ${dirname(existing.dir)} (${existing.source}), which is searched before ${target.path}; a copy saved there would never be used`, [`id: "${id}" is taken by the ${existing.source} library; pick another id`]);
    } else overrides = existing.source ?? null;
  } else if (existsSync(finalDir)) updating = true;
  if (updating && args.overwrite !== true) {
    refuse("ARTIFACT_TEMPLATE_EXISTS", `template "${id}" already exists in ${target.path}; pass overwrite: true to update it`, [`id: "${id}" exists; pass overwrite: true to update it (files you do not pass are kept)`]);
  }
  mkdirSync(target.path, { recursive: true });
  const stage = mkdtempSync(join(target.path, `.${id}.staging-`));
  let trial = null;
  try {
    if (updating && existsSync(finalDir)) cpSync(finalDir, stage, { recursive: true });
    for (const [p, c] of Object.entries(files)) {
      const dst = join(stage, p);
      if (c === null) {
        try {
          unlinkSync(dst);
        } catch {
          warnings.push(`files.${p}: nothing to delete`);
        }
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, bytesOf(c));
    }
    const tj = { id, title, kind, purpose: str(args.purpose), when: str(args.when) };
    if (typeof args.not_for === "string" && args.not_for.trim()) tj.not_for = args.not_for.trim();
    if (typeof args.entry === "string" && args.entry) tj.entry = args.entry;
    if (Array.isArray(args.render)) tj.render = args.render;
    if (isObj(args.timing)) tj.timing = args.timing;
    if (typeof args.size === "string" && args.size) tj.size = args.size;
    tj.schema = schema;
    tj.example = example;
    writeFileSync(join(stage, "template.json"), JSON.stringify(tj, null, 2) + "\n");
    writeFileSync(join(stage, "README.md"), readme.endsWith("\n") ? readme : readme + "\n");
    const errs = [];
    const all = templateFiles(stage);
    const sizeTotal = all.reduce((a, f) => a + statSync(join(stage, f)).size, 0);
    if (sizeTotal > LIMITS.totalMax) errs.push(`files: the template folder would be ${sizeTotal} bytes, max ${LIMITS.totalMax}`);
    const t = load(stage);
    if (!t) throw new TemplateError("staging lost template.json", "ARTIFACT_INTERNAL");
    t.id = id;
    const need = kind === "react" ? Array.isArray(args.render) ? args.render : ["index.html"] : [typeof args.entry === "string" && args.entry ? args.entry : kind === "motion" ? "composition.html" : "template.md"];
    for (const f of need) if (!all.includes(f)) errs.push(`files.${f}: missing (a ${kind} template needs it${kind === "react" ? ", listed in render" : " as its entry"})`);
    const ex = structuredClone(example);
    const [exErrors, exWarnings] = check({ ...t, schema }, ex, stage);
    errs.push(...exErrors.map((e) => "example: " + e));
    warnings.push(...exWarnings.map((w) => "example: " + w));
    if (!errs.length) {
      trial = mkdtempSync(join(tmpdir(), "artifact-template-trial-"));
      try {
        const res = create(t, structuredClone(example), trial, "trial", stage, { env });
        warnings.push(...res.warnings.filter((w) => !w.startsWith("data:")).map((w) => "trial render: " + w));
      } catch (e) {
        errs.push(`trial render of the example failed: ${e && e.message}`);
      }
    }
    warnings.push(...lintText({ title, purpose: args.purpose, when: args.when, readme }, "template"));
    if (errs.length) refuse(errs.some((e) => e.includes("credential-shaped")) ? "ARTIFACT_SECRET_REFUSED" : "ARTIFACT_TEMPLATE_INVALID", `template ${id} refused:
  ${errs.join("\n  ")}`, errs);
    let old = null;
    if (existsSync(finalDir)) {
      old = join(target.path, `.${id}.old-${process.pid}-${Date.now()}`);
      renameSync(finalDir, old);
    }
    try {
      renameSync(stage, finalDir);
    } catch (e) {
      if (old) renameSync(old, finalDir);
      throw e;
    }
    if (old) rmSync(old, { recursive: true, force: true });
    return {
      ok: true,
      id,
      action: updating ? "updated" : "created",
      dir: finalDir,
      library: target.path,
      source: target.source,
      overrides,
      files: templateFiles(finalDir),
      warnings
    };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    if (trial) rmSync(trial, { recursive: true, force: true });
  }
}
export {
  ID_RE,
  LIMITS,
  saveTemplate,
  schemaProblems,
  writeTarget
};
