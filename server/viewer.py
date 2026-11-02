"""dsh-artifacts: the enclosure, a themed page around one media or file artifact.

Same look as a Markdown artifact (the artifact-kit CSS, header, brand line and meta bar), with the content in
a proper viewer: image (SVG only ever as <img>), video and audio players (poster and waveform from the
thumbnail), PDF in the browser's viewer, CSV/TSV/JSON/JSONL as a table or pretty text, the first lines of text
and code, the entry list of archives and Office files (text of a .docx, first rows of an .xlsx) and, for
everything, a details card (name, size, type, modified, sha256, media facts), a download button and the
version history with per-version downloads.

Every value that reaches the page is escaped; nothing from the file is ever inserted as markup.
"""
import csv
import html
import io
import json
import re
import tarfile
import time
import zipfile
from urllib.parse import quote

import files as F

esc = lambda s: html.escape(str(s if s is not None else ""), quote=True)

EXTRA_CSS = """
.enc{margin:8px 0 18px;background:var(--panel);border:1px solid var(--line);padding:12px;display:flex;justify-content:center;align-items:center;min-height:120px;overflow:auto}
.enc img{max-width:100%;max-height:78vh;margin:0;object-fit:contain;background:repeating-conic-gradient(rgba(128,128,128,.12) 0 25%,transparent 0 50%) 0 0/16px 16px;cursor:zoom-in}
.enc img.full{max-width:none;max-height:none;cursor:zoom-out}
.enc video{width:100%;max-height:78vh;background:#000}
.enc.audio{flex-direction:column;align-items:stretch;gap:10px}.enc.audio img{width:100%;height:120px;object-fit:fill;background:none;cursor:default}.enc audio{width:100%}
.enc.pdf{padding:0;min-height:0}.enc.pdf iframe{width:100%;height:82vh;border:0;background:#fff}
.enc.text{display:block;padding:0}.enc pre{margin:0;border:0;max-height:78vh;counter-reset:ln}
.enc pre span.l{display:block}.enc pre span.l::before{counter-increment:ln;content:counter(ln);display:inline-block;width:4ch;margin-right:12px;text-align:right;color:var(--muted);opacity:.6;user-select:none}
.enc.table{display:block;padding:0}.enc .tw{margin:0;max-height:78vh;overflow:auto}.enc table{font-size:13px}.enc th{position:sticky;top:0;background:var(--panel);cursor:default}
.enc.card{display:block;min-height:0}.enc.card .enc-big{font:600 13px ui-monospace,monospace;color:var(--accent);letter-spacing:.06em;text-transform:uppercase}
.enc-bar{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.enc-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;padding:6px 14px;font:600 14px system-ui,sans-serif;text-decoration:none;border-radius:4px}
.enc-btn.ghost{background:transparent;color:var(--accent)}
.enc-note{color:var(--muted);font-size:13px;margin:6px 0}
dl.enc-facts{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:8px 0;font-size:14px}dl.enc-facts dt{color:var(--muted)}dl.enc-facts dd{margin:0;overflow-wrap:anywhere}
dl.enc-facts code{font-size:12px}
ol.enc-vers{padding-left:22px;font-size:14px}ol.enc-vers li{margin:2px 0}
footer{margin-top:40px;color:var(--muted);font-size:12px}
"""

KIND_WORD = {"image": "image", "video": "video", "audio": "audio", "pdf": "pdf", "data": "data", "code": "code",
             "file": "file", "doc": "document", "page": "page"}


def fmt_size(n):
    n = int(n or 0)
    if n < 1024:
        return "%d B" % n
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024.0
        if n < 1024 or unit == "TB":
            return ("%.1f %s" % (n, unit)).replace(".0 ", " ")
    return str(n)


