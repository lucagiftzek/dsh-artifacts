import { appendFileSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, extname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { baseUrl, hasSecret, reportDir } from "./engine/templates.js";
class ListingError extends Error {
  code;
  extra;
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}
const T = "text/plain; charset=utf-8";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": T,
  ".log": T,
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".jsx": T,
  ".ts": T,
  ".tsx": T,
  ".py": T,
  ".sh": T,
  ".sql": T,
  ".yaml": T,
  ".yml": T,
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".pdf": "application/pdf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".jsonl": T,
  ".ndjson": T,
  ".geojson": "application/json; charset=utf-8",
  ".ipynb": "application/json; charset=utf-8",
  ".ics": T,
  ".patch": T,
  ".diff": T,
  ".toml": T,
  ".ini": T,
  ".go": T,
  ".rs": T,
  ".c": T,
  ".h": T,
  ".srt": T,
  ".vtt": "text/vtt; charset=utf-8",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".weba": "audio/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".bz2": "application/x-bzip2",
  ".xz": "application/x-xz",
  ".7z": "application/x-7z-compressed",
  ".zst": "application/zstd",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".xls": "application/vnd.ms-excel",
  ".ppt": "application/vnd.ms-powerpoint",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".rtf": "application/rtf",
  ".epub": "application/epub+zip",
  ".parquet": "application/vnd.apache.parquet",
  ".sqlite": "application/vnd.sqlite3",
  ".eml": "message/rfc822",
  ".stl": "model/stl"
};
const k = (kind, exts) => Object.fromEntries(exts.split(" ").map((e) => ["." + e, kind]));
const KIND = {
  ".md": "doc",
  ".html": "page",
  ".htm": "page",
  ...k("data", "txt log json csv tsv xml jsonl ndjson geojson ipynb ics srt vtt"),
  ...k("image", "svg png jpg jpeg gif webp avif bmp"),
  ...k("audio", "mp3 wav ogg oga opus m4a aac flac weba"),
  ...k("video", "mp4 m4v webm mov mkv"),
  ".pdf": "pdf",
  ...k("code", "py sh sql js jsx ts tsx css yaml yml patch diff toml ini go rs c h"),
  ...k("file", "tif tiff heic avi zip tar gz tgz bz2 xz 7z zst docx xlsx pptx doc xls ppt odt ods odp rtf epub parquet sqlite eml stl glb gltf")
};
const LISTED_KINDS = /* @__PURE__ */ new Set(["doc", "page", "data", "image", "audio", "video", "pdf", "code", "file"]);
const VIEW_KINDS = /* @__PURE__ */ new Set(["image", "audio", "video", "pdf", "data", "code", "file"]);
const THUMB_KINDS = /* @__PURE__ */ new Set(["image", "video", "audio", "pdf"]);
const RASTER_EXT = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff"]);
const TEXT_KINDS = /* @__PURE__ */ new Set(["doc", "page", "data", "code"]);
const MEDIA_DIR = "media";
const PREFIX = "/report/";
const SESSION_RE = /^(session-)?[0-9a-fA-F-]{8,80}$/;
function pyQuote(s, safe = "/") {
  return Array.from(new TextEncoder().encode(s)).map((b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9_.~-]/.test(c) || safe.includes(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
}
function thumbsOn(env) {
  return env.ARTIFACT_THUMBS !== "0";
}
function storeDir(env) {
  return join(reportDir(env), ".artifacts");
}
function listingFile(env) {
  return join(storeDir(env), "listing.jsonl");
}
function foldListing(rows) {
  const out = {};
  for (const c of rows) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const n = c.name, op = c.op;
    if (typeof n !== "string" || !n || !["hide", "show", "meta", "add"].includes(op)) continue;
    const s = out[n] ?? (out[n] = { hidden: false, title: "", description: "", added: null, sandbox: false, time: 0 });
    s.time = c.time || s.time;
    if (op === "hide") s.hidden = true;
    else if (op === "show") s.hidden = false;
    else if (op === "add") {
      s.hidden = false;
      if (c.from || !s.added) s.added = { from: c.from ?? null, mode: c.mode ?? null, time: c.time ?? null, session: c.session ?? null };
      if (c.from) s.sandbox = !!c.sandbox;
    }
    if (op === "meta" || op === "add") {
      for (const key of ["title", "description"]) {
        if (typeof c[key] === "string") s[key] = key === "title" ? c[key].slice(0, 300) : c[key].slice(0, 2e3);
      }
    }
  }
  return out;
}
function readListing(env = process.env) {
  let text = "";
  try {
    text = readFileSync(listingFile(env), "utf8");
  } catch {
    return {};
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
    }
  }
  return foldListing(rows);
}
function appendListing(entry, env = process.env) {
  const e = { ...entry, time: Date.now() };
  mkdirSync(storeDir(env), { recursive: true });
  appendFileSync(listingFile(env), JSON.stringify(e) + "\n");
  return e;
}
function head(path, n) {
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(n);
    const got = readSync(fd, b, 0, n, 0);
    return b.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}
