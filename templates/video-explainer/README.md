# video-explainer: motion explainer to MP4

A data-driven HyperFrames/GSAP composition on the dsh-motion pipeline. Scenes come from JSON: title card,
bullets (one at a time), a counting stat, a bar chart with one highlighted bar, a quote, an outro. The
animation code is generic (every element marked `data-in` enters in order), so a new video is only data.

Preview (player page): https://llm.tzekos.eu/report/template-preview-video-explainer.html

## Use it

    artifact template-info video-explainer
    artifact new q3-video --template video-explainer --data q3-video.json
    artifact motion check q3-video
    artifact motion snapshot q3-video --at 1.5,4,7     # look at the stills with read_image
    artifact motion export q3-video                    # MP4 (host auto: BlackServer if >= 4 GB free, else WhiteServer)

Change the data and rerun with `--force` to rebuild the composition (the player page stays). Small timing or
wording tweaks can also be made directly in `<name>.motion/index.html`. Follow the dsh-motion skill for the
brief, storyboard and QA loop; this template replaces only the build step.

## Durations

Every scene may set `seconds`. Without it the CLI derives it from the amount of text: 1.6 s + 0.3 s per word,
at least 2.5 s (chart 3.5 s, stat 3 s, outro 2 s), at most 9 s. Scene starts and the total length are computed
from those values, so adding a scene never needs manual retiming.

## Data

- `title` (required), `size` landscape|portrait|square|720p, `theme` dark|light, `accent`, `accent2`, `brand`
- `scenes` (required), each `{type, label?, seconds?, kicker?, ...}`:
  - `title`: `title`, `text` | `bullets`: `title`, `bullets` (max 5)
  - `stat`: `title`, `value`, `prefix`, `unit`, `decimals`, `caption`
  - `chart`: `title`, `bars: [{label, value}]`, `unit`, `highlight` (a bar label), `caption`
  - `quote`: `text`, `by` | `outro`: `title`, `text`

No invented numbers: every figure on screen comes from the source, illustrative content says so.
To give the MP4 a page with chapters, use the `video-page` template with `src` set to the render URL.

## Changes

- 1 Nov 2026: created (template library v1).
