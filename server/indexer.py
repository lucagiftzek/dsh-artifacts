#!/usr/bin/env python3
"""dsh-artifacts indexer -- a small, niced background process.

Two jobs, both incremental and both cheap at steady state:

1. ATTRIBUTION. Which chat wrote which artifact. Every DSH transcript is an
   append-only zstd file where each flush is its own frame, so the indexer keeps
   a byte cursor per transcript and only ever decompresses the frames appended
   since the last pass. A write/edit/shell call that authors something under the
   artifact directory becomes a (name -> session) claim in registry.json.

   This replaces the v1 design (a full rescan of a chat's transcripts on every
   index request, keyed on the GLOBAL file list) which was both slow -- 10-100 s
   per chat -- and blind to 'tool/ptc-dispatch*' rows, whose 'arguments' are an
   object rather than a JSON string. Every write made from inside run_code
   lands in exactly that shape, so most chats showed "Nothing from this chat".

2. VERSIONS. Every time an artifact's bytes change, the new content is copied
   to .artifacts/versions/<quoted name>/<mtime_ns>. That gives undo, diffs and a
   version picker for free, whoever wrote the file (write tool, bash, a CLI).

It runs as a separate process (spawned by the DSH proxy, niced) so a backfill can
never starve the proxy's request threads through the GIL -- the failure mode
that took the proxy down on 2026-09-26.

Usage:  indexer.py [--once] [--no-parent-check]
"""
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

try:
    import zstandard as zstd
except Exception:  # pragma: no cover - attribution simply stays empty
    zstd = None

HOME = str(Path.home())
REPORT_DIR = Path(os.environ.get("ARTIFACT_DIR", os.path.join(HOME, "reports"))).resolve()
STORE = REPORT_DIR / ".artifacts"
SESSIONS_DIR = Path(os.environ.get("DSH_SESSIONS_DIR", os.path.join(HOME, ".dsh", "sessions")))
REGISTRY = STORE / "registry.json"
CURSORS = STORE / "cursors.json"
SNAPMETA = STORE / "snapmeta.json"
VERSIONS = STORE / "versions"

POLL_S = 2.0
BACKFILL_BUDGET_S = 0.6      # max transcript work per loop, so fresh writes stay prompt
KEEP_VERSIONS = 40
SNAP_MAX_BYTES = 1_500_000
TEXT_EXT = {".html", ".htm", ".md", ".txt", ".json", ".csv", ".svg", ".js", ".mjs",
            ".css", ".jsx", ".tsx", ".ts", ".py", ".sql", ".yaml", ".yml", ".xml"}

WRITE_TOOLS = {"write", "edit", "str_replace_editor", "create_file", "fs_write", "apply_patch",
               "multi_edit", "notebook_edit"}
SHELL_TOOLS = {"bash", "shell", "exec_command"}

_name = r"([A-Za-z0-9][A-Za-z0-9._@+,=-]*)"
PATH_RX = re.compile(r"(?:~|\$HOME|\$\{HOME\}|" + re.escape(HOME) + r")/reports/" + _name)
SHELL_VERB = re.compile(r"(?:^|[\s;&|(])(?:cp|mv|install|tee|rsync|dd|mkdir|unzip|tar|curl\s+-o|wget|ln)\b")
RENDER_RX = re.compile(r"(?:artifact-kit|artifact)\s+(?:render|new|media|image|tts|video|stt|publish|restore|music)\b")
WRITE_IDIOMS = ("write_text(", "write_bytes(", "to_csv(", "to_json(", "writelines(", "savefig(",
                "open(", "writeFile", "json.dump(", ".save(")


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, file=sys.stderr, flush=True)


def atomic_json(path, obj):
    tmp = str(path) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, separators=(",", ":"))
    os.replace(tmp, path)


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return default


# -- attribution -------------------------------------------------------------

def iter_calls(record):
    """(tool name, argument object-or-string) for every tool call in a record.

    Covers every shape seen in v2/v3 transcripts: tool/call (string args),
    tool/ptc-dispatch-start (OBJECT args -- the v1 blind spot), streaming
    block-end chunks and consolidated assistant/message content parts.
    """
    data = record.get("data") if isinstance(record, dict) else None
    if not isinstance(data, dict):
        return
    t = record.get("type") or ""
    if t.startswith("tool/result") or t == "tool/ptc-dispatch":
        return  # results are not authorship; ptc-dispatch duplicates -start
    if isinstance(data.get("name"), str) and "arguments" in data:
        yield data["name"], data["arguments"]
    chunk = data.get("chunk")
    if isinstance(chunk, dict):
        block = chunk.get("block")
        if isinstance(block, dict) and block.get("type") == "tool-call":
            yield block.get("name") or "", block.get("arguments")
    msg = data.get("message")
    if isinstance(msg, dict) and isinstance(msg.get("content"), list):
        for part in msg["content"]:
            if isinstance(part, dict) and part.get("type") == "tool-call":
                yield part.get("name") or "", part.get("arguments")


