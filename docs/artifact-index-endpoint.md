# The artifact index endpoint

DSH does not define an artifact directory or an index route, so `dsh-artifacts`
expects *some* same-origin HTTP endpoint to answer a small JSON contract. This
document is that contract, the rules that keep it safe, and the optional
live-reload behaviour.

`contrib/artifact-index-server.py` is a complete standalone implementation you
can run as-is or steal pieces from.

## The contract

`GET <indexUrl>` (default `/report/?list=1`) answers `application/json`:

```json
{
  "count": 2,
  "items": [
    {
      "name": "quarterly-report.html",
      "url": "/report/quarterly-report.html",
      "ext": "html",
      "size": 11160,
      "mtime": 1788934528
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `items` | yes | Array, newest first. Anything else degrades to an empty list. |
| `name` | yes | Display name. Also the row's identity — keep it stable. |
| `url` | yes | Relative or absolute. Used verbatim as the iframe `src`, so a relative path inherits the GUI's origin and session cookie. |
| `ext` | no | Lowercase, no dot. Drives the type badge; unknown values fall back to the extension text. |
| `size` | no | Bytes. Rendered as B / kB / MB. |
| `mtime` | no | Unix **seconds**. Rendered as `just now` / `5m ago` / `2h ago` / a locale date. |
| `mine` | no | Boolean. True when this session produced the artifact — see [Optional: per-session scope](#optional-per-session-scope). |
| `count` | no | Informational; the plugin counts `items` itself. |

An object-level `error` string is surfaced inline instead of an empty state,
which is how a misconfigured endpoint tells the user what is wrong rather than
looking like "no artifacts yet".

Configure the URL per browser without a rebuild:

```js
localStorage['dsh-artifacts:indexUrl'] = '/artifacts/index.json'
```

## Optional: per-session scope

One artifact directory usually serves every session on the host, so an
unfiltered list mixes this chat's output with everyone else's. The tab can
narrow it to the current chat — but only if the endpoint can say which artifacts
belong to which session.

When the sidebar supplies a session id, the request gains one parameter:

```
GET /report/?list=1&session=session-43850cf2-3217-4d28-8ea9-d126e15d5f34
```

The id is URL-encoded and comes from `TabComponentProps.scope.sessionId`. An
endpoint that supports scoping answers with `mine` on every item:

```json
{ "count": 2, "attributed": 1, "session": "session-43850cf2-…",
  "items": [ { "name": "a.html", "url": "/report/a.html", "mine": true },
             { "name": "b.html", "url": "/report/b.html", "mine": false } ] }
```

`attributed` and the echoed `session` are informational. What the tab acts on is
`mine`.

**Ignoring the parameter is a supported answer.** Omit `mine` entirely and the
tab hides its `This chat` / `All` toggle and lists everything, exactly as before
— the reference server in `contrib/` does this. What it must not do is emit
`mine: false` for artifacts it knows nothing about, because the tab reads a
boolean as "attribution ran" and would then offer a permanently empty
`This chat` view. Say nothing when you cannot say anything true.

Attribution is the host's problem, not the plugin's, because only the host knows
what a session is. One workable rule: a session's transcript records its tool
calls, so an artifact whose path appears in a `write`/`edit`/`bash` call of that
session belongs to it. Scanning a several-megabyte transcript costs a few hundred
milliseconds, so cache it per session for tens of seconds and only scan when the
`session` parameter is actually present. Validate the id against a strict
pattern before it goes anywhere near a path, and treat a scan failure as "no
attribution" rather than as an error — a shared list still works, and it must
never be possible for scoping to break the index.

With scoping available the tab defaults to `This chat` when it has at least one
artifact and to `All` otherwise, remembers an explicit choice in
`localStorage['dsh-artifacts:scope']`, and marks this chat's rows with a dot in
`All` mode.

## Rules that keep it safe

The index is usually one auth hop from the internet, so treat it as a public
surface even when it is not:

- **Metadata only.** The index must never contain file contents — names, sizes
  and mtimes only. A directory listing is a disclosure surface of its own; do
  not serve one for `/etc` or a home directory.
- **Fence to one directory.** Resolve the requested name against a single root
  and reject anything that escapes it. Basename-only, reject dotfiles, reject
  any path separator.
- **Allowlist extensions.** e.g. `.html .md .txt .json .csv .svg`. An allowlist
  stops the route becoming a generic file server for whatever else lands in that
  directory.
- **Authenticate it.** Put it behind your reverse proxy's auth, or accept a
  token. Unauthenticated requests should get a redirect, not a `200`.
- **Do not cache.** `Cache-Control: no-store`, or a stale index makes the tab
  look broken.

## Optional: live reload

If the server injects a few lines into served `.html`, previews refresh
themselves when a file is regenerated, and a browser tab left open on an artifact
tracks it too. The artifact on disk stays a plain static file — nothing has to
opt in.

The mechanism `contrib/artifact-index-server.py` uses:

1. Before `</body>` (case-insensitive; appended if absent) inject a script that
   polls `<same url>?artifact-etag=1` on an interval.
2. Answer that probe with a ~24-byte etag — `"<mtime_ns>-<size>"` in hex — not a
   re-download of the document.
3. When the etag differs from the one the page was served with, `location.reload()`.

Two seconds is a reasonable interval; the probe costs almost nothing. The plugin
itself does not implement or require any of this.
