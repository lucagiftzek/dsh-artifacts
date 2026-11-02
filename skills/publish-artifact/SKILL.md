---
name: publish-artifact
description: Publish a deliverable (report, dashboard, plan, comparison, doc, interactive tool, mini web app, media) as an artifact in ~/reports/ that opens in the Artifacts sidebar tab and at https://dsh.example.com/report/<name>. Covers the cheap Markdown path, React/HTML apps, listing any file you produced (images, video, audio, PDF, CSV, zip, Office files) with a viewer page and direct download, de-listing, two-way interaction with the chat, versions/undo, and image/audio/video generation. Load it whenever the deliverable is more than a one-screen answer.
---

# Publishing artifacts (dsh-artifacts v2)

Artifacts are files in **~/reports/**. Whatever you write there shows up in the
**Artifacts** sidebar tab under "This chat" within ~2 s (attribution is automatic
for write/edit/bash and the artifact CLI, subagents included), is versioned on
every change, and is served at https://dsh.example.com/report/<name>.

Reply with the URL as a markdown link plus one or two sentences. Never paste the
contents into the chat too. Never put secrets in an artifact.

## 0. Templates first (always the first step)

Before writing any deliverable, list the templates and pick a fitting one. A template is a finished, tested
layout: you write only a small JSON data object, it is validated and the page is published. That costs a few
KB of output instead of a whole page, and every deliverable of a kind looks the same.

With the agent tools (registered by the dsh-artifacts plugin, preferred):

    artifact_templates({ query? })                         # id, title, kind, purpose, when, not_for, required fields, source
    artifact_template_info({ id })                         # schema, example, minimal example, field table, README summary
    artifact_from_template({ name, template, data })       # validate, fill, write; returns path and url (check: true validates only)
    artifact_template_save({ id, title, kind, purpose, when, schema, example, files, readme })   # save a new layout

The same with the CLI (works everywhere the plugin is installed):

    artifact templates                          # id, purpose, data fields, preview link of each template
    artifact template-info <id>                 # field list + minimal example (add --json for the schema)
    artifact new <name> --template <id> --data /tmp/<name>.json [--check] [--force] [--json]
    artifact template-save <spec.json>          # same fields as artifact_template_save

Bundled set: report-text (memo, long prose), article (photos, charts, quotes, sources), dashboard
(KPI tiles, charts, table), review-queue (approve/edit/reject a list), video-explainer (animated
explainer to MP4), video-page (player page with chapters for an existing MP4). Templates are read from
$ARTIFACT_TEMPLATES, ~/estate/templates/artifacts, the user library ~/.dsh/artifacts/templates, then the
plugin's templates/ folder (first match per id wins).

- Image and video fields take local paths; they are copied next to the artifact. Bad data is refused with one
  problem per field (tool: `errors[{field, problem}]`, CLI: exit 2): fix and call again. Nothing is written.
- Small later changes: edit the generated `~/reports/<name>.md` (or `<name>/data.json` for react templates).
  Changed numbers: update the data and call again with `force: true` (CLI `--force`).
- Generate from scratch (sections below) only when nothing fits. If the layout will come back, save it as a
  template with `artifact_template_save`: move the variable parts into a schema plus an example, the rest into
  template.md (markdown), index.html + app.jsx (react) or composition.html (motion). It is validated (schema,
  example, trial render, no secrets, size limits), written to the user library and listed at once.

## 0b. Files you produced: list them, do not describe them

Any file you made (a chart PNG, a rendered MP4, a recording, a PDF, a CSV export, a zip, a .docx or .xlsx) can be
an artifact. It opens in a themed page with the right viewer (image; video and audio players with seeking, poster
and waveform; PDF viewer; CSV/JSON as a table; first lines of text and code; entry list of archives and Office
files; size, type and sha256 for everything), a Download button and the version history.

    artifact_add({ path, title?, description?, slug?, mode? })   # copy (or mode "link": hardlink) into ~/reports,
                                                                # attached to this chat; returns url, download_url
    artifact_list({ scope?: "chat"|"all", kind?, query?, include_hidden? })   # what the tab lists, with URLs
    artifact_remove({ name })        # de-list: hidden from the tab, the file, versions and links stay
    artifact_add({ name })           # list a de-listed artifact again
    artifact_update({ name, title?, description? })   # title / description in the tab and on the page

CLI: `artifact add <file> [--name slug] [--title t] [--link]`, `artifact remove <name>`, `artifact relist <name>`,
`artifact retitle <name> --title t`, `artifact list --json [--hidden] [--kind video]`.

- A file written straight into ~/reports is listed automatically; `artifact_add` is for files elsewhere (and to
  set a title). Text files with a credential-shaped string are refused; HTML from outside ~/reports is served
  sandboxed (no script) unless `trusted: true`.
- De-list drafts, scratch files and superseded versions instead of leaving them in the user's list.
- Links: give the user `url` (`/report/<file>`, the viewer page). Direct download: `<url>?download=1` or
  `<url>/download` (original bytes and name); Markdown has both `<name>.md?download=1` (source) and
  `<name>.html?download=1` (rendered page). Embeds (`<img>`, `<video>`, fetch) get the bytes; `?raw=1` forces
  the bytes in a browser tab.
- Types: png jpg webp gif avif bmp svg (SVG only ever as an image), mp4 webm mov mkv, mp3 m4a ogg opus wav flac,
  pdf, csv tsv json jsonl txt log and code, zip tar gz 7z, docx xlsx pptx odt ods epub and more; anything else is
  refused with the list.

## 1 - Pick the cheapest form that does the job

| Need | Write | URL |
|---|---|---|
| report, dashboard, plan, comparison, brief | ~/reports/<name>.md | /report/<name>.html |
| interactive choice / form / approval | .md with actions / form blocks | same |
| custom single page, visual, tool | ~/reports/<name>.html | /report/<name>.html |
| real web app (state, components) | artifact new <name> --type react | /report/<name>/ |
| image / speech / video file | artifact media ... | /report/media/<file> |
| a file you produced elsewhere | artifact_add({ path }) | /report/<file> |

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
    ```chart bar|hbar|line|pie|donut [title]   CSV, first column = labels
    ```callout info|ok|warn|risk       ```timeline   when | what | detail
    ```progress            Label | value | max | note
    ```columns [2|3|4]     blocks separated by a line '||'
    ```figure [hero|wide]  src | caption | credit (2+ lines = grid)   ```quote  text, '||', attribution
    ```lead                larger opening paragraph    footnotes: [^id] + a line "[^id]: note"
    ```details Title       collapsible       ```mermaid / ```math (KaTeX)
    ```actions             Label | message to send to the chat | context
    ```form Title [context] Label | text|textarea|number|date|select a/b|radio a/b|check a/b|range 0-10

Front matter: title, subtitle, template (report|dashboard|plan|comparison|brief|article),
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
  every change is snapshotted (40 per file, text and small media up to 1.5 MB);
  the sidebar has the same history with Preview / Source / Changes.
- Public no-login pages offer the download too (/report-public/<name>?download=1).
- Public no-login link: artifact public <name> on -> /report-public/<name>.
  Re-check for secrets and private data first.
- Name files after the thing (q3-margin-analysis.md), not the session or date.
- Always include the extension in the URL.
