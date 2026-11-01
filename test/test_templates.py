"""python3 test/test_templates.py: the template library (list, info, new, validation) and a smoke render of
every bundled template with its own example data, all through the CLI (which runs the TypeScript engine in
lib/engine). Offline: no server, no browser, no network. Engine unit tests: test/engine.mjs, parity: test/parity.mjs."""
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CLI = ROOT / "contrib" / "artifact"
KIT = ROOT / "contrib" / "artifact-kit"
BUNDLED = ROOT / "templates"


class Env:
    def __init__(self, with_estate=False):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        self.home = Path(self.tmp.name) / "home"
        self.reports = Path(self.tmp.name) / "reports"
        self.home.mkdir()
        self.reports.mkdir()
        self.env = {k: v for k, v in os.environ.items() if k not in ("DSH_SESSION_ID", "ARTIFACT_TEMPLATES")}
        self.env.update({"HOME": str(self.home), "ARTIFACT_DIR": str(self.reports)})
        if with_estate:
            self.env["ARTIFACT_TEMPLATES"] = str(BUNDLED)

    def run(self, *args):
        return subprocess.run([sys.executable, str(CLI), *args], capture_output=True, text=True, env=self.env, timeout=120)

    def info(self, tid):
        r = self.run("template-info", tid, "--json")
        assert r.returncode == 0, r.stderr
        return json.loads(r.stdout)

    def ids(self):
        r = self.run("templates", "--json")
        assert r.returncode == 0, r.stderr
        return [t for t in json.loads(r.stdout)["templates"]]

    def write(self, name, obj):
        p = Path(self.tmp.name) / name
        p.write_text(json.dumps(obj) if not isinstance(obj, str) else obj)
        return str(p)

    def close(self):
        self.tmp.cleanup()


def no_dashes(test, text, where):
    test.assertNotIn("\u2014", text, where)
    test.assertNotIn("\u2013", text, where)


class ListAndInfo(unittest.TestCase):
    def setUp(self):
        self.e = Env()  # empty HOME: no ~/estate, so the bundled fallback must be used

    def tearDown(self):
        self.e.close()

    def test_list_falls_back_to_bundled_copy(self):
        r = self.e.run("templates", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        d = json.loads(r.stdout)
        ids = {t["id"] for t in d["templates"]}
        self.assertTrue({"report-text", "article", "dashboard", "video-explainer", "video-page", "review-queue"} <= ids, ids)
        for t in d["templates"]:
            self.assertNotIn("error", t)
            self.assertEqual(t["source"], "bundled")
            self.assertTrue(t["purpose"] and t["fields"] and t["preview"].endswith((".html", "/")))
            self.assertIn(t["kind"], ("markdown", "react", "motion"))

    def test_list_text(self):
        r = self.e.run("templates")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("dashboard", r.stdout)
        self.assertIn("preview:", r.stdout)
        no_dashes(self, r.stdout, "templates output")

    def test_info_schema_and_minimal_example(self):
        for tid in ("dashboard", "article", "video-explainer"):
            r = self.e.run("template-info", tid, "--json")
            self.assertEqual(r.returncode, 0, r.stderr)
            d = json.loads(r.stdout)
            self.assertEqual(d["schema"]["type"], "object")
            mini = d["minimal_example"]
            chk = self.e.run("new", "m-" + tid, "--template", tid, "--data", self.e.write("mini.json", mini), "--check")
            self.assertEqual(chk.returncode, 0, tid + ": " + chk.stderr)
            for k in d["schema"].get("required", []):
                self.assertIn(k, mini)
        r = self.e.run("template-info", "dashboard")
        self.assertIn("DATA FIELDS", r.stdout)
        self.assertIn("kpis[].label*", r.stdout)

    def test_unknown_template(self):
        r = self.e.run("template-info", "nope")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no template 'nope'", r.stderr)


class Smoke(unittest.TestCase):
    """Every bundled template renders with its example data."""

    def setUp(self):
        self.e = Env(with_estate=True)

    def tearDown(self):
        self.e.close()

    def test_every_template_renders(self):
        for t in self.e.ids():
            with self.subTest(t["id"]):
                stem = "smoke-" + t["id"]
                r = self.e.run("new", stem, "--template", t["id"], "--json")
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                res = json.loads(r.stdout)
                self.assertTrue(res["ok"])
                for f in res["files"]:
                    p = Path(f)
                    self.assertTrue(p.exists(), f)
                    if p.suffix in (".md", ".html", ".json"):
                        txt = p.read_text()
                        self.assertNotRegex(txt, r"\{\{[#^/]?\s*[\w.@]+", f + " has an unfilled tag")
                        no_dashes(self, txt, f)
                if t["kind"] == "markdown":
                    md = self.e.reports / (stem + ".md")
                    k = subprocess.run([str(KIT), "render", str(md)], capture_output=True, text=True)
                    self.assertEqual(k.returncode, 0, k.stderr)
                    page = md.with_suffix(".html").read_text()
                    self.assertIn("<main>", page)
                    self.assertNotIn('class="err"', page)
                    marker = {"report-text": 'class="footnotes"', "article": 'class="fig hero"', "dashboard": "cols cols-2"}[t["id"]]
                    self.assertIn(marker, page)
                elif t["kind"] == "react":
                    d = self.e.reports / stem
                    self.assertIn("<title>%s</title>" % self.e.info(t["id"])["example"]["title"], (d / "index.html").read_text())
                    data = json.loads((d / "data.json").read_text())
                    self.assertFalse(any(k.startswith("_") for k in data))
                else:
                    comp = (self.e.reports / (stem + ".motion") / "index.html").read_text()
                    total = float(re.search(r'data-composition-id="main"[^>]*data-duration="([\d.]+)"', comp).group(1))
                    scenes = [(float(a), float(b)) for a, b in re.findall(r'<section[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"', comp)]
                    self.assertEqual(len(scenes), len(self.e.info(t["id"])["example"]["scenes"]))
                    self.assertAlmostEqual(scenes[-1][0] + scenes[-1][1], total, places=2)
                    self.assertTrue((self.e.reports / (stem + ".html")).exists())

    def test_assets_are_copied(self):
        r = self.e.run("new", "a1", "--template", "article")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.e.reports / "a1-files" / "hero.jpg").stat().st_size > 1000)
        self.assertIn("a1-files/hero.jpg", (self.e.reports / "a1.md").read_text())
        r = self.e.run("new", "v1", "--template", "video-page")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads((self.e.reports / "v1" / "data.json").read_text())["src"], "assets/sample.mp4")

    def test_exists_needs_force(self):
        self.assertEqual(self.e.run("new", "d1", "--template", "dashboard").returncode, 0)
        r = self.e.run("new", "d1", "--template", "dashboard")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--force", r.stderr)
        self.assertEqual(self.e.run("new", "d1", "--template", "dashboard", "--force").returncode, 0)

    def test_derived_durations(self):
        data = {"title": "T", "scenes": [{"type": "title", "title": "One two three"}, {"type": "chart", "bars": [{"label": "a", "value": 1}, {"label": "b", "value": 2}]}, {"type": "outro", "title": "Bye", "seconds": 4}]}
        r = self.e.run("new", "m1", "--template", "video-explainer", "--data", self.e.write("m.json", data))
        self.assertEqual(r.returncode, 0, r.stderr)
        comp = (self.e.reports / "m1.motion" / "index.html").read_text()
        starts = re.findall(r'<section[^>]*data-start="([\d.]+)" data-duration="([\d.]+)"', comp)
        self.assertEqual(starts[0], ("0", "2.5"))     # 1.6 + 3 words * 0.3 = 2.5
        self.assertEqual(starts[1], ("2.5", "3.5"))   # chart minimum
        self.assertEqual(starts[2], ("6", "4"))
        self.assertIn('data-duration="10"', comp)


