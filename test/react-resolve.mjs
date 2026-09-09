/**
 * Resolve react for the offline suites.
 *
 * This package deliberately ships no node_modules of its own, so the tests look
 * for a react installation in the places a DSH plugin checkout realistically has
 * one: an explicit override, this package, its parent, each sibling package (a
 * profile usually has several plugins and one of them has react), then up the
 * directory tree the way Node itself would.
 *
 * Only `react/jsx-runtime` is taken from there - the suites stub `react` itself
 * so hooks run without a dispatcher.
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = resolve(here, '..')

function candidates() {
  const out = []
  if (process.env.DSH_ARTIFACTS_REACT_DIR) out.push(process.env.DSH_ARTIFACTS_REACT_DIR)
  out.push(pkg)
  const parent = dirname(pkg)
  out.push(parent)
  let siblings = []
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    /* unreadable parent - the walk-up below still applies */
  }
  for (const name of siblings) out.push(resolve(parent, name))
  let d = pkg
  for (let i = 0; i < 10; i += 1) {
    const up = dirname(d)
    if (up === d) break
    out.push(up)
    d = up
  }
  return out
}

/** First directory whose node_modules holds a real react, or null. */
export function findReactRoot() {
  for (const root of candidates()) {
    if (existsSync(resolve(root, 'node_modules', 'react', 'package.json'))) return root
  }
  return null
}

/** A require() whose bare specifiers resolve against that react installation. */
export function makeRequire() {
  const root = findReactRoot()
  if (root) {
    // A path inside that node_modules makes `react/jsx-runtime` resolve there.
    return { require: createRequire(resolve(root, 'node_modules', '_')), root }
  }
  return { require: createRequire(import.meta.url), root: '(node resolution)' }
}
