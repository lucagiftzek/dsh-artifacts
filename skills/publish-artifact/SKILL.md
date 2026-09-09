---
name: publish-artifact
description: "Publish a file an agent produced so a human can open it in a browser: write it into the artifact directory, use an allowlisted extension, never include a secret, and reply with the URL rather than a filesystem path. Use whenever you generate an HTML report, dashboard, diagram, CSV or Markdown summary meant to be read."
---

# Publish artifacts where a human can actually open them

The person you are working for is usually remote and reading you through a
browser or a chat client. **A filesystem path is not a delivery.** "`/tmp/x.html`"
and "`~/reports/x.html`" are both unreadable to them unless something serves the
file.

If the `dsh-artifacts` sidebar tab is installed, published files also appear
there automatically, listed newest-first and previewable in place.

## The convention

1. **Write the artifact straight into the artifact directory** (commonly
   `~/reports/`) using your file-writing tool, rather than writing it elsewhere
   and copying it. On DSH this also lights up the turn's "Produced files" row,
   which is sourced from successful `write`/`edit` calls rather than from your
   closing prose — so the file is listed whether or not you remember to mention
   it.

   It is also what makes the artifact show up under **This chat** in the sidebar's
   Artifacts tab. That tab has to work out which of the directory's files belong
   to the conversation it is open in, and the only evidence available is this
   session's own transcript: a file whose path appears in one of *your* tool calls
   is yours. Write it somewhere else and move it with a shell one-liner, or ask a
   different session to write it, and the link between the file and this chat is
   lost — the artifact still serves, but it only appears in the unfiltered
   **All** list alongside everyone else's.
2. **Use an allowlisted extension**: `.html`, `.md`, `.txt`, `.json`, `.csv`,
   `.svg`. Anything else will be refused by the serving route.
3. **Use a plain basename**, no directories, no leading dot.
4. **Name it for the thing it reports**, not for the timestamp:
   `q3-margin-analysis.html`, not `report-final-v2.html`.
5. **Reply with the URL.** If a publisher script exists
   (`contrib/publish-artifact` in the dsh-artifacts repo, or a host-local
   equivalent), use it — it prints the URL and self-checks for HTTP 200.
6. **Prefer regenerating over appending.** If the artifact already exists, write
   the whole file again. Servers commonly inject a live-reload probe into served
   HTML, so an open browser tab or sidebar preview refreshes itself when you do —
   the human watches it update instead of re-clicking a link.

## Never put a secret in an artifact

These files end up one authentication hop from the internet and are meant to be
handed to a human in a browser. Before publishing, make sure the content has
none of:

- API keys or tokens (`sk-ant-…`, `ghp_…`, `xox…`, anything shaped like
  `<NAME>_API_KEY=<value>`)
- Private keys or certificates (PEM blocks)
- Passwords, connection strings, session cookies, launch tokens
- Other people's personal data that was not already theirs to see

Report **status**, not credentials: "signed in", "grant present, expires in 6 h",
"key loaded from the environment" — never the value. A publisher script should
refuse these patterns; do not treat that refusal as something to work around.

## If nothing serves artifacts here

Say so plainly and offer to set one up, rather than silently handing over a path.
The `dsh-artifacts` repository ships `contrib/artifact-index-server.py`, a
complete standalone implementation of the index and file route (metadata-only
index, directory fence, extension allowlist, optional live reload). It has **no
authentication of its own** — put it behind a reverse proxy that authenticates,
and bind it to loopback.

## Testing your own work

Check against the origin that actually serves the file (usually
`http://127.0.0.1:<port>/…`). If the public hostname hairpins back through a
tunnel or a CDN, a failure from the box itself can be a property of that path
rather than of your file, and looks exactly like an outage.