class Validation(unittest.TestCase):
    def setUp(self):
        self.e = Env(with_estate=True)

    def tearDown(self):
        self.e.close()

    def bad(self, tid, data, *expect):
        r = self.e.run("new", "x", "--template", tid, "--data", self.e.write("bad.json", data))
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        for s in expect:
            self.assertIn(s, r.stderr)
        self.assertFalse(any(self.e.reports.iterdir()), "nothing may be written on bad data")
        return r

    def test_missing_required(self):
        self.bad("dashboard", {"title": "x"}, 'data: missing required property "kpis"', "template-info dashboard")

    def test_wrong_type_and_enum(self):
        self.bad("dashboard", {"title": "x", "kpis": [{"label": "a", "value": {"n": 1}, "verdict": "great"}]},
                 "data.kpis[0].value: expected string or number, got object",
                 'data.kpis[0].verdict: must be one of "good", "bad" (got "great")')

    def test_unknown_property_and_pattern(self):
        self.bad("report-text", {"title": "x", "sections": [{"heading": "h", "body": "b"}], "colour": "red", "footnotes": [{"id": "a b", "text": "t"}]},
                 "data.colour: unknown property", "data.footnotes[0].id: does not match the pattern")

    def test_empty_list(self):
        self.bad("report-text", {"title": "x", "sections": []}, "data.sections: needs at least 1 item(s), has 0")

    def test_missing_asset(self):
        self.bad("article", {"title": "x", "hero": {"src": "nope.jpg"}, "blocks": [{"type": "text", "text": "t"}]}, "data.hero.src: file not found")

    def test_secret_refused(self):
        self.bad("report-text", {"title": "x", "sections": [{"heading": "h", "body": "OPENAI_API_KEY=abcdefghijk12345"}]}, "credential-shaped")

    def test_invalid_json(self):
        r = self.e.run("new", "x", "--template", "dashboard", "--data", self.e.write("broken.json", "{\"title\": "))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is not valid JSON", r.stderr)

    def test_json_errors_and_check(self):
        r = self.e.run("new", "x", "--template", "dashboard", "--data", self.e.write("b.json", {"kpis": []}), "--json")
        self.assertEqual(r.returncode, 2)
        d = json.loads(r.stdout)
        self.assertFalse(d["ok"])
        self.assertTrue(any("title" in x for x in d["errors"]))
        ok = self.e.run("new", "x", "--template", "dashboard", "--data", self.e.write("g.json", {"title": "t", "kpis": [{"label": "a", "value": 1}]}), "--check")
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertFalse(any(self.e.reports.iterdir()), "--check writes nothing")

    def test_dash_warning_is_not_fatal(self):
        r = self.e.run("new", "x", "--template", "dashboard", "--data", self.e.write("w.json", {"title": "a \u2014 b", "kpis": [{"label": "a", "value": 1}]}))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("data.title: contains an em dash", r.stderr)


class Docs(unittest.TestCase):
    def test_no_dashes_in_templates(self):
        for p in BUNDLED.rglob("*"):
            if p.is_file() and p.suffix in (".md", ".json", ".html", ".jsx"):  # dashes anywhere; spaced hyphen only in prose files
                no_dashes(self, p.read_text(), str(p))
                if p.suffix in (".md", ".json"):
                    self.assertNotRegex(p.read_text(), r"\w \- \w", str(p) + " has a spaced hyphen used as a dash")


if __name__ == "__main__":
    unittest.main()
