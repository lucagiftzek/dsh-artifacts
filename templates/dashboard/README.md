# dashboard: KPI tiles, charts, progress, table

A thin, documented layer over the artifact-kit dashboard renderer: the renderer already draws KPI tiles,
SVG charts, progress bars and sortable tables, so this template only fixes the layout (tiles, alert,
charts two per row, progress, table, notes) and moves the numbers into one JSON file.

Preview: https://llm.tzekos.eu/report/template-preview-dashboard.html

## Use it

    artifact template-info dashboard
    artifact new pipeline-health --template dashboard --data pipeline.json
    # refresh later: write the new numbers into pipeline.json, then
    artifact new pipeline-health --template dashboard --data pipeline.json --force

A script or timer can regenerate the page the same way; every regeneration is a versioned snapshot.

## Data

- `title` (required), `subtitle`, `date` (as of), `status` (badge)
- `kpis` (required): `{label, value, note, verdict: good|bad}`; a note starting with a plus or minus sign is coloured
  automatically, `verdict` overrides it (for example falling costs are good). No `|` in these fields.
- `alert`: `{tone, text}` callout under the tiles
- `charts`: `{kind: bar|hbar|line|pie|donut, title, columns, rows}`, two per row on wide screens
- `progress`: `{label, value, max (100), note}`
- `table`: `{title, columns, rows}`, sortable by clicking a header
- `notes`: Markdown (method, sources, caveats)

For data that changes every minute, build a react artifact that reads `dsh.storage` and push updates with
`artifact state-set` instead.

## Changes

- 1 Nov 2026: created (template library v1); artifact-kit gained `columns 2|3|4`.
