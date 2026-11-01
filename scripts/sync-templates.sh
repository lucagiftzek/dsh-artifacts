#!/bin/sh
# Refresh the bundled template copy (templates/) from the canonical library.
# The CLI reads ~/estate/templates/artifacts first; this copy is the fallback for installs without it.
set -eu
SRC=${1:-$HOME/estate/templates/artifacts}
DST=$(cd "$(dirname "$0")/.." && pwd)/templates
[ -d "$SRC" ] || { echo "sync-templates: no $SRC" >&2; exit 1; }
mkdir -p "$DST"
rsync -a --delete --exclude '.*' "$SRC"/ "$DST"/
echo "templates/ now mirrors $SRC ($(ls "$DST" | grep -vc README.md) templates)"
