# dsh-artifacts

An **Artifacts** tab for the DSH (DeepSeek Harness) web GUI sidebar.

Agents produce files — an HTML report, a dashboard, a diagram, a CSV. This tab
lists them newest-first inside the sidebar and previews one in place, so a human
watching a session can see what it produced without copying paths into a browser
by hand.

It is a peer of the sidebar's own tabs (explorer, editor, terminal, browser), not
an overlay: it registers through the same public extension point they use.

## What it does

- Registers one tab, `dsh-artifacts:library`, via `ctx.betterSidebar.registerTab`.
- Lists the artifact directory newest-first with a type badge, size and age.
- Click a row to preview it in an iframe inside the tab, using the **relative**
  URL the index supplies, so it is same-origin with the GUI and loads with the
  browser's existing session cookie.
- `Open ↗` opens it in a real browser tab, `Copy link` copies the shareable
  absolute URL, `Reload` re-fetches the preview, `Refresh` re-reads the index.
- Polls every 5 s **only while the tab is active and the panel is open**, using
  the `visible` prop the sidebar provides for exactly that.
- Toolbar and row geometry are fixed-box on purpose: no label or metric changes
  width with state, so a poll re-render cannot make the bar jitter.

If your server injects a live-reload snippet into served HTML (see
`docs/artifact-index-endpoint.md` for a reference implementation), previews
refresh themselves when a file is regenerated. This plugin does not implement
that and does not need to know about it.

## Requirements

- DSH web GUI with `dsh-better-sidebar` mounted (entry id `better-sidebar`).
  If the registry is missing, the client half logs an error and registers
  nothing — it never throws, so a missing dependency degrades to "no tab"
  rather than a broken sidebar.
- Some same-origin HTTP endpoint answering the small JSON index contract in
  [`docs/artifact-index-endpoint.md`](docs/artifact-index-endpoint.md). DSH does
  not define an artifact directory or an index route itself, so this is the one
  piece you wire up. A standalone reference server and a publisher script are in
  [`contrib/`](contrib).

## Install

```sh
# from GitHub
dsh plugin --profile web add github:lucagiftzek/dsh-artifacts

# or from a checkout
git clone https://github.com/lucagiftzek/dsh-artifacts
dsh plugin --profile web add link:./dsh-artifacts
```

`dsh plugin` is a pnpm passthrough, so `add` also appends the package to
`dsh.profile.bundles`. Removing is `dsh plugin --profile web remove dsh-artifacts`.

**Activation needs a `dsh-web` restart**, which mints a new launch token and
kills any session in flight. Rebuilds of `lib/client.js` afterwards are picked
up live — the served `rev` changes and a browser refresh is enough.

## Point it at your artifacts

The default index URL is `/report/?list=1`. Override it per browser without a
rebuild:

```js
localStorage['dsh-artifacts:indexUrl'] = '/artifacts/index.json'
```

The endpoint must return:

```json
{ "count": 2, "items": [
  { "name": "report.html", "url": "/report/report.html", "ext": "html",
    "size": 11160, "mtime": 1788934528 }
] }
```

`url` may be relative or absolute. Anything else the plugin can render without
(`badge`, a missing `size`) degrades quietly. Full contract, plus how to keep it
metadata-only and fenced to one directory, is in
[`docs/artifact-index-endpoint.md`](docs/artifact-index-endpoint.md).

### Scoping the list to the current chat

One directory usually holds every session's output, so the tab can narrow the
list. When the sidebar supplies a session id the request gains
`&session=<id>`; an endpoint that can attribute artifacts answers with a boolean
`mine` per item, and the tab shows a **This chat** / **All** toggle, defaulting to
`This chat` when it has something.

Attribution is deliberately the endpoint's business, not the plugin's — only the
host knows what a session is. **Ignoring the parameter is fully supported:** omit
`mine` and the toggle simply does not render, which is what the reference server
in `contrib/` does. The one mistake to avoid is emitting `mine: false` for
artifacts you know nothing about; the tab reads a boolean as "attribution ran"
and would offer a permanently empty `This chat` view. Say nothing unless it is
true. `docs/artifact-index-endpoint.md` describes a transcript-scanning rule that
works, including why to cache it and validate the id.

## Architecture: why the node half is empty

`lib/index.js` imports nothing and registers nothing. That is deliberate, and
both reasons are failures worth designing against:

1. **It still has to exist.** The client-modules host scan reads the `dsh.client`
   declaration from packages mounted in the host Loader. No mount, no served
   bundle.
2. **A bad host import is fatal, not local.** A DSH profile this plugin's author
   runs was taken down by exactly that: two plugins imported symbols from
   `@deepseek-ai/dsh-settings` that the installed version does not export. The
   ESM import became a hard `SyntaxError` at load, the loader entry threw, and
   `dsh` exited 1 before boot finished — hundreds of restarts and the site fully
   down. A zero-import host half cannot fail that way.
3. **An unsatisfied `inject` hangs boot.** `inject: []` on the host half avoids
   the "1 entry did not activate" failure that an `inject` nothing provides
   causes.

All data reaches the browser over HTTP, so the plugin needs no host service, no
filesystem access and no settings namespace.

## Build

```sh
pnpm install                 # esbuild is a devDependency
node scripts/build.mjs       # writes lib/client.js (+ map)
```

Set `ESBUILD_MAIN=/path/to/esbuild/lib/main.js` to build against a bundler that
lives elsewhere, which keeps the build offline.

The client bundle is CJS wrapped in the web boot factory
(`window.__ModuleLoader__.load({ id, factory })`). `react` and
`react/jsx-runtime` stay external and resolve to the shell's own instances — the
served URL is the **combo** form `/plugins/??dsh-artifacts/client.js&rev=…`, not
a plain per-plugin path. Two gates run after the build:

- **purity** — no `@deepseek-ai/` may reach the bundle; a value import would
  inline a duplicate runtime instance of a shell package.
- **seed words** — every bare `require` must be a declared external, or the
  module system throws loudly at materialization.

## Test

```sh
node test/run.mjs            # offline: no browser, no DSH_HOME, no network
```

`test/render.mjs` materializes the bundle the way the browser module system
does, drives `registerTab`, and structurally renders six states — empty library,
populated with a selection, hidden tab, fetch error, vanished selection, and
toolbar geometry under `busy`. It seeds the **real** `react/jsx-runtime` so
elements are genuine, with a programmable stub for `react` so hooks need no
dispatcher.

`test/fetch.mjs` captures `load()` from the poll interval and drives every fetch
outcome, including the auth-redirect case where a proxy answers HTML instead of
JSON.

Both suites have already earned their keep. The render suite caught a vanished
selection being synced in an effect, which painted one frame with an iframe
pointing at a path that had just 404'd — it is derived during render now. It
later caught a toolbar that changed width on every poll because a button label
swapped with `busy`.

## For agents

[`skills/publish-artifact/SKILL.md`](skills/publish-artifact/SKILL.md) is a
drop-in skill teaching an agent the convention this tab reads: where to write
artifacts, how to name them, and what never to put in one. Copy it into
`$DSH_HOME/skills/`, `~/.agents/skills/`, or a project's `.dsh/skills/`.

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Loukas "Luca" Tzekos.

Do whatever you want with it. The only ask is attribution: keep the copyright
line, and if you fork it publicly, a "based on dsh-artifacts by Luca Tzekos"
note in your README is appreciated. See [NOTICE](NOTICE).
