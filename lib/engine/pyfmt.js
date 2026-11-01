const PY_WS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WS_RUN = new RegExp("[" + PY_WS + "]+", "g");
const WS_LEAD = new RegExp("^[" + PY_WS + "]+");
const WS_TRAIL = new RegExp("[" + PY_WS + "]+$");
function pyStrip(s) {
  return s.replace(WS_LEAD, "").replace(WS_TRAIL, "");
}
function collapseWs(s) {
  return s.replace(WS_RUN, " ");
}
function wordCount(s) {
  return s.split(WS_RUN).filter((x) => x !== "").length;
}
function pyLen(s) {
  let n = 0;
  for (const _ of s) n++;
  return n;
}
function exactDecimal(x) {
  const neg = x < 0 || Object.is(x, -0);
  const s = Math.abs(x).toFixed(100);
  const [i, f] = s.split(".");
  return { neg, int: i, frac: (f || "").replace(/0+$/, "") };
}
function pyRound(x, nd = 0) {
  if (!Number.isFinite(x)) return x;
  if (Number.isInteger(x)) return x;
  const { neg, int, frac } = exactDecimal(x);
  const keep = frac.slice(0, nd).padEnd(nd, "0");
  const rest = frac.slice(nd);
  let digits = BigInt(int + keep);
  if (rest !== "") {
    const first = rest.charCodeAt(0) - 48;
    const tail = rest.slice(1).replace(/0+$/, "");
    const up = first > 5 || first === 5 && (tail !== "" || digits % 2n === 1n);
    if (up) digits += 1n;
  }
  const scaled = Number(digits) / 10 ** nd;
  const str = digits.toString().padStart(nd + 1, "0");
  const dec = nd ? str.slice(0, str.length - nd) + "." + str.slice(str.length - nd) : str;
  const v = Number(dec);
  const out = Number.isFinite(v) ? v : scaled;
  return neg ? -out : out;
}
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const e = Math.abs(x).toExponential();
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(e);
  if (!m) return String(x);
  const digits = m[1] + (m[2] || "");
  const exp = parseInt(m[3], 10);
  if (exp < -4 || exp >= 16) {
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const ex = Math.abs(exp).toString().padStart(2, "0");
    return sign + mant + "e" + (exp < 0 ? "-" : "+") + ex;
  }
  let out;
  if (exp < 0) out = "0." + "0".repeat(-exp - 1) + digits;
  else if (digits.length > exp + 1) out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
  else out = digits + "0".repeat(exp + 1 - digits.length) + ".0";
  return sign + out;
}
function pyNum(x) {
  if (Number.isInteger(x)) return BigInt(x).toString();
  return pyFloatRepr(x);
}
function pyStr(v) {
  if (v === null || v === void 0) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyNum(v);
  if (typeof v === "string") return v;
  return pyDumps(v);
}
function pyRepr(s) {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "	") out += "\\t";
    else if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127) out += "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
    else out += ch;
  }
  return q + out + q;
}
function dumpString(s, ensureAscii) {
  const j = JSON.stringify(s);
  if (!ensureAscii) return j;
  return j.replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}
function pyDumps(v, opts = {}) {
  const ensureAscii = opts.ensureAscii !== false;
  const indent = opts.indent;
  const walk = (x, level) => {
    if (x === null || x === void 0) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (Number.isNaN(x)) return "NaN";
      if (!Number.isFinite(x)) return x > 0 ? "Infinity" : "-Infinity";
      return pyNum(x);
    }
    if (typeof x === "string") return dumpString(x, ensureAscii);
    const pad = indent === void 0 ? "" : "\n" + " ".repeat(indent * (level + 1));
    const end = indent === void 0 ? "" : "\n" + " ".repeat(indent * level);
    const sep = indent === void 0 ? ", " : ",";
    if (Array.isArray(x)) {
      if (!x.length) return "[]";
      return "[" + x.map((y) => pad + walk(y, level + 1)).join(sep) + end + "]";
    }
    if (typeof x === "object") {
      const keys = Object.keys(x);
      if (!keys.length) return "{}";
      return "{" + keys.map((k) => pad + dumpString(k, ensureAscii) + ": " + walk(x[k], level + 1)).join(sep) + end + "}";
    }
    return "null";
  };
  return walk(v, 0);
}
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}
function pyTitle(s) {
  let out = "";
  let prevCased = false;
  for (const ch of s) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    const cased = lo !== up;
    if (cased) out += prevCased ? lo : up;
    else out += ch;
    prevCased = cased;
  }
  return out;
}
function pyEq(a, b) {
  const numLike = (x) => typeof x === "number" || typeof x === "boolean";
  if (numLike(a) && numLike(b)) return Number(a) === Number(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEq(a[k], b[k]));
}
export {
  PY_WS,
  collapseWs,
  htmlEscape,
  pyDumps,
  pyEq,
  pyFloatRepr,
  pyLen,
  pyNum,
  pyRepr,
  pyRound,
  pyStr,
  pyStrip,
  pyTitle,
  wordCount
};
