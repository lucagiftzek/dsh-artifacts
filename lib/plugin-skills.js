/**
 * plugin-skills: let a DSH host plugin ship its own skills (skills/<name>/SKILL.md
 * inside the package) so agents find them without a manual copy into
 * ~/.dsh/skills. Standard: docs/PLUGIN-DOCS-STANDARD.md, section 4.
 *
 * Vendored verbatim (single source: dsh-migrate-0.2/shared/plugin-skills.js).
 * Node builtins only. Same provider contract as the harness's own bundled skill
 * packages (`ctx.skills.registerProvider(() => ({ name, list, get }))`), which
 * is identical on DSH 0.1.5 and 0.2.x.
 *
 *   import { registerPluginSkills } from './plugin-skills.js'
 *   export function apply(ctx, config) {
 *     registerPluginSkills(ctx, { plugin: 'dsh-phone', dir: new URL('../skills/', import.meta.url) })
 *   }
 *
 * Safety: it never throws into apply(). The skills service is reached through
 * ctx.inject(['skills'], ...), so a host without it simply never runs the
 * callback (and DSH 0.2.x does not throw for an undeclared service). A user copy
 * in ~/.dsh/skills/<name>/ outranks the packaged one, so a human can override it.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN_SKILLS_VERSION = '1.0.0'
const BUNDLED_RANK = 600 // BUNDLED_SKILL_RANK in @deepseek-ai/dsh-skill (0.1.5 and 0.2.1)
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Minimal frontmatter reader: single-line `key: value` pairs, optional quotes. */
export function parseSkillFile(raw, path = 'SKILL.md') {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(String(raw))
  if (!m) throw new Error(`plugin-skills: ${path} has no frontmatter`)
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    meta[kv[1]] = v
  }
  if (!meta.name || !NAME_RE.test(meta.name)) throw new Error(`plugin-skills: ${path} needs a kebab-case name`)
  if (!meta.description) throw new Error(`plugin-skills: ${path} needs a description`)
  return { meta, content: String(raw).slice(m[0].length).trim() }
}

/** Discover skills/<name>/SKILL.md under dir. Returns provider candidates. */
export function discoverSkills(dir, providerName) {
  const root = dir instanceof URL ? fileURLToPath(dir) : String(dir)
  if (!existsSync(root)) return []
  const out = []
  for (const entry of readdirSync(root).sort()) {
    const d = join(root, entry)
    const p = join(d, 'SKILL.md')
    try {
      if (!statSync(d).isDirectory() || !existsSync(p)) continue
      const { meta } = parseSkillFile(readFileSync(p, 'utf8'), p)
      if (meta.name !== entry) continue // the folder name is the skill name
      out.push({
        name: meta.name,
        description: meta.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: providerName,
        source: 'bundled',
        rank: BUNDLED_RANK,
        resourceBase: { kind: 'directory', path: d.split(sep).join('/') },
        locator: p,
      })
    } catch { /* a broken skill file is skipped, never fatal */ }
  }
  return out
}

/** Build the provider object (exported for tests). */
export function createSkillProvider(plugin, dir) {
  const name = `plugin-${String(plugin).replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`
  const candidates = discoverSkills(dir, name)
  return {
    name,
    count: candidates.length,
    list: () => Promise.resolve(candidates),
    async get(candidate, options = {}) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: parseSkillFile(raw, locator).content }
    },
  }
}

/**
 * Register the plugin's packaged skills. Returns the number of skills found
 * (registration itself happens when the skills service is available).
 */
export function registerPluginSkills(ctx, { plugin, dir, log } = {}) {
  let provider
  try {
    provider = createSkillProvider(plugin, dir)
  } catch (e) {
    if (log) log(`skills: not registered (${e && e.message})`)
    return 0
  }
  try {
    if (!ctx || typeof ctx.inject !== 'function') return 0
    ctx.inject(['skills'], (c) => {
      try {
        if (!c.skills || typeof c.skills.registerProvider !== 'function') return
        c.skills.registerProvider(() => provider)
      } catch (e) {
        if (log) log(`skills: registerProvider failed (${e && e.message})`)
      }
    })
  } catch (e) {
    if (log) log(`skills: inject failed (${e && e.message})`)
    return 0
  }
  return provider.count
}
