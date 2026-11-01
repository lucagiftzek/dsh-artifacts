"""Artifact templates: reuse a finished layout and only write the data.

A template is a folder with:
  template.json   id, title, purpose, when, kind (markdown|react|motion), schema (JSON Schema),
                  example (data object, or the name of a JSON file in the folder), entry / render / copy
  README.md       how to use it, what each field does, changes
  the files       template.md (markdown), index.html + app.jsx (react), composition.html (motion)

Lookup order (first wins per id): $ARTIFACT_TEMPLATES (colon separated), ~/estate/templates/artifacts,
then the copy bundled with dsh-artifacts (templates/), so the plugin works without the estate repo.

Filling uses a small Mustache subset, no dependency:
  {{x}}  {{a.b}}  {{.}}       value (HTML-escaped for html kinds, verbatim for markdown)
  {{{x}}}                     verbatim in every kind
  {{#list}}..{{/list}}        repeat per item (dict items push their keys; @n, @first, @last are set)
  {{#flag}}..{{/flag}}  {{^x}}..{{/x}}   conditional / inverted
  {{x|filter}}                join[:sep] csv cells sep json oneline lower upper count default:text
Lines holding only a section tag disappear, so Markdown fences stay intact.

Validation is a dependency-free JSON Schema subset: type, enum, const, required, properties,
additionalProperties, items, min/maxItems, min/maxLength, minimum, maximum, pattern, anyOf, oneOf,
default (filled in), plus x-asset (a local file copied next to the artifact).
"""
import copy
import datetime
import html
import json
import os
import re
import shutil
from pathlib import Path

HERE = Path(os.path.realpath(__file__)).parent
PLUGIN = HERE.parent
BUNDLED = PLUGIN / "templates"
ESTATE = Path.home() / "estate" / "templates" / "artifacts"
KINDS = ("markdown", "react", "motion")
META_FILES = {"template.json", "README.md", "preview.png", "example"}
DASHES = ("\u2014", "\u2013")


class TemplateError(Exception):
    pass


# -- discovery -------------------------------------------------------------------

def search_dirs():
    out = []
    for p in os.environ.get("ARTIFACT_TEMPLATES", "").split(":"):
        if p.strip():
            out.append(Path(p).expanduser())
    out += [ESTATE, BUNDLED]
    seen, res = set(), []
    for d in out:
        try:
            r = d.resolve()
        except OSError:
            continue
        if r not in seen and d.is_dir():
            seen.add(r)
            res.append(d)
    return res


