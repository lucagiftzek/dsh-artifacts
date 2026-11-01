# Changelog

## 2.1.0 (2026-11-01)

Templates for every agent on every install, and agents can create templates.

- **Agent tools** registered by the node half: `artifact_templates`, `artifact_template_info`,
  `artifact_from_template`, `artifact_template_save`. Lossless JSON results; failures carry a stable
  `ARTIFACT_*` code, a hint and a docs anchor ([docs/ERRORS.md](docs/ERRORS.md)). Results of
  `artifact_from_template` are attributed to the calling chat (Artifacts tab, "This chat").
- **Skill auto-registration**: `skills/publish-artifact` is registered with the host skill registry, so agents
  find it without a copy into `~/.dsh/skills` (a user copy still wins). Its first section is now "templates first"
  with the tools.
- **Safe loading**: `lib/index.js` keeps zero static imports and an empty static `inject`; the skill helper, the
  tools and the host's `@deepseek-ai/dsh-tools` are loaded with guarded dynamic imports and registered through
  runtime `ctx.inject`. Without the tools package the plugin loads, logs one `ARTIFACT_TOOLS_UNAVAILABLE` line and
  registers no tool. Kill switch: `DSH_ARTIFACTS_TOOLS=0`. Default export `{ name, inject, apply }` added.
- **Template engine in TypeScript** (`src/engine` built into `lib/engine`), replacing `contrib/templates.py`.
  Output is byte-identical to the Python engine on every bundled template (`test/parity.mjs` checks it against the
  Python reference from git history). Installs need neither Python nor a build step for templates.
- **User template library** `${DSH_HOME:-~/.dsh}/artifacts/templates`, searched after
  `~/estate/templates/artifacts` and before the bundled copy. Agents save there by default
  (`ARTIFACT_TEMPLATES_WRITE` or the first writable `ARTIFACT_TEMPLATES` entry override it); the bundled copy is
  never written. Saves are validated as a whole (id, schema, example, trial render, paths, secrets, size limits)
  in a staging folder and swapped in atomically.
- **CLI**: template commands keep their output and exit codes and now run the TypeScript engine through node;
  new `artifact template-save <spec.json>`.
- Docs: README "Templates" and "When something goes wrong", templates/README.md "Creating a template",
  docs/TROUBLESHOOTING.md, docs/ERRORS.md.
- Internal: the motion player page moved to `contrib/motion-player.html` (one source for both engines).

Known differences from the Python engine (none affects the bundled templates): JavaScript has one number type,
so a whole-number float in user data is written as `1` instead of `1.0` in `data.json` and accepted where the
schema says `integer`; object keys that look like integers are ordered first.
