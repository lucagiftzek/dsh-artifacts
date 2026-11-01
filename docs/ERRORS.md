# Error codes: dsh-artifacts

Checked on: DSH 0.1.5-rc.1 and 0.2.1-rc.5, plugin 2.1.0.

Every failed result of the agent tools (`artifact_templates`, `artifact_template_info`, `artifact_from_template`,
`artifact_template_save`) has this shape:

```json
{ "ok": false, "error": "The data does not fit the template", "code": "ARTIFACT_DATA_INVALID",
  "message": "data does not fit template dashboard", "hint": "Fix every field listed in errors ...",
  "docs": "docs/ERRORS.md#artifact_data_invalid",
  "errors": [{ "field": "data.kpis[0].value", "problem": "expected string or number, got object" }],
  "error_lines": ["data.kpis[0].value: expected string or number, got object"] }
```

`errors` and `error_lines` are present when there is a list of problems (validation). Log lines of the node half
start with `dsh-artifacts:` followed by the code, so `grep ARTIFACT_` finds them. The `artifact` CLI prints the
same messages as text (exit 2 for refused data or templates, 1 for other errors) and the same JSON with `--json`.

| Code | HTTP | Where it appears | Meaning | Agent action |
|---|---|---|---|---|
| ARTIFACT_TEMPLATE_NOT_FOUND | 404 | tool artifact_template_info, tool artifact_from_template | no template with that id | call artifact_templates and use a listed id ([details](#artifact_template_not_found)) |
| ARTIFACT_TEMPLATE_BROKEN | 500 | tool artifact_template_info, tool artifact_from_template | the template folder cannot be loaded | use another template; fix the folder ([details](#artifact_template_broken)) |
| ARTIFACT_DATA_INVALID | 400 | tool artifact_from_template | the data does not fit the schema | fix each listed field and call again ([details](#artifact_data_invalid)) |
| ARTIFACT_SECRET_REFUSED | 400 | tool artifact_from_template, tool artifact_template_save | a credential-shaped string in the input | remove the value, report a status instead ([details](#artifact_secret_refused)) |
| ARTIFACT_EXISTS | 409 | tool artifact_from_template | an artifact with that name exists | edit it, pick another name, or pass force: true ([details](#artifact_exists)) |
| ARTIFACT_BAD_NAME | 400 | tool artifact_from_template | the artifact name is not a safe slug | use a slug such as weekly-report ([details](#artifact_bad_name)) |
| ARTIFACT_RENDER_FAILED | 500 | tool artifact_from_template | the template text cannot be filled | fix the template text ([details](#artifact_render_failed)) |
| ARTIFACT_TEMPLATE_INVALID | 400 | tool artifact_template_save | the template was refused | fix every listed problem and save again ([details](#artifact_template_invalid)) |
| ARTIFACT_TEMPLATE_EXISTS | 409 | tool artifact_template_save | the id exists in the target library | pass overwrite: true or pick another id ([details](#artifact_template_exists)) |
| ARTIFACT_TEMPLATE_SHADOWED | 409 | tool artifact_template_save | the id is taken by a library searched first | pick another id ([details](#artifact_template_shadowed)) |
| ARTIFACT_TEMPLATE_READONLY | 403 | tool artifact_template_save | the target library is not writable | ask the human to fix the folder or the setting ([details](#artifact_template_readonly)) |
| ARTIFACT_TOO_LARGE | 413 | tool artifact_template_save | a size limit was exceeded | make the files smaller, link big media ([details](#artifact_too_large)) |
| ARTIFACT_WRITE_FAILED | 500 | tool artifact_from_template, tool artifact_template_save | a file system error | check the artifacts folder and the disk ([details](#artifact_write_failed)) |
| ARTIFACT_TOOLS_UNAVAILABLE | 500 | log | the host tool registry was not found, no tool registered | use the CLI; see troubleshooting ([details](#artifact_tools_unavailable)) |
| ARTIFACT_INTERNAL | 500 | any tool, log | unexpected exception | collect the log line and report a bug ([details](#artifact_internal)) |

### ARTIFACT_TEMPLATE_NOT_FOUND
- **Meaning:** no template folder with that id in any library (`$ARTIFACT_TEMPLATES`, `~/estate/templates/artifacts`, the user library, the bundled copy).
- **Where:** tool `artifact_template_info`, tool `artifact_from_template`; CLI `no template 'x' (available: ...)`.
- **Likely causes:** a typo; a template saved in another library that this process does not search (different `HOME`, `DSH_HOME` or `ARTIFACT_TEMPLATES`).
- **Agent action:** call `artifact_templates` and use one of the listed ids.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-template-missing)

### ARTIFACT_TEMPLATE_BROKEN
- **Meaning:** the folder exists but its `template.json` is missing, not valid JSON, not an object, has no valid `kind`, or its example file cannot be read.
- **Where:** tool `artifact_template_info`, tool `artifact_from_template`; `artifact_templates` lists the folder with an `error` field.
- **Likely causes:** a hand edit of `template.json`; an interrupted copy.
- **Agent action:** use another template now; to repair, read the `error`, fix `template.json` (or save the template again with `artifact_template_save` and `overwrite: true`).
- **Needs the human:** only when the folder belongs to a library the agent must not edit.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-template-missing)

### ARTIFACT_DATA_INVALID
- **Meaning:** the data does not fit the template schema, a local file named in the data does not exist, or `data` is not a JSON object.
- **Where:** tool `artifact_from_template` (`errors[]` per field); CLI exit 2 with one line per problem.
- **Likely causes:** a missing required field, a wrong type, a value outside an enum, an unknown property, a relative image path resolved against the wrong folder.
- **Agent action:** read `errors`, compare with `artifact_template_info` (schema and `minimal_example`), fix the data and call again. Relative file paths resolve against `base_dir` (default: the artifacts folder); pass absolute paths or `base_dir`.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-refused)

### ARTIFACT_SECRET_REFUSED
- **Meaning:** the data or the template contains something shaped like a credential (`NAME_API_KEY=...`, `PASSWORD: ...`, private key blocks, well-known token prefixes).
- **Where:** tool `artifact_from_template`, tool `artifact_template_save`.
- **Likely causes:** a pasted configuration file or log; an example that shows a real key.
- **Agent action:** remove the value. Artifacts and templates are served over HTTP: report a status (configured: yes or no), never a value. Use an obvious placeholder without the `NAME=value` shape if the layout needs one.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-refused)

### ARTIFACT_EXISTS
- **Meaning:** an artifact with that name already exists in the artifacts folder.
- **Where:** tool `artifact_from_template`; CLI `... already exists: edit it, or pass --force`.
- **Likely causes:** a second call with the same name.
- **Agent action:** edit the existing file, choose another name, or pass `force: true` to regenerate it from the data (the previous version stays in the artifact history).
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-refused)

### ARTIFACT_BAD_NAME
- **Meaning:** the artifact name is not a safe slug (folders, `..`, leading dot or other characters).
- **Where:** tool `artifact_from_template`.
- **Likely causes:** a path passed as the name.
- **Agent action:** pass a short slug such as `q3-sales`; the folder is always the artifacts folder.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-refused)

### ARTIFACT_RENDER_FAILED
- **Meaning:** the template text has an unbalanced `{{#section}}` or `{{/section}}`, or uses an unknown filter.
- **Where:** tool `artifact_from_template` (templates saved before validation existed, or edited by hand).
- **Likely causes:** a hand edit of `template.md`, `index.html` or `composition.html`.
- **Agent action:** fix the template text (supported filters: join csv cells sep json oneline lower upper count default), or use another template.
- **Needs the human:** only when the template belongs to a library the agent must not edit.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_TEMPLATE_INVALID
- **Meaning:** `artifact_template_save` refused the template; nothing was written.
- **Where:** tool `artifact_template_save` (`errors[]`), CLI `artifact template-save`.
- **Likely causes:** the id is not a lower-case slug; the schema root is not `{"type": "object", "properties": {...}}` or has malformed keywords; the example does not fit the schema or names a missing asset; a file path leaves the folder or is hidden; the entry file for the kind is missing; the trial render of the example failed; `title`, `purpose`, `when` or `readme` is missing.
- **Agent action:** fix every listed problem and save again.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_TEMPLATE_EXISTS
- **Meaning:** a template with that id is already in the target library.
- **Where:** tool `artifact_template_save`.
- **Likely causes:** saving the same template twice; an id another agent already used.
- **Agent action:** to update it, pass `overwrite: true` (files you do not pass are kept, `null` deletes one); otherwise pick another id.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_TEMPLATE_SHADOWED
- **Meaning:** a library searched before the target library already has a template with that id, so a saved copy would never be used.
- **Where:** tool `artifact_template_save`.
- **Likely causes:** the id of a template in `$ARTIFACT_TEMPLATES` or `~/estate/templates/artifacts`. (Bundled ids can be overridden: the user library is searched before the bundled copy.)
- **Agent action:** pick another id.
- **Needs the human:** only to change that other library.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_TEMPLATE_READONLY
- **Meaning:** the target library is not writable, or it is the bundled copy inside the plugin (never written).
- **Where:** tool `artifact_template_save`.
- **Likely causes:** `ARTIFACT_TEMPLATES_WRITE` points at the bundled copy or at a read-only folder; the user library (`${DSH_HOME:-~/.dsh}/artifacts/templates`) is owned by another user.
- **Agent action:** report the folder named in `message` to the human.
- **Needs the human:** yes: fix the folder permissions or set `ARTIFACT_TEMPLATES_WRITE` in the environment of `dsh web` (takes effect at its next start).
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_TOO_LARGE
- **Meaning:** a size limit of `artifact_template_save` was exceeded: 512 KB per file, 4 MB per template, 60 files, 256 KB for schema and for example.
- **Where:** tool `artifact_template_save`.
- **Likely causes:** a video or large image embedded as an example asset.
- **Agent action:** use smaller example assets; real media belongs in the data of each artifact, not in the template.
- **Needs the human:** no.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-save-refused)

### ARTIFACT_WRITE_FAILED
- **Meaning:** a file system error (`EACCES`, `ENOSPC`, `ENOTDIR` ...) while writing the artifact or the template. The system error code is in `message`.
- **Where:** tool `artifact_from_template`, tool `artifact_template_save`.
- **Likely causes:** `ARTIFACT_DIR` points at a file or a read-only folder; the disk is full.
- **Agent action:** check with `ls -ld "${ARTIFACT_DIR:-$HOME/reports}"` and `df -h`; report to the human.
- **Needs the human:** yes when permissions or disk space must change.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-data-refused)

### ARTIFACT_TOOLS_UNAVAILABLE
- **Meaning:** at start, the node half could not find the running harness's `@deepseek-ai/dsh-tools` (or the host has no `inject()`), so no agent tool was registered. The plugin itself loaded normally.
- **Where:** log line `dsh-artifacts: ARTIFACT_TOOLS_UNAVAILABLE ...` of `dsh web`.
- **Likely causes:** an unusual install layout where the harness package cannot be resolved from the dsh executable or the profile.
- **Agent action:** use the `artifact` CLI meanwhile (same engine, same templates).
- **Needs the human:** yes: set `DSH_ARTIFACTS_TOOLS_MAIN` to the harness `package.json` in the environment of `dsh web` and restart it.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-tools-missing)

### ARTIFACT_INTERNAL
- **Meaning:** an unexpected exception inside the plugin.
- **Where:** any tool; log lines `dsh-artifacts: ARTIFACT_INTERNAL ...`.
- **Likely causes:** a bug.
- **Agent action:** retry once; if it repeats, collect the `message` and the log line and report an issue on the plugin repository.
- **Needs the human:** to file the report.
- **Troubleshooting:** [entry](TROUBLESHOOTING.md#t-tools-missing)
