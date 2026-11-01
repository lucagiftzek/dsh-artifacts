"""Motion artifacts: Claude-Motion-style animated explainers as editable code.

Layout of a motion artifact <name>:
  ~/reports/<name>.html                 player page (scrubber, scene chips, timed change
                                        requests, export button, latest render)
  ~/reports/<name>.motion/index.html    the HyperFrames composition -- the file you edit
  ~/reports/<name>.motion/vendor/       GSAP copied in, so the project renders anywhere
  ~/reports/<name>.motion/assets/       images, voice-over, music
  ~/reports/<name>.motion/renders/      exported MP4/WebM/GIF/MOV

Engine: HyperFrames (heygen-com/hyperframes, Apache-2.0) -- HTML + one paused GSAP timeline
registered on window.__timelines, rendered frame by frame by headless Chrome + ffmpeg.
"""
import json
import os
import re
import shlex
import shutil
import subprocess
from pathlib import Path

HF_VERSION = "0.8.171"
HERE = Path(os.path.realpath(__file__)).parent
PLUGIN = HERE.parent
LOCAL_HF = PLUGIN / "motion" / "node_modules" / ".bin" / "hyperframes"
GSAP_SRC = PLUGIN / "vendor" / "gsap.js"
REMOTE_HOSTS = tuple(h for h in os.environ.get("DSH_MOTION_REMOTE_HOSTS", "").split(",") if h.strip())
QUIET_ENV = {"HF_CLI_TELEMETRY_DISABLED": "1", "HYPERFRAMES_NO_TELEMETRY": "1", "DO_NOT_TRACK": "1"}

SIZES = {"landscape": (1920, 1080), "1080p": (1920, 1080), "portrait": (1080, 1920),
         "vertical": (1080, 1920), "square": (1080, 1080), "720p": (1280, 720)}


class MotionError(Exception):
    pass


def hf_bin():
    if LOCAL_HF.exists():
        return str(LOCAL_HF)
    found = shutil.which("hyperframes")
    if found:
        return found
    raise MotionError("hyperframes CLI missing: cd %s/motion && npm i hyperframes@%s" % (PLUGIN, HF_VERSION))


def hf_env():
    env = dict(os.environ)
    env.update(QUIET_ENV)
    return env


def run_hf(args, cwd=None, capture=False, timeout=None):
    cmd = [hf_bin()] + list(args)
    if capture:
        return subprocess.run(cmd, cwd=cwd, env=hf_env(), capture_output=True, text=True, timeout=timeout)
    return subprocess.run(cmd, cwd=cwd, env=hf_env(), timeout=timeout)


# -- names --------------------------------------------------------------------

def split_name(report_dir, name):
    """Accept foo, foo.html, foo.motion, foo.motion/index.html, a URL -> stem 'foo'."""
    n = str(name).split("?")[0].strip("/")
    for p in ("/report/", str(report_dir) + "/", "~/reports/"):
        if n.startswith(p):
            n = n[len(p):]
    n = n.split("/")[0]
    for suf in (".html", ".motion"):
        if n.endswith(suf):
            n = n[: -len(suf)]
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", n):
        raise MotionError("bad motion artifact name: %s (letters, digits, - and _ only)" % name)
    return n


def project_dir(report_dir, stem):
    d = Path(report_dir) / (stem + ".motion")
    if not (d / "index.html").is_file():
        raise MotionError("%s is not a motion artifact (no %s)" % (stem, d / "index.html"))
    return d


def comp_meta(proj):
    html = (proj / "index.html").read_text(encoding="utf-8", errors="replace")
    m = re.search(r"<[^>]*data-composition-id=[^>]*>", html)
    tag = m.group(0) if m else ""

    def get(a, d=None):
        mm = re.search(r'%s="([^"]*)"' % a, tag)
        return mm.group(1) if mm else d
    t = re.search(r"<title>(.*?)</title>", html, re.S)
    return {"id": get("data-composition-id", "main"), "width": int(get("data-width", 1920)),
            "height": int(get("data-height", 1080)), "duration": float(get("data-duration", 0) or 0),
            "fps": get("data-fps"), "title": t.group(1).strip() if t else proj.stem}


# -- scaffold -----------------------------------------------------------------

