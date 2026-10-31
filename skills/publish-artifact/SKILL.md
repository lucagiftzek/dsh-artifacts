---
name: publish-artifact
description: Publish a deliverable (report, dashboard, plan, comparison, doc, interactive tool, mini web app, media) as an artifact in ~/reports/ that opens in the Artifacts sidebar tab and at https://dsh.example.com/report/<name>. Covers the cheap Markdown path, React/HTML apps, two-way interaction with the chat, versions/undo, and image/audio/video generation. Load it whenever the deliverable is more than a one-screen answer.
---

# Publishing artifacts (dsh-artifacts v2)

Artifacts are files in **~/reports/**. Whatever you write there shows up in the
**Artifacts** sidebar tab under "This chat" within ~2 s (attribution is automatic
for write/edit/bash and the artifact CLI, subagents included), is versioned on
every change, and is served at https://dsh.example.com/report/<name>.

Reply with the URL as a markdown link plus one or two sentences. Never paste the
contents into the chat too. Never put secrets in an artifact.

## 1 - Pick the cheapest form that does the job

| Need | Write | URL |
|---|---|---|
| report, dashboard, plan, comparison, brief | ~/reports/<name>.md | /report/<name>.html |
| interactive choice / form / approval | .md with actions / form blocks | same |
| custom single page, visual, tool | ~/reports/<name>.html | /report/<name>.html |
| real web app (state, components) | artifact new <name> --type react | /report/<name>/ |
| image / speech / video file | artifact media ... | /report/media/<file> |

**Markdown is the default.** The server renders it on the fly with artifact-kit
(themed, light/dark, responsive). There is no render step: write the .md, link
the .html. Starters: artifact new <name> --type report|dashboard|plan|comparison|brief|interactive.

## 2 - Token discipline (this is the point)

- **Edit, don't rewrite.** Change an artifact with the edit tool (exact-match
  replace) on the .md / app.jsx. Every save live-reloads the open preview. Never
  regenerate a whole file to change a few lines.
- **Do not re-read your own artifact** to "check" it. If you need the current
  text of a small region, read with offset/limit.
- **Data apart from layout.** For apps, keep data in storage or a data.json and
  push updates with artifact state-set <name> <key> <json> - the page updates
  itself (dsh.storage.watch) without you touching the code.
- **Reference, don't resend.** The user can pick an element in the sidebar and
  ask about it; you receive "[artifact x.html - element <selector> ...] question".
  Edit just that part.
- Use local libraries (/report/_lib/...) instead of inlining library code. Never a CDN.

## 3 - Markdown components (artifact help md for the full list)

    ```kpi                 Label | Value | note | good|bad
    ```chart bar|hbar|line|pie|donut   CSV, first column = labels
    ```callout info|ok|warn|risk       ```timeline   when | what | detail
    ```progress            Label | value | max | note
    ```columns             blocks separated by a line '||'
    ```details Title       collapsible       ```mermaid / ```math (KaTeX)
    ```actions             Label | message to send to the chat | context
    ```form Title [context] Label | text|textarea|number|date|select a/b|radio a/b|check a/b|range 0-10

Front matter: title, subtitle, template (report|dashboard|plan|comparison|brief),
status, date, width (narrow|normal|wide|full), toc, accent. Media: ![cap](media/x.png),
[audio](media/x.mp3) and .mp4/.webm links become players.

## 4 - Two-way interaction

From the artifact to the chat:
- actions buttons and form blocks (no JS). Default = sends a user message into
  this chat (prefixed "[from artifact <name>]"). With "context" the payload is
  stored silently instead.
- In HTML/apps: dsh.send(text), dsh.context(obj), <button data-dsh-send="...">,
  <form data-dsh-form="submit|context">.
- Silent items, form answers and **runtime errors** land in the inbox: run
  artifact inbox (add --clear once handled) when the user says they filled
  something in, or when a page misbehaves.

From the chat to the artifact: edit the file (live reload), or
artifact state-set <name> <key> <json> for live data.

## 5 - Apps and hand-written HTML

    artifact new my-tool --type react    # my-tool/index.html + my-tool/app.jsx

React 18 + Tailwind + in-browser JSX are pre-wired; edit only app.jsx.
window.dsh in every served page (artifact help bridge):
dsh.storage.get/set/delete/list/watch (persistent, server-side), dsh.ai(prompt,
{json:true}) (LLM call, key stays server-side), dsh.image(prompt), dsh.tts(text),
dsh.transcribe(blob), dsh.video(prompt), dsh.send, dsh.context.
Claude-style window.claude.complete and window.storage, and OpenAI-style
window.openai.sendFollowUpMessage also work. Libraries: artifact libs
(react, recharts, tailwind, preact-htm, chart.js, d3, three, mermaid, katex,
lucide, marked, papaparse, leaflet). Multi-file apps are directories with an
index.html; .js/.css/.json/media inside are served.

## 6 - Media

    artifact media image "<prompt>" [--provider mistral|dashscope|local] [--name f]
    artifact media tts "<text>" [--voice gb_oliver_neutral]
    artifact media stt <audio-file>
    artifact media video "<prompt>"            # local ComfyUI, free, ~2 s clip, 10-20 min
    artifact media video "<prompt>" --provider gemini   # METERED: only if the user asked

Image = Mistral (FLUX, ~8 s, subscription) by default. Text AI inside apps =
Mistral (subscription). BytePlus Seedream/Seedance are not available
(pay-as-you-go closed on purpose) and Claude has no media generation.

## 7 - Housekeeping

- artifact list, artifact show <name>, artifact versions|diff|restore <name> -
  every change is snapshotted (40 per file); the sidebar has the same history
  with Preview / Source / Changes.
- Public no-login link: artifact public <name> on -> /report-public/<name>.
  Re-check for secrets and private data first.
- Name files after the thing (q3-margin-analysis.md), not the session or date.
- Always include the extension in the URL.