def fmt_dur(s):
    s = int(round(float(s or 0)))
    return "%d:%02d:%02d" % (s // 3600, s % 3600 // 60, s % 60) if s >= 3600 else "%d:%02d" % (s // 60, s % 60)


def _read_head(path, limit):
    with open(path, "rb") as fh:
        data = fh.read(limit + 1)
    return data[:limit], len(data) > limit


def _table(rows, note):
    if not rows:
        return '<p class="enc-note">Empty file.</p>'
    width = max(len(r) for r in rows)
    head = rows[0] + [""] * (width - len(rows[0]))
    out = ['<div class="tw"><table><thead><tr>', "".join("<th>%s</th>" % esc(c) for c in head), "</tr></thead><tbody>"]
    for r in rows[1:]:
        out.append("<tr>" + "".join("<td>%s</td>" % esc(c) for c in r + [""] * (width - len(r))) + "</tr>")
    out.append("</tbody></table></div>")
    return '<div class="enc table">%s</div>%s' % ("".join(out), note)


def _pre(text, note=""):
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    body = "".join('<span class="l">%s</span>' % (esc(l) or " ") for l in lines)
    return '<div class="enc text"><pre><code>%s</code></pre></div>%s' % (body, note)


def _flat_dicts(rows):
    if not rows or not all(isinstance(r, dict) for r in rows):
        return None
    keys = []
    for r in rows:
        for k, v in r.items():
            if isinstance(v, (dict, list)):
                return None
            if k not in keys:
                keys.append(k)
            if len(keys) > 40:
                return None
    return [keys] + [["" if r.get(k) is None else str(r.get(k)) for k in keys] for r in rows]


def preview_data(full, ext, st):
    data, cut = _read_head(full, F.PREVIEW_BYTES)
    text = data.decode("utf-8", "replace")
    more = " (first %s of %s)" % (fmt_size(len(data)), fmt_size(st.st_size)) if cut else ""
    if ext in (".csv", ".tsv"):
        rows = []
        try:
            lines = text.splitlines()
            if cut and lines:
                lines = lines[:-1]  # the last line may be cut in the middle
            for r in csv.reader(io.StringIO("\n".join(lines)), delimiter="\t" if ext == ".tsv" else ","):
                rows.append(r)
                if len(rows) > F.PREVIEW_ROWS:
                    break
        except csv.Error:
            return _pre(text[:200000])
        shown = len(rows) - 1
        note = '<p class="enc-note">%d row%s shown%s%s.</p>' % (
            max(0, min(shown, F.PREVIEW_ROWS)), "" if shown == 1 else "s",
            ", more in the file" if (cut or shown > F.PREVIEW_ROWS) else "", more)
        return _table(rows[:F.PREVIEW_ROWS + 1], note)
    if ext in (".json", ".ipynb", ".map", ".geojson") and not cut:
        try:
            obj = json.loads(text)
        except ValueError:
            return _pre(text, '<p class="enc-note">Not valid JSON; shown as text.</p>')
        table = _flat_dicts(obj[:F.PREVIEW_ROWS]) if isinstance(obj, list) else None
        pretty = json.dumps(obj, indent=2, ensure_ascii=False)
        if table:
            return _table(table, '<p class="enc-note">%d of %d records.</p>' % (len(table) - 1, len(obj))) + \
                "<details><summary>JSON</summary>" + _pre(pretty[:400000]) + "</details>"
        return _pre(pretty[:400000], '<p class="enc-note">Pretty printed%s.</p>' % (", cut at 400 KB" if len(pretty) > 400000 else ""))
    if ext in (".jsonl", ".ndjson"):
        recs = []
        for line in text.splitlines()[: F.PREVIEW_ROWS]:
            try:
                recs.append(json.loads(line))
            except ValueError:
                recs = None
                break
        table = _flat_dicts(recs) if recs else None
        if table:
            return _table(table, '<p class="enc-note">First %d records%s.</p>' % (len(table) - 1, more))
    lines = text.split("\n")
    note = '<p class="enc-note">First %d lines%s.</p>' % (min(len(lines), 2000), more) if (cut or len(lines) > 2000) else ""
    return _pre("\n".join(lines[:2000]), note)


def _xml_text(blob, limit=6000):
    t = re.sub(rb"</w:p>", b"\n", blob)
    t = re.sub(rb"<[^>]+>", b"", t)
    return html.unescape(t.decode("utf-8", "replace"))[:limit]


def preview_archive(full, ext, st):
    """Entry list of zip and tar files; text of a .docx; first rows of an .xlsx. '' when not cheap."""
    try:
        if zipfile.is_zipfile(full):
            with zipfile.ZipFile(full) as z:
                infos = z.infolist()
                parts = []
                if ext in (".docx", ".odt") or (ext == ".docx"):
                    member = "word/document.xml" if ext == ".docx" else "content.xml"
                    if member in z.namelist() and z.getinfo(member).file_size < 20_000_000:
                        txt = _xml_text(z.read(member)).strip()
                        if txt:
                            parts.append("<h2>Text</h2>" + _pre(txt, '<p class="enc-note">Text only, first 6000 characters.</p>'))
                if ext == ".xlsx" and "xl/worksheets/sheet1.xml" in z.namelist():
                    rows = _xlsx_rows(z)
                    if rows:
                        parts.append("<h2>First sheet</h2>" + _table(rows, '<p class="enc-note">First %d rows, values only.</p>' % len(rows)))
                rows = [["Entry", "Size"]] + [[i.filename, fmt_size(i.file_size)] for i in infos[:F.PREVIEW_ROWS]]
                parts.append("<h2>Contents</h2>" + _table(rows, '<p class="enc-note">%d entr%s%s.</p>' % (
                    len(infos), "y" if len(infos) == 1 else "ies", ", first %d shown" % F.PREVIEW_ROWS if len(infos) > F.PREVIEW_ROWS else "")))
                return "".join(parts)
        if ext in (".tar", ".tgz", ".gz", ".bz2", ".xz") and tarfile.is_tarfile(full):
            rows = [["Entry", "Size"]]
            with tarfile.open(full, "r:*") as t:
                for i, m in enumerate(t):
                    if i >= F.PREVIEW_ROWS:
                        break
                    rows.append([m.name + ("/" if m.isdir() else ""), "" if m.isdir() else fmt_size(m.size)])
            return "<h2>Contents</h2>" + _table(rows, '<p class="enc-note">First %d entries.</p>' % (len(rows) - 1))
    except Exception:  # noqa: BLE001 - a broken archive just gets no preview
        return ""
    return ""


def _xlsx_rows(z, limit=50):
    import xml.etree.ElementTree as ET
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    shared = []
    try:
        if "xl/sharedStrings.xml" in z.namelist() and z.getinfo("xl/sharedStrings.xml").file_size < 30_000_000:
            for si in ET.fromstring(z.read("xl/sharedStrings.xml")).iter(ns + "si"):
                shared.append("".join(t.text or "" for t in si.iter(ns + "t")))
        if z.getinfo("xl/worksheets/sheet1.xml").file_size > 30_000_000:
            return []
        rows = []
        for r in ET.fromstring(z.read("xl/worksheets/sheet1.xml")).iter(ns + "row"):
            row = []
            for c in r.iter(ns + "c"):
                v = c.find(ns + "v")
                val = v.text if v is not None else "".join(t.text or "" for t in c.iter(ns + "t"))
                if c.get("t") == "s" and val and val.isdigit() and int(val) < len(shared):
                    val = shared[int(val)]
                row.append(val or "")
            rows.append(row[:40])
            if len(rows) >= limit:
                break
        return rows
    except Exception:  # noqa: BLE001
        return []


def render(*, rel, full, st, kind, ext, ctype, title, description, base, versions, public, kit_css, versions_url):
    """The enclosure page (bytes). base = the artifact URL without query (owner or public prefix)."""
    raw = base + "?raw=1"
    dl = base + "?download=1"
    th = base + "?thumb=1&m=%x" % st.st_mtime_ns
    name = rel.split("/")[-1]
    shown_title = title or name
    facts = [("File", esc(rel)), ("Type", esc(ctype.split(";")[0])), ("Size", "%s (%s bytes)" % (fmt_size(st.st_size), "{:,}".format(st.st_size))),
             ("Modified", esc(time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))))]
    p = F.probe(full, st) if kind in ("video", "audio") or (kind == "image" and ext in F.RASTER_EXT) else {}
    if p.get("width"):
        facts.append(("Dimensions", "%s x %s px" % (p["width"], p["height"])))
    if p.get("duration") and kind in ("video", "audio"):
        facts.append(("Duration", fmt_dur(p["duration"])))
    codecs = ", ".join(x for x in (p.get("video_codec"), p.get("audio_codec")) if x)
    if codecs and kind in ("video", "audio"):
        facts.append(("Codecs", esc(codecs)))
    digest = F.sha256_of(full, st)
    facts.append(("SHA-256", "<code>%s</code>" % digest if digest else "not computed (larger than %s)" % fmt_size(F.HASH_MAX)))

    thumb_ok = F.THUMBS_ON and kind in F.THUMB_KINDS
    if kind == "image":
        body = '<div class="enc"><img src="%s" alt="%s" onclick="this.classList.toggle(\'full\')"></div>' % (esc(raw), esc(shown_title))
        if ext not in F.RASTER_EXT and ext != ".svg":
            body += '<p class="enc-note">If the browser cannot show this format, download it.</p>'
    elif kind == "video":
        body = '<div class="enc"><video controls preload="metadata" playsinline src="%s"%s></video></div>' % (
            esc(raw), ' poster="%s"' % esc(th) if thumb_ok else "")
        if ext in (".mov", ".mkv", ".avi"):
            body += '<p class="enc-note">Browsers play %s only with common codecs (H.264, VP9, AV1); otherwise download it.</p>' % esc(ext)
    elif kind == "audio":
        body = '<div class="enc audio">%s<audio controls preload="metadata" src="%s"></audio></div>' % (
            '<img src="%s" alt="waveform" onerror="this.remove()">' % esc(th) if thumb_ok else "", esc(raw))
    elif kind == "pdf":
        body = '<div class="enc pdf"><iframe src="%s#view=FitH" title="%s"></iframe></div><p class="enc-note">If the PDF does not show, <a href="%s">open it</a> or download it.</p>' % (
            esc(raw), esc(shown_title), esc(raw))
    elif kind in ("data", "code"):
        body = preview_data(full, ext, st)
    else:
        body = '<div class="enc card"><div><div class="enc-big">%s file</div><p class="enc-note">%s, %s. No preview in the browser: download it to open it.</p></div></div>' % (
            esc(ext.lstrip(".") or "binary"), esc(ctype.split(";")[0]), fmt_size(st.st_size)) + preview_archive(full, ext, st)

    vers = ""
    if versions and not public:
        items = []
        for i, v in enumerate(reversed(versions)):
            n = len(versions) - i
            items.append('<li>v%d, %s, %s: <a href="%s">download</a></li>' % (
                n, esc(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(v["mtime"]))), fmt_size(v["size"]),
                esc(versions_url(v["id"]))))
        vers = '<h2>Versions</h2><ol class="enc-vers" reversed>%s</ol><p class="enc-note">Snapshots are kept for files up to 1.5 MB, the last 40 per file.</p>' % "".join(items)

    sub = '<p class="sub">%s</p>' % esc(description) if description else ""
    meta = "".join("<span>%s</span>" % x for x in (esc(name), fmt_size(st.st_size), esc(ext.lstrip(".").upper()),
                                                    "public link" if public else ""))
    page = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>%s</title><meta name="generator" content="dsh-artifacts enclosure">
<style>%s%s</style></head>
<body class="t-report" style="--w:1100px"><main>
<header class="top"><div class="brand">artifact \u00b7 %s</div><h1>%s</h1>%s<div class="meta">%s</div>
<div class="enc-bar"><a class="enc-btn" href="%s" data-file="%s">Download</a>%s</div></header>
%s
<h2>Details</h2><dl class="enc-facts">%s</dl>
%s
<footer>Served by dsh-artifacts.</footer>
</main></body></html>
""" % (esc(shown_title), kit_css or "", EXTRA_CSS, KIND_WORD.get(kind, kind), esc(shown_title), sub, meta,
       esc(dl), esc(name),
       "" if kind == "file" else '<a class="enc-btn ghost" href="%s" target="_blank" rel="noopener">Open original</a>' % esc(raw), body,
       "".join("<dt>%s</dt><dd>%s</dd>" % (k, v) for k, v in facts), vers)
    return page.encode("utf-8")


def versions_link(prefix, rel):
    return lambda vid: "%s_api/raw?name=%s&v=%s&download=1" % (prefix, quote(rel, safe=""), vid)
