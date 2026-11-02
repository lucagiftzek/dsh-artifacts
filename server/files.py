"""dsh-artifacts: files, listing state, HTTP byte serving, thumbnails and media metadata.

Used by artifacts_server.py (the module dsh-proxy imports). Everything here is small and synchronous except
the thumbnail and probe helpers, which run ffmpeg, ffprobe or pdftoppm as niced child processes with a
timeout and at most two at a time.

Listing state (2.2): ~/reports/.artifacts/listing.jsonl, append only, one JSON object per line:

  {"op": "hide", "name": N, "time": ms, "session": S}          de-list (the file stays, versions stay)
  {"op": "show", "name": N, ...}                               list again
  {"op": "meta", "name": N, "title": T, "description": D}      title / description ("" clears, absent keeps)
  {"op": "add",  "name": N, "from": P, "mode": "copy"|"link", "sandbox": bool, "title"?, "description"?}

The node half (lib/listing.js: agent tools and CLI) appends to the same file. Append only keeps two writers
(this process and dsh web) safe without a lock; readers fold the lines in order.
"""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from email.utils import formatdate, parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote


def _env_int(name, default):
    try:
        v = int(os.environ.get(name, "") or default)
        return v if v >= 0 else default
    except ValueError:
        return default


# Limits (environment of dsh-proxy; the node half reads the same names)
PREVIEW_BYTES = _env_int("ARTIFACT_PREVIEW_KB", 512) * 1024      # text read for CSV/JSON/text previews
PREVIEW_ROWS = _env_int("ARTIFACT_PREVIEW_ROWS", 200)
HASH_MAX = _env_int("ARTIFACT_HASH_MAX_MB", 1024) * 1048576       # sha256 shown for files up to this size
THUMB_MAX = _env_int("ARTIFACT_THUMB_MAX_MB", 200) * 1048576      # images / PDFs larger than this get no thumbnail
THUMBS_ON = os.environ.get("ARTIFACT_THUMBS", "1") != "0"
INLINE_MAX = 8_000_000                                            # above this, files are streamed from disk

# Types whose raw bytes could run script if a browser rendered them on our origin: always sandboxed.
ACTIVE_EXT = {".svg", ".xml"}
SANDBOX_CSP = ("sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; "
               "font-src data:; media-src 'self' data: blob:")


# -- listing state -------------------------------------------------------------------------------------------

_listing_cache = {"sig": None, "val": {}}
_listing_lock = threading.Lock()


def listing_path(store):
    return Path(store) / "listing.jsonl"


def fold_listing(lines):
    """Fold listing ops (iterable of dicts) into {name: {hidden, title, description, added, sandbox, time}}."""
    out = {}
    for c in lines:
        if not isinstance(c, dict):
            continue
        n, op = c.get("name"), c.get("op")
        if not isinstance(n, str) or not n or op not in ("hide", "show", "meta", "add"):
            continue
        s = out.setdefault(n, {"hidden": False, "title": "", "description": "", "added": None, "sandbox": False, "time": 0})
        s["time"] = c.get("time") or s["time"]
        if op == "hide":
            s["hidden"] = True
        elif op == "show":
            s["hidden"] = False
        elif op == "add":
            s["hidden"] = False
            if c.get("from") or not s["added"]:  # an in-place re-list keeps where the file came from
                s["added"] = {"from": c.get("from"), "mode": c.get("mode"), "time": c.get("time"), "session": c.get("session")}
            if c.get("from"):
                s["sandbox"] = bool(c.get("sandbox"))
        if op in ("meta", "add"):
            for k in ("title", "description"):
                v = c.get(k)
                if isinstance(v, str):
                    s[k] = v[:300] if k == "title" else v[:2000]
    return out


def listing(store):
    """The folded listing state, cached on the file's mtime and size."""
    p = listing_path(store)
    try:
        st = p.stat()
        sig = (st.st_mtime_ns, st.st_size)
    except OSError:
        return {}
    if sig == _listing_cache["sig"]:
        return _listing_cache["val"]
    rows = []
    try:
        with open(p, encoding="utf-8") as fh:
            for line in fh:
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        return {}
    val = fold_listing(rows)
    _listing_cache.update(sig=sig, val=val)
    return val


