#!/usr/bin/env python3
"""Reference artifact index + file server for the dsh-artifacts sidebar tab.

Implements the contract in docs/artifact-index-endpoint.md: a metadata-only JSON
index, a fenced extension-allowlisted file route, and the optional live-reload
injection that makes previews refresh themselves.

    ARTIFACT_DIR=~/public-artifacts ARTIFACT_PORT=8090 python3 artifact-index-server.py

Authentication is deliberately NOT implemented here - put this behind your
reverse proxy's auth, or front it with something that does. Bind to 127.0.0.1
unless you have a reason not to.
"""
import http.server
import json
import os
import re
import socketserver
import sys

ROOT = os.path.realpath(os.path.expanduser(os.environ.get("ARTIFACT_DIR", "~/reports")))
PORT = int(os.environ.get("ARTIFACT_PORT", "8090"))
HOST = os.environ.get("ARTIFACT_HOST", "127.0.0.1")
ALLOWED = {".html", ".md", ".txt", ".json", ".csv", ".svg"}
POLL_MS = int(os.environ.get("ARTIFACT_POLL_MS", "2000"))

LIVE_RELOAD = """<script>/* live reload, injected by the artifact server */
(function () {
  var known = %s, t = null;
  function probe() {
    fetch(location.pathname + '?artifact-etag=1', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.text(); })
      .then(function (v) { if (v && known && v !== known) location.reload(); })
      .catch(function () {});
  }
  t = setInterval(probe, %d);
  window.addEventListener('pagehide', function () { clearInterval(t); });
})();
</script>"""


def safe_join(name):
    """Resolve a request name inside ROOT, or None. Basename only, no dotfiles."""
    if not name or name != os.path.basename(name) or name.startswith("."):
        return None
    if os.path.splitext(name)[1].lower() not in ALLOWED:
        return None
    path = os.path.realpath(os.path.join(ROOT, name))
    if path != ROOT and not path.startswith(ROOT + os.sep):
        return None
    return path if os.path.isfile(path) else None


def rev_of(path):
    """Bare change token: mtime_ns and size in hex.

    This is what the injected page remembers and what the probe answers, so the
    two compare as plain strings with no quoting involved.
    """
    st = os.stat(path)
    return "%x-%x" % (st.st_mtime_ns, st.st_size)


def etag_of(path):
    """Quoted form, for the HTTP ETag header (which requires the quotes)."""
    return '"%s"' % rev_of(path)


def index_payload():
    items = []
    for entry in os.scandir(ROOT):
        if not entry.is_file() or entry.name.startswith("."):
            continue
        if os.path.splitext(entry.name)[1].lower() not in ALLOWED:
            continue
        st = entry.stat()
        items.append({
            "name": entry.name,
            "url": "/report/" + entry.name,
            "ext": os.path.splitext(entry.name)[1].lower().lstrip("."),
            "size": st.st_size,
            "mtime": int(st.st_mtime),
        })
    items.sort(key=lambda i: i["mtime"], reverse=True)
    # No `mine` field on purpose. This server has no idea what a session is, and
    # the tab treats a boolean `mine` as "attribution ran" -- emitting
    # `mine: False` for everything would offer a permanently empty "This chat"
    # view. Omitting the field makes the tab hide its scope toggle and list
    # everything, which is the honest answer. A caller may still send
    # `&session=<id>`; it is ignored here. See docs/artifact-index-endpoint.md
    # for a transcript-scanning rule that does attribute, if you want to add one.
    return {"count": len(items), "items": items}


class Handler(http.server.SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_file(self, path, head_only=False):
        ext = os.path.splitext(path)[1].lower()
        with open(path, "rb") as fh:
            data = fh.read()
        if ext == ".html":
            text = data.decode("utf-8", "replace")
            # json.dumps gives a correct JS string literal for any token shape
            snippet = LIVE_RELOAD % (json.dumps(rev_of(path)), POLL_MS)
            # Inside </body> when there is one, else inside </html>, else append.
            # Taking the later of the two positions used to drop the script
            # after </body>, which is not where a script belongs.
            low = text.lower()
            at = low.rfind("</body>")
            if at < 0:
                at = low.rfind("</html>")
            text = (text[:at] + snippet + text[at:]) if at >= 0 else (text + snippet)
            data = text.encode("utf-8")
        ctype = {".html": "text/html; charset=utf-8", ".md": "text/markdown; charset=utf-8",
                 ".txt": "text/plain; charset=utf-8", ".json": "application/json; charset=utf-8",
                 ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml"}.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("ETag", etag_of(path))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def _route(self, head_only=False):
        rest = self.path.split("?", 1)
        path_part, query = rest[0], (rest[1] if len(rest) > 1 else "")
        path_part = path_part.rstrip("/") or "/"

        # the live-reload probe: a ~24 byte answer, never the document
        if "artifact-etag=1" in query:
            target = safe_join(os.path.basename(path_part))
            if not target:
                return self._json(404, {"error": "not found"})
            body = rev_of(target).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head_only:
                self.wfile.write(body)
            return

        if path_part == "/" and "list=1" in query:
            return self._json(200, index_payload())
        if path_part in ("/", "/index.json"):
            return self._json(200, index_payload())

        target = safe_join(os.path.basename(path_part))
        if not target:
            return self._json(404, {"error": "not found: outside the artifact directory, "
                                            "dotfile, or extension not allowed"})
        return self._send_file(target, head_only)

    def do_GET(self):
        self._route(False)

    def do_HEAD(self):
        self._route(True)

    def log_message(self, fmt, *args):
        sys.stderr.write("[artifact-server] %s\n" % (fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    if not os.path.isdir(ROOT):
        sys.exit("ARTIFACT_DIR does not exist: %s" % ROOT)
    print("artifact server: root=%s  http://%s:%d/  (index: /?list=1)" % (ROOT, HOST, PORT))
    print("  allowed extensions: %s" % " ".join(sorted(ALLOWED)))
    print("  NO AUTHENTICATION - put this behind your reverse proxy's auth")
    with Server((HOST, PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
