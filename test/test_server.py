"""python3 test/test_server.py -- artifact server + indexer unit checks (no network)."""
import json, os, sys, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
TMP = tempfile.mkdtemp()
os.environ["ARTIFACT_DIR"] = TMP
sys.path.insert(0, str(HERE.parent / "server"))
import artifacts_server as S  # noqa: E402
import indexer as X  # noqa: E402


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        d = Path(TMP)
        (d / "a.md").write_text("# Alpha report\n\nhello\n")
        (d / "b.html").write_text("<html><head><title>Bee page</title></head><body>x</body></html>")
        (d / "c.md").write_text("# Cee\n")
        (d / "c.html").write_text("<html><head><title>hand made</title></head></html>")
        (d / "app1").mkdir()
        (d / "app1" / "index.html").write_text("<title>My app</title>")
        (d / "media").mkdir()
        (d / "media" / "x.png").write_bytes(b"\x89PNG\r\n\x1a\n0000")
        S.STORE.mkdir(parents=True, exist_ok=True)

    def test_fence(self):
        for bad in ("../etc/passwd", ".artifacts/registry.json", "a/../../x", "", "x/.hidden"):
            self.assertIsNone(S.safe_rel(bad), bad)
        self.assertEqual(S.safe_rel("app1/index.html"), "app1/index.html")

    def test_index_groups_md_and_kinds(self):
        idx = S.build_index()
        by = {i["name"]: i for i in idx["items"]}
        self.assertIn("a.html", by)                 # md surfaces under its rendered name
        self.assertEqual(by["a.html"]["source"], "a.md")
        self.assertEqual(by["a.html"]["title"], "Alpha report")
        self.assertIn("c.md", [f for i in idx["items"] for f in i["files"]])
        self.assertIn("c.html", by)                 # hand-written html is NOT swallowed by c.md
        self.assertEqual(by["app1"]["kind"], "app")
        self.assertEqual(by["media/x.png"]["kind"], "image")

    def test_claims_and_family(self):
        S.add_claim("b.html", "session-aaaaaaaa-1111", "test")
        idx = S.build_index("session-aaaaaaaa-1111")
        mine = {i["name"] for i in idx["items"] if i["mine"]}
        self.assertEqual(mine, {"b.html"})

    def test_render_md(self):
        page, etag = S.render_md(Path(TMP) / "a.md")
        self.assertIn(b"Alpha report", page)
        self.assertTrue(etag.startswith('"md-'))

    def test_bridge_injection(self):
        out = S.inject_bridge(b"<html><head><title>t</title></head><body></body></html>", "b.html", '"e"')
        self.assertIn(b"data-dsh-bridge", out)
        self.assertLess(out.index(b"data-dsh-bridge"), out.index(b"<title>"))

    def test_storage(self):
        S.storage_op("b.html", "set", key="k", value={"v": 1})
        self.assertEqual(S.storage_op("b.html", "get", key="k")["value"], {"v": 1})
        self.assertEqual(S.storage_op("b.html", "list")["keys"], ["k"])


class Indexer(unittest.TestCase):
    def test_ptc_dispatch_object_args(self):
        rec = {"type": "tool/ptc-dispatch-start", "data": {"name": "write",
               "arguments": {"file_path": str(Path.home()) + "/reports/x-report.md", "content": "hi"}}}
        names, _ = X.claims_in_line(json.dumps(rec).encode())
        self.assertEqual(names, {"x-report.md"})

    def test_tool_call_string_args(self):
        rec = {"type": "tool/call", "data": {"name": "edit", "arguments": json.dumps({"file_path": "~/reports/y.html"})}}
        self.assertEqual(X.claims_in_line(json.dumps(rec).encode())[0], {"y.html"})

    def test_shell_reads_do_not_claim(self):
        for cmd, want in (("cat ~/reports/z.md | head", set()),
                          ("grep foo ~/reports/z.md > /tmp/out", set()),
                          ("echo hi > ~/reports/z.md", {"z.md"}),
                          ("artifact-kit render ~/reports/z.md", {"z.md", "z.html"}),
                          ("cp /tmp/a ~/reports/z.csv", {"z.csv"})):
            rec = {"type": "tool/call", "data": {"name": "bash", "arguments": json.dumps({"command": cmd})}}
            self.assertEqual(X.claims_in_line(json.dumps(rec).encode())[0], want, cmd)

    def test_results_are_not_authorship(self):
        rec = {"type": "tool/result", "data": {"name": "write", "arguments": {"file_path": "~/reports/q.md"}}}
        self.assertEqual(X.claims_in_line(json.dumps(rec).encode())[0], set())


if __name__ == "__main__":
    unittest.main()
