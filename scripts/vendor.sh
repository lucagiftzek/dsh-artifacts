#!/usr/bin/env bash
# Rebuild vendor/ -- the local library shelf served at /report/_lib/.
# Artifacts load these instead of a CDN: same origin, no network egress, no tokens.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
npm init -y >/dev/null
npm i --silent react@18 react-dom@18 prop-types recharts@2 @babel/standalone@7 mermaid katex chart.js d3 three@0.160 \
  @tailwindcss/browser lucide htm marked papaparse leaflet gsap @hyperframes/player @hyperframes/core >/dev/null
N=node_modules
V="$HERE/vendor"
rm -rf "$V"; mkdir -p "$V/katex" "$V/leaflet" "$V/gsap" "$V/hyperframes"
cp $N/react/umd/react.production.min.js "$V/react.js"
cp $N/react-dom/umd/react-dom.production.min.js "$V/react-dom.js"
cp $N/prop-types/prop-types.min.js "$V/prop-types.js"
cp $N/recharts/umd/Recharts.js "$V/recharts.js"
cp $N/@babel/standalone/babel.min.js "$V/babel.js"
cp $N/mermaid/dist/mermaid.min.js "$V/mermaid.min.js"
cp $N/katex/dist/katex.min.js $N/katex/dist/katex.min.css "$V/katex/"
cp -r $N/katex/dist/fonts "$V/katex/fonts"
cp $N/chart.js/dist/chart.umd.min.js "$V/chart.js"
cp $N/d3/dist/d3.min.js "$V/d3.js"
cp $N/three/build/three.module.min.js "$V/three.module.js"
cp $N/three/build/three.min.js "$V/three.js" 2>/dev/null || true
cp $N/@tailwindcss/browser/dist/index.global.js "$V/tailwind.js"
cp $N/lucide/dist/umd/lucide.min.js "$V/lucide.js"
cp $N/htm/preact/standalone.umd.js "$V/preact-htm.js"
cp $N/marked/lib/marked.umd.js "$V/marked.js"
cp $N/papaparse/papaparse.min.js "$V/papaparse.js"
cp $N/leaflet/dist/leaflet.js $N/leaflet/dist/leaflet.css "$V/leaflet/"
cp -r $N/leaflet/dist/images "$V/leaflet/images"
# motion: GSAP (all plugins are free since 3.13) + HyperFrames player/runtime (Apache-2.0)
cp $N/gsap/dist/gsap.min.js "$V/gsap.js"
cp $N/gsap/dist/*.min.js "$V/gsap/"
cp $N/@hyperframes/player/dist/hyperframes-player.global.js "$V/hyperframes/player.js"
cp $N/@hyperframes/core/dist/hyperframe.runtime.iife.js "$V/hyperframes/runtime.js"
ver() { node -p "require('./$N/$1/package.json').version"; }
cat > "$V/index.json" <<EOF
{"base":"/report/_lib/","libs":[
 {"name":"react","version":"$(ver react)","files":["react.js","react-dom.js"],"global":"React, ReactDOM","note":"UMD; pair with babel.js for <script type=text/babel>"},
 {"name":"babel","version":"$(ver @babel/standalone)","files":["babel.js"],"global":"Babel","note":"JSX in the browser: <script type=\"text/babel\" data-presets=\"react\">"},
 {"name":"recharts","version":"$(ver recharts)","files":["prop-types.js","recharts.js"],"global":"Recharts","note":"load after react + react-dom"},
 {"name":"tailwind","version":"$(ver @tailwindcss/browser)","files":["tailwind.js"],"note":"Tailwind v4 browser build: utility classes just work"},
 {"name":"preact-htm","version":"$(ver htm)","files":["preact-htm.js"],"global":"htm/preact standalone (html, render, useState...)","note":"3 KB React-like, no build step"},
 {"name":"chart.js","version":"$(ver chart.js)","files":["chart.js"],"global":"Chart"},
 {"name":"d3","version":"$(ver d3)","files":["d3.js"],"global":"d3"},
 {"name":"three","version":"$(ver three)","files":["three.module.js","three.js"],"note":"ES module: import * as THREE from '/report/_lib/three.module.js'"},
 {"name":"mermaid","version":"$(ver mermaid)","files":["mermaid.min.js"],"global":"mermaid"},
 {"name":"katex","version":"$(ver katex)","files":["katex/katex.min.js","katex/katex.min.css"],"global":"katex"},
 {"name":"lucide","version":"$(ver lucide)","files":["lucide.js"],"global":"lucide","note":"lucide.createIcons() turns <i data-lucide=name> into SVG"},
 {"name":"marked","version":"$(ver marked)","files":["marked.js"],"global":"marked"},
 {"name":"papaparse","version":"$(ver papaparse)","files":["papaparse.js"],"global":"Papa"},
 {"name":"leaflet","version":"$(ver leaflet)","files":["leaflet/leaflet.js","leaflet/leaflet.css"],"global":"L","note":"map tiles come from the internet"},
 {"name":"gsap","version":"$(ver gsap)","files":["gsap.js"],"global":"gsap","note":"plugins under /report/_lib/gsap/ (SplitText.min.js, MotionPathPlugin.min.js, DrawSVGPlugin.min.js, Flip.min.js...)"},
 {"name":"hyperframes","version":"$(ver @hyperframes/player)","files":["hyperframes/player.js"],"note":"<hyperframes-player src=... runtime-src=/report/_lib/hyperframes/runtime.js controls>; motion artifacts: artifact new X --type motion"}
]}
EOF
du -sh "$V"
