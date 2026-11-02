"""python3 test/test_media.py -- 2.2: listing state, type detection, byte serving (Range, 304, 416),
headers (nosniff, Content-Disposition, sandbox CSP), downloads, the enclosure page and thumbnails.

Sample media is generated with ffmpeg test sources (skipped where ffmpeg is missing); no network, no DSH.
"""
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
TMP = tempfile.mkdtemp(prefix="artifacts-media-test-")
os.environ["ARTIFACT_DIR"] = TMP
sys.path.insert(0, str(HERE.parent / "server"))
import artifacts_server as S  # noqa: E402
import files as F  # noqa: E402

FFMPEG = shutil.which("ffmpeg") is not None
PDF = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<<>>>>endobj\n"
       b"4 0 obj<</Length 35>>stream\n0 0 1 rg 20 20 160 60 re f\nendstream endobj\n"
       b"trailer<</Root 1 0 R>>\n%%EOF\n")


class Headers(dict):
    def get(self, k, d=None):
        for key, v in self.items():
            if key.lower() == k.lower():
                return v
        return d


class FakeHandler:
    """Enough of BaseHTTPRequestHandler for serve_path/handle: records status, headers and body."""

    def __init__(self, path, headers=None):
        self.path = path
        self.headers = Headers(headers or {})
        self.wfile = io.BytesIO()
        self.status = None
        self.out = {}

    def send_response(self, code):
        self.status = code

    def send_header(self, k, v):
        self.out[k.lower()] = v

    def end_headers(self):
        pass

    def _authorized(self):
        return True

    @property
    def body(self):
        return self.wfile.getvalue()


def get(path, method="GET", **headers):
    h = FakeHandler(path, {k.replace("_", "-"): v for k, v in headers.items()})
    if path.startswith(S.PUBLIC_PREFIX):
        S.handle_public(h, method)
    else:
        S.handle(h, method)
    return h


def ff(*args):
    subprocess.run(["ffmpeg", "-v", "error", "-y"] + list(args), check=True, stdin=subprocess.DEVNULL)