def listing_append(store, entry):
    entry = dict(entry)
    entry.setdefault("time", int(time.time() * 1000))
    line = json.dumps(entry, ensure_ascii=False)
    Path(store).mkdir(parents=True, exist_ok=True)
    with _listing_lock:
        with open(listing_path(store), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    return entry


def state_for(lst, names):
    """Listing state for an item: the first of its names that has one (item name, source, files)."""
    for n in names:
        if n and n in lst:
            return lst[n]
    return None


# -- HTTP helpers -------------------------------------------------------------------------------------------

def parse_range(value, total):
    """One byte range. None = no usable Range (send 200), False = unsatisfiable (416), else (start, end)."""
    if not value or not value.startswith("bytes="):
        return None
    spec = value[6:].split(",")[0].strip()
    if "-" not in spec:
        return None
    a, b = spec.split("-", 1)
    a, b = a.strip(), b.strip()
    try:
        if a == "":
            if not b:
                return None
            n = int(b)
            if n <= 0 or total == 0:
                return False
            return (max(0, total - n), total - 1)
        start = int(a)
        end = int(b) if b else total - 1
    except ValueError:
        return None
    if start < 0 or (b and end < start):
        return None
    if start >= total:
        return False
    return (start, min(end, total - 1))


def disposition(kind, filename):
    """Content-Disposition with an ASCII fallback and the RFC 5987 UTF-8 name."""
    base = os.path.basename(filename) or "download"
    ascii_name = re.sub(r'[^A-Za-z0-9._ ()+,-]', "_", base)[:180] or "download"
    return '%s; filename="%s"; filename*=UTF-8\'\'%s' % (kind, ascii_name, quote(base, safe=""))


def etag_for(st):
    return '"%x-%x"' % (st.st_mtime_ns, st.st_size)


def _if_range_ok(h, etag, mtime):
    v = h.headers.get("If-Range")
    if not v:
        return True
    if v.startswith('"') or v.startswith("W/"):
        return v == etag
    try:
        return int(parsedate_to_datetime(v).timestamp()) >= int(mtime)
    except (TypeError, ValueError):
        return False


def _not_modified(h, etag):
    inm = h.headers.get("If-None-Match")
    return bool(etag and inm and etag in [x.strip() for x in inm.split(",")])


def send_content(h, method, ctype, *, data=None, path=None, size=None, etag=None, mtime=None, cache="no-store",
                 headers=None):
    """Answer with bytes (data) or a file streamed from disk (path + size): Range, If-Range, 304, nosniff.

    Every response carries Accept-Ranges and X-Content-Type-Options; extra headers (Content-Disposition, CSP)
    are added to 200, 206, 304 and 416 alike.
    """
    total = len(data) if data is not None else int(size or 0)
    extra = dict(headers or {})

    def head(code, length, more=None):
        h.send_response(code)
        h.send_header("Content-Type", ctype)
        h.send_header("Content-Length", str(length))
        h.send_header("Accept-Ranges", "bytes")
        h.send_header("Cache-Control", cache)
        h.send_header("X-Content-Type-Options", "nosniff")
        if etag:
            h.send_header("ETag", etag)
        if mtime:
            h.send_header("Last-Modified", formatdate(mtime, usegmt=True))
        for k, v in list(extra.items()) + list((more or {}).items()):
            h.send_header(k, v)
        h.end_headers()

    if _not_modified(h, etag) and not h.headers.get("Range"):
        head(304, 0)
        return True
    rng = parse_range(h.headers.get("Range"), total) if _if_range_ok(h, etag, mtime) else None
    if rng is False:
        head(416, 0, {"Content-Range": "bytes */%d" % total})
        return True
    start, end = rng if rng else (0, total - 1)
    length = max(0, end - start + 1)
    if rng:
        head(206, length, {"Content-Range": "bytes %d-%d/%d" % (start, end, total)})
    else:
        head(200, total)
    if method == "HEAD" or length == 0:
        return True
    try:
        if data is not None:
            h.wfile.write(data[start:end + 1])
        else:
            with open(path, "rb") as fh:
                fh.seek(start)
                left = length
                while left > 0:
                    chunk = fh.read(min(1 << 20, left))
                    if not chunk:
                        break
                    h.wfile.write(chunk)
                    left -= len(chunk)
    except (BrokenPipeError, ConnectionResetError):
        pass
    return True


# -- checksums, probing, thumbnails -------------------------------------------------------------------------

_hash_cache = {}
_probe_cache = {}
_slots = threading.BoundedSemaphore(2)


def sha256_of(path, st):
    """Hex sha256 of a file up to HASH_MAX bytes (cached on mtime and size), else None."""
    if st.st_size > HASH_MAX:
        return None
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _hash_cache:
        return _hash_cache[key]
    h = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    if len(_hash_cache) > 500:
        _hash_cache.clear()
    _hash_cache[key] = h.hexdigest()
    return _hash_cache[key]


def _run(cmd, timeout):
    if not _slots.acquire(timeout=timeout):
        return None
    try:
        return subprocess.run(["nice", "-n", "15"] + cmd, capture_output=True, timeout=timeout, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError):
        return None
    finally:
        _slots.release()


def probe(path, st):
    """Media facts from ffprobe: duration (s), width, height, video and audio codec. {} when unknown."""
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _probe_cache:
        return _probe_cache[key]
    out = {}
    r = _run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)], 20)
    if r is not None and r.returncode == 0:
        try:
            j = json.loads(r.stdout.decode("utf-8", "replace") or "{}")
            fmt = j.get("format") or {}
            if fmt.get("duration"):
                out["duration"] = round(float(fmt["duration"]), 2)
            for s in j.get("streams") or []:
                if s.get("codec_type") == "video" and "width" not in out:
                    out["width"], out["height"] = s.get("width"), s.get("height")
                    out["video_codec"] = s.get("codec_name")
                elif s.get("codec_type") == "audio" and "audio_codec" not in out:
                    out["audio_codec"] = s.get("codec_name")
        except (ValueError, TypeError):
            out = {}
    if len(_probe_cache) > 500:
        _probe_cache.clear()
    _probe_cache[key] = out
    return out


