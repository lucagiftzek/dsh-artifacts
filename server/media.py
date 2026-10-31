"""dsh-artifacts media + AI backends.

Used two ways:
  * by the artifact server (DSH proxy process) for window.dsh.ai / .image / .tts /
    .video / .transcribe calls made from inside an artifact, and
  * by the 'artifact' CLI for agents (artifact media image "..." etc.).

Routes, chosen for "already paid for" first (2026-10 state of this install):
  ai     Mistral chat on the Vibe SUBSCRIPTION key (MISTRAL_VIBE_API_KEY);
         qwen*/deepseek*/glm* model ids go to the Alibaba token plan.
  image  mistral  : Mistral Agents image_generation tool (FLUX), Vibe key, ~7 s  [default]
         dashscope: qwen-image-3.0-pro on the Alibaba token plan
         local    : ComfyUI on the GTX 1070 (sdxl-lightning ~15 s, flux-schnell ~3 min)
  tts    Mistral Voxtral TTS (voxtral-mini-tts-latest)
  stt    Mistral Voxtral (voxtral-mini-latest)
  video  local    : ComfyUI wan22-t2v, 2 s animated WebP, 11-20 min           [default, free]
         gemini   : gemini-omni-flash-preview (Interactions API) -- METERED Google
                    key, opt-in only (provider:"gemini")
BytePlus Seedream/Seedance are NOT wired: pay-as-you-go was closed on purpose
2026-10-02 and the Coding Plan does not serve media.

Secrets are read at call time from the usual files and never logged or returned.
"""
import base64
import json
import os
import random
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

HOME = Path.home()
REPORT_DIR = Path(os.environ.get("ARTIFACT_DIR", str(HOME / "reports"))).resolve()
MEDIA = REPORT_DIR / "media"
STORE = REPORT_DIR / ".artifacts"
STATE_FILE = STORE / "media-state.json"
PREFIX = "/report/"
CRED_FILES = [HOME / ".config" / d / "credentials" for d in
              ("mistral", "alibaba-bailian", "googleai", "deepseek")] \
    + [HOME / ".config" / d.strip() / "credentials" for d in os.environ.get("DSH_ARTIFACTS_CRED_DIRS", "").split(",") if d.strip()] \
    + [Path("/etc/dsh/voice-extra.env")]
DSH_CREDS = HOME / ".dsh" / ".credentials.yaml"
CORDIS = HOME / ".dsh" / "profiles" / "web" / "cordis.patch.yml"
COMFY = os.environ.get("COMFYUI_URL", "http://127.0.0.1:8188")
DASHSCOPE = "https://token-plan.ap-southeast-1.maas.aliyuncs.com/api/v1"

_jobs = {}
_rate = {}
_lock = threading.Lock()


class MediaError(Exception):
    pass


# -- credentials ---------------------------------------------------------------

def cred(name):
    v = os.environ.get(name)
    if v:
        return v
    for f in CRED_FILES:
        try:
            for line in f.read_text(encoding="utf-8").splitlines():
                m = re.match(r"\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$", line)
                if m and m.group(1) == name:
                    return m.group(2).strip().strip("'\"")
        except OSError:
            continue
    try:
        import yaml
        refs = (yaml.safe_load(DSH_CREDS.read_text(encoding="utf-8")) or {}).get("refs") or {}
        v = refs.get(name)
        if isinstance(v, str) and v:
            return v
    except Exception:
        pass
    return None


def _http(url, body=None, headers=None, method=None, timeout=120, raw=False):
    data = None
    h = dict(headers or {})
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        else:
            data = json.dumps(body).encode()
            h.setdefault("content-type", "application/json")
    req = urllib.request.Request(url, data=data, headers=h, method=method or ("POST" if data is not None else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            b = r.read()
            return b if raw else json.loads(b.decode() or "{}")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")[:400]
        for k in ("MISTRAL_VIBE_API_KEY", "MISTRAL_API_KEY", "ALIBABA_BAILIAN_API_KEY", "DASHSCOPE_API_KEY", "GOOGLE_AI_STUDIO_KEY"):
            s = cred(k)
            if s:
                txt = txt.replace(s, "<redacted>")
        raise MediaError("HTTP %s from %s: %s" % (e.code, url.split("?")[0], txt))
    except urllib.error.URLError as e:
        raise MediaError("cannot reach %s: %s" % (url.split("?")[0], e.reason))


def _state():
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {}


def _save_state(s):
    STORE.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(s))


def _rate_ok(kind, per_min):
    now = time.time()
    with _lock:
        q = [t for t in _rate.get(kind, []) if now - t < 60]
        if len(q) >= per_min:
            return False
        q.append(now)
        _rate[kind] = q
    return True


def _slug(text, n=40):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "media").lower()).strip("-")[:n].strip("-")
    return s or "media"