def load(folder):
    folder = Path(folder)
    try:
        t = json.loads((folder / "template.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except ValueError as e:
        raise TemplateError("%s/template.json is not valid JSON: %s" % (folder, e))
    t["dir"] = str(folder)
    t.setdefault("id", folder.name)
    if t.get("kind") not in KINDS:
        raise TemplateError("%s: kind must be one of %s" % (folder, ", ".join(KINDS)))
    return t


def all_templates():
    found = {}
    for d in search_dirs():
        for sub in sorted(d.iterdir()):
            if not sub.is_dir() or sub.name.startswith((".", "_")):
                continue
            try:
                t = load(sub)
            except TemplateError as e:
                t = {"id": sub.name, "error": str(e), "dir": str(sub), "kind": "?", "title": sub.name}
            if t and t["id"] not in found:
                t["source"] = "estate" if d == ESTATE else "bundled" if d == BUNDLED else "custom"
                found[t["id"]] = t
    return [found[k] for k in sorted(found)]


def get(tid):
    for t in all_templates():
        if t["id"] == tid:
            if t.get("error"):
                raise TemplateError(t["error"])
            return t
    ids = ", ".join(t["id"] for t in all_templates()) or "(none)"
    raise TemplateError("no template %r (available: %s)" % (tid, ids))


def example_of(t):
    ex = t.get("example")
    if isinstance(ex, str):
        p = Path(t["dir"]) / ex
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise TemplateError("%s: example file %s unreadable: %s" % (t["id"], p, e))
    if ex is None:
        raise TemplateError("%s: template.json has no example" % t["id"])
    return copy.deepcopy(ex)


def preview_rel(t):
    stem = "template-preview-" + t["id"]
    if t["kind"] == "react":
        return stem + "/"
    return stem + ".html"


# -- schema summary + minimal example ---------------------------------------------

def _type_of(s):
    if not isinstance(s, dict):
        return "any"
    if "enum" in s:
        return "|".join(str(v) for v in s["enum"])
    ty = s.get("type", "any")
    return "|".join(ty) if isinstance(ty, list) else ty


def summary(schema, depth=0):
    """One line: title*, sections*[heading*, body*], kpis[label*, value*]"""
    props = schema.get("properties", {}) if isinstance(schema, dict) else {}
    req = set(schema.get("required", [])) if isinstance(schema, dict) else set()
    parts = []
    for k, s in props.items():
        mark = "*" if k in req else ""
        if s.get("type") == "array" and isinstance(s.get("items"), dict) and s["items"].get("properties") and depth < 2:
            parts.append("%s%s[%s]" % (k, mark, summary(s["items"], depth + 1)))
        elif s.get("type") == "object" and s.get("properties") and depth < 2:
            parts.append("%s%s{%s}" % (k, mark, summary(s, depth + 1)))
        elif s.get("type") == "array":
            parts.append("%s%s[]" % (k, mark))
        else:
            parts.append(k + mark)
    return ", ".join(parts)


def fields(schema, prefix="", out=None):
    """Flat field table: (path, type, required, description, default)."""
    out = [] if out is None else out
    props = schema.get("properties", {})
    req = set(schema.get("required", []))
    for k, s in props.items():
        path = prefix + k
        extra = " (local file, copied next to the artifact)" if s.get("x-asset") else ""
        out.append((path, _type_of(s), k in req, (s.get("description", "") + extra).strip(), s.get("default")))
        if s.get("type") == "object" and s.get("properties"):
            fields(s, path + ".", out)
        it = s.get("items")
        if s.get("type") == "array" and isinstance(it, dict):
            if it.get("properties"):
                fields(it, path + "[].", out)
            elif it.get("type") == "array" and isinstance(it.get("items"), dict) and it["items"].get("properties"):
                fields(it["items"], path + "[][].", out)
    return out


def minimal(schema, value):
    """Prune an example to what the schema requires (arrays keep one item)."""
    if not isinstance(schema, dict):
        return value
    if isinstance(value, dict) and schema.get("properties"):
        req = schema.get("required", [])
        return {k: minimal(schema["properties"].get(k, {}), value[k]) for k in req if k in value}
    if isinstance(value, list):
        n = max(1, schema.get("minItems", 1))
        return [minimal(schema.get("items", {}), v) for v in value[:n]]
    return value


# -- validation ------------------------------------------------------------------

JSON_TYPES = {"string": str, "boolean": bool, "object": dict, "array": list}


def _is(v, ty):
    if ty == "null":
        return v is None
    if ty == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if ty == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    if ty == "boolean":
        return isinstance(v, bool)
    return isinstance(v, JSON_TYPES.get(ty, object))


def _name(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "boolean"
    if isinstance(v, (int, float)):
        return "number"
    return {str: "string", list: "array", dict: "object"}.get(type(v), type(v).__name__)


def validate(schema, data, path="data", errors=None):
    """Return a list of 'path: problem' strings. Fills schema defaults into data in place."""
    errors = [] if errors is None else errors
    if not isinstance(schema, dict):
        return errors
    ty = schema.get("type")
    if ty:
        tys = ty if isinstance(ty, list) else [ty]
        if not any(_is(data, t) for t in tys):
            errors.append("%s: expected %s, got %s" % (path, " or ".join(tys), _name(data)))
            return errors
    if "const" in schema and data != schema["const"]:
        errors.append("%s: must be %s" % (path, json.dumps(schema["const"])))
    if "enum" in schema and data not in schema["enum"]:
        errors.append("%s: must be one of %s (got %s)" % (path, ", ".join(json.dumps(v) for v in schema["enum"]), json.dumps(data)))
    for kw in ("anyOf", "oneOf"):
        if kw in schema:
            ok = [s for s in schema[kw] if not validate(s, copy.deepcopy(data), path)]
            if not ok or (kw == "oneOf" and len(ok) > 1):
                errors.append("%s: does not match %s of the allowed shapes" % (path, "any" if kw == "anyOf" else "exactly one"))
    if isinstance(data, str):
        if len(data) < schema.get("minLength", 0):
            errors.append("%s: too short (min %d characters)" % (path, schema["minLength"]))
        if "maxLength" in schema and len(data) > schema["maxLength"]:
            errors.append("%s: too long (%d characters, max %d)" % (path, len(data), schema["maxLength"]))
        if "pattern" in schema and not re.search(schema["pattern"], data):
            errors.append("%s: does not match the pattern %s" % (path, schema["pattern"]))
    if _is(data, "number"):
        if "minimum" in schema and data < schema["minimum"]:
            errors.append("%s: %s is below the minimum %s" % (path, data, schema["minimum"]))
        if "maximum" in schema and data > schema["maximum"]:
            errors.append("%s: %s is above the maximum %s" % (path, data, schema["maximum"]))
    if isinstance(data, list):
        if len(data) < schema.get("minItems", 0):
            errors.append("%s: needs at least %d item(s), has %d" % (path, schema["minItems"], len(data)))
        if "maxItems" in schema and len(data) > schema["maxItems"]:
            errors.append("%s: at most %d item(s), has %d" % (path, schema["maxItems"], len(data)))
        if isinstance(schema.get("items"), dict):
            for i, v in enumerate(data):
                validate(schema["items"], v, "%s[%d]" % (path, i), errors)
    if isinstance(data, dict):
        props = schema.get("properties", {})
        for k in schema.get("required", []):
            if k not in data:
                if "default" in props.get(k, {}):
                    continue
                errors.append("%s: missing required property \"%s\"" % (path, k))
        for k, s in props.items():
            if k not in data and isinstance(s, dict) and "default" in s:
                data[k] = copy.deepcopy(s["default"])
        extra = schema.get("additionalProperties", True)
        for k, v in data.items():
            if k in props:
                validate(props[k], v, "%s.%s" % (path, k), errors)
            elif extra is False:
                errors.append("%s.%s: unknown property (allowed: %s)" % (path, k, ", ".join(props)))
            elif isinstance(extra, dict):
                validate(extra, v, "%s.%s" % (path, k), errors)
    return errors


def lint_text(data, path="data", out=None):
    """House-style warnings: em and en dashes (Luca's rule). Not fatal."""
    out = [] if out is None else out
    if isinstance(data, str):
        for ch, nm in ((DASHES[0], "an em dash"), (DASHES[1], "an en dash")):
            if ch in data:
                out.append("%s: contains %s; use a comma, colon or full stop" % (path, nm))
    elif isinstance(data, list):
        for i, v in enumerate(data):
            lint_text(v, "%s[%d]" % (path, i), out)
    elif isinstance(data, dict):
        for k, v in data.items():
            lint_text(v, "%s.%s" % (path, k), out)
    return out


SECRET_PATTERNS = [
    re.compile(r"sk-ant-(oat|api)|-----BEGIN [A-Z ]*PRIVATE KEY-----|(sk|ghp|gho|xox[baprs])-[A-Za-z0-9]{16,}"),
    re.compile(r"(^|\s|\")([A-Z0-9_]*(API_KEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)\s*[=:]\s*\S{8,}"),
]


def secret_check(data):
    blob = json.dumps(data, ensure_ascii=False)
    for pat in SECRET_PATTERNS:
        if pat.search(blob):
            return ["data: contains a credential-shaped string; artifacts are served over HTTP, report status, never values"]
    return []


def check(t, data, base=None):
    """(errors, warnings) for data against template t. Fills defaults in place.
    With base (the data file's folder) local asset files are checked too."""
    errors = validate(t.get("schema", {}), data)
    errors += secret_check(data)
    if base is not None and not errors:
        collect_assets(t.get("schema", {}), data, base, None, "", errors)
    return errors, lint_text(data)


# -- assets ----------------------------------------------------------------------

def _is_url(s):
    return bool(re.match(r"^([a-z][a-z0-9+.-]*:|/|#)", s, re.I))


def collect_assets(schema, data, base, dest_dir, url_prefix, errors, path="data", copied=None):
    """Copy every x-asset file into dest_dir and rewrite the value to url_prefix + file name."""
    copied = {} if copied is None else copied
    if not isinstance(schema, dict):
        return copied
    if schema.get("x-asset") and isinstance(data, str) and data and not _is_url(data):
        src = (Path(base) / Path(data).expanduser()).resolve() if not os.path.isabs(os.path.expanduser(data)) else Path(data).expanduser()
        if not src.is_file():
            errors.append("%s: file not found: %s" % (path, src))
            return copied
        name = re.sub(r"[^A-Za-z0-9._-]+", "-", src.name)
        if name in copied and copied[name] != src:
            stem, ext = os.path.splitext(name)
            name = "%s-%d%s" % (stem, len(copied), ext)
        copied[name] = src
        return copied
    if isinstance(data, dict):
        for k, v in data.items():
            collect_assets(schema.get("properties", {}).get(k, {}), v, base, dest_dir, url_prefix, errors, "%s.%s" % (path, k), copied)
    elif isinstance(data, list):
        for i, v in enumerate(data):
            collect_assets(schema.get("items", {}), v, base, dest_dir, url_prefix, errors, "%s[%d]" % (path, i), copied)
    return copied


def rewrite_assets(schema, data, base, url_prefix, copied):
    if not isinstance(schema, dict):
        return data
    if schema.get("x-asset") and isinstance(data, str) and data and not _is_url(data):
        src = (Path(base) / Path(data).expanduser()).resolve() if not os.path.isabs(os.path.expanduser(data)) else Path(data).expanduser()
        for name, p in copied.items():
            if p == src:
                return url_prefix + name
        return data
    if isinstance(data, dict):
        return {k: rewrite_assets(schema.get("properties", {}).get(k, {}), v, base, url_prefix, copied) for k, v in data.items()}
    if isinstance(data, list):
        return [rewrite_assets(schema.get("items", {}), v, base, url_prefix, copied) for v in data]
    return data


# -- derived fields (declared in template.json "timing") ---------------------------

def _words(v):
    if isinstance(v, str):
        return len(v.split())
    if isinstance(v, list):
        return sum(_words(x) for x in v)
    if isinstance(v, dict):
        return sum(_words(x) for x in v.values())
    return 0


def prepare(schema, data):
    """Declared but missing properties become null, so {{x}} inside an item never falls back to an
    outer value with the same name; every object with a string "type" gets an is_<type> flag."""
    if isinstance(data, list):
        return [prepare(schema.get("items", {}) if isinstance(schema, dict) else {}, v) for v in data]
    if not isinstance(data, dict):
        return data
    props = schema.get("properties", {}) if isinstance(schema, dict) else {}
    out = {k: prepare(props.get(k, {}), v) for k, v in data.items()}
    for k in props:
        out.setdefault(k, None)
    if isinstance(out.get("type"), str):
        out["is_" + re.sub(r"\W", "_", out["type"])] = True
    return out


def derive(t, data):
    """Scene timing for templates that declare "timing" in template.json."""
    tm = t.get("timing")
    if not tm:
        return data
    items = data.get(tm.get("list", "scenes"), [])
    start = 0.0
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        it["sid"] = "s%d" % (i + 1)
        if not it.get("seconds"):
            w = sum(_words(it.get(f)) for f in tm.get("text_fields", []))
            per_type = tm.get("min_by_type", {}).get(str(it.get("type")), tm.get("min", 2.5))
            it["seconds"] = round(min(tm.get("max", 9), max(per_type, tm.get("base", 1.5) + w * tm.get("per_word", 0.3))), 2)
        it["start"] = round(start, 2)
        start += float(it["seconds"])
        it["end"] = round(start, 2)
    data["_duration"] = round(start, 2)
    return data


# -- mustache subset ---------------------------------------------------------------

STANDALONE = re.compile(r"(?m)^[ \t]*(\{\{\s*[#^/!][^}]*\}\})[ \t]*\r?\n")
TAG = re.compile(r"\{\{\{\s*(.+?)\s*\}\}\}|\{\{\s*([#^/!&]?)\s*(.+?)\s*\}\}")


def parse(tpl):
    tpl = STANDALONE.sub(r"\1", tpl)
    root = []
    stack = [("", root)]
    pos = 0
    for m in TAG.finditer(tpl):
        if m.start() > pos:
            stack[-1][1].append(("text", tpl[pos:m.start()]))
        pos = m.end()
        if m.group(1) is not None:
            stack[-1][1].append(("var", m.group(1), True))
            continue
        sig, name = m.group(2), m.group(3)
        if sig == "!":
            continue
        if sig in ("#", "^"):
            node = ("sec", name, sig == "^", [])
            stack[-1][1].append(node)
            stack.append((name, node[3]))
        elif sig == "/":
            if len(stack) == 1 or stack[-1][0] != name:
                raise TemplateError("template: {{/%s}} closes %s" % (name, ("{{#%s}}" % stack[-1][0]) if len(stack) > 1 else "nothing"))
            stack.pop()
        else:
            stack[-1][1].append(("var", name, sig == "&"))
    if len(stack) > 1:
        raise TemplateError("template: {{#%s}} is never closed" % stack[-1][0])
    if pos < len(tpl):
        root.append(("text", tpl[pos:]))
    return root


def _lookup(stack, name):
    if name == ".":
        return stack[-1]
    parts = name.split(".")
    for frame in reversed(stack):
        if isinstance(frame, dict) and parts[0] in frame:
            v = frame[parts[0]]
            for p in parts[1:]:
                if isinstance(v, dict):
                    v = v.get(p)
                elif isinstance(v, list) and p.isdigit() and int(p) < len(v):
                    v = v[int(p)]
                else:
                    return None
            return v
    return None


def _scalar(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def _csv_cell(v):
    s = _scalar(v)
    return '"%s"' % s.replace('"', '""') if any(c in s for c in ',"\n') else s


def apply_filter(v, f):
    name, _, arg = f.partition(":")
    name = name.strip()
    seq = v if isinstance(v, list) else [] if v is None else [v]
    if name == "join":
        return (arg or ", ").join(_scalar(x) for x in seq)
    if name == "csv":
        return ",".join(_csv_cell(x) for x in seq)
    if name == "cells":
        return " | ".join(re.sub(r"\s+", " ", _scalar(x)).replace("|", "\\|") for x in seq)
    if name == "sep":
        return "|".join("---" for _ in seq)
    if name == "json":
        return json.dumps(v, ensure_ascii=False)
    if name == "oneline":
        return re.sub(r"\s+", " ", _scalar(v)).strip()
    if name == "lower":
        return _scalar(v).lower()
    if name == "upper":
        return _scalar(v).upper()
    if name == "count":
        return len(seq)
    if name == "default":
        return v if v not in (None, "", []) else arg
    raise TemplateError("template: unknown filter %r" % name)


def _render(nodes, stack, escape):
    out = []
    for n in nodes:
        if n[0] == "text":
            out.append(n[1])
        elif n[0] == "var":
            name, *filters = [x.strip() for x in n[1].split("|")]
            v = _lookup(stack, name)
            for f in filters:
                v = apply_filter(v, f)
            if isinstance(v, list) and not filters:
                v = ", ".join(_scalar(x) for x in v)
            s = _scalar(v)
            out.append(s if (n[2] or not escape) else html.escape(s, quote=True))
        else:
            _, name, inverted, kids = n
            v = _lookup(stack, name)
            empty = v is None or v is False or v == "" or v == [] or v == {}
            if inverted:
                if empty:
                    out.append(_render(kids, stack, escape))
            elif isinstance(v, list):
                for i, item in enumerate(v):
                    frame = {"@n": i + 1, "@index": i, "@first": i == 0, "@last": i == len(v) - 1}
                    out.append(_render(kids, stack + [frame, item], escape))
            elif not empty:
                out.append(_render(kids, stack + [v], escape))
    return "".join(out)


def fill(tpl, data, escape):
    return _render(parse(tpl), [data], escape)


# -- create ------------------------------------------------------------------------

def context(t, data, name, title):
    ctx = dict(data)
    ctx.setdefault("title", title)
    ctx["_name"] = name
    ctx["_template"] = t["id"]
    ctx["_date"] = datetime.date.today().isoformat()
    return ctx


def create(t, data, report_dir, stem, base_dir, force=False, title=None, log=print):
    """Validate, copy assets, fill and write. Returns dict(kind, rel, files, url_rel, warnings)."""
    report_dir = Path(report_dir)
    errors, warnings = check(t, data)
    if errors:
        raise TemplateError("data does not fit template %s:\n  %s" % (t["id"], "\n  ".join(errors)))
    tdir = Path(t["dir"])
    kind = t["kind"]
    title = title or data.get("title") or stem.replace("-", " ").title()
    if kind == "markdown":
        target = report_dir / (stem + ".md")
        asset_dir, prefix = report_dir / (stem + "-files"), stem + "-files/"
    elif kind == "react":
        target = report_dir / stem
        asset_dir, prefix = target / "assets", "assets/"
    else:
        target = report_dir / (stem + ".motion")
        asset_dir, prefix = target / "assets", "assets/"
    if target.exists() and not force:
        raise TemplateError("%s already exists: edit it, or pass --force to regenerate it from the data" % target)
    aerr = []
    copied = collect_assets(t.get("schema", {}), data, base_dir, asset_dir, prefix, aerr)
    if aerr:
        raise TemplateError("data does not fit template %s:\n  %s" % (t["id"], "\n  ".join(aerr)))
    data = rewrite_assets(t.get("schema", {}), data, base_dir, prefix, copied)
    view = derive(t, prepare(t.get("schema", {}), copy.deepcopy(data)))
    ctx = context(t, view, stem, title)
    files = []

    def put_assets():
        if copied:
            asset_dir.mkdir(parents=True, exist_ok=True)
            for nm, src in copied.items():
                shutil.copyfile(src, asset_dir / nm)
                files.append(str(asset_dir / nm))

    if kind == "markdown":
        tpl = (tdir / t.get("entry", "template.md")).read_text(encoding="utf-8")
        out = fill(tpl, ctx, escape=False)
        out = re.sub(r"\n{3,}", "\n\n", out).strip() + "\n"
        put_assets()
        target.write_text(out, encoding="utf-8")
        files.append(str(target))
        return {"kind": kind, "rel": target.name, "files": files, "warnings": warnings}
    if kind == "react":
        render = set(t.get("render", ["index.html"]))
        if target.exists() and force:
            pass
        target.mkdir(parents=True, exist_ok=True)
        for src in sorted(tdir.rglob("*")):
            relp = src.relative_to(tdir)
            if relp.parts[0] in META_FILES or relp.name.startswith(".") or relp.name in t.get("skip", []) or src.is_dir():
                continue
            if str(relp) == t.get("example") or relp.name.startswith("data.example"):
                continue
            dst = target / relp
            dst.parent.mkdir(parents=True, exist_ok=True)
            if str(relp) in render:
                dst.write_text(fill(src.read_text(encoding="utf-8"), ctx, escape=True), encoding="utf-8")
            else:
                shutil.copyfile(src, dst)
            files.append(str(dst))
        put_assets()
        clean = {k: v for k, v in data.items() if not k.startswith("_")}
        (target / "data.json").write_text(json.dumps(clean, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        files.append(str(target / "data.json"))
        return {"kind": kind, "rel": stem, "files": files, "warnings": warnings}
    # motion: the standard scaffold (player page + vendor) then the filled composition
    import motion as MO
    size = data.get("size") or t.get("size")
    page = report_dir / (stem + ".html")
    dur = max(3, view.get("_duration") or 12)
    if not (target / "index.html").is_file():
        if page.exists() and not force:
            raise TemplateError("%s already exists" % page)
        if page.exists():
            page.unlink()
        if target.exists():
            shutil.rmtree(target)
        MO.scaffold(report_dir, stem, title, size=size, duration=dur)
    w, h = MO.parse_size(size)
    ctx.update({"_w": w, "_h": h, "_u": h if w >= h else round(w * 1.5), "_duration": dur})
    tpl = (tdir / t.get("entry", "composition.html")).read_text(encoding="utf-8")
    comp = fill(tpl, ctx, escape=True)
    put_assets()
    (target / "index.html").write_text(comp, encoding="utf-8")
    files += [str(page), str(target / "index.html")]
    (target / "data.json").write_text(json.dumps({k: v for k, v in data.items() if not k.startswith("_")}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"kind": kind, "rel": page.name, "files": files, "warnings": warnings, "duration": dur}