def as_obj(args):
    if isinstance(args, (dict, list)):
        return args
    if isinstance(args, str):
        try:
            return json.loads(args)
        except Exception:
            return args
    return None


def leaves(v, out, depth=0):
    if depth > 6 or len(out) > 64:
        return out
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, dict):
        for x in v.values():
            leaves(x, out, depth + 1)
    elif isinstance(v, list):
        for x in v:
            leaves(x, out, depth + 1)
    return out


def shell_claims(text):
    """Report names a shell command plausibly CREATES (not merely reads)."""
    names = set(PATH_RX.findall(text))
    if not names:
        return set()
    if RENDER_RX.search(text) or "publish-artifact" in text:
        out = set(names)
        for n in names:  # 'artifact-kit render x.md' writes x.html too
            if n.endswith(".md"):
                out.add(n[:-3] + ".html")
        return out
    hit = set()
    verb = bool(SHELL_VERB.search(text))
    for n in names:
        if verb:
            hit.add(n)
            continue
        for idiom in WRITE_IDIOMS:
            i = text.find(idiom)
            while i >= 0:
                if n in text[max(0, i - 300):i + 300]:
                    hit.add(n)
                    break
                i = text.find(idiom, i + 1)
            if n in hit:
                break
        if n in hit:
            continue
        at = 0
        while True:  # redirection whose target is the artifact itself
            i = text.find(">", at)
            if i < 0:
                break
            at = i + 1
            if i and text[i - 1] in "&-=2":
                continue
            if n in text[i + 1:i + 220].split(";")[0].split("|")[0].split("\n")[0]:
                hit.add(n)
                break
    return hit


def claims_in_line(raw):
    try:
        rec = json.loads(raw)
    except Exception:
        return set(), None
    found = set()
    for tool, args in iter_calls(rec):
        tool = (tool or "").split("__")[-1]
        obj = as_obj(args)
        if tool in WRITE_TOOLS:
            paths = []
            if isinstance(obj, dict):
                for k in ("file_path", "path", "filename", "target"):
                    if isinstance(obj.get(k), str):
                        paths.append(obj[k])
            for p in paths:
                found |= set(PATH_RX.findall(p))
        elif tool in SHELL_TOOLS:
            text = "\n".join(leaves(obj, [])) if not isinstance(obj, str) else obj
            found |= shell_claims(text)
    found = {n for n in found if not n.startswith(".")}
    return found, rec.get("time")


def read_header(path):
    if zstd is None:
        return None
    try:
        with open(path, "rb") as fh:
            blob = zstd.ZstdDecompressor().stream_reader(fh, read_across_frames=True).read(1 << 16)
        return json.loads(blob.split(b"\n")[0])
    except Exception:
        return None


class Attributor:
    def __init__(self):
        self.cursors = load_json(CURSORS, {})
        reg = load_json(REGISTRY, {})
        self.artifacts = reg.get("artifacts", {})
        self.parents = reg.get("parents", {})
        self.dirty = False
        self.cur_dirty = False
        self.dctx = zstd.ZstdDecompressor() if zstd else None

    def transcripts(self):
        out = []
        for d in SESSIONS_DIR.glob("*/*"):
            for name in ("session.v3.jsonl.zstd", "session.jsonl.zstd"):
                p = d / name
                try:
                    st = p.stat()
                except OSError:
                    continue
                out.append((st.st_mtime, st.st_size, str(p), str(d)))
        out.sort(reverse=True)  # newest first: live chats stay prompt during a backfill
        return out

    def claim(self, name, sid, ts):
        a = self.artifacts.setdefault(name, {"sessions": [], "first": ts, "last": ts})
        if sid not in a["sessions"]:
            a["sessions"].append(sid)
            self.dirty = True
        if ts and (not a.get("last") or ts > a["last"]):
            a["last"] = ts
            self.dirty = True

    def step(self, budget_s):
        if self.dctx is None:
            return False
        t0 = time.time()
        more = False
        for mtime, size, path, d in self.transcripts():
            cur = self.cursors.get(path) or {}
            if cur.get("size") == size and cur.get("mtime") == mtime:
                continue
            if time.time() - t0 > budget_s:
                more = True
                break
            sid = os.path.basename(d)
            if path.endswith("session.v3.jsonl.zstd") and sid not in self.parents:
                head = read_header(path) or {}
                par = head.get("parentSession")
                self.parents[sid] = par if isinstance(par, str) else None
                self.dirty = True
            done = self.consume(path, sid, cur, size, t0, budget_s)
            if done:
                cur["mtime"], cur["size"] = mtime, size
            self.cursors[path] = cur
            self.cur_dirty = True
            if not done:
                more = True
                break
        return more

    def consume(self, path, sid, cur, size, t0, budget_s):
        """Decompress whole frames from the cursor on. True when caught up."""
        off = cur.get("off", 0)
        if size < off:
            off = 0
        try:
            fh = open(path, "rb")
        except OSError:
            return True
        with fh:
            fh.seek(off)
            carry = b""
            data = fh.read(4 << 20)
            pos = 0
            while pos < len(data):
                dobj = self.dctx.decompressobj()
                try:
                    out = dobj.decompress(data[pos:])
                except Exception:
                    # Corrupt frame. Skip the rest of this file rather than
                    # spinning on it forever.
                    log("corrupt frame, skipping rest of", path)
                    cur["off"] = size
                    return True
                if not dobj.eof:
                    more = fh.read(4 << 20)
                    if not more:
                        break  # torn tail (writer mid-flush): stop here, retry later
                    data = data[pos:] + more
                    pos = 0
                    continue
                used = len(data) - pos - len(dobj.unused_data)
                pos += used
                off += used
                carry += out
                if b"\n" in carry:
                    *lines, carry = carry.split(b"\n")
                    for raw in lines:
                        if b"reports/" in raw:
                            names, ts = claims_in_line(raw)
                            for n in names:
                                self.claim(n, sid, ts)
                if pos >= len(data):
                    data = fh.read(4 << 20)
                    pos = 0
                if time.time() - t0 > budget_s * 4:
                    break
            if carry and b"reports/" in carry:
                names, ts = claims_in_line(carry)
                for n in names:
                    self.claim(n, sid, ts)
        cur["off"] = off
        return off >= size

    def flush(self):
        if self.dirty:
            atomic_json(REGISTRY, {"updated": time.time(), "artifacts": self.artifacts,
                                   "parents": self.parents})
            self.dirty = False
        if self.cur_dirty:
            atomic_json(CURSORS, self.cursors)
            self.cur_dirty = False


