# Changelog

## 2.2.0 (2026-11-02)

Media and plain files as first-class artifacts, listing control for agents, direct downloads everywhere.

- **Enclosure page** for images, video, audio, PDF, data, code and plain files: the artifact-kit theme, the right
  viewer (players with seeking, poster and waveform, PDF viewer, CSV/JSON tables, text heads, archive entries,
  .docx text, .xlsx rows), a details card (sha256, duration, dimensions, codecs), Download, version history.
  Browser navigations get the page, embeds get the bytes; `?view=1` / `?raw=1` force either.
- **Downloads**: `?download=1` and `<name>/download` on every file (attachment, original name, RFC 5987), Markdown
  as `.md` and as the rendered `.html`, old versions with `_api/raw?...&download=1`, the same on public pages.
  Download icon per row and download buttons in the tab. No `<a download>` anywhere (service workers such as
  dsh-seal never see those requests).
- **Listing control**: agent tools `artifact_list`, `artifact_add` (copy or hardlink any file into the folder,
  attach it to the calling chat, title and description), `artifact_remove` (de-list, reversible, nothing deleted),
  `artifact_update`; CLI `artifact add|remove|relist|retitle`, `artifact list --json --hidden --kind`. State in
  `.artifacts/listing.jsonl` (append only, shared by the proxy module and the node half). Tab: de-list button and
  a Hidden filter. The TypeScript index (`src/listing.ts`) is checked against the Python server by `test/listing.mjs`.
- **Serving**: one byte path for every file with Range, If-Range, ETag/304 and 416; `nosniff` also on 206 and
  streamed answers; raw SVG and XML (and HTML listed from outside the folder unless `trusted`) carry a sandbox CSP;
  plain files always download. Many more types on the closed allowlist (zip, tar, gz, 7z, Office, ODF, epub,
  parquet, jsonl, mkv, ...); they appear in the tab like any artifact.
- **Thumbnails**: WebP from ffmpeg (images, video poster, audio waveform) and pdftoppm (PDF), cached per file
  version, two at a time, niced, with timeouts; `ARTIFACT_THUMBS=0` turns them off.
- **Versions** also for small media and files (same 1.5 MB limit as text).
- New error codes `ARTIFACT_NOT_FOUND`, `ARTIFACT_AMBIGUOUS`, `ARTIFACT_ARGS_INVALID`, `ARTIFACT_SOURCE_INVALID`,
  `ARTIFACT_TYPE_UNSUPPORTED`, `ARTIFACT_FILE_TOO_LARGE`, `ARTIFACT_LINK_FAILED`; troubleshooting sections 7 to 9.
- Upgrade: the browser half reloads by itself and degrades against a 2.1 server (no thumbnails, old players);
  the tools need a `dsh web` restart and the server half a restart of the proxy that imports it.

## 2.1.0 (2026-11-01)

Templates for every agent on every install, and agents can create templates.

- **Agent tools** registered by the node half: `artifact_templates`, `artifact_template_info`,
  `artifact_from_template`, `artifact_template_save`. Lossless JSON results; failures carry a stable
  `ARTIFACT_*` code, a hint and a docs anchor ([docs/ERRORS.md](docs/ERRORS.md)). Results of
  `artifact_from_template` are attributed to the calling chat (Artifacts tab, "This chat").
- **Skill auto-registration**: `skills/publish-artifact` is registered with the host skill registry, so agents
  find it without a copy into `~/.dsh/skills` (a user copy still wins). Its first section is now "templates first"
  with the tools.
- **Safe loading**: `lib/index.js` keeps zero static imports and an empty static `inject`; the skill helper, the
  tools and the host's `@deepseek-ai/dsh-tools` are loaded with guarded dynamic imports and registered through
  runtime `ctx.inject`. Without the tools package the plugin loads, logs one `ARTIFACT_TOOLS_UNAVAILABLE` line and
  registers no tool. Kill switch: `DSH_ARTIFACTS_TOOLS=0`. Default export `{ name, inject, apply }` added.
- **Template engine in TypeScript** (`src/engine` built into `lib/engine`), replacing `contrib/templates.py`.
  Output is byte-identical to the Python engine on every bundled template (`test/parity.mjs` checks it against the
  Python reference from git history). Installs need neither Python nor a build step for templates.
- **User template library** `${DSH_HOME:-~/.dsh}/artifacts/templates`, searched after
  `~/estate/templates/artifacts` and before the bundled copy. Agents save there by default
  (`ARTIFACT_TEMPLATES_WRITE` or the first writable `ARTIFACT_TEMPLATES` entry override it); the bundled copy is
  never written. Saves are validated as a whole (id, schema, example, trial render, paths, secrets, size limits)
  in a staging folder and swapped in atomically.
- **CLI**: template commands keep their output and exit codes and now run the TypeScript engine through node;
  new `artifact template-save <spec.json>`.
- Docs: README "Templates" and "When something goes wrong", templates/README.md "Creating a template",
  docs/TROUBLESHOOTING.md, docs/ERRORS.md.
- Internal: the motion player page moved to `contrib/motion-player.html` (one source for both engines).

Known differences from the Python engine (none affects the bundled templates): JavaScript has one number type,
so a whole-number float in user data is written as `1` instead of `1.0` in `data.json` and accepted where the
schema says `integer`; object keys that look like integers are ordered first.
