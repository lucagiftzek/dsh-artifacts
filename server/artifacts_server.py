"""dsh-artifacts server module, imported by the DSH proxy.

Owns everything under /report/ for the owner's workspace:

  /report/<name>                 an artifact (file, app directory, or media)
  /report/<name>.md              rendered to HTML for browser navigations,
                                 raw Markdown for fetch/curl or ?raw=1
  /report/<stem>.html            rendered on the fly from <stem>.md when the
                                 HTML is missing or an older artifact-kit render
  /report/<app>/                 app directory: serves <app>/index.html + assets
  /report/_lib/<file>            vendored libraries (react, mermaid, chart.js...)
  /report/_api/...               JSON API used by the sidebar and the bridge
  /report/?list=1                v1-compatible index (same item shape, plus fields)

Every served HTML page gets the BRIDGE script (see bridge.js): live reload,
window.dsh (send to chat, silent context, storage, ai, media, pick-and-ask),
Claude/OpenAI-compatible aliases, and error capture.

Design rules carried over from v1: closed extension allowlist, no dotfiles,
everything fenced to REPORT_DIR, and nothing here can raise out of a request.
The heavy work (attribution, version snapshots) is in indexer.py, a separate
niced process, so this module only ever reads small JSON files.
"""
import difflib
import hashlib
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import urllib.request
from email.utils import formatdate
from importlib.machinery import SourceFileLoader
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

log = logging.getLogger("dsh-artifacts")

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import files as F  # noqa: E402  listing state, byte serving, thumbnails (2.2)
import viewer as V  # noqa: E402  the enclosure page for media and files (2.2)

PLUGIN = HERE.parent
HOME = str(Path.home())
REPORT_DIR = Path(os.environ.get("ARTIFACT_DIR", os.path.join(HOME, "reports"))).resolve()
STORE = REPORT_DIR / ".artifacts"
VERSIONS = STORE / "versions"
STATE = STORE / "state"
INBOX = STORE / "inbox"
TRASH = STORE / "trash"
CLAIMS = STORE / "claims.jsonl"
REGISTRY = STORE / "registry.json"
VENDOR = PLUGIN / "vendor"
PREFIX = "/report/"
PUBLIC_PREFIX = "/report-public/"
KIT_PATH = PLUGIN / "contrib" / "artifact-kit"
DSH_WEB = os.environ.get("DSH_WEB_URL", "http://127.0.0.1:3080")
SESSION_RE = re.compile(r"^(session-)?[0-9a-fA-F-]{8,80}$")

TYPES = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8", ".tsv": "text/tab-separated-values; charset=utf-8",
    ".svg": "image/svg+xml", ".xml": "application/xml; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".jsx": "text/plain; charset=utf-8", ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8",
    ".sh": "text/plain; charset=utf-8", ".sql": "text/plain; charset=utf-8",
    ".yaml": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
    ".opus": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
    ".glb": "model/gltf-binary", ".gltf": "model/gltf+json",
    # 2.2: more text, media and plain files (closed list; files are only ever served as downloads)
    ".jsonl": "text/plain; charset=utf-8", ".ndjson": "text/plain; charset=utf-8",
    ".geojson": "application/json; charset=utf-8", ".ipynb": "application/json; charset=utf-8",
    ".ics": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8", ".diff": "text/plain; charset=utf-8",
    ".toml": "text/plain; charset=utf-8", ".ini": "text/plain; charset=utf-8", ".go": "text/plain; charset=utf-8",
    ".rs": "text/plain; charset=utf-8", ".c": "text/plain; charset=utf-8", ".h": "text/plain; charset=utf-8",
    ".srt": "text/plain; charset=utf-8", ".vtt": "text/vtt; charset=utf-8",
    ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
    ".weba": "audio/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
    ".zip": "application/zip", ".tar": "application/x-tar", ".gz": "application/gzip", ".tgz": "application/gzip",
    ".bz2": "application/x-bzip2", ".xz": "application/x-xz", ".7z": "application/x-7z-compressed",
    ".zst": "application/zstd",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".doc": "application/msword", ".xls": "application/vnd.ms-excel", ".ppt": "application/vnd.ms-powerpoint",
    ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
    ".odp": "application/vnd.oasis.opendocument.presentation", ".rtf": "application/rtf",
    ".epub": "application/epub+zip", ".parquet": "application/vnd.apache.parquet",
    ".sqlite": "application/vnd.sqlite3", ".eml": "message/rfc822", ".stl": "model/stl",
}
KIND = {
    ".md": "doc", ".html": "page", ".htm": "page", ".txt": "data", ".log": "data",
    ".json": "data", ".csv": "data", ".tsv": "data", ".xml": "data",
    ".svg": "image", ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image",
    ".webp": "image", ".avif": "image",
    ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".oga": "audio", ".opus": "audio",
    ".m4a": "audio", ".aac": "audio", ".flac": "audio",
    ".mp4": "video", ".m4v": "video", ".webm": "video", ".mov": "video", ".pdf": "pdf",
    ".py": "code", ".sh": "code", ".sql": "code", ".js": "code", ".jsx": "code",
    ".ts": "code", ".tsx": "code", ".css": "code", ".yaml": "code", ".yml": "code",
    # 2.2
    ".jsonl": "data", ".ndjson": "data", ".geojson": "data", ".ipynb": "data", ".ics": "data", ".srt": "data",
    ".vtt": "data", ".patch": "code", ".diff": "code", ".toml": "code", ".ini": "code", ".go": "code", ".rs": "code",
    ".c": "code", ".h": "code", ".bmp": "image", ".weba": "audio", ".mkv": "video",
    ".tif": "file", ".tiff": "file", ".heic": "file", ".avi": "file",
    ".zip": "file", ".tar": "file", ".gz": "file", ".tgz": "file", ".bz2": "file", ".xz": "file", ".7z": "file",
    ".zst": "file", ".docx": "file", ".xlsx": "file", ".pptx": "file", ".doc": "file", ".xls": "file",
    ".ppt": "file", ".odt": "file", ".ods": "file", ".odp": "file", ".rtf": "file", ".epub": "file",
    ".parquet": "file", ".sqlite": "file", ".eml": "file", ".stl": "file", ".glb": "file", ".gltf": "file",
}
LISTED_KINDS = {"doc", "page", "data", "image", "audio", "video", "pdf", "code", "file"}
# Kinds a top-level browser navigation opens in the enclosure page (2.2); embeds and fetches get the bytes.
VIEW_KINDS = {"image", "audio", "video", "pdf", "data", "code", "file"}
LISTING_OPS = ("hide", "show", "meta")
MEDIA_DIR = "media"