# -- versions ----------------------------------------------------------------

def vdir(rel):
    return VERSIONS / quote(rel, safe="")


def iter_artifact_files():
    try:
        top = list(os.scandir(REPORT_DIR))
    except OSError:
        return
    for e in top:
        if e.name.startswith("."):
            continue
        if e.is_file(follow_symlinks=False):
            yield e.name, e
        elif e.is_dir(follow_symlinks=False):
            try:
                for f in os.scandir(e.path):
                    if f.name.startswith(".") or f.name == "node_modules":
                        continue
                    if f.is_file(follow_symlinks=False):
                        yield e.name + "/" + f.name, f
            except OSError:
                continue


class Versioner:
    def __init__(self):
        self.meta = load_json(SNAPMETA, {})
        self.dirty = False

    def step(self):
        seen = set()
        for rel, entry in iter_artifact_files():
            ext = os.path.splitext(rel)[1].lower()
            if ext not in TEXT_EXT:
                continue
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            if st.st_size > SNAP_MAX_BYTES:
                continue
            seen.add(rel)
            m = self.meta.get(rel)
            if m and m[0] == st.st_mtime_ns:
                continue
            try:
                data = Path(entry.path).read_bytes()
            except OSError:
                continue
            digest = hashlib.sha1(data).hexdigest()[:16]
            if m and m[1] == digest:
                self.meta[rel] = [st.st_mtime_ns, digest]
                self.dirty = True
                continue
            d = vdir(rel)
            try:
                d.mkdir(parents=True, exist_ok=True)
                tmp = d / (".%d.tmp" % st.st_mtime_ns)
                tmp.write_bytes(data)
                os.replace(tmp, d / str(st.st_mtime_ns))
                snaps = sorted((p for p in d.iterdir() if p.name.isdigit()), key=lambda p: int(p.name))
                for old in snaps[:-KEEP_VERSIONS]:
                    old.unlink(missing_ok=True)
            except OSError as e:
                log("snapshot failed", rel, e)
                continue
            self.meta[rel] = [st.st_mtime_ns, digest]
            self.dirty = True
        for rel in list(self.meta):
            if rel not in seen and not (REPORT_DIR / rel).exists():
                del self.meta[rel]  # the versions dir is kept: deleted artifacts stay restorable
                self.dirty = True

    def flush(self):
        if self.dirty:
            atomic_json(SNAPMETA, self.meta)
            self.dirty = False


def main(argv):
    once = "--once" in argv
    parent_check = "--no-parent-check" not in argv and not once
    ppid = os.getppid()
    STORE.mkdir(parents=True, exist_ok=True)
    VERSIONS.mkdir(parents=True, exist_ok=True)
    (STORE / "indexer.pid").write_text(str(os.getpid()))
    attr = Attributor()
    ver = Versioner()
    log("indexer up; report dir", REPORT_DIR)
    while True:
        if parent_check and os.getppid() != ppid:
            log("parent gone; exiting")
            return
        t0 = time.time()
        try:
            ver.step()
            ver.flush()
        except Exception as e:  # never die on one bad file
            log("versioner error", e)
        more = False
        try:
            more = attr.step(BACKFILL_BUDGET_S if not once else 3600)
            attr.flush()
        except Exception as e:
            log("attributor error", e)
        if once and not more:
            log("once: done in %.1fs" % (time.time() - t0))
            return
        time.sleep(0.2 if more else POLL_S)


if __name__ == "__main__":
    main(sys.argv[1:])