def save_media(data, ext, hint, name=None):
    MEDIA.mkdir(parents=True, exist_ok=True)
    if name:
        fname = re.sub(r"[^A-Za-z0-9._-]+", "-", name)
        if not fname.lower().endswith("." + ext):
            fname += "." + ext
    else:
        fname = "%s-%s.%s" % (_slug(hint), time.strftime("%m%d-%H%M%S"), ext)
    p = MEDIA / fname
    p.write_bytes(data)
    os.chmod(p, 0o644)
    rel = "media/" + fname
    return {"url": PREFIX + rel, "path": str(p), "name": rel, "bytes": len(data)}


def _sniff(data):
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[:4] == b"GIF8":
        return "gif"
    if data[4:8] == b"ftyp":
        return "mp4"
    if data[:4] == b"\x1aE\xdf\xa3":
        return "webm"
    if data[:3] == b"ID3" or data[:2] in (b"\xff\xfb", b"\xff\xf3"):
        return "mp3"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "wav"
    return "bin"


# -- text AI -----------------------------------------------------------------------

def ai(prompt=None, system=None, model=None, json_mode=False, max_tokens=None, messages=None):
    model = (model or "mistral-small-latest").strip()
    msgs = []
    if system:
        msgs.append({"role": "system", "content": str(system)[:20000]})
    if messages and isinstance(messages, list):
        for m in messages[-40:]:
            if isinstance(m, dict) and m.get("role") in ("user", "assistant", "system"):
                msgs.append({"role": m["role"], "content": str(m.get("content", ""))[:40000]})
    if prompt:
        msgs.append({"role": "user", "content": str(prompt)[:60000]})
    if not msgs:
        raise MediaError("ai: empty prompt")
    body = {"model": model, "messages": msgs, "max_tokens": max(16, min(int(max_tokens or 1500), 8000))}
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    if re.match(r"^(qwen|deepseek|glm)", model):
        key, base = cred("ALIBABA_BAILIAN_API_KEY"), cred("ALIBABA_BAILIAN_BASE_URL")
        if not key or not base:
            raise MediaError("ai: Alibaba token plan not configured")
    else:
        key, base = cred("MISTRAL_VIBE_API_KEY") or cred("MISTRAL_API_KEY"), "https://api.mistral.ai/v1"
        if not key:
            raise MediaError("ai: no Mistral key configured")
    d = _http(base.rstrip("/") + "/chat/completions", body, {"authorization": "Bearer " + key}, timeout=180)
    try:
        text = d["choices"][0]["message"]["content"]
    except Exception:
        raise MediaError("ai: unexpected response shape")
    if isinstance(text, list):
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    out = {"text": text, "model": d.get("model", model), "usage": d.get("usage")}
    if json_mode:
        try:
            out["json"] = json.loads(text)
        except Exception:
            pass
    return out


# -- image -----------------------------------------------------------------------

def _mistral_image_agent(key):
    st = _state()
    if st.get("mistral_image_agent"):
        return st["mistral_image_agent"]
    a = _http("https://api.mistral.ai/v1/agents", {
        "model": "mistral-medium-latest", "name": "dsh-artifacts-image",
        "instructions": "You generate images. Always call the image generation tool exactly once with a faithful, detailed prompt. Do not refuse stylistic requests.",
        "tools": [{"type": "image_generation"}]}, {"authorization": "Bearer " + key})
    st["mistral_image_agent"] = a["id"]
    _save_state(st)
    return a["id"]


