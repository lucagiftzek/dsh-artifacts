# Troubleshooting dsh-artifacts: templates and agent tools

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 2.1.0.

<a id="start-here"></a>
**Start here.** Every failed tool result carries a `code`; look it up in [ERRORS.md](ERRORS.md). Collect the
facts in section 0 first: they are read-only and safe.

## Quick index
| # | Symptom (what you see) | Most likely cause | Jump |
|---|---|---|---|
| 1 | No `artifact_templates` tool in the agent's tool list | dsh web not restarted after installing or updating the plugin | [1](#t-tools-missing) |
| 2 | A template is missing from the list, or listed with `error` | wrong library, or a broken `template.json` | [2](#t-template-missing) |
| 3 | `artifact_from_template` refuses the data | the data does not fit the schema | [3](#t-data-refused) |
| 4 | `artifact_template_save` refuses the template | schema, example, files or limits | [4](#t-save-refused) |
| 5 | The `artifact` CLI says the engine needs Node.js | node is not on PATH | [5](#t-cli-node) |
| 6 | The skill publish-artifact is not offered | a user copy wins, or the node half is not loaded | [6](#t-skill-missing) |

## 0. Collect facts (read-only, always safe)

```bash
# where the plugin is installed (run where dsh web runs)
P=$(node -p "require('path').dirname(require.resolve('dsh-artifacts/package.json',{paths:[(process.env.DSH_HOME||require('os').homedir()+'/.dsh')+'/profiles/web']}))")
echo "$P"; node -p "require('$P/package.json').version"
# the libraries the engine searches, in order, and where agents save templates
node "$P/lib/engine/cli.js" list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.dirs,"save to:",j.write_dir);for(const t of j.templates)console.log(t.id,t.source,t.error||"")})'
# what the node half logged at the last start of dsh web (adapt to how you run it)
journalctl --user -u <dsh-web-unit> --since today | grep 'dsh-artifacts:'
```

Healthy log lines: `dsh-artifacts: agent tools registered: artifact_templates, artifact_template_info,
artifact_from_template, artifact_template_save`.

<a id="t-tools-missing"></a>
## 1. The agent has no artifact_templates tool

**Likely causes** (most likely first)
1. The plugin was installed or updated but `dsh web` has not been restarted: the node half (tools, skill) loads only at start.
2. The node half could not find the harness tool package (log line `ARTIFACT_TOOLS_UNAVAILABLE`).
3. The kill switch `DSH_ARTIFACTS_TOOLS=0` is set in the environment of `dsh web` (log line `disabled`).
4. A plugin version before 2.1 is installed (no tools at all).

**Diagnose** (read-only)
```bash
node -p "require('$P/package.json').version"          # needs 2.1.0 or later
journalctl --user -u <dsh-web-unit> --since today | grep 'dsh-artifacts:'
```
No `dsh-artifacts:` line since the last start: cause 1. `ARTIFACT_TOOLS_UNAVAILABLE`: cause 2. `disabled`: cause 3.

**Fix**
- Cause 1 **[HUMAN]**: restart `dsh web` (the chat you are in may run inside it, so a human does it).
- Cause 2 **[HUMAN]**: set `DSH_ARTIFACTS_TOOLS_MAIN=<harness>/package.json` (the `@deepseek-ai/dsh` package of the running install, for example `$(npm root -g)/@deepseek-ai/dsh/package.json`) in the environment of `dsh web`, then restart it.
- Cause 3 **[HUMAN]**: remove the variable, restart.
- Meanwhile every agent can use the CLI: `artifact templates`, `artifact template-info <id>`, `artifact new <name> --template <id> --data x.json`, `artifact template-save spec.json`. Same engine, same libraries.

**Verify**: a new chat lists `artifact_templates` among its tools, and the log shows the `agent tools registered` line.

**Related codes:** `ARTIFACT_TOOLS_UNAVAILABLE`, `ARTIFACT_INTERNAL`.

<a id="t-template-missing"></a>
## 2. A template is missing, or listed with an error

**Likely causes**
1. It lives in a library this process does not search: the search order is `$ARTIFACT_TEMPLATES` (colon separated), `~/estate/templates/artifacts`, the user library `${DSH_HOME:-~/.dsh}/artifacts/templates`, then the bundled copy. `dsh web` and your shell may have different `HOME`, `DSH_HOME` or `ARTIFACT_TEMPLATES`.
2. A library searched earlier has a template with the same id (first match wins).
3. Its `template.json` is broken (`ARTIFACT_TEMPLATE_BROKEN`; the list shows `error`).

**Diagnose**: run the `list` command of section 0 and compare `dirs` and `source` with where the folder is.

**Fix**: move the folder into a searched library, or set `ARTIFACT_TEMPLATES` **[HUMAN]** for `dsh web`; rename the id when it collides; fix the JSON named in `error` (or save the template again with `artifact_template_save` and `overwrite: true`).

**Verify**: `artifact_templates` lists the id without `error`.

**Related codes:** `ARTIFACT_TEMPLATE_NOT_FOUND`, `ARTIFACT_TEMPLATE_BROKEN`.

<a id="t-data-refused"></a>
## 3. artifact_from_template refuses the data

**Likely causes**
1. A field does not fit the schema (`ARTIFACT_DATA_INVALID`, see `errors[]`: one entry per field).
2. A local image or video path does not exist (`data.hero.src: file not found: ...`): relative paths resolve against `base_dir`, default the artifacts folder.
3. A credential-shaped string (`ARTIFACT_SECRET_REFUSED`).
4. The name exists (`ARTIFACT_EXISTS`) or is not a slug (`ARTIFACT_BAD_NAME`).
5. The artifacts folder is not writable (`ARTIFACT_WRITE_FAILED`).

**Diagnose**: call `artifact_template_info` and compare the `minimal_example` with your data; call `artifact_from_template` with `check: true` while fixing (writes nothing).

**Fix**: correct the listed fields; pass absolute file paths or `base_dir`; remove secrets; pick another name or `force: true`; for cause 5 check `ls -ld "${ARTIFACT_DIR:-$HOME/reports}"` and `df -h`.

**Verify**: the call returns `ok: true` with `path` and `url`.

**Related codes:** `ARTIFACT_DATA_INVALID`, `ARTIFACT_SECRET_REFUSED`, `ARTIFACT_EXISTS`, `ARTIFACT_BAD_NAME`, `ARTIFACT_WRITE_FAILED`.

<a id="t-save-refused"></a>
## 4. artifact_template_save refuses the template

**Likely causes**
1. A validation problem (`ARTIFACT_TEMPLATE_INVALID`): every one is listed in `errors[]`. The checks: id slug; schema root `{"type": "object", "properties": {...}}` with well-formed keywords; the example fits the schema and its asset files exist in `files`; paths stay inside the folder; the entry file for the kind exists (markdown `template.md`, react the `render` files, motion `composition.html`); a trial render of the example succeeds; title, purpose, when and readme are present.
2. The id exists in the target library (`ARTIFACT_TEMPLATE_EXISTS`): pass `overwrite: true`.
3. The id is taken by a library searched first (`ARTIFACT_TEMPLATE_SHADOWED`): pick another id.
4. Limits (`ARTIFACT_TOO_LARGE`): 512 KB per file, 4 MB per template, 60 files.
5. The target library is not writable (`ARTIFACT_TEMPLATE_READONLY`).

**Diagnose**: `artifact_templates` shows `save_to` (the target library) and the `libraries` with `writable`.

**Fix**: causes 1 to 4 by the agent as described. Cause 5 **[HUMAN]**: make the folder writable, or set `ARTIFACT_TEMPLATES_WRITE=<folder>` for `dsh web` (restart). The bundled copy inside the plugin is never a target.

**Verify**: the save returns `ok: true`, and `artifact_templates` lists the id with `source: user` (or `custom`).

**Related codes:** `ARTIFACT_TEMPLATE_INVALID`, `ARTIFACT_TEMPLATE_EXISTS`, `ARTIFACT_TEMPLATE_SHADOWED`, `ARTIFACT_TOO_LARGE`, `ARTIFACT_TEMPLATE_READONLY`, `ARTIFACT_SECRET_REFUSED`, `ARTIFACT_RENDER_FAILED`.

<a id="t-cli-node"></a>
## 5. The artifact CLI says the template engine needs Node.js

The template commands of the CLI run the same TypeScript engine as the tools (`lib/engine/cli.js`).

**Diagnose**: `command -v node`.

**Fix**: put `node` on `PATH` for the shell that runs `artifact`, or set `ARTIFACT_NODE=/path/to/node`.

**Verify**: `artifact templates` prints the list.

<a id="t-skill-missing"></a>
## 6. The publish-artifact skill is not offered

**Likely causes**
1. A user copy in `~/.dsh/skills/publish-artifact/` wins over the packaged one (by design) and is older.
2. The node half is not loaded (section 1).

**Fix**: refresh or delete the user copy (`cp -r "$P/skills/publish-artifact" ~/.dsh/skills/`); for cause 2 see section 1.

**Verify**: a new chat offers the skill and its section 0 names the `artifact_*` tools.

## Common install problems on DSH

- **C1. Installed but nothing changed.** The node half of any plugin loads only when `dsh web` starts; the browser half (the Artifacts tab) hot-reloads. Restart `dsh web` **[HUMAN]**.
- **C2. `profile bundle "dsh-artifacts" declares no dsh.bundle`.** An old package without `dsh.bundle.patch`; update the plugin.
- **C3. `duplicate loader entry id: dsh-artifacts`.** A hand-written `insert` row in `cordis.patch.yml` collides with the packaged one. Override settings with a plain `- id: dsh-artifacts` row, never a second `insert`.
