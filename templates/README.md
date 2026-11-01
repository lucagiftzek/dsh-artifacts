# Artifact templates

Reusable artifact layouts, so a known kind of deliverable is not written again from scratch: an agent picks a
template, writes only the data (JSON), and the `artifact` CLI validates it, fills the template and publishes it
under `~/reports/`. Cheaper (a few KB of data instead of a whole page of output tokens), faster, and every
deliverable of the same kind looks the same.

    artifact templates                              # list: purpose, data fields, preview link
    artifact template-info <id>                     # data schema + a minimal example (--json for the full schema)
    artifact new <name> --template <id> --data data.json   # validate, fill, publish; --check validates only
    artifact new <name> --template <id> --data data.json --force   # regenerate after the data changed
    artifact template-preview [id]                  # republish ~/reports/template-preview-<id> from the example

All commands take `--json` (lossless JSON for agents). Bad data fails with exit code 2 and one line per problem,
for example `data.kpis[0].value: expected string or number, got object`; nothing is written.

| Template | Kind | What it is for | Preview |
|---|---|---|---|
| `report-text` | markdown | long-form document: summary, key points, sections, callouts, footnotes | [preview](https://llm.tzekos.eu/report/template-preview-report-text.html) |
| `article` | markdown | article with hero photo, captioned figures, inline charts, pull quotes, sources | [preview](https://llm.tzekos.eu/report/template-preview-article.html) |
| `dashboard` | markdown | KPI tiles, charts two per row, progress bars, sortable table | [preview](https://llm.tzekos.eu/report/template-preview-dashboard.html) |
| `review-queue` | react | approve, edit or reject a list of items; hotkeys 1 approve, 3 reject, J and K | [preview](https://llm.tzekos.eu/report/template-preview-review-queue/) |
| `video-explainer` | motion | animated explainer (title, bullets, stat, chart, quote, outro) to MP4 | [preview](https://llm.tzekos.eu/report/template-preview-video-explainer.html) |
| `video-page` | react | player page for an existing MP4: chapters, marker bar, transcript, captions | [preview](https://llm.tzekos.eu/report/template-preview-video-page/) |

## Anatomy of a template

    <id>/
      template.json   id, title, kind (markdown|react|motion), purpose, when, not_for,
                      schema (JSON Schema), example (object, or the name of a JSON file here),
                      entry (markdown/motion file to fill), render (react files to fill), timing (motion)
      README.md       what it is for, how to use it, the fields, a Changes list
      template.md     markdown kind: filled into ~/reports/<name>.md (artifact-kit renders it)
      index.html, app.jsx    react kind: copied to ~/reports/<name>/, data written to data.json
      composition.html       motion kind: filled into ~/reports/<name>.motion/index.html (player page from the motion scaffold)
      example/        example assets (images, a short clip) used by the example data

Filling uses a small Mustache subset: `{{x}}`, `{{a.b}}`, `{{{raw}}}`, `{{#list}}...{{/list}}` (with `@n`, `@first`,
`@last`), `{{^x}}...{{/x}}`, filters `join csv cells sep json oneline lower upper count default:x`. Objects with
a `type` get an `is_<type>` flag. Schema fields marked `"x-asset": true` are local files: the CLI copies them next to
the artifact (`<name>-files/` or `assets/`) and rewrites the link. Motion templates declare `timing`: scene lengths
come from the data (or from the amount of text) and starts and the total are computed.

## Adding or improving a template

1. Build the deliverable once by hand. When it is a layout that will come back, move the variable parts into a
   data file and the rest into a folder here, with a `template.json` (schema with descriptions, an example that
   says "Example data" where figures are illustrative) and a `README.md`.
2. `artifact template-info <id>` and `artifact new t1 --template <id>` must work with the example; then
   `artifact template-preview <id>` and check the preview in a browser, light and dark, phone width.
3. Commit here (estate repo on BlackServer) and refresh the copy bundled with dsh-artifacts:
   `/opt/stacks/llm/plugins/dsh-artifacts/scripts/sync-templates.sh` (the plugin falls back to it when
   `~/estate` is missing). Run the plugin tests: `node test/run.mjs` in the plugin folder.

Search order: `$ARTIFACT_TEMPLATES` (colon separated), `~/estate/templates/artifacts`, then the bundled copy.

Conventions: local libraries only (`/report/_lib/`), never a CDN; no secrets in data files (the CLI refuses
credential-shaped strings); English only; no em dash, en dash or spaced hyphen in any text (the CLI warns).
See the publish-artifact skill for the artifact basics and the dsh-motion skill for video.