COMPOSITION = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=__W__, height=__H__" />
<title>__TITLE__</title>
<script src="vendor/gsap.min.js"></script>
<style>
  /* Palette + type: change these first. Keep body text >= 28px at 1080p. */
  :root { --bg:#0f1115; --ink:#f4efe8; --muted:#a39d94; --accent:#e0623f; --accent2:#4fb3a9; --u:__U__px; }
  html, body { margin:0; background:var(--bg); color:var(--ink);
    font-family: ui-sans-serif, system-ui, sans-serif; }
  #root { position:relative; width:100%; height:100%; overflow:hidden; background:var(--bg); }
  .clip { position:absolute; inset:0; display:flex; flex-direction:column; justify-content:center;
    padding: 0 9%; box-sizing:border-box; }
  .kicker { font-size: calc(var(--u) * 0.030); letter-spacing:.18em; text-transform:uppercase; color:var(--accent); margin:0 0 .6em; }
  .title { font-size: calc(var(--u) * 0.085); line-height:1.05; font-weight:750; margin:0; }
  .title .w { display:inline-block; }
  .rule { height: calc(var(--u) * 0.006); width: 38%; background:var(--accent); margin-top:.9em; transform-origin:left center; }
  .stat { display:flex; align-items:baseline; gap:.3em; }
  .num { font-size: calc(var(--u) * 0.16); font-weight:800; font-variant-numeric: tabular-nums; }
  .unit { font-size: calc(var(--u) * 0.06); color:var(--accent); font-weight:700; }
  .caption { font-size: calc(var(--u) * 0.034); color:var(--muted); margin:.4em 0 0; max-width: 26em; }
  .bars { display:flex; align-items:flex-end; gap: calc(var(--u) * 0.02); height: 28%; margin-top: 5%; }
  .bar { width: calc(var(--u) * 0.07); background:var(--accent2); transform-origin:bottom center; border-radius: 6px 6px 0 0; }
  .bar.hl { background:var(--accent); }
  .outro .title { font-size: calc(var(--u) * 0.07); }
  .dot { width: calc(var(--u) * 0.03); height: calc(var(--u) * 0.03); border-radius:50%; background:var(--accent); margin-bottom: .8em; }
</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-width="__W__" data-height="__H__" data-duration="__DUR__">

  <section id="s1-title" class="clip" data-label="Title" data-start="0" data-duration="__S1D__">
    <p class="kicker" id="s1-kicker">Quarterly update</p>
    <h1 class="title" id="s1-head"><span class="w">__TITLE_WORDS__</span></h1>
    <div class="rule" id="s1-rule"></div>
  </section>

  <section id="s2-stat" class="clip" data-label="Key number" data-start="__S2S__" data-duration="__S2D__">
    <div class="stat"><span class="num" id="s2-num">0</span><span class="unit">%</span></div>
    <p class="caption" id="s2-cap">Growth quarter over quarter. Replace with your own number and source.</p>
    <div class="bars" id="s2-bars">
      <div class="bar" style="height:35%"></div><div class="bar" style="height:52%"></div>
      <div class="bar" style="height:61%"></div><div class="bar hl" style="height:88%"></div>
    </div>
  </section>

  <section id="s3-outro" class="clip outro" data-label="Takeaway" data-start="__S3S__" data-duration="__S3D__">
    <div class="dot" id="s3-dot"></div>
    <h2 class="title" id="s3-head">One clear takeaway goes here.</h2>
    <p class="caption" id="s3-cap">Who should do what next.</p>
  </section>

</div>
<script>
  // ONE paused timeline, registered on window.__timelines[<data-composition-id>].
  // Deterministic only: no Date.now(), no unseeded Math.random(), no fetch, no CSS transitions.
  const tl = gsap.timeline({ paused: true });
  const S2 = __S2S__, S3 = __S3S__;

  // Scene 1: title rises word by word, rule draws
  tl.fromTo("#s1-kicker", { y: 24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power3.out" }, 0.2);
  tl.fromTo("#s1-head .w", { yPercent: 60, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.7, ease: "power4.out", stagger: 0.09 }, 0.35);
  tl.fromTo("#s1-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "expo.out" }, 0.9);
  tl.to("#s1-title > *", { y: -30, opacity: 0, duration: 0.45, ease: "power2.in", stagger: 0.04 }, S2 - 0.5);

  // Scene 2: number counts up, bars grow, the highlight lands last
  const counter = { v: 0 };
  tl.fromTo("#s2-num", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, S2 + 0.05);
  tl.to(counter, { v: 42, duration: 1.4, ease: "power2.out",
    onUpdate: () => { document.querySelector("#s2-num").textContent = Math.round(counter.v); } }, S2 + 0.1);
  tl.fromTo("#s2-cap", { opacity: 0 }, { opacity: 1, duration: 0.6 }, S2 + 0.5);
  tl.fromTo("#s2-bars .bar", { scaleY: 0 }, { scaleY: 1, duration: 0.7, ease: "back.out(1.4)", stagger: 0.12 }, S2 + 0.6);
  tl.to("#s2-stat > *", { opacity: 0, duration: 0.4, ease: "power2.in" }, S3 - 0.45);

  // Scene 3: takeaway
  tl.fromTo("#s3-dot", { scale: 0 }, { scale: 1, duration: 0.5, ease: "back.out(2)" }, S3 + 0.1);
  tl.fromTo("#s3-head", { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, ease: "power3.out" }, S3 + 0.25);
  tl.fromTo("#s3-cap", { opacity: 0 }, { opacity: 1, duration: 0.6 }, S3 + 0.7);

  (window.__timelines = window.__timelines || {})["main"] = tl;  // guarded: the player iframe may not have the registry yet
</script>
<script>
  /* DSH: opened directly in the Artifacts sidebar -> show the player page instead.
     Inert during renders (navigator.webdriver) and inside the player (?player=1). */
  if (window.__DSH_ARTIFACT__ && !navigator.webdriver && !/[?&]player=1/.test(location.search))
    location.replace("../__NAME__.html");
</script>
</body>
</html>
"""

# The player page is a plain file so the TypeScript template engine (lib/engine) uses the same source.
PLAYER = (HERE / "motion-player.html").read_text(encoding="utf-8")


def parse_size(s):
    if not s:
        return SIZES["landscape"]
    s = str(s).lower()
    if s in SIZES:
        return SIZES[s]
    m = re.fullmatch(r"(\d{3,4})x(\d{3,4})", s)
    if not m:
        raise MotionError("--size must be landscape|portrait|square|720p|WxH")
    return int(m.group(1)), int(m.group(2))


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def scaffold(report_dir, stem, title, size=None, duration=None):
    report_dir = Path(report_dir)
    proj = report_dir / (stem + ".motion")
    page = report_dir / (stem + ".html")
    for p in (proj, page):
        if p.exists():
            raise MotionError("%s already exists - edit it instead" % p)
    w, h = parse_size(size)
    dur = float(duration or 12)
    if dur < 3:
        raise MotionError("--duration must be >= 3 seconds")
    k = dur / 12.0
    s2, s3 = round(4.0 * k, 2), round(8.5 * k, 2)
    unit = h if w >= h else round(w * 1.5)  # type scale: canvas height (landscape) or 1.5x width (portrait)
    words = '</span> <span class="w">'.join(_esc(x) for x in title.split()) or "Title"
    rep = {"__W__": str(w), "__H__": str(h), "__U__": str(unit), "__DUR__": "%g" % dur,
           "__S1D__": "%g" % s2, "__S2S__": "%g" % s2, "__S2D__": "%g" % round(s3 - s2, 2),
           "__S3S__": "%g" % s3, "__S3D__": "%g" % round(dur - s3, 2), "__NAME__": stem,
           "__TITLE_WORDS__": words, "__TITLE__": _esc(title)}
    comp = COMPOSITION
    for a, b in rep.items():
        comp = comp.replace(a, b)
    player = PLAYER.replace("__TITLE__", _esc(title)).replace("__NAME__", stem).replace("__W__", str(w)).replace("__H__", str(h))
    (proj / "vendor").mkdir(parents=True)
    (proj / "assets").mkdir()
    shutil.copyfile(GSAP_SRC, proj / "vendor" / "gsap.min.js")
    (proj / "vendor" / "README.txt").write_text(
        "GSAP core is copied here so the project renders on any machine (local or a remote render host).\n"
        "Need a plugin (SplitText, MotionPath, DrawSVG, Flip...)? Copy it next to gsap.min.js:\n"
        "  cp %s/<Plugin>.min.js vendor/   and add <script src=\"vendor/<Plugin>.min.js\"></script>\n"
        % (PLUGIN / "vendor" / "gsap"))
    (proj / "index.html").write_text(comp, encoding="utf-8")
    page.write_text(player, encoding="utf-8")
    return proj, page


# -- export -------------------------------------------------------------------

def mem_available_gb():
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) / 1048576
    except OSError:
        pass
    return 0.0


def pick_host(host):
    if host and host != "auto":
        if host != "local" and host not in REMOTE_HOSTS:
            raise MotionError("--host must be auto|local|" + "|".join(REMOTE_HOSTS))
        return host
    # Local is fastest (no copy). Memory margin: keep >= 4 GB free for the Chrome workers.
    if mem_available_gb() >= 4 or not REMOTE_HOSTS:
        return "local"
    return REMOTE_HOSTS[0]


def render_args(quality, fps, fmt, resolution, workers):
    a = ["--quality", quality, "--format", fmt, "--workers", str(workers)]
    if fps:
        a += ["--fps", str(fps)]
    if resolution:
        a += ["--resolution", resolution]
    return a


def export(report_dir, stem, quality="looks", fps=None, fmt="mp4", host="auto", resolution=None, log=print):
    proj = project_dir(report_dir, stem)
    meta = comp_meta(proj)
    if fmt not in ("mp4", "webm", "mov", "gif"):
        raise MotionError("--format must be mp4, webm, mov or gif")
    out = proj / "renders" / (stem + "." + fmt)
    out.parent.mkdir(exist_ok=True)
    host = pick_host(host)
    log("rendering %s (%sx%s, %ss, %s, %s) on %s ..." % (stem, meta["width"], meta["height"],
                                                         meta["duration"] or "?", quality, fmt, host))
    if host == "local":
        r = run_hf(["render", str(proj), "-o", str(out)] + render_args(quality, fps, fmt, resolution, 3),
                   capture=True, timeout=3600)
        if r.returncode != 0:
            raise MotionError("render failed:\n" + (r.stdout + r.stderr)[-3000:])
        tail = (r.stdout + r.stderr).strip()
    else:
        tail = remote_render(host, proj, stem, out, render_args(quality, fps, fmt, resolution, 6))
    if not out.is_file():
        raise MotionError("render produced no file: %s" % out)
    return out, host, tail


REMOTE_SETUP = r"""set -e
R=$HOME/.local/share/dsh-motion
if [ ! -x "$R/node_modules/.bin/hyperframes" ]; then
  mkdir -p "$R"; cd "$R"; [ -f package.json ] || npm init -y >/dev/null
  PUPPETEER_SKIP_DOWNLOAD=1 npm i --no-audit --no-fund hyperframes@%(ver)s >/dev/null 2>&1
fi
if ! command -v ffprobe >/dev/null 2>&1 && [ ! -x "$R/bin/ffprobe" ]; then
  # static ffmpeg+ffprobe (no sudo needed); johnvansickle.com builds, GPL
  mkdir -p "$R/bin" "$R/tmp"; cd "$R/tmp"
  curl -fsSL -o ff.tar.xz https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz
  tar -xJf ff.tar.xz && cp ffmpeg-*-static/ffmpeg ffmpeg-*-static/ffprobe "$R/bin/" && cd "$R" && rm -rf "$R/tmp"
fi
export PATH="$R/bin:$PATH"
B=$(ls -d $HOME/.cache/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell $HOME/.cache/ms-playwright/chromium_headless_shell-*/*/headless_shell 2>/dev/null | tail -1 || true)
[ -n "$B" ] && export HYPERFRAMES_BROWSER_PATH="$B"
export HF_CLI_TELEMETRY_DISABLED=1 HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1
cd "$HOME/.cache/dsh-motion/jobs/%(stem)s"
nice -n 10 "$R/node_modules/.bin/hyperframes" render . -o "renders/%(file)s" %(args)s
"""


def remote_render(host, proj, stem, out, args):
    job = ".cache/dsh-motion/jobs/%s/" % stem
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host]
    subprocess.run(ssh + ["mkdir -p " + job], check=True)
    subprocess.run(["rsync", "-a", "--delete", "--exclude", "renders/", "--exclude", ".hyperframes/",
                    "--exclude", ".snapshots/", str(proj) + "/", "%s:%s" % (host, job)], check=True)
    script = REMOTE_SETUP % {"ver": HF_VERSION, "stem": stem, "file": out.name,
                             "args": " ".join(shlex.quote(a) for a in args)}
    r = subprocess.run(ssh + ["bash -s"], input=script, capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise MotionError("remote render on %s failed:\n%s" % (host, (r.stdout + r.stderr)[-3000:]))
    subprocess.run(["rsync", "-a", "%s:%srenders/%s" % (host, job, out.name), str(out)], check=True)
    return (r.stdout + r.stderr).strip()


# -- check / snapshot ---------------------------------------------------------

def check(report_dir, stem, extra=()):
    proj = project_dir(report_dir, stem)
    r = run_hf(["check", str(proj)] + list(extra), capture=True, timeout=600)
    return r.returncode, (r.stdout + r.stderr).strip()


def snapshot(report_dir, stem, at=None, frames=None):
    proj = project_dir(report_dir, stem)
    outd = proj / ".snapshots"
    if outd.exists():
        shutil.rmtree(outd)
    args = ["snapshot", str(proj), "-o", str(outd), "--describe", "false"]
    if at:
        args += ["--at", str(at)]
    if frames:
        args += ["--frames", str(frames)]
    r = run_hf(args, capture=True, timeout=600)
    if r.returncode != 0:
        raise MotionError("snapshot failed:\n" + (r.stdout + r.stderr)[-2000:])
    return sorted(str(p) for p in outd.rglob("*.png"))


def probe_duration(path):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                       capture_output=True, text=True)
    try:
        return round(float(r.stdout.strip()), 2)
    except ValueError:
        return None