_get_token = lambda: None
_indexer = None
_lock = threading.Lock()


# -- small utils --------------------------------------------------------------

def _json_load(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


def _atomic_write(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name("." + path.name + ".tmp-%d" % os.getpid())
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def safe_rel(rel):
    """A REPORT_DIR-relative path that cannot escape the fence, or None."""
    rel = unquote(rel or "").strip("/")
    if not rel:
        return None
    parts = rel.split("/")
    if len(parts) > 4 or any(not p or p.startswith(".") or p in ("..",) for p in parts):
        return None
    full = (REPORT_DIR / rel).resolve()
    try:
        full.relative_to(REPORT_DIR)
    except ValueError:
        return None
    return rel


def valid_session(s):
    return s if isinstance(s, str) and SESSION_RE.match(s) else None


def _sec_dest(h):
    return (h.headers.get("Sec-Fetch-Dest") or "").lower()


def _wants_html(h, q):
    if "raw" in q:
        return False
    if "html" in q:
        return True
    return _sec_dest(h) in ("document", "iframe", "frame")


# -- kit (markdown -> html) -------------------------------------------------

_kit = None
_kit_mtime = 0
_render_cache = {}


def kit():
    """The artifact-kit module, reloaded when its file changes."""
    global _kit, _kit_mtime
    try:
        m = KIT_PATH.stat().st_mtime
    except OSError:
        return None
    if _kit is None or m != _kit_mtime:
        try:
            import importlib.util
            loader = SourceFileLoader("artifact_kit_mod", str(KIT_PATH))
            spec = importlib.util.spec_from_loader("artifact_kit_mod", loader)
            mod = importlib.util.module_from_spec(spec)
            loader.exec_module(mod)
            _kit = mod
            _kit_mtime = m
            _render_cache.clear()
        except Exception as e:
            log.error("artifact-kit load failed: %s", e)
            return _kit
    return _kit


def render_md(md_path):
    """(html bytes, etag) for a Markdown artifact, cached by mtime/size."""
    k = kit()  # first: picks up a changed artifact-kit, which invalidates the cache
    st = md_path.stat()
    key = str(md_path)
    hit = _render_cache.get(key)
    sig = (st.st_mtime_ns, st.st_size, _kit_mtime)
    if hit and hit[0] == sig:
        return hit[1], hit[2]
    text = md_path.read_text(encoding="utf-8", errors="replace")
    try:
        page = k.render_text(text, md_path.name).encode("utf-8")
    except Exception as e:
        page = ("<!doctype html><meta charset=utf-8><title>render error</title><pre>artifact-kit could not render %s:\n%s</pre>"
                % (md_path.name, str(e).replace("<", "&lt;"))).encode()
    etag = '"md-%x-%x-%x"' % (st.st_mtime_ns, st.st_size, int(_kit_mtime))
    _render_cache[key] = (sig, page, etag)
    if len(_render_cache) > 200:
        _render_cache.pop(next(iter(_render_cache)), None)
    return page, etag


def is_kit_html(path):
    try:
        with open(path, "rb") as fh:
            return b"artifact-kit" in fh.read(1200)
    except OSError:
        return False


# -- bridge ------------------------------------------------------------------

_bridge_src = None
_bridge_mtime = 0


def bridge_js():
    global _bridge_src, _bridge_mtime
    p = HERE / "bridge.js"
    try:
        m = p.stat().st_mtime
        if _bridge_src is None or m != _bridge_mtime:
            _bridge_src = p.read_text(encoding="utf-8")
            _bridge_mtime = m
    except OSError:
        _bridge_src = _bridge_src or ""
    return _bridge_src


def owner_session(name):
    claims = all_claims()
    for n in (name, name.split("/")[0], _pair(name)):
        if n and n in claims and claims[n]["sessions"]:
            return claims[n]["sessions"][-1]
    return ""


def _pair(name):
    if name.endswith(".html"):
        return name[:-5] + ".md"
    if name.endswith(".md"):
        return name[:-3] + ".html"
    return None


def inject_bridge(data, name, etag, public=False):
    cfg = json.dumps({"name": name, "etag": etag, "owner": "" if public else owner_session(name),
                      "api": PREFIX + "_api/", "public": public})
    snippet = ("<script data-dsh-bridge>window.__DSH_ARTIFACT__=%s;\n%s</script>" % (cfg, bridge_js())).encode()
    low = data[:4096].lower()
    i = low.find(b"<head>")
    if i == -1:
        i = low.find(b"<head ")
        if i != -1:
            i = data.find(b">", i)
            return data[:i + 1] + snippet + data[i + 1:]
        j = low.find(b"<html")
        if j != -1:
            j = data.find(b">", j)
            return data[:j + 1] + snippet + data[j + 1:]
        return snippet + data
    return data[:i + 6] + snippet + data[i + 6:]


# -- claims / registry --------------------------------------------------------

_claims_cache = {"sig": None, "val": {}, "parents": {}}


def all_claims():
    """name -> {sessions, last}: indexer registry merged with explicit CLI claims."""
    sig = []
    for p in (REGISTRY, CLAIMS):
        try:
            st = p.stat()
            sig.append((st.st_mtime_ns, st.st_size))
        except OSError:
            sig.append(None)
    if sig == _claims_cache["sig"]:
        return _claims_cache["val"]
    reg = _json_load(REGISTRY, {})
    val = {k: {"sessions": list(v.get("sessions", [])), "last": v.get("last")}
           for k, v in reg.get("artifacts", {}).items()}
    try:
        with open(CLAIMS, encoding="utf-8") as fh:
            for line in fh:
                try:
                    c = json.loads(line)
                except Exception:
                    continue
                n, s = c.get("name"), c.get("session")
                if not n or not s:
                    continue
                a = val.setdefault(n, {"sessions": [], "last": c.get("time")})
                if s in a["sessions"]:
                    a["sessions"].remove(s)
                a["sessions"].append(s)
    except OSError:
        pass
    _claims_cache.update(sig=sig, val=val, parents=reg.get("parents", {}))
    return val


def add_claim(name, session, how="api"):
    if not valid_session(session) or not name:
        return
    line = json.dumps({"name": name, "session": session, "time": int(time.time() * 1000), "how": how})
    STORE.mkdir(parents=True, exist_ok=True)
    with open(CLAIMS, "a", encoding="utf-8") as fh:
        fh.write(line + "\n")


def family(session):
    """The session plus every subagent session below it."""
    all_claims()
    parents = _claims_cache["parents"]
    fam, frontier = {session}, {session}
    bare = session[len("session-"):] if session.startswith("session-") else session
    fam.add(bare)
    frontier.add(bare)
    for _ in range(6):
        nxt = {sid for sid, par in parents.items() if par in frontier and sid not in fam}
        if not nxt:
            break
        fam |= nxt
        frontier = nxt
    return fam


# -- index --------------------------------------------------------------------

_title_cache = {}
TITLE_RX = re.compile(rb"<title[^>]*>(.*?)</title>", re.I | re.S)


def title_of(path, ext, st):
    key = (str(path), st.st_mtime_ns)
    if key in _title_cache:
        return _title_cache[key]
    t = ""
    try:
        if ext in (".html", ".htm") or path.is_dir():
            p = path / "index.html" if path.is_dir() else path
            with open(p, "rb") as fh:
                m = TITLE_RX.search(fh.read(6000))
            if m:
                import html as _h
                t = _h.unescape(re.sub(rb"\s+", b" ", m.group(1)).decode("utf-8", "replace")).strip()
        elif ext == ".md":
            with open(path, encoding="utf-8", errors="replace") as fh:
                head = fh.read(3000)
            m = re.search(r"^title:\s*(.+)$", head, re.M) if head.startswith("---") else None
            m = m or re.search(r"^#\s+(.+)$", head, re.M)
            if m:
                t = m.group(1).strip().strip("'\"")
    except OSError:
        pass
    if len(_title_cache) > 4000:
        _title_cache.clear()
    _title_cache[key] = t[:140]
    return _title_cache[key]


def _item(rel, full, st, ext, kind, url=None, source=None, files=None):
    url = url or PREFIX + quote(rel)
    it = {
        "name": rel, "url": url, "ext": ext.lstrip("."), "kind": kind,
        "size": st.st_size, "mtime": int(st.st_mtime),
        "title": title_of(full, ext, st) if kind in ("doc", "page", "app") else "",
        "source": source, "files": files or [rel],
        "public": os.path.exists(str(REPORT_DIR / rel) + ".public") if "/" not in rel else False,
    }
    # 2.2: where to view and download it, and a thumbnail for media
    if kind != "app":
        it["download"] = url + "?download=1"
        if kind == "doc" and source:
            it["downloads"] = [{"label": ".md source", "url": PREFIX + quote(source) + "?download=1"},
                               {"label": ".html page", "url": url + "?download=1"}]
    if kind in VIEW_KINDS:
        it["view"] = url + "?view=1"
    if F.THUMBS_ON and (kind in F.THUMB_KINDS and (kind != "image" or ext in F.RASTER_EXT)):
        it["thumb"] = url + "?thumb=1&m=%x" % st.st_mtime_ns
    elif kind == "image" and ext == ".svg":
        it["thumb"] = url + "?raw=1&m=%x" % st.st_mtime_ns
    return it


def _apply_listing(items, include_hidden):
    lst = F.listing(STORE)
    out, hidden = [], 0
    for it in items:
        s = F.state_for(lst, [it["name"], it.get("source")]) if lst else None
        if s:
            if s["title"]:
                it["title"] = s["title"]
            if s["description"]:
                it["description"] = s["description"]
            if s["added"]:
                it["added"] = True
            if s["hidden"]:
                hidden += 1
                if not include_hidden:
                    continue
                it["hidden"] = True
        out.append(it)
    return out, hidden


def build_index(session=None, include_hidden=False):
    items = []
    try:
        entries = list(os.scandir(REPORT_DIR))
    except OSError as e:
        return {"error": "cannot list artifact directory: %s" % e, "count": 0, "items": []}
    names = {e.name: e for e in entries if not e.name.startswith(".")}
    consumed = set()
    for name, e in names.items():
        try:
            if e.is_dir():
                if name == MEDIA_DIR:
                    for f in os.scandir(e.path):
                        ext = os.path.splitext(f.name)[1].lower()
                        if f.is_file() and not f.name.startswith(".") and ext in KIND:
                            rel = MEDIA_DIR + "/" + f.name
                            items.append(_item(rel, Path(f.path), f.stat(), ext, KIND[ext]))
                    continue
                idx = os.path.join(e.path, "index.html")
                if os.path.isfile(idx):
                    st = os.stat(idx)
                    it = _item(name, Path(e.path), st, ".html", "app", url=PREFIX + quote(name) + "/")
                    it["ext"] = "app"
                    items.append(it)
                continue
            if not e.is_file():
                continue
            ext = os.path.splitext(name)[1].lower()
            kind = KIND.get(ext)
            if kind not in LISTED_KINDS or name in consumed:
                continue
            st = e.stat()
            stem = name[: -len(ext)]
            if ext == ".md":
                html_name = stem + ".html"
                h = names.get(html_name)
                if h is None or is_kit_html(h.path):
                    # One artifact: the Markdown is the source, the page is the view.
                    consumed.add(html_name)
                    it = _item(html_name, Path(e.path), st, ".md", "doc",
                               url=PREFIX + quote(html_name), source=name,
                               files=[name] + ([html_name] if h is not None else []))
                    it["ext"] = "md"
                    items.append(it)
                    continue
            if ext == ".html" and (stem + ".md") in names and is_kit_html(e.path):
                continue  # handled with its .md
            items.append(_item(name, Path(e.path), st, ext, kind))
        except OSError:
            continue
    items, hidden = _apply_listing(items, include_hidden)
    items.sort(key=lambda i: (-i["mtime"], i["name"]))
    out = {"count": len(items), "items": items, "hidden": hidden}
    if session:
        fam = family(session)
        claims = all_claims()
        for it in items:
            mine = False
            for f in it["files"] + [it["name"], it["name"].split("/")[0]]:
                c = claims.get(f)
                if c and fam.intersection(c["sessions"]):
                    mine = True
                    break
            it["mine"] = mine
        out["session"] = session
        out["attributed"] = sum(1 for i in items if i["mine"])
    out["indexer"] = indexer_status()
    sig = hashlib.sha1(json.dumps(items, sort_keys=True).encode()).hexdigest()[:16]
    out["etag"] = sig
    return out


def indexer_status():
    reg = REGISTRY
    try:
        age = time.time() - reg.stat().st_mtime
    except OSError:
        age = None
    alive = _indexer is not None and _indexer.poll() is None
    return {"alive": alive, "registryAge": None if age is None else int(age)}


# -- versions -----------------------------------------------------------------

def versions_of(rel):
    d = VERSIONS / quote(rel, safe="")
    try:
        snaps = sorted((p for p in d.iterdir() if p.name.isdigit()), key=lambda p: int(p.name))
    except OSError:
        return []
    return [{"id": p.name, "mtime": int(p.name) / 1e9, "size": p.stat().st_size} for p in snaps]


def version_bytes(rel, vid):
    if not vid.isdigit():
        return None
    p = VERSIONS / quote(rel, safe="") / vid
    try:
        return p.read_bytes()
    except OSError:
        return None


def source_rel(rel):
    """For an md-backed page the editable source is the .md."""
    if rel.endswith(".html"):
        md = rel[:-5] + ".md"
        if (REPORT_DIR / md).is_file() and (not (REPORT_DIR / rel).exists() or is_kit_html(REPORT_DIR / rel)):
            return md
    p = REPORT_DIR / rel
    if p.is_dir() and (p / "index.html").is_file():
        return rel + "/index.html"
    return rel


# -- chat delivery --------------------------------------------------------------

_iw_secret = None
_send_times = {}


def iw_secret():
    global _iw_secret
    if _iw_secret:
        return _iw_secret
    s = (os.environ.get("DSH_IDLE_WATCHDOG_SECRET") or "").strip()
    if not s:
        try:
            s = Path(os.path.expanduser("~/.dsh/idle-watchdog/api-secret")).read_text().strip()
        except OSError:
            pass
    _iw_secret = s
    return s


def deliver_to_chat(session, text):
    """Post a user message into a chat (live or cold) via Idle Watchdog's API."""
    secret = iw_secret()
    if not secret:
        raise RuntimeError("chat delivery unavailable: Idle Watchdog secret not configured")
    now = time.time()
    recent = [t for t in _send_times.get(session, []) if now - t < 60]
    if len(recent) >= 6:
        raise RuntimeError("rate limited: at most 6 artifact messages per minute per chat")
    recent.append(now)
    _send_times[session] = recent
    body = json.dumps({"chat": session, "message": text, "provenance": "dsh-artifacts"}).encode()
    req = urllib.request.Request(DSH_WEB + "/dsh-idle-watchdog/api/prompt", data=body, method="POST",
                                 headers={"content-type": "application/json", "x-idle-watchdog-secret": secret})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode() or "{}")


def inbox_add(session, entry):
    entry["time"] = int(time.time())
    INBOX.mkdir(parents=True, exist_ok=True)
    with open(INBOX / (session + ".jsonl"), "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False)[:20000] + "\n")


def inbox_read(session):
    out = []
    try:
        with open(INBOX / (session + ".jsonl"), encoding="utf-8") as fh:
            for line in fh:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    except OSError:
        pass
    return out


# -- storage ------------------------------------------------------------------

def _state_path(name):
    return STATE / (quote(name, safe="") + ".json")


def storage_op(name, op, key=None, value=None, prefix=""):
    with _lock:
        p = _state_path(name)
        data = _json_load(p, {})
        if op == "get":
            return {"key": key, "value": data.get(key), "exists": key in data}
        if op == "list":
            return {"keys": sorted(k for k in data if k.startswith(prefix or ""))}
        if op == "all":
            return {"data": data}
        if op == "set":
            data[key] = value
        elif op == "delete":
            data.pop(key, None)
        blob = json.dumps(data, ensure_ascii=False).encode()
        if len(blob) > 20_000_000:
            raise ValueError("storage for this artifact would exceed 20 MB")
        _atomic_write(p, blob)
        return {"ok": True}


# -- HTTP plumbing --------------------------------------------------------------

def _send(h, code, body, ctype, method, extra=None):
    if isinstance(body, str):
        body = body.encode()
    h.send_response(code)
    h.send_header("Content-Type", ctype)
    h.send_header("Content-Length", str(len(body)))
    h.send_header("Cache-Control", "no-store")
    h.send_header("X-Content-Type-Options", "nosniff")
    for k, v in (extra or {}).items():
        h.send_header(k, v)
    h.end_headers()
    if method != "HEAD":
        h.wfile.write(body)
    return True


def _json(h, code, obj, method="GET", extra=None):
    return _send(h, code, json.dumps(obj, ensure_ascii=False), "application/json; charset=utf-8", method, extra)


def _read_body(h, limit=8_000_000):
    try:
        n = int(h.headers.get("Content-Length", 0) or 0)
    except ValueError:
        n = 0
    if n <= 0:
        return {}
    if n > limit:
        raise ValueError("body too large")
    obj = json.loads(h.rfile.read(n).decode("utf-8"))
    if not isinstance(obj, dict):
        raise ValueError("expected a JSON object")
    return obj


def _serve_bytes(h, method, data, ctype, etag, mtime=None, cache="no-store", headers=None):
    return F.send_content(h, method, ctype, data=data, etag=etag, mtime=mtime, cache=cache, headers=headers)


def _serve_large_file(h, method, path, ctype, st, headers=None):
    """Stream big files with Range support, without reading all into memory."""
    return F.send_content(h, method, ctype, path=path, size=st.st_size, etag=F.etag_for(st), mtime=st.st_mtime,
                          headers=headers)


def _serve_file(h, method, full, ctype, st, headers=None, transform=None):
    """A file from disk: streamed when big, else read (and optionally transformed, e.g. the bridge)."""
    if st.st_size > F.INLINE_MAX or transform is None:
        if st.st_size > F.INLINE_MAX:
            return _serve_large_file(h, method, full, ctype, st, headers)
        return _serve_bytes(h, method, full.read_bytes(), ctype, F.etag_for(st), st.st_mtime, headers=headers)
    return _serve_bytes(h, method, transform(full.read_bytes()), ctype, F.etag_for(st), st.st_mtime, headers=headers)


def _md_footer(page, rel, public):
    """Download links in the footer of a rendered Markdown page (served pages only, never the file)."""
    base = (PUBLIC_PREFIX if public else PREFIX)
    stem = rel[:-5] if rel.endswith(".html") else rel[:-3]
    # no download attribute: a plain navigation to an attachment downloads too, and only navigations pass
    # through dsh-seal's service worker (Chrome sends <a download> straight to the network)
    links = (' Download: <a href="%s%s.md?download=1">.md source</a>, '
             '<a href="%s%s.html?download=1">.html page</a>.' % (base, quote(stem), base, quote(stem)))
    i = page.rfind(b"</footer>")
    if i == -1 or b"artifact-kit" not in page[:1200]:
        return page
    return page[:i] + links.encode() + page[i:]


def _wants_view(h, q, kind):
    if kind not in VIEW_KINDS or "raw" in q or "download" in q or "thumb" in q:
        return False
    return "view" in q or _sec_dest(h) == "document"


def item_meta(rel):
    """Listing state (title, description, sandbox) for a served name."""
    lst = F.listing(STORE)
    return F.state_for(lst, [rel, _pair(rel)] if rel.endswith((".md", ".html")) else [rel]) or {}


def serve_path(h, method, rel, q, public=False, download=False):
    """Serve one artifact path (already fenced)."""
    full = REPORT_DIR / rel
    download = download or "download" in q
    if full.is_dir():
        if download:
            return _send(h, 404, "an app folder has no single file to download\n", "text/plain; charset=utf-8", method)
        if not h.path.split("?")[0].endswith("/"):
            loc = h.path.split("?")[0] + "/" + (("?" + h.path.split("?", 1)[1]) if "?" in h.path else "")
            h.send_response(301)
            h.send_header("Location", loc)
            h.send_header("Content-Length", "0")
            h.end_headers()
            return True
        full = full / "index.html"
        rel = rel + "/index.html"
    ext = os.path.splitext(rel)[1].lower()
    if ext not in TYPES:
        return _send(h, 404, "not found\n", "text/plain; charset=utf-8", method)
    probe = "artifact-etag" in q
    md_twin = REPORT_DIR / (rel[:-5] + ".md") if ext == ".html" else None
    # .md requested by a browser -> rendered page; .html whose source is newer .md -> fresh render
    render_from = None
    if ext == ".md" and full.is_file() and _wants_html(h, q) and not download:
        render_from = full
    elif ext == ".html" and md_twin is not None and md_twin.is_file():
        if not full.exists() or (is_kit_html(full) and md_twin.stat().st_mtime >= full.stat().st_mtime - 1):
            render_from = md_twin
    if render_from is not None:
        if public and not os.path.exists(str(render_from) + ".public") and not os.path.exists(str(full) + ".public"):
            return _send(h, 404, "not found\n", "text/plain; charset=utf-8", method)
        page, etag = render_md(render_from)
        if probe:
            return _send(h, 200, etag + "\n", "text/plain; charset=utf-8", method)
        page_name = rel if ext == ".html" else rel[:-3] + ".html"
        if download:
            return _serve_bytes(h, method, page, TYPES[".html"], etag, render_from.stat().st_mtime,
                                headers={"Content-Disposition": F.disposition("attachment", page_name.split("/")[-1])})
        page = inject_bridge(_md_footer(page, page_name, public), page_name, etag, public)
        return _serve_bytes(h, method, page, TYPES[".html"], etag, render_from.stat().st_mtime)
    if not full.is_file():
        return _send(h, 404, "no such artifact: %s\n" % rel, "text/plain; charset=utf-8", method)
    st = full.stat()
    etag = F.etag_for(st)
    if probe:
        return _send(h, 200, etag + "\n", "text/plain; charset=utf-8", method)
    kind = KIND.get(ext, "file" if ext not in (".html", ".htm") else "page")
    ctype = TYPES[ext]
    fname = rel.split("/")[-1]
    if download:
        return _serve_file(h, method, full, ctype, st, {"Content-Disposition": F.disposition("attachment", fname)})
    if "thumb" in q:
        t = F.thumb(STORE, rel, full, kind, ext, st)
        if t is None:
            return _send(h, 404, "no thumbnail\n", "text/plain; charset=utf-8", method)
        tst = t.stat()
        return _serve_bytes(h, method, t.read_bytes(), "image/webp", F.etag_for(tst), tst.st_mtime, cache="private, max-age=86400")
    meta = item_meta(rel)
    if _wants_view(h, q, kind):
        base = (PUBLIC_PREFIX if public else PREFIX) + quote(rel)
        k = kit()
        page = V.render(rel=rel, full=full, st=st, kind=kind, ext=ext, ctype=ctype, title=meta.get("title") or "",
                        description=meta.get("description") or "", base=base, versions=versions_of(rel), public=public,
                        kit_css=getattr(k, "CSS", "") if k else "", versions_url=V.versions_link(PREFIX, rel))
        page = inject_bridge(page, rel, etag, public)
        return _serve_bytes(h, method, page, TYPES[".html"], None)
    headers = {}
    if kind == "file":
        headers["Content-Disposition"] = F.disposition("attachment", fname)
    elif ext not in (".html", ".htm"):
        headers["Content-Disposition"] = F.disposition("inline", fname)
    if ext in F.ACTIVE_EXT or (ext in (".html", ".htm") and meta.get("sandbox")):
        # SVG and XML can carry script, and HTML listed from outside the artifacts folder is not ours:
        # rendered in an opaque origin without script, it can never act as the DSH origin.
        headers["Content-Security-Policy"] = F.SANDBOX_CSP
        return _serve_file(h, method, full, ctype, st, headers)
    if ext in (".html", ".htm"):
        # Pages inside an app directory share the app's identity (storage, inbox,
        # owner) so 'artifact state <app>' and the page agree on one name.
        top = rel.split("/")[0]
        bname = top if "/" in rel and top != MEDIA_DIR and (REPORT_DIR / top).is_dir() else rel
        return _serve_file(h, method, full, ctype, st, headers, transform=lambda d: inject_bridge(d, bname, etag, public))
    return _serve_file(h, method, full, ctype, st, headers)


def serve_lib(h, method, rel):
    rel = unquote(rel).strip("/")
    if not rel:
        manifest = VENDOR / "index.json"
        if manifest.is_file():
            return _serve_bytes(h, method, manifest.read_bytes(), TYPES[".json"], None)
        return _json(h, 200, {"libs": []}, method)
    parts = rel.split("/")
    if any(not p or p.startswith(".") for p in parts):
        return _send(h, 404, "not found\n", "text/plain", method)
    full = (VENDOR / rel).resolve()
    try:
        full.relative_to(VENDOR.resolve())
    except ValueError:
        return _send(h, 404, "not found\n", "text/plain", method)
    ext = os.path.splitext(rel)[1].lower()
    if not full.is_file() or ext not in TYPES:
        return _send(h, 404, "no such library file: %s\n" % rel, "text/plain", method)
    return _serve_bytes(h, method, full.read_bytes(), TYPES[ext], None, None, cache="public, max-age=3600")


# -- API ----------------------------------------------------------------------

def api(h, method, route, q):
    g = lambda k, d=None: (q.get(k) or [d])[0]
    if method in ("POST", "PUT", "DELETE"):
        if h.headers.get("X-Artifact-Api") != "1":
            return _json(h, 403, {"error": "missing X-Artifact-Api header"}, method)
    try:
        body = _read_body(h) if method in ("POST", "PUT") else {}
    except Exception as e:
        return _json(h, 400, {"error": str(e)}, method)
    b = lambda k, d=None: body.get(k, d)
    try:
        if route == "index":
            out = build_index(valid_session(g("session")), include_hidden=g("hidden") in ("1", "true"))
            if h.headers.get("If-None-Match") == '"%s"' % out["etag"]:
                h.send_response(304)
                h.send_header("ETag", '"%s"' % out["etag"])
                h.send_header("Content-Length", "0")
                h.end_headers()
                return True
            return _json(h, 200, out, method, {"ETag": '"%s"' % out["etag"]})

        if route == "info":
            rel = safe_rel(g("name"))
            if not rel:
                return _json(h, 400, {"error": "bad name"}, method)
            src = source_rel(rel)
            claims = all_claims()
            sess = []
            for n in {rel, src, rel.split("/")[0]}:
                for s in (claims.get(n) or {}).get("sessions", []):
                    if s not in sess:
                        sess.append(s)
            meta = F.state_for(F.listing(STORE), [rel, src]) or {}
            return _json(h, 200, {"name": rel, "source": src, "home": str(REPORT_DIR), "versions": versions_of(src),
                                  "sessions": sess, "public": os.path.exists(str(REPORT_DIR / rel) + ".public"),
                                  "storageKeys": len(_json_load(_state_path(rel), {})),
                                  "hidden": bool(meta.get("hidden")), "title": meta.get("title") or "",
                                  "description": meta.get("description") or "", "added": meta.get("added"),
                                  "sandbox": bool(meta.get("sandbox"))}, method)

        if route == "listing" and method == "POST":
            # de-list, list again, or set the title / description shown in the tab (the file is never touched)
            rel = safe_rel(b("name"))
            op = b("op")
            if not rel or op not in LISTING_OPS:
                return _json(h, 400, {"error": "need name and op (hide, show or meta)"}, method)
            if not (REPORT_DIR / rel).exists() and not (REPORT_DIR / source_rel(rel)).exists():
                return _json(h, 404, {"error": "no such artifact: %s" % rel}, method)
            entry = {"op": op, "name": rel, "how": "ui"}
            sess = valid_session(b("session"))
            if sess:
                entry["session"] = sess
            for k in ("title", "description"):
                if isinstance(b(k), str):
                    entry[k] = b(k)
            F.listing_append(STORE, entry)
            return _json(h, 200, {"ok": True, "name": rel, "op": op}, method)

        if route == "raw":
            rel = safe_rel(g("name"))
            vid = g("v")
            if not rel:
                return _json(h, 400, {"error": "bad name"}, method)
            src = source_rel(rel)
            data = version_bytes(src, vid) if vid else ((REPORT_DIR / src).read_bytes() if (REPORT_DIR / src).is_file() else None)
            if data is None:
                return _json(h, 404, {"error": "not found"}, method)
            if g("download") is not None:
                ext = os.path.splitext(src)[1].lower()
                stem, dot = os.path.splitext(src.split("/")[-1])
                fname = "%s.v%s%s" % (stem, vid, dot) if vid else src.split("/")[-1]
                return _serve_bytes(h, method, data, TYPES.get(ext, "application/octet-stream"), None,
                                    headers={"Content-Disposition": F.disposition("attachment", fname)})
            return _send(h, 200, data, "text/plain; charset=utf-8", method)

        if route == "diff":
            rel = safe_rel(g("name"))
            if not rel:
                return _json(h, 400, {"error": "bad name"}, method)
            src = source_rel(rel)
            vs = versions_of(src)
            bid = g("b") or (vs[-1]["id"] if vs else None)
            aid = g("a")
            if not aid:
                ids = [v["id"] for v in vs]
                i = ids.index(bid) if bid in ids else len(ids) - 1
                aid = ids[i - 1] if i > 0 else None
            if not aid or not bid:
                return _json(h, 200, {"diff": "", "note": "no earlier version"}, method)
            A = (version_bytes(src, aid) or b"").decode("utf-8", "replace").splitlines()
            B = (version_bytes(src, bid) or b"").decode("utf-8", "replace").splitlines()
            d = "\n".join(difflib.unified_diff(A, B, "v" + aid, "v" + bid, lineterm="", n=2))
            added = sum(1 for l in d.splitlines() if l.startswith("+") and not l.startswith("+++"))
            removed = sum(1 for l in d.splitlines() if l.startswith("-") and not l.startswith("---"))
            return _json(h, 200, {"a": aid, "b": bid, "diff": d[:400000], "added": added, "removed": removed}, method)

        if route == "restore" and method == "POST":
            rel = safe_rel(b("name"))
            vid = str(b("v") or "")
            if not rel:
                return _json(h, 400, {"error": "bad name"}, method)
            src = source_rel(rel)
            data = version_bytes(src, vid)
            if data is None:
                return _json(h, 404, {"error": "no such version"}, method)
            _atomic_write(REPORT_DIR / src, data)
            return _json(h, 200, {"ok": True, "restored": src, "v": vid}, method)

        if route == "public" and method == "POST":
            rel = safe_rel(b("name"))
            if not rel or "/" in rel:
                return _json(h, 400, {"error": "only top-level artifacts can be public"}, method)
            marker = Path(str(REPORT_DIR / rel) + ".public")
            names = [rel] + ([source_rel(rel)] if source_rel(rel) != rel else [])
            for n in names:
                m = Path(str(REPORT_DIR / n) + ".public")
                if b("on"):
                    m.touch()
                elif m.exists():
                    m.unlink()
            return _json(h, 200, {"ok": True, "public": marker.exists(),
                                  "url": PUBLIC_PREFIX + quote(rel)}, method)

        if route == "trash" and method == "POST":
            rel = safe_rel(b("name"))
            if not rel:
                return _json(h, 400, {"error": "bad name"}, method)
            it_files = [rel] + ([source_rel(rel)] if source_rel(rel) != rel else [])
            TRASH.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%d-%H%M%S")
            moved = []
            for n in it_files:
                p = REPORT_DIR / n
                if p.exists():
                    os.replace(p, TRASH / (stamp + "-" + n.replace("/", "__")))
                    moved.append(n)
            return _json(h, 200, {"ok": True, "trashed": moved}, method)

        if route == "storage":
            name = safe_rel(g("name") or b("name"))
            if not name:
                return _json(h, 400, {"error": "bad name"}, method)
            if method == "GET":
                if g("list") is not None:
                    return _json(h, 200, storage_op(name, "list", prefix=g("list") or ""), method)
                if g("key") is None:
                    return _json(h, 200, storage_op(name, "all"), method)
                return _json(h, 200, storage_op(name, "get", key=g("key")), method)
            key = b("key")
            if not isinstance(key, str) or not key or len(key) > 200:
                return _json(h, 400, {"error": "key must be a 1-200 char string"}, method)
            if b("delete"):
                return _json(h, 200, storage_op(name, "delete", key=key), method)
            return _json(h, 200, storage_op(name, "set", key=key, value=b("value")), method)

        if route == "send" and method == "POST":
            name = safe_rel(b("name")) or "artifact"
            session = valid_session(b("session")) or owner_session(name)
            text = str(b("text") or "").strip()
            mode = b("mode") or "submit"
            if not session:
                return _json(h, 400, {"error": "no chat to deliver to (artifact has no owning session)"}, method)
            if not text and mode != "context":
                return _json(h, 400, {"error": "empty message"}, method)
            if not session.startswith("session-") and len(session) >= 32:
                session_full = session
            else:
                session_full = session
            if mode == "context":
                inbox_add(session_full, {"kind": "context", "name": name, "text": text[:8000],
                                         "data": b("data")})
                return _json(h, 200, {"ok": True, "queued": True}, method)
            prefix = "[from artifact %s] " % name
            res = deliver_to_chat(session_full, prefix + text[:12000])
            return _json(h, 200, {"ok": True, "delivered": True, "result": res}, method)

        if route == "error" and method == "POST":
            name = safe_rel(b("name")) or "artifact"
            session = valid_session(b("session")) or owner_session(name)
            if session:
                inbox_add(session, {"kind": "error", "name": name, "text": str(b("message"))[:2000],
                                    "data": {"stack": str(b("stack") or "")[:3000], "where": b("where")}})
            return _json(h, 200, {"ok": True}, method)

        if route == "inbox":
            session = valid_session(g("session") or b("session"))
            if not session:
                return _json(h, 400, {"error": "bad session"}, method)
            if method == "POST" and b("clear"):
                try:
                    (INBOX / (session + ".jsonl")).unlink()
                except OSError:
                    pass
                return _json(h, 200, {"ok": True}, method)
            return _json(h, 200, {"items": inbox_read(session)}, method)

        if route == "claim" and method == "POST":
            rel = safe_rel(b("name"))
            if rel:
                add_claim(rel, b("session"), "ui")
            return _json(h, 200, {"ok": bool(rel)}, method)

        if route in ("ai", "media", "job", "capabilities"):
            import media  # noqa: lazy, so a media bug cannot break serving
            return media.handle(h, method, route, q, body, _json, add_claim, owner_session)

        return _json(h, 404, {"error": "unknown api route: %s" % route}, method)
    except Exception as e:
        log.exception("artifact api %s failed", route)
        return _json(h, 500, {"error": str(e)[:500]}, method)


# -- entry points used by the DSH proxy -----------------------------------------------

def init(get_token=None, spawn_indexer=True):
    global _get_token, _indexer
    if get_token:
        _get_token = get_token
    if str(HERE) not in sys.path:
        sys.path.insert(0, str(HERE))
    for d in (STORE, VERSIONS, STATE, INBOX):
        d.mkdir(parents=True, exist_ok=True)
    if spawn_indexer:
        try:
            errlog = open(STORE / "indexer.log", "ab")
            _indexer = subprocess.Popen(["nice", "-n", "15", sys.executable, str(HERE / "indexer.py")],
                                        stdout=errlog, stderr=errlog, stdin=subprocess.DEVNULL)
            log.info("dsh-artifacts indexer started (pid %s)", _indexer.pid)
        except Exception as e:
            log.error("could not start the artifact indexer: %s", e)


def split_download(rest):
    """(rel, download): "<name>/download" names the download of the file <name> (2.2)."""
    rel = safe_rel(rest)
    if rest.rstrip("/").endswith("/download"):
        parent = safe_rel(rest.rstrip("/")[: -len("/download")])
        if parent and not (REPORT_DIR / parent).is_dir():
            p = REPORT_DIR / parent
            if p.is_file() or (parent.endswith(".html") and (REPORT_DIR / (parent[:-5] + ".md")).is_file()):
                return parent, True
    return rel, False


def _deny(h, method):
    if method in ("GET", "HEAD"):
        token = _get_token()
        base = h.path.split("?")[0]
        h.send_response(302)
        h.send_header("Location", "%s?token=%s" % (base, token) if token else base)
        h.send_header("Content-Length", "0")
        h.end_headers()
        return True
    return _json(h, 401, {"error": "unauthorized"}, method)


def handle(h, method):
    """Answer a request under /report/ for the owner. False = not ours."""
    if not h.path.startswith(PREFIX):
        return False
    parts = urlsplit(h.path)
    rest = parts.path[len(PREFIX):]
    q = parse_qs(parts.query, keep_blank_values=True)
    is_api = rest.startswith("_api/")
    if not is_api and method not in ("GET", "HEAD"):
        return False  # legacy POST /report/<x>.json state route stays in the proxy
    if not h._authorized():
        return _deny(h, method)
    try:
        if is_api:
            return api(h, method, rest[5:], q)
        if rest.startswith("_lib/") or rest == "_lib":
            return serve_lib(h, method, rest[5:])
        if rest in ("", "/"):
            if "list" in q:
                out = build_index(valid_session((q.get("session") or [None])[0]))
                return _json(h, 200, out, method)
            return _send(h, 404, "not found\n", "text/plain", method)
        rel, dl = split_download(rest)
        if not rel:
            return _send(h, 404, "not found\n", "text/plain; charset=utf-8", method)
        return serve_path(h, method, rel, q, download=dl)
    except (BrokenPipeError, ConnectionResetError):
        return True
    except Exception as e:
        log.exception("artifact serve failed for %s", h.path)
        try:
            return _send(h, 500, "artifact server error: %s\n" % e, "text/plain", method)
        except Exception:
            return True


def handle_public(h, method):
    """GET/HEAD /report-public/<name>: marker-flagged artifacts only, no API."""
    if not h.path.startswith(PUBLIC_PREFIX):
        return False
    if method not in ("GET", "HEAD"):
        return _send(h, 405, "method not allowed\n", "text/plain", method)
    parts = urlsplit(h.path)
    rel, dl = split_download(parts.path[len(PUBLIC_PREFIX):])
    if not rel or "/" in rel:
        return _send(h, 404, "not found\n", "text/plain", method)
    q = parse_qs(parts.query, keep_blank_values=True)
    ok = os.path.exists(str(REPORT_DIR / rel) + ".public")
    if not ok and rel.endswith(".html"):
        ok = os.path.exists(str(REPORT_DIR / (rel[:-5] + ".md")) + ".public")
    if not ok:
        return _send(h, 404, "not found\n", "text/plain", method)
    try:
        return serve_path(h, method, rel, q, public=True, download=dl)
    except Exception:
        log.exception("public artifact serve failed")
        return _send(h, 500, "error\n", "text/plain", method)
