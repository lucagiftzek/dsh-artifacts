// dsh-artifacts node half.
//
// This file still has ZERO static imports, and that stays the rule.
//
// Why: this profile has been taken down before by exactly that mistake. Two github: plugins imported
// `installSettingsSection` / `settingsNamespace` from @deepseek-ai/dsh-settings@0.1.2-rc.1, which does not
// export them; the ESM import became a hard SyntaxError at load, the loader entry threw, and dsh exited 1
// before boot finished: hundreds of restarts and the whole GUI down. A module without static imports cannot
// fail that way, so everything this half does is loaded with a guarded dynamic import inside apply().
//
// What it does (since 2.1):
//   1. registers the packaged skills (skills/publish-artifact) with the host skill registry, so agents on any
//      install find them without a copy into ~/.dsh/skills (a user copy there still wins);
//   2. registers the agent tools artifact_templates, artifact_template_info, artifact_from_template and
//      artifact_template_save (lib/tools.js), so any agent can discover and use the template library.
// Both go through a runtime ctx.inject([...], callback): a host without the service never runs the callback,
// and nothing here can leave the entry pending. If @deepseek-ai/dsh-tools cannot be found, one log line is
// written and no tool is registered; the plugin itself always loads.
//
// It also still exists so the client-modules host scan sees the `dsh.client` declaration: the browser half
// (lib/client.js, the Artifacts sidebar tab) is only served when this package is mounted by a cordis row.
//
// Kill switch for the tools and skills: DSH_ARTIFACTS_TOOLS=0 in the environment of dsh web.

export const name = 'dsh-artifacts'

// Empty on purpose: an unsatisfied static `inject` leaves the entry pending forever and boot fails on
// "1 entry did not activate". The tools service is reached through a runtime ctx.inject instead.
export const inject = []

// stderr: stdout belongs to the app (dsh headless --json writes its event stream there).
function log(message) {
  try { console.error(`dsh-artifacts: ${message}`) } catch { /* never throw from logging */ }
}

/** Every place the RUNNING harness's @deepseek-ai/dsh-tools can be resolved from, best first. */
async function toolsBases() {
  const { realpathSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { homedir } = await import('node:os')
  const bases = []
  if (process.env.DSH_ARTIFACTS_TOOLS_MAIN) bases.push(process.env.DSH_ARTIFACTS_TOOLS_MAIN)
  if (process.argv && process.argv[1]) {
    try { bases.push(realpathSync(process.argv[1])) } catch { bases.push(process.argv[1]) }
  }
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  bases.push(join(dshHome, 'profiles', 'web', 'package.json'))
  bases.push(import.meta.url)
  return bases
}

/** The host's defineTool, or null. Never throws. */
export async function loadDefineTool() {
  try {
    const { createRequire } = await import('node:module')
    const { pathToFileURL } = await import('node:url')
    for (const base of await toolsBases()) {
      let resolved
      try { resolved = createRequire(base).resolve('@deepseek-ai/dsh-tools') } catch { continue }
      try {
        const mod = await import(pathToFileURL(resolved).href)
        const fn = mod && (mod.defineTool || (mod.default && mod.default.defineTool))
        if (typeof fn === 'function') return fn
      } catch { /* try the next base */ }
    }
  } catch { /* fall through */ }
  return null
}

async function setup(ctx, opts) {
  try {
    const skills = await import('./plugin-skills.js')
    const n = skills.registerPluginSkills(ctx, { plugin: name, dir: new URL('../skills/', import.meta.url), log })
    if (!n) log('skills: none registered')
  } catch (e) {
    log(`skills: not registered (${e && e.message})`)
  }

  const defineTool = opts.defineTool !== undefined ? opts.defineTool : await loadDefineTool()
  if (typeof defineTool !== 'function') {
    log('ARTIFACT_TOOLS_UNAVAILABLE @deepseek-ai/dsh-tools not found: agent tools not registered (the artifact CLI and the sidebar tab still work)')
    return
  }
  let tools
  try {
    tools = await import('./tools.js')
  } catch (e) {
    log(`ARTIFACT_INTERNAL lib/tools.js did not load (${e && e.message}): agent tools not registered`)
    return
  }
  if (!ctx || typeof ctx.inject !== 'function') {
    log('ARTIFACT_TOOLS_UNAVAILABLE the host context has no inject(): agent tools not registered')
    return
  }
  try {
    ctx.inject(['tools'], (c) => {
      try {
        const names = tools.registerTools(defineTool, c.tools, log)
        if (names.length) log(`agent tools registered: ${names.join(', ')}`)
      } catch (e) {
        log(`ARTIFACT_INTERNAL tool registration failed (${e && e.message})`)
      }
    })
  } catch (e) {
    // the app already stopped this plugin (for example `dsh headless --help` exits at once): nothing to do
    if (/inactive context/.test(String(e && e.message))) return
    log(`ARTIFACT_INTERNAL tool registration failed (${e && e.message})`)
  }
}

/**
 * Never throws and never waits: the work happens in a promise whose errors end up in one log line.
 * `apply.ready` (that promise) exists for tests. `opts.defineTool` lets a test inject a defineTool or null.
 */
export function apply(ctx, _config, opts) {
  if (process.env.DSH_ARTIFACTS_TOOLS === '0') {
    log('agent tools and skills disabled (DSH_ARTIFACTS_TOOLS=0)')
    apply.ready = Promise.resolve()
    return
  }
  apply.ready = Promise.resolve().then(() => setup(ctx, opts || {})).catch((e) => log(`ARTIFACT_INTERNAL setup failed (${e && e.message})`))
}

// The 0.2.x loader reads name, inject and apply from the default export when one exists.
export default { name, inject, apply }