class Media(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = Path(TMP)
        S.STORE.mkdir(parents=True, exist_ok=True)
        (d / "notes.md").write_text("# Notes\n\nhello\n")
        (d / "table.csv").write_text("name,score\nalpha,1\n<script>alert(1)</script>,2\n")
        (d / "data.json").write_text(json.dumps([{"a": 1, "b": "x"}, {"a": 2, "b": "y"}]))
        (d / "pic.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>')
        (d / "doc.pdf").write_bytes(PDF)
        (d / "big.bin.txt").write_bytes(b"0123456789" * 1000)
        with zipfile.ZipFile(d / "bundle.zip", "w") as z:
            z.writestr("readme.txt", "hi")
            z.writestr("dir/a.csv", "x,y\n1,2\n")
        (d / "outside.html").write_text("<html><head><title>x</title></head><body><script>1</script></body></html>")
        if FFMPEG:
            ff("-f", "lavfi", "-i", "testsrc=size=64x48:rate=1", "-frames:v", "1", str(d / "pic.png"))
            ff("-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-t", "2", "-pix_fmt", "yuv420p", "-c:v", "libx264", str(d / "clip.mp4"))
            ff("-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", str(d / "tone.mp3"))

    # -- pure helpers -----------------------------------------------------------------------------------

    def test_parse_range(self):
        cases = [
            (None, 100, None), ("bytes=0-9", 100, (0, 9)), ("bytes=90-", 100, (90, 99)), ("bytes=-10", 100, (90, 99)),
            ("bytes=50-1000", 100, (50, 99)), ("bytes=100-", 100, False), ("bytes=-0", 100, False),
            ("bytes=9-3", 100, None), ("bytes=a-b", 100, None), ("items=0-1", 100, None), ("bytes=0-1,5-6", 100, (0, 1)),
            ("bytes=-500", 100, (0, 99)), ("bytes=0-", 0, False),
        ]
        for v, total, want in cases:
            self.assertEqual(F.parse_range(v, total), want, v)

    def test_disposition(self):
        self.assertEqual(F.disposition("attachment", "a b.png"), "attachment; filename=\"a b.png\"; filename*=UTF-8''a%20b.png")
        d = F.disposition("attachment", 'r\u00e9sum\u00e9 "x".pdf')
        self.assertIn('filename="r_sum_ _x_.pdf"', d)
        self.assertIn("filename*=UTF-8''r%C3%A9sum%C3%A9%20%22x%22.pdf", d)
        self.assertNotIn("\n", F.disposition("inline", "a\nb"))

    def test_fold_listing(self):
        st = F.fold_listing([
            {"op": "hide", "name": "a"}, {"op": "meta", "name": "a", "title": "T"}, {"op": "show", "name": "b"},
            {"op": "add", "name": "c", "from": "/x/c.png", "mode": "copy", "sandbox": True, "description": "D"},
            {"op": "hide", "name": "c"}, {"op": "bogus", "name": "d"}, "junk", {"op": "hide"},
            {"op": "meta", "name": "a", "description": "only d"},
        ])
        self.assertTrue(st["a"]["hidden"])
        self.assertEqual((st["a"]["title"], st["a"]["description"]), ("T", "only d"))
        self.assertFalse(st["b"]["hidden"])
        self.assertTrue(st["c"]["hidden"] and st["c"]["sandbox"])
        self.assertEqual(st["c"]["added"]["from"], "/x/c.png")
        self.assertNotIn("d", st)

    def test_types(self):
        for ext, kind in ((".png", "image"), (".mp4", "video"), (".mp3", "audio"), (".opus", "audio"), (".pdf", "pdf"),
                          (".csv", "data"), (".zip", "file"), (".docx", "file"), (".xlsx", "file"), (".m4a", "audio"),
                          (".webm", "video"), (".mov", "video"), (".wav", "audio"), (".ogg", "audio")):
            self.assertEqual(S.KIND[ext], kind, ext)
            self.assertIn(ext, S.TYPES)
        for ext in S.KIND:
            self.assertIn(ext, S.TYPES, ext)

    # -- index and listing ------------------------------------------------------------------------------

    def test_index_listing_hide_show_meta(self):
        by = {i["name"]: i for i in S.build_index()["items"]}
        self.assertEqual(by["bundle.zip"]["kind"], "file")
        self.assertEqual(by["bundle.zip"]["download"], "/report/bundle.zip?download=1")
        self.assertEqual(by["table.csv"]["view"], "/report/table.csv?view=1")
        self.assertEqual([d["label"] for d in by["notes.html"]["downloads"]], [".md source", ".html page"])
        self.assertTrue(by["pic.svg"]["thumb"].startswith("/report/pic.svg?raw=1"))
        if FFMPEG:
            self.assertIn("?thumb=1", by["clip.mp4"]["thumb"])
        F.listing_append(S.STORE, {"op": "hide", "name": "table.csv"})
        F.listing_append(S.STORE, {"op": "meta", "name": "notes.html", "title": "Better title", "description": "why"})
        idx = S.build_index()
        names = {i["name"] for i in idx["items"]}
        self.assertNotIn("table.csv", names)
        self.assertGreaterEqual(idx["hidden"], 1)
        by = {i["name"]: i for i in idx["items"]}
        self.assertEqual((by["notes.html"]["title"], by["notes.html"]["description"]), ("Better title", "why"))
        allx = {i["name"]: i for i in S.build_index(include_hidden=True)["items"]}
        self.assertTrue(allx["table.csv"]["hidden"])
        # de-listed files are still served (the link keeps working) and come back with show
        self.assertEqual(get("/report/table.csv?raw=1").status, 200)
        F.listing_append(S.STORE, {"op": "show", "name": "table.csv"})
        self.assertIn("table.csv", {i["name"] for i in S.build_index()["items"]})

    def test_listing_api(self):
        h = FakeHandler("/report/_api/listing", {"X-Artifact-Api": "1", "Content-Length": "40"})
        body = json.dumps({"name": "data.json", "op": "hide"}).encode()
        h.headers["Content-Length"] = str(len(body))
        h.rfile = io.BytesIO(body)
        S.handle(h, "POST")
        self.assertEqual(h.status, 200, h.body)
        self.assertNotIn("data.json", {i["name"] for i in S.build_index()["items"]})
        F.listing_append(S.STORE, {"op": "show", "name": "data.json"})
        bad = FakeHandler("/report/_api/listing", {"X-Artifact-Api": "1"})
        body = json.dumps({"name": "data.json", "op": "delete"}).encode()
        bad.headers["Content-Length"] = str(len(body))
        bad.rfile = io.BytesIO(body)
        S.handle(bad, "POST")
        self.assertEqual(bad.status, 400)

    # -- serving ----------------------------------------------------------------------------------------

    def test_raw_headers_and_ranges(self):
        h = get("/report/big.bin.txt?raw=1")
        self.assertEqual(h.status, 200)
        self.assertEqual(h.out["x-content-type-options"], "nosniff")
        self.assertEqual(h.out["accept-ranges"], "bytes")
        etag = h.out["etag"]
        h = get("/report/big.bin.txt?raw=1", Range="bytes=10-19")
        self.assertEqual((h.status, h.body, h.out["content-range"]), (206, b"0123456789", "bytes 10-19/10000"))
        self.assertEqual(h.out["x-content-type-options"], "nosniff")
        h = get("/report/big.bin.txt?raw=1", Range="bytes=-5")
        self.assertEqual((h.status, h.body), (206, b"56789"))
        h = get("/report/big.bin.txt?raw=1", Range="bytes=20000-")
        self.assertEqual((h.status, h.out["content-range"]), (416, "bytes */10000"))
        h = get("/report/big.bin.txt?raw=1", Range="bytes=0-1", If_Range='"other"')
        self.assertEqual(h.status, 200)
        h = get("/report/big.bin.txt?raw=1", Range="bytes=0-1", If_Range=etag)
        self.assertEqual(h.status, 206)
        h = get("/report/big.bin.txt?raw=1", If_None_Match=etag)
        self.assertEqual((h.status, h.body), (304, b""))
        h = get("/report/big.bin.txt?raw=1", "HEAD", Range="bytes=0-9")
        self.assertEqual((h.status, h.out["content-length"], h.body), (206, "10", b""))

    def test_large_file_streams_with_range(self):
        p = Path(TMP) / "large.txt"
        p.write_bytes(b"a" * (F.INLINE_MAX + 10) + b"END")
        h = get("/report/large.txt?raw=1", Range="bytes=-3")
        self.assertEqual((h.status, h.body), (206, b"END"))
        self.assertEqual(h.out["x-content-type-options"], "nosniff")
        h = get("/report/large.txt/download", "HEAD")
        self.assertEqual(h.status, 200)
        self.assertTrue(h.out["content-disposition"].startswith("attachment;"))
        p.unlink()

    def test_downloads(self):
        h = get("/report/bundle.zip?download=1")
        self.assertEqual(h.status, 200)
        self.assertEqual(h.out["content-type"], "application/zip")
        self.assertTrue(h.out["content-disposition"].startswith('attachment; filename="bundle.zip"'))
        self.assertEqual(get("/report/bundle.zip/download").out["content-disposition"], h.out["content-disposition"])
        # a plain file kind is never inline, even raw
        self.assertTrue(get("/report/bundle.zip?raw=1").out["content-disposition"].startswith("attachment"))
        md = get("/report/notes.md?download=1", Sec_Fetch_Dest="document")
        self.assertEqual(md.body, b"# Notes\n\nhello\n")
        self.assertIn('filename="notes.md"', md.out["content-disposition"])
        page = get("/report/notes.html/download")
        self.assertIn(b"artifact-kit", page.body)
        self.assertNotIn(b"data-dsh-bridge", page.body)
        self.assertIn('filename="notes.html"', page.out["content-disposition"])
        # the served page links both downloads in its footer
        served = get("/report/notes.html", Sec_Fetch_Dest="document")
        self.assertIn(b"/report/notes.md?download=1", served.body)
        self.assertEqual(get("/report/missing.zip/download").status, 404)

    def test_svg_and_untrusted_html_are_sandboxed(self):
        h = get("/report/pic.svg?raw=1")
        self.assertIn("sandbox", h.out["content-security-policy"])
        self.assertIn("default-src 'none'", h.out["content-security-policy"])
        self.assertNotIn("content-security-policy", get("/report/outside.html").out)
        F.listing_append(S.STORE, {"op": "add", "name": "outside.html", "from": "/elsewhere/outside.html", "mode": "copy", "sandbox": True})
        h = get("/report/outside.html", Sec_Fetch_Dest="document")
        self.assertIn("sandbox", h.out["content-security-policy"])
        self.assertNotIn(b"data-dsh-bridge", h.body)

    def test_view_vs_embed(self):
        # a top-level navigation gets the enclosure, an <img> or fetch gets the bytes, ?raw=1 forces bytes
        nav = get("/report/table.csv", Sec_Fetch_Dest="document")
        self.assertIn(b"dsh-artifacts enclosure", nav.body)
        self.assertIn(b"<table>", nav.body)
        self.assertNotIn(b"<script>alert(1)</script>", nav.body)
        self.assertIn(b"&lt;script&gt;alert(1)&lt;/script&gt;", nav.body)
        self.assertIn(b"/report/table.csv?download=1", nav.body)
        self.assertEqual(get("/report/table.csv", Sec_Fetch_Dest="empty").body[:10], b"name,score")
        self.assertEqual(get("/report/table.csv?raw=1", Sec_Fetch_Dest="document").body[:10], b"name,score")
        self.assertIn(b"enclosure", get("/report/table.csv?view=1").body)
        self.assertIn(b"<table>", get("/report/data.json?view=1").body)
        z = get("/report/bundle.zip?view=1").body
        self.assertIn(b"dir/a.csv", z)
        self.assertIn(b"SHA-256", z)
        pdf = get("/report/doc.pdf?view=1").body
        self.assertIn(b'<iframe src="/report/doc.pdf?raw=1#view=FitH"', pdf)
        self.assertEqual(get("/report/doc.pdf?raw=1").out["content-type"], "application/pdf")
        svg = get("/report/pic.svg?view=1").body
        self.assertIn(b'<img src="/report/pic.svg?raw=1"', svg)
        self.assertNotIn(b"<svg", svg)
        probe = get("/report/table.csv?view=1&artifact-etag=1")
        self.assertTrue(probe.body.startswith(b'"'))

    @unittest.skipUnless(FFMPEG, "ffmpeg missing")
    def test_media_view_and_thumbs(self):
        v = get("/report/clip.mp4", Sec_Fetch_Dest="document").body
        self.assertIn(b'<video controls preload="metadata" playsinline src="/report/clip.mp4?raw=1"', v)
        self.assertIn(b"Duration", v)
        self.assertIn(b"160 x 120 px", v)
        self.assertIn(b"<audio controls", get("/report/tone.mp3?view=1").body)
        self.assertEqual(get("/report/clip.mp4", Sec_Fetch_Dest="video", Range="bytes=0-99").status, 206)
        for name in ("pic.png", "clip.mp4", "tone.mp3", "doc.pdf"):
            h = get("/report/%s?thumb=1" % name)
            self.assertEqual((name, h.status, h.out.get("content-type")), (name, 200, "image/webp"), h.body[:200])
            self.assertEqual(h.body[:4], b"RIFF")
        self.assertEqual(get("/report/table.csv?thumb=1").status, 404)

    def test_public(self):
        get("/report/pic.svg")  # warm
        self.assertEqual(get("/report-public/table.csv").status, 404)
        Path(TMP, "table.csv.public").touch()
        Path(TMP, "notes.md.public").touch()
        Path(TMP, "notes.html.public").touch()
        try:
            page = get("/report-public/table.csv", Sec_Fetch_Dest="document").body
            self.assertIn(b"/report-public/table.csv?download=1", page)
            self.assertNotIn(b"Versions", page)
            self.assertTrue(get("/report-public/table.csv/download").out["content-disposition"].startswith("attachment"))
            md = get("/report-public/notes.html", Sec_Fetch_Dest="document").body
            self.assertIn(b"/report-public/notes.md?download=1", md)
            self.assertEqual(get("/report-public/notes.md?download=1").body, b"# Notes\n\nhello\n")
        finally:
            for n in ("table.csv.public", "notes.md.public", "notes.html.public"):
                Path(TMP, n).unlink()


if __name__ == "__main__":
    unittest.main()
