# dsh-artifacts 2

Artifacts for the DeepSeek Harness web GUI: a sidebar tab, a server, a bridge and
a CLI that together turn ~/reports/ into a Claude/ChatGPT/Gemini-class artifact
system - with lower long-term token use, real web apps, two-way interaction with
the chat, version history, and image / speech / video generation.

    agent ──write/edit .md, .html, app/──▶ ~/reports/ ──▶ artifact server (in your DSH reverse proxy)
      ▲                                            │  md→html, apps, media, _lib, bridge, API
      │   artifact inbox / state                   ▼
      └──── chat ◀── dsh.send / forms / pick-and-ask ── Artifacts sidebar tab (iframe)

## What is in the box

| Part | Path | Role |
|---|---|---|
| Sidebar tab | src/client.jsx → lib/client.js | list (This chat / All, search, kinds), detail with Preview / Source / Changes, version arrows + restore, pick-and-ask, "Fix with agent", public toggle, trash, inbox banner; chat links to ~/reports/* open here rendered |
| Server module | server/artifacts_server.py | imported by your DSH reverse proxy; owns /report/ and /report-public/ |
| Indexer | server/indexer.py | niced child process: incremental transcript attribution + version snapshots |
| Bridge | server/bridge.js | injected into every served HTML page: window.dsh, Claude/OpenAI aliases, live reload |
| Media + AI | server/media.py | Mistral (Vibe subscription) chat + FLUX images, Voxtral TTS/STT, DashScope, local ComfyUI, Gemini video (opt-in) |
| Kit | contrib/artifact-kit | Markdown → themed HTML (kpi, charts, callouts, timeline, progress, columns, details, mermaid, math, actions, forms, media, figures, pull quotes, lead, footnotes; templates report, dashboard, plan, comparison, brief, article) |
| CLI | contrib/artifact | the agent interface: new, list, show, versions, diff, restore, inbox, state, state-set, public, media, libs, motion, export |
| Motion | contrib/motion.py + motion/ (npm: hyperframes) | animated explainers as code: `artifact new X --type motion` scaffolds X.html (player: scrubber, scene chips, timed change requests, export buttons, latest render) + X.motion/index.html (HyperFrames composition, one paused GSAP timeline); `artifact motion check/snapshot/voice/export`; renders locally or on a remote host over ssh+rsync (DSH_MOTION_REMOTE_HOSTS) |
| Templates | contrib/templates.py + templates/ (scripts/sync-templates.sh) | reusable layouts: `artifact templates`, `artifact template-info <id>`, `artifact new <name> --template <id> --data x.json` (JSON Schema validation, assets copied, `--json` output); read from $ARTIFACT_TEMPLATES, ~/estate/templates/artifacts, then the bundled templates/ copy (report-text, article, dashboard, review-queue, video-explainer, video-page) |
| Library shelf | vendor/ (scripts/vendor.sh) | React, ReactDOM, Babel, Recharts, Tailwind, preact-htm, Chart.js, d3, three, mermaid, KaTeX, lucide, marked, PapaParse, Leaflet, GSAP (+ plugins under gsap/), HyperFrames player/runtime at /report/_lib/ |
| Skill | skills/publish-artifact/SKILL.md | how agents should use all of the above |

## Why v2 (what was broken in v1)

1. **"This chat" was usually empty.** Attribution rescanned a chat's transcripts on
   every index request, keyed on the global file list (any new file anywhere forced
   a 10-100 s rescan; the client waited 2 s), and it ignored tool/ptc-dispatch-start
   rows whose arguments are objects - i.e. every write made from inside run_code.
   v2 tails each zstd transcript frame by frame from a stored cursor (full backfill
   of 892 MB: 75 s once; steady state: milliseconds) and also records explicit
   claims from the CLI ($DSH_SESSION_ID). Index requests are ~30 ms with ETag/304.
2. **The .md opened instead of the page.** .md requested by a browser now renders
   (?raw=1 or curl gets the source), md+html pairs are one artifact, /report/x.html
   is rendered on the fly from x.md, and chat links to ~/reports/* open the
   rendered artifact in the tab.
3. **Kit pages did not adapt to text length.** Long words, KPI values, table cells,
   headings and TOC entries now wrap; widths adapt to the content (wide tables get a
   wide page); chart label space is measured, long x labels rotate, labels with
   commas parse, ticks are round numbers.

## Token economics

- Templates before everything: a known kind of deliverable is a JSON data file (a few
  KB) filled into a finished layout, instead of a page written from scratch.
- Markdown first (35-40 % fewer output tokens than hand-written HTML on a typical
  report, far more with charts), rendered server-side: no render step, no HTML in
  context.
- Edit, never rewrite: every save is snapshotted and live-reloads the preview.
- state-set pushes data into a running app without touching its code.
- Pick-and-ask sends a compact reference (selector + heading + text) instead of
  the user pasting or the agent re-reading the page.
- Libraries are served locally, never inlined; the CLI + skill cost zero tokens
  per turn until used (no tool schemas in every request).

## Two-way protocol

Artifact → chat: dsh.send(text) / data-dsh-send / form blocks deliver a user
message into the owning chat through Idle Watchdog's prompt API (rate-limited,
6/min/chat). dsh.context(obj), "context" forms and runtime errors go to the inbox
(.artifacts/inbox/<session>.jsonl) that the agent reads with artifact inbox.
Chat → artifact: file edits (live reload) and artifact state-set (dsh.storage.watch).
Sidebar ↔ iframe (same-origin postMessage): dsh:ready, dsh:error, dsh:pick,
dsh:picked, dsh:compose, dsh:sent, dsh:session, dsh:highlight.

## HTTP API (/report/_api/, same auth as /report/; writes need X-Artifact-Api: 1)

index?session= · info?name= · raw?name=&v= · diff?name=&a=&b= · restore · public ·
trash · storage (GET ?name=&key= | ?list= ; POST {name,key,value|delete}) · send
{name,session,text,mode} · error · inbox (GET ?session= ; POST {clear}) · claim ·
ai · media {kind:image|tts|stt|video} · job?id= · capabilities.
/report/?list=1 keeps the v1 shape (items[].name/url/ext/size/mtime/mine).

## Storage layout (~/reports/.artifacts/, never served)

registry.json (indexer claims + session parents) · claims.jsonl (explicit claims) ·
cursors.json · versions/<quoted name>/<mtime_ns> (40 per file) · snapmeta.json ·
state/<name>.json · inbox/<session>.jsonl · trash/ · media-state.json · indexer.log

## Install / operate

- Client: node scripts/build.mjs (ESBUILD_MAIN=<sibling esbuild>); hot-reloaded by the GUI.
- Server: your DSH reverse proxy imports server/artifacts_server.py (falls back to its legacy
  /report/ handlers if the import fails) and spawns the indexer.
  Changes to server/*.py need restart that proxy (seconds; dsh-web
  is untouched). artifact-kit and bridge.js are reloaded on change automatically.
- Libraries: scripts/vendor.sh (vendor/ is git-ignored).
- Tests: node test/run.mjs (client SSR smoke, server/indexer unit tests, kit tests).

Security: same auth as the GUI (your login proxy, for example a forward-auth gate, plus the dsh cookie/token); closed extension
allowlist; dotfiles and .artifacts/ never served; API writes require a custom
header (forces a CORS preflight that is never answered). Artifacts are same-origin
with the GUI by design - they are written by your own agents.

MIT © Loukas "Luca" Tzekos

---

Built by Luca Tzekos, who also makes [**Job Opportunities API**](https://jobopportunitiesapi.org): employer-direct job data with per-field provenance you can verify yourself, free to read and available as an API. If this plugin is useful to you, a star on this repo or a look at [jobopportunitiesapi.org](https://jobopportunitiesapi.org) is the best thanks.
