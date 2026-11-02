import { readFileSync } from "node:fs";
import { failure } from "./tools.js";
import { addArtifact, listArtifacts, removeArtifact, updateArtifact } from "./listing.js";
const cmds = {
  list: listArtifacts,
  add: addArtifact,
  remove: removeArtifact,
  update: updateArtifact
};
const cmd = process.argv[2] || "";
let res;
if (!cmds[cmd]) {
  res = { ok: false, code: "ARTIFACT_ARGS_INVALID", message: `unknown listing command "${cmd}" (list, add, remove, update)` };
} else {
  let args = {};
  try {
    const text = readFileSync(0, "utf8");
    args = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    args = null;
    res = { ok: false, code: "ARTIFACT_ARGS_INVALID", message: "stdin is not a JSON object: " + e.message };
  }
  if (args !== null) {
    try {
      res = cmds[cmd](args, process.env.DSH_SESSION_ID || void 0);
    } catch (e) {
      res = failure(e);
    }
  }
}
process.stdout.write(JSON.stringify(res, null, 2) + "\n");
const code = String(res.code || "");
process.exitCode = res.ok ? 0 : /ARGS_INVALID|SOURCE_INVALID|TYPE_UNSUPPORTED|TOO_LARGE|SECRET|BAD_NAME|EXISTS|AMBIGUOUS|NOT_FOUND/.test(code) ? 2 : 1;