def image_mistral(prompt, **_):
    key = cred("MISTRAL_VIBE_API_KEY") or cred("MISTRAL_API_KEY")
    if not key:
        raise MediaError("image: no Mistral key")
    for attempt in (1, 2):
        agent = _mistral_image_agent(key)
        try:
            c = _http("https://api.mistral.ai/v1/conversations",
                      {"agent_id": agent, "inputs": "Generate this image: " + prompt, "store": False},
                      {"authorization": "Bearer " + key}, timeout=240)
            break
        except MediaError as e:
            if attempt == 1 and ("404" in str(e) or "agent" in str(e).lower()):
                st = _state()
                st.pop("mistral_image_agent", None)
                _save_state(st)
                continue
            raise
    url = fid = None
    for o in c.get("outputs", []):
        info = o.get("info") or {}
        if isinstance(info.get("result"), str):
            try:
                url = url or json.loads(info["result"]).get("url")
            except Exception:
                pass
        content = o.get("content")
        if isinstance(content, list):
            for ch in content:
                if isinstance(ch, dict) and ch.get("type") == "tool_file":
                    fid = fid or ch.get("file_id")
    if fid:
        data = _http("https://api.mistral.ai/v1/files/%s/content" % fid, headers={"authorization": "Bearer " + key}, raw=True)
    elif url:
        data = _http(url, raw=True, timeout=120)
    else:
        raise MediaError("image: Mistral returned no image (the model may have refused)")
    return data


def image_dashscope(prompt, size=None, **_):
    key = cred("DASHSCOPE_API_KEY") or cred("ALIBABA_BAILIAN_API_KEY")
    if not key:
        raise MediaError("image: no DashScope key")
    body = {"model": "qwen-image-3.0-pro", "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
            "parameters": {"size": size.replace("x", "*")} if size else {}}
    d = _http(DASHSCOPE + "/services/aigc/multimodal-generation/generation", body, {"authorization": "Bearer " + key}, timeout=240)
    for item in ((d.get("output") or {}).get("choices") or [{}])[0].get("message", {}).get("content", []):
        u = item.get("image") or item.get("image_url") or item.get("url")
        if u:
            return _http(u, raw=True)
    raise MediaError("image: DashScope returned no image")


def _comfy_workflows():
    try:
        import yaml
        rows = yaml.safe_load(CORDIS.read_text(encoding="utf-8")) or []
        for r in rows if isinstance(rows, list) else []:
            if isinstance(r, dict) and r.get("id") == "image-gen":
                return {w["name"]: w["json"] for w in (r.get("config") or {}).get("comfyuiWorkflows", [])}
    except Exception:
        pass
    return {}


def comfy_run(workflow, prompt, timeout=3600):
    wfs = _comfy_workflows()
    if workflow not in wfs:
        raise MediaError("ComfyUI workflow %r not configured (have: %s)" % (workflow, ", ".join(wfs) or "none"))
    seed = random.randint(1, 2**31 - 1)
    graph = json.loads(wfs[workflow].replace("{{prompt}}", json.dumps(prompt)[1:-1]).replace('"{{seed}}"', str(seed)).replace("{{seed}}", str(seed)))
    r = _http(COMFY + "/prompt", {"prompt": graph, "client_id": "dsh-artifacts"}, timeout=30)
    pid = r.get("prompt_id")
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(3)
        h = _http(COMFY + "/history/" + pid, timeout=30)
        if pid in h:
            outs = h[pid].get("outputs", {})
            for node in outs.values():
                for k in ("videos", "gifs", "images"):
                    for f in node.get(k, []) or []:
                        q = "filename=%s&subfolder=%s&type=%s" % (urllib.request.quote(f["filename"]), urllib.request.quote(f.get("subfolder", "")), f.get("type", "output"))
                        return _http(COMFY + "/view?" + q, raw=True, timeout=120)
            status = h[pid].get("status", {})
            if status.get("status_str") == "error":
                raise MediaError("ComfyUI job failed")
    raise MediaError("ComfyUI job timed out")


def image(prompt, provider=None, size=None, name=None, workflow=None, **_):
    if not prompt or not str(prompt).strip():
        raise MediaError("image: empty prompt")
    if not _rate_ok("image", 12):
        raise MediaError("image: rate limited (12/min)")
    order = [provider] if provider else ["mistral", "dashscope", "local"]
    errors = []
    for p in order:
        try:
            if p == "mistral":
                data = image_mistral(prompt)
            elif p == "dashscope":
                data = image_dashscope(prompt, size=size)
            elif p in ("local", "comfyui"):
                data = comfy_run(workflow or "sdxl-lightning", prompt, timeout=600)
            else:
                raise MediaError("unknown image provider %r (mistral|dashscope|local)" % p)
            out = save_media(data, _sniff(data) if _sniff(data) != "bin" else "png", prompt, name)
            out["provider"] = p
            return out
        except MediaError as e:
            errors.append("%s: %s" % (p, e))
    raise MediaError("image failed - " + " | ".join(errors))


