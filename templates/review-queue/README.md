# Review queue (approve / edit / reject with hotkeys)

A one-page artifact app for going through a list of items quickly and deciding on each one:
outreach emails to approve, prospects to validate, drafts to accept, anything with a yes or no.
Born from a real outreach review (approve each email before it is sent) and a prospect validation app.

## What it does

- One card per item: title, subtitle and link, coloured badges, an optional subject and body (the exact text),
  extra labelled fields, an evidence box with a highlighted phrase, a note.
- Approve, Edit (inline subject and body, Save and approve or Save only), Reject, Undo.
- Keyboard: **1** approve, **3** reject (acts on the highlighted card, then moves to the next one),
  **J** and **K** move down and up, click a card to highlight it. Keys are ignored while typing in a field.
- Filters (pending, approved, edited, rejected, all), counters, search, a "left out" list.
- Optional no-dash guard on edits (`noDashes`: refuses em dashes, en dashes and spaced hyphens in edited text).
- Answers persist in the artifact storage (key `answers`) and every decision is also sent to the agent inbox
  with `dsh.context` (type from `answerType`), so `artifact inbox` shows them.

## Use it

1. Write the data as a JSON file following `data.example.json` (fields below), then
   `artifact new <name> --template review-queue --data <file>.json`: the CLI validates it, copies `index.html`
   (title filled in) and `app.jsx` to `~/reports/<name>/` and writes `data.json` there.
   `artifact template-info review-queue` shows the schema. Later changes: edit `~/reports/<name>/data.json`.
2. Data fields (`data.example.json` is a full example):
   - top level: `title`, `intro`, `answerType`, `editable` (default true), `noDashes`, `approveLabel`,
     `rejectLabel`, `footer` (read-only text under every body), `items`, `excluded`;
   - item: `id` (stable), `title`, `subtitle`, `link`, `badges` [{text, tone: green|amber|red|gray|blue, title}],
     `subject` (omit for no subject), `body`, `fields` [{label, value, href, note}],
     `evidence` {label, text, highlight, url}, `note`.
3. Open <your DSH host>/report/<name>/ and send the link.
4. Read decisions with `artifact inbox` (or the stored `answers` object: id to {status, edited, subject, body, ts}).
   Only act on what the human approved; edited text replaces the original.

Do not change `app.jsx` per use: put everything in `data.json`. Improve the template here instead, and note the change below.

## Testing without the artifact server

Copy the four libraries from the dsh-artifacts `vendor/` folder next to the files, point
`index.html` at them, define a fake `window.dsh` (storage get, set, watch, context, toast) and drive it with the
Playwright (headless Chrome's own --print or --screenshot flags can hang on servers). The reference test
presses 1, 3 and J and checks the stored answers.

## Changes

- 1 Nov 2026: created from an outreach approval app; hotkeys 1 and 3, J and K navigation.
- 1 Nov 2026: registered in the template library (template.json with schema, `artifact new <name> --template review-queue`).
