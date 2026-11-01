# article: article with photos and charts

An editorial page: hero photo with caption and credit, a larger lead paragraph, text, headings, single
figures or a gallery grid, inline charts from data series, pull quotes, callouts and a numbered sources list.
Rendered by artifact-kit (`template: article`, 780 px reading column, light and dark).

Preview: `artifact template-preview article` (publishes the example data as a page you can open).

## Use it

    artifact template-info article
    artifact new solar-story --template article --data solar-story.json

Image `src` values are local files, relative to the data file (or absolute). The CLI copies them to
`~/reports/<name>-files/` and links them from the page, so the article keeps working when the originals move.
A value starting with `/` or `http` is used as is (for example `/report/media/x.png` from `artifact media image`).

## Data

- `title` (required), `subtitle` (standfirst), `author`, `date`
- `hero`: `{src, caption, credit}`
- `lead`: Markdown
- `blocks` (required), each with a `type`:
  - `text`: `text` (Markdown) | `heading`: `text`
  - `figure`: `src`, `caption`, `credit`, `wide` | `gallery`: `images: [{src, caption, credit}]`
  - `chart`: `kind` bar|hbar|line|pie|donut, `title`, `columns` (label column, then series names),
    `rows` ([label, value, ...]), `caption` (source line)
  - `quote`: `text`, `by` | `callout`: `tone`, `text`
- `sources`: `{title, url, publisher, date}`

No invented numbers: label illustrative figures "Example data". Image credits are required for photos
that are not ours; generated images say "Generated illustration".

## Changes

- 1 Nov 2026: created (template library v1); artifact-kit gained the `figure`, `quote` and `lead` blocks,
  chart titles and footnotes for it.
