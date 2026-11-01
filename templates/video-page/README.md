# video-page: player page with chapters

A React + Tailwind page around an existing video: native player, chapter list with the current chapter
highlighted, a clickable chapter bar under the video, optional WebVTT captions, optional clickable transcript,
description, download button and links. Deep links: `#t=75` starts at 1:15.

Preview: `artifact template-preview video-page`.

## Use it

    artifact template-info video-page
    artifact new launch-video --template video-page --data launch-video.json
    # -> ~/reports/launch-video/ (index.html, app.jsx, data.json, assets/)

`src`, `poster` and `captions` may be local files (copied to `assets/`) or URLs on this server, for example the
MP4 of a motion artifact: `/report/<name>.motion/renders/<file>.mp4`. Afterwards edit `data.json` directly:
the page reads it on every load. Do not edit `app.jsx` per use; improve the template here.

## Data

- `title`, `src` (required); `subtitle`, `date`, `author`, `poster`, `description` (plain text, blank lines
  between paragraphs), `duration` (only if the browser cannot read it)
- `chapters`: `{at, title, note}` with `at` in seconds, `m:ss` or `h:mm:ss`
- `transcript`: `{at, text}`
- `captions` (.vtt), `captions_lang` (en), `captions_label` (English)
- `links`: `{label, url}`; `download`: true (default) shows the Download video button

## Changes

- 1 Nov 2026: created (template library v1). Example clip = the video-explainer preview, re-encoded small.
