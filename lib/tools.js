import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineErrors, losslessDefineTool, toLossless } from "../lib/plugin-errors.js";
import {
  TemplateError,
  allTemplates,
  check,
  create,
  exampleOf,
  fields,
  get,
  minimal,
  previewRel,
  readmeSummary,
  reportDir,
  safeStem,
  searchDirs,
  summary,
  templateFiles,
  urlFor,
  writable
} from "./engine/templates.js";
import { LIMITS, saveTemplate, writeTarget } from "./engine/save.js";
import { ListingError, addArtifact, listArtifacts, removeArtifact, updateArtifact } from "./listing.js";
const TOOL_NAMES = ["artifact_templates", "artifact_template_info", "artifact_from_template", "artifact_template_save", "artifact_list", "artifact_add", "artifact_remove", "artifact_update"];
const E = defineErrors("ARTIFACT", {
  ARTIFACT_TEMPLATE_NOT_FOUND: { status: 404, message: "No template with that id", hint: "Call artifact_templates for the ids that exist on this install." },
  ARTIFACT_TEMPLATE_BROKEN: { status: 500, message: "The template folder is broken", hint: "Its template.json is missing, not valid JSON, or has no valid kind; fix the folder or use another template." },
  ARTIFACT_DATA_INVALID: { status: 400, message: "The data does not fit the template", hint: "Fix every field listed in errors (artifact_template_info shows the schema and a minimal example), then call again." },
  ARTIFACT_SECRET_REFUSED: { status: 400, message: "Refused: the input contains a credential-shaped string", hint: "Artifacts and templates are served over HTTP; report a status (configured: yes or no), never a key, token or password." },
  ARTIFACT_EXISTS: { status: 409, message: "An artifact with that name already exists", hint: "Edit the existing artifact, pick another name, or pass force: true to regenerate it from the data." },
  ARTIFACT_BAD_NAME: { status: 400, message: "Bad artifact name", hint: "Use a short slug such as weekly-report: letters, digits, dot, underscore, hyphen, no folders." },
  ARTIFACT_RENDER_FAILED: { status: 500, message: "The template could not be filled", hint: "The template text has an unbalanced {{#section}} or an unknown filter; fix the template (or report it to its author)." },
  ARTIFACT_TEMPLATE_INVALID: { status: 400, message: "The template was refused", hint: "Fix every problem listed in errors and save again; nothing was written." },
  ARTIFACT_TEMPLATE_EXISTS: { status: 409, message: "A template with that id already exists in the library", hint: "Pass overwrite: true to update it (files you do not pass are kept), or pick another id." },
  ARTIFACT_TEMPLATE_SHADOWED: { status: 409, message: "That id is taken by a library that is searched first", hint: "Pick another id: a copy saved under this id would never be used." },
  ARTIFACT_TEMPLATE_READONLY: { status: 403, message: "The template library is not writable", hint: "Set ARTIFACT_TEMPLATES_WRITE (or make the user library writable) in the environment of dsh web; the bundled copy is never written." },
  ARTIFACT_TOO_LARGE: { status: 413, message: "The template is too large", hint: `Keep files under ${LIMITS.fileMax} bytes each, ${LIMITS.totalMax} bytes in total and ${LIMITS.filesMax} files; link big media instead of embedding it.` },
  ARTIFACT_WRITE_FAILED: { status: 500, message: "Writing to disk failed", hint: "Check that the artifacts folder (ARTIFACT_DIR, default ~/reports) exists, is writable and the disk is not full." },
  ARTIFACT_NOT_FOUND: { status: 404, message: "No artifact with that name", hint: "Call artifact_list (include_hidden: true also shows de-listed ones) and pass a listed name, file name, path or URL." },
  ARTIFACT_AMBIGUOUS: { status: 409, message: "The name matches more than one artifact", hint: "Pass one of the names in candidates, with its extension." },
  ARTIFACT_ARGS_INVALID: { status: 400, message: "An argument is missing or has the wrong type", hint: "Fix the fields listed in errors; the tool description lists every argument." },
  ARTIFACT_SOURCE_INVALID: { status: 400, message: "The file to list does not exist or is not a regular file", hint: "Pass the absolute path of a file you produced; folders cannot be listed (write an app folder into the artifacts folder instead)." },
  ARTIFACT_TYPE_UNSUPPORTED: { status: 415, message: "Files of this type cannot be listed", hint: "Use one of the extensions in supported (images, video, audio, PDF, text, data, code, archives, Office files), or convert the file." },
  ARTIFACT_FILE_TOO_LARGE: { status: 413, message: "The file is larger than the listing limit", hint: "Raise ARTIFACT_MAX_ADD_MB in the environment of dsh web (and of the artifact CLI), or share a smaller file." },
  ARTIFACT_LINK_FAILED: { status: 500, message: "The file could not be hardlinked into the artifacts folder", hint: 'Hardlinks work only on the same file system: use mode: "copy".' },
  ARTIFACT_TOOLS_UNAVAILABLE: { status: 500, message: "The host tool registry is not available, so the artifact tools were not registered", hint: "Use the artifact CLI meanwhile; see docs/TROUBLESHOOTING.md#t-tools-missing." },
  ARTIFACT_INTERNAL: { status: 500, message: "Unexpected error in dsh-artifacts", hint: "Collect the dsh web log line that starts with ARTIFACT_INTERNAL and report a bug." }
}, { scrub: (s) => s.replace(/(sk-ant-|ghp_|gho_|xox[baprs]-)[A-Za-z0-9_-]+/g, "$1[redacted]") });
function splitErrors(errors) {
  return errors.map((e) => {
    const i = e.indexOf(": ");
    return i > 0 ? { field: e.slice(0, i), problem: e.slice(i + 2) } : { field: "", problem: e };
  });
}
function failure(e) {
  if (e instanceof ListingError && E.has(e.code)) {
    return E.tool(e.code, { message: String(e.message).split("\n")[0], ...e.extra });
  }
  if (e instanceof TemplateError || e && typeof e.code === "string" && E.has(e.code)) {
    const errs = Array.isArray(e.errors) ? e.errors : [];
    const extra = {};
    if (errs.length) {
      extra.errors = splitErrors(errs);
      extra.error_lines = errs;
    }
    return E.tool(E.has(e.code) ? e.code : "ARTIFACT_INTERNAL", { message: String(e.message).split("\n")[0], ...extra });
  }
  if (e && typeof e.code === "string" && /^E[A-Z]+$/.test(e.code)) return E.tool("ARTIFACT_WRITE_FAILED", { detail: `${e.code} ${e.path || ""}`.trim() });
  return E.tool("ARTIFACT_INTERNAL", { detail: e && e.message ? e.message : String(e) });
}
function row(t) {
  const r = { id: t.id, title: t.title ?? t.id, kind: t.kind, purpose: t.purpose ?? "", when: t.when ?? "", not_for: t.not_for ?? "", source: t.source ?? "", dir: t.dir };
  if (t.error) return { ...r, error: t.error };
  const schema = t.schema ?? {};
  r.required = Array.isArray(schema.required) ? schema.required : [];
  r.fields = summary(schema);
  return r;
}
const SESSION_RE = /^(session-)?[0-9a-fA-F-]{8,80}$/;
function claim(rels, session) {
  if (typeof session !== "string" || !SESSION_RE.test(session)) return;
  try {
    const store = join(reportDir(), ".artifacts");
    mkdirSync(store, { recursive: true });
    const now = Date.now();
    appendFileSync(join(store, "claims.jsonl"), rels.map((name) => JSON.stringify({ name, session, time: now, how: "tool" }) + "\n").join(""));
  } catch {
  }
}
function sessionOf(exec) {
  return exec && exec.agent && exec.agent.session ? exec.agent.session.id : void 0;
}
function listTemplates(args = {}) {
  const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  let rows = allTemplates().map(row);
  if (q) rows = rows.filter((r) => [r.id, r.title, r.purpose, r.when, r.kind].some((v) => String(v).toLowerCase().includes(q)));
  return {
    ok: true,
    count: rows.length,
    templates: rows,
    libraries: searchDirs(void 0, { includeMissingUser: true }).map((d) => ({ path: d.path, source: d.source, writable: writable(d.path) })),
    save_to: writeTarget().path,
    next: "artifact_template_info({ id }) for the fields, then artifact_from_template({ name, template, data })."
  };
}
function templateInfo(args) {
  const t = get(String(args.id ?? ""));
  const ex = exampleOf(t);
  const schema = t.schema ?? {};
  const rm = readmeSummary(t.dir);
  return {
    ok: true,
    ...row(t),
    schema,
    example: ex,
    minimal_example: minimal(schema, ex),
    field_table: fields(schema),
    readme: rm.path,
    readme_summary: rm.summary,
    files: templateFiles(t.dir),
    preview_name: previewRel(t).replace(/\/$/, "").replace(/\.html$/, ""),
    next: `artifact_from_template({ name: "<slug>", template: "${t.id}", data: { ... } }); omit data to publish the example.`
  };
}
function fromTemplate(args, exec) {
  const stem = safeStem(args.name);
  if (!stem) return E.tool("ARTIFACT_BAD_NAME", { detail: String(args.name ?? "") });
  const t = get(String(args.template ?? ""));
  let data = args.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch (e) {
      return E.tool("ARTIFACT_DATA_INVALID", { message: "data is a string but not valid JSON", errors: [{ field: "data", problem: "not valid JSON: " + e.message }], error_lines: ["data: not valid JSON: " + e.message] });
    }
  }
  let base;
  if (data === void 0 || data === null) {
    data = exampleOf(t);
    base = t.dir;
  } else {
    base = args.base_dir ? resolve(String(args.base_dir)) : reportDir();
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return E.tool("ARTIFACT_DATA_INVALID", { message: "data must be a JSON object", errors: [{ field: "data", problem: "expected object" }], error_lines: ["data: expected object"] });
  }
  const obj = data;
  const [errors, warnings] = check(t, obj, base);
  if (errors.length) {
    const secret = errors.some((x) => x.includes("credential-shaped"));
    return E.tool(secret ? "ARTIFACT_SECRET_REFUSED" : "ARTIFACT_DATA_INVALID", { message: `data does not fit template ${t.id}`, template: t.id, errors: splitErrors(errors), error_lines: errors, warnings });
  }
  if (args.check) return { ok: true, checked: true, template: t.id, errors: [], warnings };
  const dir = reportDir();
  const res = create(t, obj, dir, stem, base, { force: !!args.force, title: args.title || null });
  const rels = /* @__PURE__ */ new Set([res.rel]);
  if (res.rel.endsWith(".md")) rels.add(res.rel.slice(0, -3) + ".html");
  for (const f of res.files) {
    const r = f.startsWith(dir + "/") ? f.slice(dir.length + 1) : null;
    if (r) rels.add(r);
  }
  claim([...rels], sessionOf(exec));
  const edit = res.kind === "react" ? `edit ${join(dir, res.rel, "data.json")} (the app reloads it), not the code` : res.kind === "markdown" ? `edit ${join(dir, res.rel)} directly, or change the data and call again with force: true` : `edit ${join(dir, stem + ".motion", "index.html")}, or change the data and call again with force: true`;
  const out = { ok: true, template: t.id, kind: res.kind, name: stem, path: join(dir, res.rel), url: urlFor(res.rel), files: res.files, warnings: res.warnings, edit };
  if (res.duration !== void 0) out.duration = res.duration;
  return out;
}
function saveTool(args) {
  const res = saveTemplate(args);
  return { ...res, next: `artifact_from_template({ name: "<slug>", template: "${res.id}" }) publishes the example; artifact_templates lists it now.` };
}
const TEXT = (s) => [{ type: "text", text: s }];
const OUT = {
  schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
  render: (_a, v) => TEXT(JSON.stringify(v, null, 2))
};
function safe(fn) {
  return async (args, exec) => {
    try {
      return toLossless(fn(args || {}, exec));
    } catch (e) {
      return failure(e);
    }
  };
}
function toolDefinitions() {
  return [
    {
      name: "artifact_templates",
      description: "List the artifact TEMPLATES: finished, tested layouts for deliverable pages (long-form report, article with photos, KPI dashboard, review queue, animated video explainer, video player page, plus templates saved by agents). Call this FIRST whenever you are about to build a report, dashboard, article, review page or video page: when a template fits, you only write its JSON data (a few KB instead of a whole page) with artifact_from_template, and it comes out validated and consistent. Returns per template: id, title, kind (markdown|react|motion), purpose, when (when to use it), not_for, required (top-level required fields), fields (field summary), source (bundled|user|estate|custom). Optional query filters by text.",
      parameters: { query: { type: "string", description: "Optional filter: words matched against id, title, purpose and when." } },
      output: OUT,
      isConcurrencySafe: () => true,
      execute: safe((a) => listTemplates(a))
    },
    {
      name: "artifact_template_info",
      description: "Everything needed to fill one artifact template: its JSON Schema (field types, required fields, allowed values, defaults), a full example data object, a minimal example with only the required fields, a flat field table with descriptions, and a README summary. Call it after artifact_templates and before artifact_from_template.",
      parameters: { id: { type: "string", required: true, description: 'Template id from artifact_templates, for example "dashboard".' } },
      output: OUT,
      isConcurrencySafe: () => true,
      execute: safe((a) => templateInfo(a))
    },
    {
      name: "artifact_from_template",
      description: "Create an artifact from a template: validates data against the template schema (every problem is listed per field, nothing is written on bad data), copies local image or video files named in the data next to the artifact, fills the template and writes it into the artifacts folder (ARTIFACT_DIR, default ~/reports). Returns the file path and the URL to give the user. Omit data to publish the template example. check: true validates only.",
      parameters: {
        name: { type: "string", required: true, description: 'Artifact name, a short slug such as "q3-sales" (letters, digits, . _ -).' },
        template: { type: "string", required: true, description: "Template id from artifact_templates." },
        data: { type: "json", description: "The data object that fits the template schema (see artifact_template_info). Omit to use the example." },
        base_dir: { type: "string", description: "Folder that relative file paths in data (images, videos) are resolved against. Default: the artifacts folder." },
        force: { type: "boolean", description: "Regenerate an existing artifact of the same name from the data." },
        check: { type: "boolean", description: "Validate only, write nothing." },
        title: { type: "string", description: "Page title when the data has none." }
      },
      output: OUT,
      execute: safe((a, exec) => fromTemplate(a, exec))
    },
    {
      name: "artifact_template_save",
      description: 'Create or update an artifact template in the user template library (never in the bundled copy), so a layout you built once can be reused by every agent: it appears immediately in artifact_templates. The save is validated as a whole and refused with a list of problems when the id is not a slug, the schema is not a well-formed JSON Schema object, the example does not fit the schema or does not render, a file path leaves the template folder, a credential-shaped string appears anywhere, or a size limit is exceeded. kind markdown needs files["template.md"], react needs the files listed in render (default index.html), motion needs files["composition.html"]. Templates fill {{field}}, {{#list}}...{{/list}}, {{^x}}...{{/x}}, {{{raw}}} and filters such as {{x|oneline}}. Binary files: content "base64:<data>". Updating needs overwrite: true; files you do not pass are kept, null deletes one.',
      parameters: {
        id: { type: "string", required: true, description: 'Lower-case slug, for example "weekly-status".' },
        title: { type: "string", required: true, description: "Short human title." },
        kind: { type: "string", required: true, enum: ["markdown", "react", "motion"], description: "markdown (artifact-kit page from template.md), react (index.html + app.jsx reading data.json) or motion (HyperFrames composition.html, exported to MP4)." },
        purpose: { type: "string", required: true, description: "One sentence: what the template produces." },
        when: { type: "string", required: true, description: "When an agent should pick it." },
        not_for: { type: "string", description: "When not to use it, and what to use instead." },
        schema: { type: "object", additionalProperties: true, required: true, description: 'JSON Schema of the data: {"type": "object", "properties": {...}, "required": [...]}. Supported: type, enum, const, required, properties, additionalProperties, items, minItems, maxItems, minLength, maxLength, minimum, maximum, pattern, anyOf, oneOf, default, description, x-asset (local file copied next to the artifact).' },
        example: { type: "object", additionalProperties: true, required: true, description: "Example data that fits the schema; it is rendered once as a check and used for previews." },
        files: { type: "object", additionalProperties: true, description: 'Template files {"relative/path": "content"}: template.md, index.html, app.jsx, composition.html, example assets ("base64:..." for binary). template.json and README.md are written from the other fields.' },
        readme: { type: "string", required: true, description: "README.md: what the template is for, how to use it, the fields." },
        entry: { type: "string", description: "Entry file for markdown or motion (default template.md or composition.html)." },
        render: { type: "array", items: { type: "string" }, description: 'react: files filled with the data (default ["index.html"]); other files are copied as they are.' },
        timing: { type: "object", additionalProperties: true, description: "motion: scene timing rules {list, text_fields, base, per_word, min, max, min_by_type}." },
        size: { type: "string", description: "motion: default canvas, landscape|portrait|square|720p|WxH." },
        overwrite: { type: "boolean", description: "Update an existing template with this id in the same library." }
      },
      output: OUT,
      execute: safe((a) => saveTool(a))
    },
    {
      name: "artifact_list",
      description: 'List the artifacts the Artifacts sidebar tab shows (files in the artifacts folder ARTIFACT_DIR, default ~/reports: Markdown docs, pages, apps, images, video, audio, PDF, data, code and other files). Filter by chat (scope "chat" = what the calling chat and its subagents produced), kind and text. Every item has name, title, description, kind, size, modified, url (opens the rendered page, or the media/file enclosure with a player or viewer), view_url, download_url (direct download, original bytes), public_url when public, path on disk, listed, this_chat. De-listed items appear only with include_hidden: true.',
      parameters: {
        scope: { type: "string", enum: ["chat", "all"], description: "chat (this chat and its subagents) or all (default all; chat when session is given)." },
        session: { type: "string", description: "Another chat session id for scope chat. Default: the calling chat." },
        kind: { type: "string", enum: ["doc", "page", "app", "image", "audio", "video", "pdf", "data", "code", "file", "media"], description: "Only this kind (media = image, audio and video)." },
        query: { type: "string", description: "Words matched against name, title and description." },
        include_hidden: { type: "boolean", description: "Also return de-listed artifacts (listed: false)." },
        limit: { type: "number", description: "Most items to return, newest first (default 50, max 1000)." }
      },
      output: OUT,
      isConcurrencySafe: () => true,
      execute: safe((a, exec) => listArtifacts(a, sessionOf(exec)))
    },
    {
      name: "artifact_add",
      description: 'List a file as an artifact so the user sees it in the Artifacts tab under "This chat": any file you produced (image, video, audio, PDF, CSV, JSON, text, code, zip, docx, xlsx...) is copied (or hardlinked with mode "link") into the artifacts folder under a slug and attached to the calling chat; a file already in the folder is listed in place. Media and files open in a themed page with the right player or viewer, a download button and the version history. Also lists again an artifact removed with artifact_remove (pass name). Returns url (give it to the user), download_url, view_url and path. Files written directly into the artifacts folder are listed automatically; use this for files elsewhere, or to set a title.',
      parameters: {
        path: { type: "string", description: "Absolute path of the file to list." },
        name: { type: "string", description: "Instead of path: an artifact already in the folder (for example a de-listed one) to list again." },
        slug: { type: "string", description: "File name in the artifacts folder without extension (letters, digits, . _ -). Default: the file name." },
        title: { type: "string", description: "Title shown in the tab and on the page." },
        description: { type: "string", description: "One or two sentences shown under the title." },
        mode: { type: "string", enum: ["copy", "link"], description: "copy (default) or link (hardlink: no extra disk space, same file system only)." },
        force: { type: "boolean", description: "Replace a different file with the same name in the folder." },
        trusted: { type: "boolean", description: "HTML only: serve it unsandboxed (scripts run on the DSH origin). Only for pages you wrote yourself; default false." }
      },
      output: OUT,
      execute: safe((a, exec) => addArtifact(a, sessionOf(exec)))
    },
    {
      name: "artifact_remove",
      description: "De-list an artifact: it disappears from the Artifacts tab (for every chat) but nothing is deleted: the file, its versions and its links keep working. Reversible with artifact_add({ name }). Use it for drafts, scratch files and superseded versions the user should not see in the list.",
      parameters: {
        name: { type: "string", required: true, description: "Artifact name as in artifact_list, a file name, a path in the artifacts folder, or its URL." }
      },
      output: OUT,
      execute: safe((a, exec) => removeArtifact(a, sessionOf(exec)))
    },
    {
      name: "artifact_update",
      description: "Set the title and/or description an artifact shows in the Artifacts tab and on its page, without touching the file. An empty string clears the value.",
      parameters: {
        name: { type: "string", required: true, description: "Artifact name as in artifact_list, a file name, a path or its URL." },
        title: { type: "string", description: "New title (max 300 characters)." },
        description: { type: "string", description: "New description (max 2000 characters)." }
      },
      output: OUT,
      execute: safe((a, exec) => updateArtifact(a, sessionOf(exec)))
    }
  ];
}
function registerTools(rawDefineTool, tools, log = () => {
}) {
  const done = [];
  if (typeof rawDefineTool !== "function" || !tools || typeof tools.register !== "function") {
    log(E.logLine("ARTIFACT_TOOLS_UNAVAILABLE", "defineTool or the tool registry is missing"));
    return done;
  }
  const defineTool = losslessDefineTool(rawDefineTool);
  for (const def of toolDefinitions()) {
    try {
      tools.register(defineTool(def));
      done.push(def.name);
    } catch (e) {
      log(E.logLine("ARTIFACT_INTERNAL", `tool ${def.name} not registered: ${e && e.message}`));
    }
  }
  return done;
}
export {
  E,
  TOOL_NAMES,
  failure,
  fromTemplate,
  listTemplates,
  registerTools,
  saveTool,
  splitErrors,
  templateInfo,
  toolDefinitions
};