THUMB_KINDS = {"image", "video", "audio", "pdf"}
THUMB_VERSION = "w2"  # part of the cache key: bump when the generators change
RASTER_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".tif", ".tiff"}


def thumb(store, rel, full, kind, ext, st):
    """Path of a cached WebP thumbnail (generated on first request), or None when there is none."""
    if not THUMBS_ON or kind not in THUMB_KINDS or (kind == "image" and ext not in RASTER_EXT):
        return None
    if kind in ("image", "pdf") and st.st_size > THUMB_MAX:
        return None
    d = Path(store) / "thumbs"
    stem = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:20] + "-%x-%x-%s" % (st.st_mtime_ns, st.st_size, THUMB_VERSION)
    out = d / (stem + ".webp")
    fail = d / (stem + ".fail")
    if out.is_file():
        return out
    if fail.exists():
        return None
    with _locks_guard:
        lk = _gen_locks.setdefault(stem, threading.Lock())
    with lk:
        try:
            if out.is_file():
                return out
            if fail.exists():
                return None
            return _generate(d, stem, out, fail, full, kind, st)
        finally:
            with _locks_guard:
                _gen_locks.pop(stem, None)


_gen_locks = {}
_locks_guard = threading.Lock()


def _generate(d, stem, out, fail, full, kind, st):
    d.mkdir(parents=True, exist_ok=True)
    for old in d.glob(stem.split("-")[0] + "-*"):
        try:
            old.unlink()
        except OSError:
            pass
    tmp = d / (stem + ".tmp-%d-%d.webp" % (os.getpid(), threading.get_ident()))
    src = str(full)
    if kind == "image":
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", src, "-frames:v", "1",
               "-vf", "scale='min(480,iw)':-2:flags=lanczos", "-c:v", "libwebp", "-quality", "80", str(tmp)]
    elif kind == "video":
        dur = probe(full, st).get("duration") or 0
        at = "%.2f" % (min(1.0, dur / 3) if dur else 0)
        cmd = ["ffmpeg", "-v", "error", "-y", "-ss", at, "-i", src, "-frames:v", "1",
               "-vf", "scale='min(640,iw)':-2", "-c:v", "libwebp", "-quality", "78", str(tmp)]
    elif kind == "audio":
        cmd = ["ffmpeg", "-v", "error", "-y", "-t", "1800", "-i", src, "-filter_complex",
               "aformat=channel_layouts=mono,showwavespic=s=960x160:colors=0xc1553a:scale=sqrt:filter=peak", "-frames:v", "1",
               "-c:v", "libwebp", "-lossless", "1", str(tmp)]
    else:  # pdf: first page through pdftoppm, then to WebP
        png = d / (stem + ".tmp-%d-%d" % (os.getpid(), threading.get_ident()))
        r = _run(["pdftoppm", "-png", "-f", "1", "-l", "1", "-scale-to", "640", "-singlefile", src, str(png)], 60)
        pngf = Path(str(png) + ".png")
        if r is None or r.returncode != 0 or not pngf.is_file():
            fail.touch()
            return None
        cmd = ["ffmpeg", "-v", "error", "-y", "-i", str(pngf), "-c:v", "libwebp", "-quality", "80", str(tmp)]
        r = _run(cmd, 60)
        try:
            pngf.unlink()
        except OSError:
            pass
        return _finish(r, tmp, out, fail)
    return _finish(_run(cmd, 90), tmp, out, fail)


def _finish(r, tmp, out, fail):
    if r is not None and r.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
        os.replace(tmp, out)
        return out
    try:
        tmp.unlink()
    except OSError:
        pass
    if r is not None:  # a real failure, not a busy slot: do not retry this version
        fail.touch()
    return None