# -- speech ---------------------------------------------------------------------------

def tts(text, voice=None, name=None, **_):
    if not text or not str(text).strip():
        raise MediaError("tts: empty text")
    if not _rate_ok("tts", 20):
        raise MediaError("tts: rate limited (20/min)")
    voice = voice if voice and re.match(r"^[a-z]{2}_[a-z]+_[a-z]+$", str(voice)) else "gb_oliver_neutral"
    errs = []
    for kname in ("MISTRAL_VIBE_API_KEY", "MISTRAL_API_KEY"):
        key = cred(kname)
        if not key:
            continue
        try:
            d = _http("https://api.mistral.ai/v1/audio/speech",
                      {"model": "voxtral-mini-tts-latest", "input": str(text)[:8000], "voice": voice},
                      {"authorization": "Bearer " + key}, timeout=180)
            b64 = d.get("audio_data") or d.get("audio") or ""
            if not b64:
                raise MediaError("no audio_data in response")
            out = save_media(base64.b64decode(b64), "mp3", text, name)
            out["provider"] = "mistral-voxtral"
            return out
        except MediaError as e:
            errs.append(str(e))
    raise MediaError("tts failed - " + " | ".join(errs) if errs else "tts: no Mistral key")


def voices():
    key = cred("MISTRAL_VIBE_API_KEY") or cred("MISTRAL_API_KEY")
    try:
        return _http("https://api.mistral.ai/v1/audio/voices", headers={"authorization": "Bearer " + key})
    except MediaError as e:
        return {"error": str(e)}


def stt(audio_bytes, mime="audio/webm", filename=None, **_):
    if not audio_bytes:
        raise MediaError("stt: no audio")
    if len(audio_bytes) > 40_000_000:
        raise MediaError("stt: audio over 40 MB")
    key = cred("MISTRAL_VIBE_API_KEY") or cred("MISTRAL_API_KEY")
    b = "----dsh" + uuid.uuid4().hex
    ext = (mime or "audio/webm").split("/")[-1].split(";")[0]
    parts = [("--%s\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nvoxtral-mini-latest\r\n" % b).encode(),
             ("--%s\r\nContent-Disposition: form-data; name=\"file\"; filename=\"%s\"\r\nContent-Type: %s\r\n\r\n"
              % (b, filename or "audio." + ext, mime or "audio/webm")).encode(), audio_bytes, ("\r\n--%s--\r\n" % b).encode()]
    d = _http("https://api.mistral.ai/v1/audio/transcriptions", b"".join(parts),
              {"authorization": "Bearer " + key, "content-type": "multipart/form-data; boundary=" + b}, timeout=300)
    return {"text": d.get("text", ""), "language": d.get("language")}


# -- video ------------------------------------------------------------------------------

def video_gemini(prompt, seconds=6, **_):
    key = cred("GOOGLE_AI_STUDIO_KEY") or cred("GEMINI_API_KEY")
    if not key:
        raise MediaError("video: no Google AI Studio key")
    body = {"model": "gemini-omni-flash-preview", "response_modalities": ["video"],
            "input": [{"type": "text", "text": "Generate a %d second video clip. %s No on-screen text or watermarks." % (int(seconds), prompt)}]}
    d = _http("https://generativelanguage.googleapis.com/v1beta/interactions?key=" + key, body, timeout=1800)
    for s in d.get("steps", []):
        for c in (s.get("content") or []) + ([s] if s.get("type") == "video" else []):
            if c.get("type") == "video" and c.get("data"):
                return base64.b64decode(c["data"])
    raise MediaError("video: Gemini returned no video")