function unescapeHtml(s) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\xA0", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", middot: "\xB7", bull: "\u2022", rsquo: "\u2019", lsquo: "\u2018", ldquo: "\u201C", rdquo: "\u201D", laquo: "\xAB", raquo: "\xBB", copy: "\xA9", reg: "\xAE", trade: "\u2122", times: "\xD7", divide: "\xF7", rarr: "\u2192", larr: "\u2190", harr: "\u2194", uarr: "\u2191", darr: "\u2193", euro: "\u20AC", pound: "\xA3", yen: "\xA5", cent: "\xA2", deg: "\xB0", plusmn: "\xB1", para: "\xB6", sect: "\xA7", shy: "\xAD", eacute: "\xE9", egrave: "\xE8", agrave: "\xE0", aacute: "\xE1", ograve: "\xF2", oacute: "\xF3", uacute: "\xFA", ugrave: "\xF9", iacute: "\xED", igrave: "\xEC", ccedil: "\xE7", ntilde: "\xF1", uuml: "\xFC", ouml: "\xF6", auml: "\xE4", szlig: "\xDF", hearts: "\u2665", check: "\u2713", minus: "\u2212", le: "\u2264", ge: "\u2265", ne: "\u2260", asymp: "\u2248", infin: "\u221E", alpha: "\u03B1", beta: "\u03B2", gamma: "\u03B3", delta: "\u03B4", lambda: "\u03BB", mu: "\u03BC", pi: "\u03C0", sigma: "\u03C3", omega: "\u03C9", thinsp: "\u2009", ensp: "\u2002", emsp: "\u2003", zwj: "\u200D", zwnj: "\u200C" };
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, g) => {
    if (g[0] === "#") {
      const cp = g[1] === "x" || g[1] === "X" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch {
        return m;
      }
    }
    return Object.prototype.hasOwnProperty.call(named, g) ? named[g] : m;
  });
}
function titleOf(path, ext, isDir) {
  let t = "";
  try {
    if (ext === ".html" || ext === ".htm" || isDir) {
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head(isDir ? join(path, "index.html") : path, 6e3).toString("latin1"));
      if (m) t = unescapeHtml(Buffer.from(m[1].replace(/[ \t\n\r\f\v]+/g, " "), "latin1").toString("utf8")).trim();
    } else if (ext === ".md") {
      const text = head(path, 12e3).toString("utf8").slice(0, 3e3);
      let m = text.startsWith("---") ? /^title:\s*(.+)$/m.exec(text) : null;
      m = m || /^#\s+(.+)$/m.exec(text);
      if (m) t = m[1].trim().replace(/^['"]+|['"]+$/g, "");
    }
  } catch {
  }
  return Array.from(t).slice(0, 140).join("");
}
function isKitHtml(path) {
  try {
    return head(path, 1200).includes("artifact-kit");
  } catch {
    return false;
  }
}
function mtimeNsHex(path) {
  return statSync(path, { bigint: true }).mtimeNs.toString(16);
}
function makeItem(rel, full, st, ext, kind, dir, opts = {}, env = process.env) {
  const url = opts.url ?? PREFIX + pyQuote(rel);
  const it = {
    name: rel,
    url,
    ext: ext.replace(/^\./, ""),
    kind,
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1e3),
    title: ["doc", "page", "app"].includes(kind) ? titleOf(full, ext, kind === "app") : "",
    source: opts.source ?? null,
    files: opts.files ?? [rel],
    public: rel.includes("/") ? false : existsSync(join(dir, rel) + ".public")
  };
  if (kind !== "app") {
    it.download = url + "?download=1";
    if (kind === "doc" && opts.source) {
      it.downloads = [{ label: ".md source", url: PREFIX + pyQuote(opts.source) + "?download=1" }, { label: ".html page", url: url + "?download=1" }];
    }
  }
  if (VIEW_KINDS.has(kind)) it.view = url + "?view=1";
  const ns = mtimeNsHex(opts.statPath ?? full);
  if (thumbsOn(env) && THUMB_KINDS.has(kind) && (kind !== "image" || RASTER_EXT.has(ext))) it.thumb = url + "?thumb=1&m=" + ns;
  else if (kind === "image" && ext === ".svg") it.thumb = url + "?raw=1&m=" + ns;
  return it;
}
function readClaims(env = process.env) {
  const store = storeDir(env);
  let reg = {};
  try {
    reg = JSON.parse(readFileSync(join(store, "registry.json"), "utf8"));
  } catch {
    reg = {};
  }
  const val = {};
  for (const [n, v] of Object.entries(reg.artifacts || {})) val[n] = { sessions: [...v.sessions || []] };
  let text = "";
  try {
    text = readFileSync(join(store, "claims.jsonl"), "utf8");
  } catch {
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let c;
    try {
      c = JSON.parse(line);
    } catch {
      continue;
    }
    if (!c || !c.name || !c.session) continue;
    const a = val[c.name] ?? (val[c.name] = { sessions: [] });
    a.sessions = a.sessions.filter((s) => s !== c.session).concat([c.session]);
  }
  return { val, parents: reg.parents || {} };
}
function family(session, claims) {
  const fam = /* @__PURE__ */ new Set([session]);
  let frontier = /* @__PURE__ */ new Set([session]);
  const bare = session.startsWith("session-") ? session.slice(8) : session;
  fam.add(bare);
  frontier.add(bare);
  for (let i = 0; i < 6; i++) {
    const nxt = new Set(Object.entries(claims.parents).filter(([sid, par]) => frontier.has(par) && !fam.has(sid)).map(([sid]) => sid));
    if (!nxt.size) break;
    nxt.forEach((s) => fam.add(s));
    frontier = nxt;
  }
  return fam;
}
function buildIndex(session = null, includeHidden = false, env = process.env) {
  const dir = reportDir(env);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    throw new ListingError("ARTIFACT_WRITE_FAILED", `cannot list the artifacts folder ${dir}: ${e.message}`);
  }
  const names = new Set(entries.filter((n) => !n.startsWith(".")));
  let items = [];
  const consumed = /* @__PURE__ */ new Set();
  for (const name of names) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    try {
      if (st.isDirectory()) {
        if (name === MEDIA_DIR) {
          for (const f of readdirSync(full)) {
            const ext2 = extname(f).toLowerCase();
            const fp = join(full, f);
            let fst;
            try {
              fst = statSync(fp);
            } catch {
              continue;
            }
            if (fst.isFile() && !f.startsWith(".") && ext2 !== "" && KIND[ext2]) items.push(makeItem(MEDIA_DIR + "/" + f, fp, fst, ext2, KIND[ext2], dir, {}, env));
          }
          continue;
        }
        const idx = join(full, "index.html");
        let ist = null;
        try {
          ist = statSync(idx);
        } catch {
          ist = null;
        }
        if (ist && ist.isFile()) {
          const it = makeItem(name, full, ist, ".html", "app", dir, { url: PREFIX + pyQuote(name) + "/", statPath: idx }, env);
          it.ext = "app";
          items.push(it);
        }
        continue;
      }
      if (!st.isFile()) continue;
      const ext = extname(name).toLowerCase();
      const kind = ext ? KIND[ext] : void 0;
      if (!kind || !LISTED_KINDS.has(kind) || consumed.has(name)) continue;
      const stem = name.slice(0, name.length - ext.length);
      if (ext === ".md") {
        const htmlName = stem + ".html";
        const hasHtml = names.has(htmlName);
        if (!hasHtml || isKitHtml(join(dir, htmlName))) {
          consumed.add(htmlName);
          const it = makeItem(htmlName, full, st, ".md", "doc", dir, { url: PREFIX + pyQuote(htmlName), source: name, files: [name, ...hasHtml ? [htmlName] : []] }, env);
          it.ext = "md";
          items.push(it);
          continue;
        }
      }
      if (ext === ".html" && names.has(stem + ".md") && isKitHtml(full)) continue;
      items.push(makeItem(name, full, st, ext, kind, dir, {}, env));
    } catch {
      continue;
    }
  }
  const lst = readListing(env);
  let hidden = 0;
  const kept = [];
  for (const it of items) {
    const s = lst[it.name] ?? (it.source ? lst[it.source] : void 0);
    if (s) {
      if (s.title) it.title = s.title;
      if (s.description) it.description = s.description;
      if (s.added) it.added = true;
      if (s.hidden) {
        hidden++;
        if (!includeHidden) continue;
        it.hidden = true;
      }
    }
    kept.push(it);
  }
  items = kept;
  items.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = { count: items.length, items, hidden };
  if (session) {
    const claims = readClaims(env);
    const fam = family(session, claims);
    for (const it of items) {
      let mine = false;
      for (const f of [...it.files, it.name, it.name.split("/")[0]]) {
        const c = claims.val[f];
        if (c && c.sessions.some((s) => fam.has(s))) {
          mine = true;
          break;
        }
      }
      it.mine = mine;
    }
    out.session = session;
    out.attributed = items.filter((i) => i.mine).length;
  }
  return out;
}
function origin(env) {
  const b = baseUrl(env);
  return b.endsWith("/report") ? b.slice(0, -"/report".length) : b.replace(/\/report$/, "");
}
function abs(u, env) {
  if (!u) return u;
  return u.startsWith(PREFIX) ? baseUrl(env) + "/" + u.slice(PREFIX.length) : u;
}
function present(it, env = process.env) {
  const dir = reportDir(env);
  const out = {
    name: it.name,
    title: it.title || "",
    description: it.description || "",
    kind: it.kind,
    ext: it.ext,
    size: it.size,
    modified: new Date(it.mtime * 1e3).toISOString(),
    url: abs(it.url, env)
  };
  if (it.view) out.view_url = abs(it.view, env);
  if (it.download) out.download_url = abs(it.download, env);
  if (it.downloads) out.downloads = it.downloads.map((d) => ({ label: d.label, url: abs(d.url, env) }));
  if (it.thumb) out.thumbnail_url = abs(it.thumb, env);
  out.public = it.public;
  if (it.public) out.public_url = origin(env) + "/report-public/" + pyQuote(it.name);
  out.path = join(dir, it.source || it.name);
  out.files = it.files;
  out.listed = !it.hidden;
  if (it.added) out.added = true;
  if (typeof it.mine === "boolean") out.this_chat = it.mine;
  return out;
}
const REPORTS_RX = /^(?:~|\/home\/[^/]+|\/root)\/reports\/(.+)$/;
function resolveName(input, env = process.env, items) {
  if (typeof input !== "string" || !input.trim()) throw new ListingError("ARTIFACT_ARGS_INVALID", "name is required: the artifact name, file name, path or URL", { errors: [{ field: "name", problem: "required" }] });
  let s = input.trim();
  const dir = reportDir(env);
  const b = baseUrl(env);
  for (const p of [b + "/", PREFIX, origin(env) + "/report-public/", "/report-public/"]) if (s.startsWith(p)) {
    s = s.slice(p.length);
    break;
  }
  s = s.split("?")[0].split("#")[0];
  try {
    s = decodeURIComponent(s);
  } catch {
  }
  if (s.startsWith(dir + sep)) s = s.slice(dir.length + 1);
  const m = REPORTS_RX.exec(s);
  if (m) s = m[1];
  s = s.replace(/^\/+|\/+$/g, "");
  const all = items ?? buildIndex(null, true, env).items;
  const by = (n) => all.find((i) => i.name === n) || all.find((i) => i.files.includes(n));
  const hit = by(s) || (s.endsWith(".md") ? by(s.slice(0, -3) + ".html") : void 0) || by(s + ".html") || by(s + "/");
  if (hit) return hit;
  const stem = (n) => n.replace(/\/$/, "").replace(/\.[^./]+$/, "");
  const cands = all.filter((i) => stem(i.name) === s || stem(i.name.split("/").pop() || "") === s);
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) throw new ListingError("ARTIFACT_AMBIGUOUS", `"${input}" matches ${cands.length} artifacts`, { candidates: cands.map((c) => c.name) });
  throw new ListingError("ARTIFACT_NOT_FOUND", `no artifact named "${input}" in ${dir}`, { name: input });
}
function listArtifacts(args = {}, callerSession, env = process.env) {
  const scope = args.scope ?? (args.session ? "chat" : "all");
  if (!["chat", "all"].includes(scope)) throw new ListingError("ARTIFACT_ARGS_INVALID", 'scope must be "chat" or "all"', { errors: [{ field: "scope", problem: "expected chat or all" }] });
  const kinds = ["doc", "page", "app", "image", "audio", "video", "pdf", "data", "code", "file", "media"];
  if (args.kind !== void 0 && !kinds.includes(args.kind)) throw new ListingError("ARTIFACT_ARGS_INVALID", `kind must be one of ${kinds.join(", ")}`, { errors: [{ field: "kind", problem: "unknown kind " + String(args.kind) }] });
  let session = null;
  if (scope === "chat") {
    const s = args.session ?? callerSession;
    if (typeof s !== "string" || !SESSION_RE.test(s)) throw new ListingError("ARTIFACT_ARGS_INVALID", 'scope "chat" needs the calling chat (or a session id): none is known here', { errors: [{ field: "session", problem: "no chat session" }] });
    session = s;
  }
  const limit = args.limit === void 0 ? 50 : Math.trunc(Number(args.limit));
  if (!Number.isFinite(limit) || limit < 1 || limit > 1e3) throw new ListingError("ARTIFACT_ARGS_INVALID", "limit must be 1 to 1000", { errors: [{ field: "limit", problem: "out of range" }] });
  const idx = buildIndex(session, !!args.include_hidden, env);
  const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
  const media = /* @__PURE__ */ new Set(["image", "audio", "video"]);
  const rows = idx.items.filter((i) => {
    if (session && !i.mine) return false;
    if (args.kind && (args.kind === "media" ? !media.has(i.kind) : i.kind !== args.kind)) return false;
    if (q && !(i.name + " " + (i.title || "") + " " + (i.description || "")).toLowerCase().includes(q)) return false;
    return true;
  });
  return {
    ok: true,
    scope,
    count: Math.min(rows.length, limit),
    total: rows.length,
    hidden_count: idx.hidden,
    items: rows.slice(0, limit).map((i) => present(i, env)),
    folder: reportDir(env),
    base_url: baseUrl(env),
    next: "artifact_add({ path }) lists a file you produced; artifact_remove({ name }) de-lists one (the file stays)."
  };
}
const SLUG_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_ADD = () => Math.max(1, Number(process.env.ARTIFACT_MAX_ADD_MB || 4096)) * 1048576;
function sha256(path) {
  const h = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const b = Buffer.alloc(1 << 20);
    let n;
    while ((n = readSync(fd, b, 0, b.length, null)) > 0) h.update(b.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest("hex");
}
function claim(rels, session, env) {
  if (typeof session !== "string" || !SESSION_RE.test(session)) return;
  try {
    mkdirSync(storeDir(env), { recursive: true });
    const now = Date.now();
    appendFileSync(join(storeDir(env), "claims.jsonl"), rels.map((name) => JSON.stringify({ name, session, time: now, how: "tool" }) + "\n").join(""));
  } catch {
  }
}
function checkText(field, v, max) {
  if (v === void 0 || v === null) return void 0;
  if (typeof v !== "string") throw new ListingError("ARTIFACT_ARGS_INVALID", `${field} must be a string`, { errors: [{ field, problem: "expected string" }] });
  if (v.length > max) throw new ListingError("ARTIFACT_ARGS_INVALID", `${field} is longer than ${max} characters`, { errors: [{ field, problem: `at most ${max} characters` }] });
  if (hasSecret(v)) throw new ListingError("ARTIFACT_SECRET_REFUSED", `${field} contains a credential-shaped string`);
  return v;
}
function addArtifact(args, session, env = process.env) {
  const title = checkText("title", args.title, 300);
  const description = checkText("description", args.description, 2e3);
  const mode = args.mode ?? "copy";
  if (!["copy", "link"].includes(mode)) throw new ListingError("ARTIFACT_ARGS_INVALID", 'mode must be "copy" or "link"', { errors: [{ field: "mode", problem: "expected copy or link" }] });
  const dir = reportDir(env);
  if (!args.path && !args.name) throw new ListingError("ARTIFACT_ARGS_INVALID", "pass path (a file to list) or name (an artifact to list again)", { errors: [{ field: "path", problem: "path or name is required" }] });
  let rel;
  let how = "";
  let from = null;
  let sandbox = false;
  if (args.path) {
    const p = resolve(String(args.path).replace(/^~(?=\/|$)/, env.HOME || homedir()));
    let real;
    let st;
    try {
      real = realpathSync(p);
      st = statSync(real);
    } catch {
      throw new ListingError("ARTIFACT_SOURCE_INVALID", `no such file: ${p}`, { path: p });
    }
    if (!st.isFile()) throw new ListingError("ARTIFACT_SOURCE_INVALID", `not a regular file: ${p} (folders: write an app folder into the artifacts folder instead)`, { path: p });
    const ext = extname(real).toLowerCase() || extname(p).toLowerCase();
    if (!ext || !KIND[ext] || basename(p).startsWith(".")) {
      throw new ListingError("ARTIFACT_TYPE_UNSUPPORTED", `files of type "${ext || "(no extension)"}" cannot be listed`, { supported: Object.keys(KIND).sort() });
    }
    if (st.size > MAX_ADD()) throw new ListingError("ARTIFACT_FILE_TOO_LARGE", `the file is ${st.size} bytes, the limit is ${MAX_ADD()} (ARTIFACT_MAX_ADD_MB)`, { size: st.size, limit: MAX_ADD() });
    if (TEXT_KINDS.has(KIND[ext]) && st.size <= 4e6) {
      let text = "";
      try {
        text = readFileSync(real, "utf8");
      } catch {
        text = "";
      }
      if (hasSecret(text)) throw new ListingError("ARTIFACT_SECRET_REFUSED", `${p} contains a credential-shaped string; artifacts are served over HTTP`);
    }
    const inside = real.startsWith(dir + sep) ? real.slice(dir.length + 1) : null;
    if (inside && (!inside.includes("/") || inside.startsWith(MEDIA_DIR + "/")) && inside.split("/").length <= 2 && !inside.split("/").some((x) => x.startsWith("."))) {
      rel = inside;
      how = "listed in place";
    } else {
      const want = args.slug ?? basename(p).slice(0, basename(p).length - extname(p).length);
      let stem = String(want).trim();
      if (stem.toLowerCase().endsWith(ext)) stem = stem.slice(0, stem.length - ext.length);
      if (!SLUG_RX.test(stem) || stem.includes("..")) {
        if (args.slug !== void 0) throw new ListingError("ARTIFACT_BAD_NAME", `bad slug "${want}"`, { detail: String(want) });
        stem = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 100) || "file";
      }
      rel = stem + ext;
      const target = join(dir, rel);
      if (existsSync(target)) {
        const tst = statSync(target);
        const same = tst.isFile() && tst.size === st.size && sha256(target) === sha256(real);
        if (!same && !args.force) throw new ListingError("ARTIFACT_EXISTS", `${rel} already exists in the artifacts folder with other content`, { name: rel, hint_extra: "pass force: true to replace it (the old content stays in the versions when it is small), or a different slug" });
        if (same) how = "already there (identical), listed";
      }
      if (!how) {
        mkdirSync(dir, { recursive: true });
        if (mode === "link") {
          const tmp = join(dir, `.${rel}.link-${process.pid}`);
          try {
            linkSync(real, tmp);
            renameSync(tmp, target);
          } catch (e) {
            try {
              unlinkSync(tmp);
            } catch {
            }
            throw new ListingError("ARTIFACT_LINK_FAILED", `cannot hardlink ${p} into ${dir} (${e.code || e.message})`, { detail: e.code || e.message });
          }
          how = "linked";
        } else {
          const tmp = join(dir, `.${rel}.copy-${process.pid}`);
          copyFileSync(real, tmp);
          renameSync(tmp, target);
          how = "copied";
        }
      }
      from = p;
      sandbox = (ext === ".html" || ext === ".htm") && !args.trusted;
    }
  } else {
    const it = resolveName(args.name, env);
    rel = it.name;
    how = it.hidden ? "listed again" : "already listed";
  }
  const idx = buildIndex(null, true, env).items;
  const relView = rel.endsWith(".md") ? rel.slice(0, -3) + ".html" : rel;
  const item = idx.find((i) => i.name === relView || i.files.includes(rel));
  if (!item) throw new ListingError("ARTIFACT_NOT_FOUND", `${rel} is not an artifact the tab can show`, { name: rel });
  const entry = { op: "add", name: item.name, mode: from ? mode : "in-place", how: "tool" };
  if (from) entry.from = from;
  if (sandbox) entry.sandbox = true;
  if (title !== void 0) entry.title = title;
  if (description !== void 0) entry.description = description;
  if (typeof session === "string" && SESSION_RE.test(session)) entry.session = session;
  appendListing(entry, env);
  claim([.../* @__PURE__ */ new Set([...item.files, item.name])], session, env);
  const fresh = buildIndex(null, true, env).items.find((i) => i.name === item.name) || item;
  const out = { ok: true, action: how, ...present(fresh, env) };
  if (sandbox) out.note = "HTML listed from outside the artifacts folder is served sandboxed (no script); pass trusted: true for a page you wrote yourself.";
  out.next = "Give the user url (opens the enclosure for media and files); download_url downloads it.";
  return out;
}
function removeArtifact(args, session, env = process.env) {
  const it = resolveName(args.name, env);
  const already = !!it.hidden;
  if (!already) {
    const e = { op: "hide", name: it.name, how: "tool" };
    if (typeof session === "string" && SESSION_RE.test(session)) e.session = session;
    appendListing(e, env);
  }
  return {
    ok: true,
    name: it.name,
    listed: false,
    already_hidden: already,
    file_kept: join(reportDir(env), it.source || it.name),
    note: "De-listed: hidden from the Artifacts tab; the file, its versions and its links stay.",
    next: `artifact_add({ name: "${it.name}" }) lists it again.`
  };
}
function updateArtifact(args, session, env = process.env) {
  const title = checkText("title", args.title, 300);
  const description = checkText("description", args.description, 2e3);
  if (title === void 0 && description === void 0) throw new ListingError("ARTIFACT_ARGS_INVALID", 'pass title, description or both ("" clears one)', { errors: [{ field: "title", problem: "title or description is required" }] });
  const it = resolveName(args.name, env);
  const e = { op: "meta", name: it.name, how: "tool" };
  if (title !== void 0) e.title = title;
  if (description !== void 0) e.description = description;
  if (typeof session === "string" && SESSION_RE.test(session)) e.session = session;
  appendListing(e, env);
  const fresh = buildIndex(null, true, env).items.find((i) => i.name === it.name) || it;
  return { ok: true, ...present(fresh, env) };
}
export {
  KIND,
  LISTED_KINDS,
  ListingError,
  RASTER_EXT,
  THUMB_KINDS,
  TYPES,
  VIEW_KINDS,
  addArtifact,
  appendListing,
  buildIndex,
  family,
  foldListing,
  listArtifacts,
  present,
  pyQuote,
  readClaims,
  readListing,
  removeArtifact,
  resolveName,
  titleOf,
  updateArtifact
};
