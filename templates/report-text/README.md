# report-text: long-form text report

A clean reading page: title, lead summary, key points box, sections with optional callouts, footnotes,
automatic table of contents (3+ sections). Rendered by the artifact server (artifact-kit), so it has the
DSH look, light and dark themes, print styles and live reload.

Preview: https://llm.tzekos.eu/report/template-preview-report-text.html

## Use it

    artifact template-info report-text                 # fields and a minimal example
    artifact new my-memo --template report-text --data my-memo.json
    # -> ~/reports/my-memo.md and https://llm.tzekos.eu/report/my-memo.html

Then edit `~/reports/my-memo.md` directly with the edit tool for small changes, or change the JSON and
rerun with `--force` to regenerate the whole page.

## Data

- `title` (required), `subtitle`, `status` (badge), `date`, `author`
- `summary`: Markdown lead, larger type
- `key_points`: list of strings shown in an info box
- `sections` (required): `{heading, body, callout?: {tone: info|ok|warn|risk, text}}`. `body` is Markdown and
  may use every artifact-kit block (tables, `kpi`, `chart`, `mermaid`...) and footnote references `[^id]`.
- `footnotes`: `{id, text}`; listed under "Notes" at the end, linked both ways
- `width`: narrow (default), normal, wide; `toc`: true (default) or false

## Changes

- 1 Nov 2026: created (template library v1).