def video(prompt, provider=None, name=None, seconds=6, **_):
    if not prompt:
        raise MediaError("video: empty prompt")
    p = provider or "local"
    if p == "gemini":
        data = video_gemini(prompt, seconds=seconds)
    elif p in ("local", "comfyui"):
        data = comfy_run("wan22-t2v", prompt, timeout=3600)
    else:
        raise MediaError("unknown video provider %r (local|gemini)" % p)
    out = save_media(data, _sniff(data) if _sniff(data) != "bin" else "mp4", prompt, name)
    out["provider"] = p
    return out


# -- capabilities --------------------------------------------------------------------------

def capabilities():
    have_m = bool(cred("MISTRAL_VIBE_API_KEY") or cred("MISTRAL_API_KEY"))
    return {
        "ai": {"default": "mistral-small-latest", "available": have_m,
               "models": ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest", "magistral-medium-latest",
                          "codestral-latest", "qwen3.8-flash (Alibaba plan)", "deepseek-v4-pro (Alibaba plan)"]},
        "image": {"providers": ["mistral (default, ~7 s)", "dashscope (qwen-image, Alibaba plan)", "local (ComfyUI sdxl-lightning ~15 s)"], "available": have_m},
        "tts": {"provider": "mistral voxtral", "voices": "en_us/en_gb, e.g. gb_oliver_neutral", "available": have_m},
        "stt": {"provider": "mistral voxtral", "available": have_m},
        "video": {"providers": ["local (ComfyUI wan22, 2 s WebP, 11-20 min, free)", "gemini (omni, metered - opt-in)"], "async": True},
        "music": {"available": False, "note": "no music backend configured"},
        "unavailable": ["BytePlus Seedream/Seedance (pay-as-you-go closed 2026-10-02)", "Claude subscription has no media generation"],
    }


# -- jobs (async in the proxy) -----------------------------------------------------------------

def start_job(fn, kwargs, on_done=None):
    jid = uuid.uuid4().hex[:12]
    _jobs[jid] = {"status": "running", "started": time.time()}

    def run():
        try:
            res = fn(**kwargs)
            _jobs[jid].update(status="done", **res)
            if on_done:
                on_done(res)
        except Exception as e:
            _jobs[jid].update(status="failed", error=str(e)[:400])
    threading.Thread(target=run, daemon=True, name="media-job").start()
    return jid


# -- HTTP entry (artifact server) -------------------------------------------------------------

def handle(h, method, route, q, body, send_json, add_claim, owner_session):
    g = lambda k, d=None: (q.get(k) or [d])[0]
    try:
        if route == "capabilities":
            return send_json(h, 200, capabilities(), method)
        if route == "job":
            j = _jobs.get(g("id") or "")
            return send_json(h, 200 if j else 404, j or {"error": "no such job"}, method)
        if method != "POST":
            return send_json(h, 405, {"error": "POST required"}, method)
        session = body.get("session") or owner_session(body.get("name") or "")

        def claim(res):
            if session and res.get("name"):
                add_claim(res["name"], session, "media")

        if route == "ai":
            if not _rate_ok("ai", 30):
                return send_json(h, 429, {"error": "ai: rate limited (30/min)"}, method)
            return send_json(h, 200, ai(prompt=body.get("prompt"), system=body.get("system"), model=body.get("model"),
                                        json_mode=bool(body.get("json")), max_tokens=body.get("maxTokens"),
                                        messages=body.get("messages")), method)
        kind = body.get("kind")
        if kind == "image":
            res = image(body.get("prompt"), provider=body.get("provider"), size=body.get("size"), name=body.get("filename"))
            claim(res)
            return send_json(h, 200, res, method)
        if kind == "tts":
            res = tts(body.get("text"), voice=body.get("voice"), name=body.get("filename"))
            claim(res)
            return send_json(h, 200, res, method)
        if kind == "stt":
            return send_json(h, 200, stt(base64.b64decode(body.get("audio") or ""), mime=body.get("mime")), method)
        if kind == "video":
            jid = start_job(video, {"prompt": body.get("prompt"), "provider": body.get("provider"),
                                    "name": body.get("filename"), "seconds": body.get("seconds") or 6}, claim)
            return send_json(h, 202, {"job": jid, "status": "running"}, method)
        if kind == "music":
            return send_json(h, 501, {"error": "no music backend configured"}, method)
        return send_json(h, 400, {"error": "unknown media kind %r" % kind}, method)
    except MediaError as e:
        return send_json(h, 502, {"error": str(e)}, method)
