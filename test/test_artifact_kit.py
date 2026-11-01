"""python3 test/test_artifact_kit.py: renders every starter and checks the guards."""
import subprocess, tempfile, unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent / "contrib" / "artifact-kit"


def run(*args, cwd=None):
    return subprocess.run([str(KIT), *args], capture_output=True, text=True, cwd=cwd)


class ArtifactKit(unittest.TestCase):
    def test_every_starter_renders(self):
        with tempfile.TemporaryDirectory() as d:
            for name, marker in [("report", 'class="kpis"'), ("dashboard", "<polyline"), ("plan", 'class="timeline"'),
                                 ("comparison", 'class="sortable"'), ("brief", 'class="callout ok"')]:
                src = Path(d) / f"{name}.md"
                src.write_text(run("example", name).stdout)
                r = run("render", str(src))
                self.assertEqual(r.returncode, 0, r.stderr)
                page = src.with_suffix(".html").read_text()
                self.assertIn(marker, page, name)
                self.assertNotIn("<script src", page)  # self-contained

    def test_refuses_credentials(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "x.md"
            src.write_text("# t\n\nOPENAI_API_KEY=abcdefgh12345678\n")
            r = run("render", str(src))
            self.assertNotEqual(r.returncode, 0)
            self.assertFalse(src.with_suffix(".html").exists())

    def test_verdict_overrides_sign(self):
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "k.md"
            src.write_text("```kpi\nRefunds | 3% | +1 pt | bad\nCost | 2 | -5% | good\n```\n")
            run("render", str(src))
            page = src.with_suffix(".html").read_text()
            self.assertIn('kpi-note down">+1 pt', page)
            self.assertIn('kpi-note up">-5%', page)


if __name__ == "__main__":
    unittest.main()
