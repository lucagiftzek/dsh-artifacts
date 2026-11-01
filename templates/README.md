# Artifact templates (bundled copy)

This folder ships with dsh-artifacts, so every install has the templates. The example images and the short clip
were generated for these examples and may be reused freely.

Reusable artifact layouts, so a known kind of deliverable is not written again from scratch: an agent picks a
template, writes only the data (JSON), and the engine validates it, fills the template and publishes it under
`~/reports/`. Agents use the tools `artifact_templates`, `artifact_template_info`, `artifact_from_template` and
`artifact_template_save`; the `artifact` CLI below does the same from a shell. Cheaper (a few KB of data instead of a whole page of output tokens), faster, and every
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
| `report-text` | markdown | long-form document: summary, key points, sections, callouts, footnotes | `artifact template-preview report-text` |
| `article` | markdown | article with hero photo, captioned figures, inline charts, pull quotes, sources | `artifact template-preview article` |
| `dashboard` | markdown | KPI tiles, charts two per row, progress bars, sortable table | `artifact template-preview dashboard` |
| `review-queue` | react | approve, edit or reject a list of items; hotkeys 1 approve, 3 reject, J and K | `artifact template-preview review-queue` |
| `video-explainer` | motion | animated explainer (title, bullets, stat, chart, quote, outro) to MP4 | `artifact template-preview video-explainer` |
| `video-page` | react | player page for an existing MP4: chapters, marker bar, transcript, captions | `artifact template-preview video-page` |

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

## Creating a template

Agents create templates with the `artifact_template_save` tool (or `artifact template-save spec.json`, same
fields). It writes into the user library `${DSH_HOME:-~/.dsh}/artifacts/templates` (or `$ARTIFACT_TEMPLATES_WRITE`,
or the first writable `$ARTIFACT_TEMPLATES` entry), never into this bundled copy, and the template is listed by
`artifact_templates` at once.

1. Build the deliverable once. When it is a layout that will come back, move the variable parts into a schema
   and an example (say "Example data" where figures are illustrative), the rest into the template files.
2. Save it:

       artifact_template_save({
         id: "weekly-status", title: "Weekly status", kind: "markdown",
         purpose: "One page weekly status with highlights and risks.",
         when: "A recurring status update for a team or a project.",
         not_for: "Long reports (use report-text).",
         schema: { type: "object", required: ["title", "highlights"], properties: {
           title: { type: "string", minLength: 1 },
           highlights: { type: "array", minItems: 1, items: { type: "string" } } } },
         example: { title: "Example data: team status", highlights: ["Shipped the importer"] },
         files: { "template.md": "# {{title|oneline}}\n\n{{#highlights}}\n- {{.}}\n{{/highlights}}\n" },
         readme: "# weekly-status\n\nWhat it is for, how to use it, the fields.\n\n## Changes\n\n- created\n"
       })

   Kind markdown needs `template.md` (or `entry`), react the files in `render` (default `index.html`; other files
   such as `app.jsx` are copied as they are and the data lands in `data.json`), motion `composition.html`.
   Binary example assets: `"example/logo.png": "base64:<data>"`, referenced from the example as `example/logo.png`
   in a field marked `"x-asset": true`.
3. The save is refused, with every problem listed and nothing written, when: the id is not a lower-case slug;
   the schema root is not `{"type": "object", "properties": {...}}` or has malformed keywords (unsupported
   keywords only warn); the example does not fit the schema or names a missing asset; a path is absolute, hidden,
   uses `..` or is deeper than 4 levels; the entry file is missing; the example does not render; a
   credential-shaped string appears anywhere; a file is over 512 KB, the template over 4 MB or 60 files; the id
   is taken by a library searched before the target (estate or `$ARTIFACT_TEMPLATES`). Updating an existing id
   needs `overwrite: true`; files you do not pass are kept, `null` deletes one.
4. Publish the example (`artifact_from_template({ name: "t1", template: "<id>" })` or `artifact template-preview
   <id>`) and check it in a browser, light and dark, phone width.

To contribute a template to this repository, copy its folder to `templates/<id>/` and run `node test/run.mjs`. If
you keep a canonical library elsewhere, refresh this bundled copy with `scripts/sync-templates.sh <your library>`.

Search order (first match per id wins): `$ARTIFACT_TEMPLATES` (colon separated), `~/estate/templates/artifacts`
if it exists, the user library `${DSH_HOME:-~/.dsh}/artifacts/templates`, then this bundled copy.

Conventions: local libraries only (`/report/_lib/`), never a CDN; no secrets in data files (the CLI refuses
credential-shaped strings); English only; no em dash, en dash or spaced hyphen in any text (the CLI warns).
See the publish-artifact skill for the artifact basics and the dsh-motion skill for video.
