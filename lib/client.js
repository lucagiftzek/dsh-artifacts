window.__ModuleLoader__.load({ id: "dsh-artifacts", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.jsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var TAB_ID = "dsh-artifacts:library";
var LS_INDEX_KEY = "dsh-artifacts:indexUrl";
var DEFAULT_LIST_URL = "/report/?list=1";
function listUrl() {
  try {
    const v = typeof localStorage !== "undefined" && localStorage.getItem(LS_INDEX_KEY);
    if (v && v.trim()) return v.trim();
  } catch {
  }
  return DEFAULT_LIST_URL;
}
function absoluteUrl(u) {
  return /^https?:\/\//i.test(u) ? u : (typeof location !== "undefined" ? location.origin : "") + u;
}
var POLL_MS = 5e3;
var EXT_LABEL = {
  html: "HTML",
  md: "Markdown",
  txt: "Text",
  json: "JSON",
  csv: "CSV",
  svg: "SVG"
};
function fmtSize(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function fmtAge(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1e3 - ts));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts * 1e3).toLocaleString();
}
var S = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    minHeight: 0,
    overflow: "hidden",
    font: "inherit",
    fontSize: 13
  },
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid rgba(128,128,128,.28)",
    flex: "0 0 auto"
  },
  title: { fontWeight: 600, letterSpacing: ".01em" },
  count: { opacity: 0.62, fontSize: 12 },
  spacer: { flex: 1 },
  btn: {
    font: "inherit",
    fontSize: 12,
    padding: "3px 9px",
    cursor: "pointer",
    border: "1px solid rgba(128,128,128,.4)",
    borderRadius: 5,
    background: "transparent",
    color: "inherit",
    // Fixed box on purpose: toolbar labels must never change with state, or
    // every poll re-render shifts the buttons and the bar visibly "ticks".
    // Busy is conveyed through aria-busy and the tooltip only - nothing
    // that can change a box.
    minWidth: 74,
    boxSizing: "border-box",
    textAlign: "center",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums"
  },
  list: {
    flex: "0 1 auto",
    maxHeight: "38%",
    overflowY: "auto",
    borderBottom: "1px solid rgba(128,128,128,.28)"
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(128,128,128,.12)"
  },
  rowOn: { background: "rgba(128,128,128,.18)" },
  name: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  meta: {
    fontSize: 11.5,
    opacity: 0.62,
    flex: "0 0 auto",
    // Same rule as the toolbar - an age string changing length must not move
    // anything, so the box is fixed and the numerals are tabular.
    minWidth: 104,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap"
  },
  badge: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: ".04em",
    border: "1px solid rgba(128,128,128,.4)",
    borderRadius: 4,
    padding: "0 4px",
    opacity: 0.78
  },
  /* Segmented scope toggle. Both halves are fixed-width and only their
   * border/weight change when selected, so clicking one cannot shift the
   * toolbar -- the same rule the Refresh button follows. */
  seg: { display: "flex", gap: 0, flex: "0 0 auto" },
  segBtn: {
    minWidth: 66,
    boxSizing: "border-box",
    textAlign: "center",
    whiteSpace: "nowrap",
    fontVariantNumeric: "tabular-nums",
    font: "inherit",
    fontSize: 11.5,
    lineHeight: "20px",
    padding: "0 8px",
    border: "1px solid rgba(128,128,128,.45)",
    background: "transparent",
    borderRadius: 0,
    cursor: "pointer",
    opacity: 0.68
  },
  segBtnFirst: { borderRadius: "5px 0 0 5px" },
  segBtnLast: { borderRadius: "0 5px 5px 0", borderLeft: 0 },
  segBtnOn: { opacity: 1, fontWeight: 600 },
  /* A glyph marker, not a colour: currentColor keeps it theme-neutral. */
  mineDot: { flex: "0 0 auto", fontSize: 8, lineHeight: "20px", opacity: 0.75, paddingRight: 5 },
  preview: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" },
  frame: { flex: 1, width: "100%", border: 0, minHeight: 0, background: "transparent" },
  note: { padding: "14px 12px", lineHeight: 1.6, opacity: 0.78 },
  err: {
    padding: "10px 12px",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
    borderTop: "1px solid rgba(128,128,128,.28)"
  },
  code: { fontFamily: "ui-monospace, monospace", fontSize: 12 }
};
var SCOPE_PREF_KEY = "dsh-artifacts:scope";
function readScopePref() {
  try {
    const v = typeof localStorage !== "undefined" && localStorage.getItem(SCOPE_PREF_KEY);
    return v === "mine" || v === "all" ? v : null;
  } catch {
    return null;
  }
}
function ArtifactsView({ visible, scope }) {
  const [items, setItems] = (0, import_react.useState)([]);
  const [error, setError] = (0, import_react.useState)(null);
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [selected, setSelected] = (0, import_react.useState)(null);
  const [reloadKey, setReloadKey] = (0, import_react.useState)(0);
  const [scopePref, setScopePref] = (0, import_react.useState)(readScopePref);
  const sessionId = scope && typeof scope.sessionId === "string" ? scope.sessionId : "";
  const load = (0, import_react.useCallback)(async () => {
    setBusy(true);
    try {
      const base = listUrl();
      const url = sessionId ? base + (base.includes("?") ? "&" : "?") + "session=" + encodeURIComponent(sessionId) : base;
      const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error("expected a JSON index but got " + (ct || "no content-type") + " \u2014 the GUI session may not be authenticated against the artifact server.");
      }
      const data = await res.json();
      if (data && data.error) throw new Error(data.error);
      setItems(Array.isArray(data && data.items) ? data.items : []);
      setError(null);
    } catch (e) {
      setError(e && e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);
  (0, import_react.useEffect)(() => {
    if (!visible) return void 0;
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [visible, load]);
  const current = selected && items.some((i) => i.name === selected.name) ? selected : null;
  const scopeKnown = !!sessionId && items.some((i) => typeof i.mine === "boolean");
  const mineCount = scopeKnown ? items.filter((i) => i.mine).length : 0;
  const effective = scopePref || (mineCount > 0 ? "mine" : "all");
  const shown = scopeKnown && effective === "mine" ? items.filter((i) => i.mine) : items;
  const chooseScope = (next) => {
    setScopePref(next);
    try {
      typeof localStorage !== "undefined" && localStorage.setItem(SCOPE_PREF_KEY, next);
    } catch {
    }
  };
  const openExternal = (item) => {
    if (item) window.open(item.url, "_blank", "noopener,noreferrer");
  };
  const copyLink = async (item) => {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(absoluteUrl(item.url));
    } catch {
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.root, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.bar, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.title, children: "Artifacts" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.count, children: !items.length ? "" : scopeKnown && effective === "mine" ? `${mineCount} of ${items.length} file${items.length === 1 ? "" : "s"}` : `${items.length} file${items.length === 1 ? "" : "s"}` }),
      scopeKnown && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: S.seg, role: "group", "aria-label": "Which artifacts to list", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            "aria-pressed": effective === "mine",
            style: { ...S.segBtn, ...S.segBtnFirst, ...effective === "mine" ? S.segBtnOn : null },
            title: "Only artifacts this chat produced",
            onClick: () => chooseScope("mine"),
            children: "This chat"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            "aria-pressed": effective === "all",
            style: { ...S.segBtn, ...S.segBtnLast, ...effective === "all" ? S.segBtnOn : null },
            title: `All ${items.length} artifacts on this host`,
            onClick: () => chooseScope("all"),
            children: "All"
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.spacer }),
      current && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: S.btn,
            title: "Reload this preview",
            onClick: () => setReloadKey((k) => k + 1),
            children: "Reload"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: S.btn,
            title: "Copy the shareable link",
            onClick: () => copyLink(current),
            children: "Copy link"
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            style: S.btn,
            title: "Open in a real browser tab",
            onClick: () => openExternal(current),
            children: "Open \u2197"
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "button",
        {
          type: "button",
          style: S.btn,
          onClick: load,
          "aria-busy": busy,
          title: busy ? "Reading the artifact directory\u2026" : "Re-read the artifact directory",
          children: "Refresh"
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.list, children: [
      scopeKnown && effective === "mine" && items.length > 0 && mineCount === 0 && !error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.note, children: [
        "Nothing from this chat yet.",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        "Attribution is read from this session's transcript, so an artifact only appears here once a tool call in ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("em", { children: "this" }),
        " chat has written it. Switch to ",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "All" }),
        " to see every artifact on the host."
      ] }),
      items.length === 0 && !error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.note, children: [
        "No artifacts yet.",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        "This tab lists whatever the index endpoint returns. Drop a file into the artifact directory your endpoint serves and it appears here within ",
        POLL_MS / 1e3,
        "s.",
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.code, children: listUrl() })
      ] }),
      shown.map((it) => {
        const on = current && current.name === it.name;
        return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
          "div",
          {
            style: { ...S.row, ...on ? S.rowOn : null },
            onClick: () => setSelected(it),
            title: it.mine ? `${it.name} \u2014 from this chat` : it.name,
            children: [
              scopeKnown && it.mine && effective === "all" && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.mineDot, "aria-label": "from this chat", children: "\u25CF" }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.badge, children: EXT_LABEL[it.ext] || it.ext }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.name, children: it.name }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { style: S.meta, children: [
                fmtSize(it.size),
                " \xB7 ",
                fmtAge(it.mtime)
              ] })
            ]
          },
          it.name
        );
      })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: S.preview, children: current ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "iframe",
      {
        style: S.frame,
        src: current.url,
        title: current.name,
        referrerPolicy: "no-referrer"
      },
      current.name + ":" + reloadKey
    ) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { style: S.note, children: shown.length ? "Select an artifact above to preview it here. HTML previews refresh themselves when the file is regenerated." : "" }) }),
    error && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { style: S.err, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: "Could not read the artifact index." }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("br", {}),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { style: S.code, children: error })
    ] })
  ] });
}
var icon = (size) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
  "svg",
  {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.3",
    strokeLinejoin: "round",
    "aria-hidden": "true",
    children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M3.2 1.8h6.1L12.8 5.3v8.9H3.2z" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M9.3 1.8v3.5h3.5" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M5.4 9h5.2M5.4 11.4h3.2", strokeLinecap: "round" })
    ]
  }
);
var inject = ["betterSidebar"];
function apply(ctx) {
  if (!ctx.betterSidebar || typeof ctx.betterSidebar.registerTab !== "function") {
    console.error("[dsh-artifacts] ctx.betterSidebar.registerTab is unavailable; tab not registered");
    return;
  }
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: TAB_ID,
    title: "Artifacts",
    order: 92,
    single: true,
    icon,
    /* Forward `scope` explicitly rather than spreading props: the view needs
     * the session id to ask the index which artifacts belong to this chat, and
     * a silent omission here degrades to "list everything" with no error. */
    component: (props) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ArtifactsView, { visible: props.visible, scope: props.scope })
  }), "dsh-artifacts: register the Artifacts sidebar tab");
}
return module.exports; } });
//# sourceMappingURL=client.js.map
