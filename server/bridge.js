/* dsh-artifacts bridge v2 -- injected into every served HTML artifact.
 *
 * window.dsh (alias window.artifact):
 *   dsh.send(text)                 post a user message into the owning chat
 *   dsh.context(textOrObject)      silent context, read by the agent on its next turn ("artifact inbox")
 *   dsh.storage.get/set/delete/list/all   persistent JSON storage per artifact (server-side)
 *   dsh.ai(prompt, {system, model, json, maxTokens})  -> text   (LLM call, key stays server-side)
 *   dsh.image(prompt, opts) -> url ; dsh.tts(text, opts) -> url ; dsh.video(prompt, opts) -> url
 *   dsh.transcribe(blob) -> text ; dsh.capabilities() -> what media backends exist
 *   dsh.compose(text)              put text into the chat composer (sidebar only)
 * Compatibility aliases (only when the page did not define them):
 *   window.claude.complete(prompt) ; window.storage.{get,set,delete,list} (Claude artifact API)
 *   window.openai.{sendFollowUpMessage, setWidgetState, widgetState, openExternal, theme}
 * Declarative two-way UI without writing JS:
 *   <button data-dsh-send="Approve the plan">  <a data-dsh-context="picked option B">
 *   <form data-dsh-form="submit|context" data-dsh-title="Survey">  (fields serialised on submit)
 * Also: live reload with scroll restore, error capture ("Fix with agent"), pick-and-ask.
 */
(function () {
  if (window.__dshBridge) return;
  window.__dshBridge = true;
  var C = window.__DSH_ARTIFACT__ || {};
  var params = new URLSearchParams(location.search);
  var session = params.get('dsh_session') || C.owner || '';
  var framed = false;
  try { framed = window.parent !== window; } catch (e) { framed = true; }
  var API = C.api || '/report/_api/';
  var PUBLIC = !!C.public;

  function call(route, body, method) {
    if (PUBLIC) return Promise.reject(new Error('dsh: ' + route + ' is not available on a public link'));
    var opts = { method: method || (body ? 'POST' : 'GET'), credentials: 'same-origin', headers: {} };
    if (body) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (opts.method !== 'GET') opts.headers['X-Artifact-Api'] = '1';
    return fetch(API + route, opts).then(function (r) {
      return r.text().then(function (t) {
        var j; try { j = t ? JSON.parse(t) : {}; } catch (e) { j = { error: t }; }
        if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }
  function q(o) { return Object.keys(o).filter(function (k) { return o[k] != null; }).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&'); }
  function toParent(msg) { if (framed) try { window.parent.postMessage(Object.assign({ source: 'dsh-artifact', name: C.name }, msg), location.origin); } catch (e) {} }

  /* -- toast ------------------------------------------------------------- */
  var toastHost;
  function toast(text, bad) {
    try {
      if (!toastHost) {
        toastHost = document.createElement('div');
        toastHost.setAttribute('data-dsh-ui', '');
        var sr = toastHost.attachShadow({ mode: 'open' });
        sr.innerHTML = '<style>.t{position:fixed;right:14px;bottom:14px;z-index:2147483647;font:13px/1.4 system-ui,sans-serif;background:#1c1917;color:#f4efe9;padding:8px 12px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:340px;opacity:0;transform:translateY(6px);transition:.18s}.t.on{opacity:1;transform:none}.t.bad{background:#8f2d22}</style><div class="t"></div>';
        document.documentElement.appendChild(toastHost);
      }
      var el = toastHost.shadowRoot.querySelector('.t');
      el.textContent = text; el.className = 't on' + (bad ? ' bad' : '');
      clearTimeout(el._t); el._t = setTimeout(function () { el.className = 't' + (bad ? ' bad' : ''); }, 2600);
    } catch (e) {}
  }

  /* -- storage --------------------------------------------------------------- */
  var LS = 'dsh-artifact:' + C.name + ':';
  var storage = PUBLIC ? {
    get: function (k) { try { var v = localStorage.getItem(LS + k); return Promise.resolve(v == null ? null : JSON.parse(v)); } catch (e) { return Promise.resolve(null); } },
    set: function (k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) {} return Promise.resolve(true); },
    delete: function (k) { try { localStorage.removeItem(LS + k); } catch (e) {} return Promise.resolve(true); },
    list: function (p) { var out = []; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k.indexOf(LS + (p || '')) === 0) out.push(k.slice(LS.length)); } } catch (e) {} return Promise.resolve(out); },
    all: function () { return Promise.resolve({}); },
  } : {
    get: function (k) { return call('storage?' + q({ name: C.name, key: k })).then(function (r) { return r.exists ? r.value : null; }); },
    has: function (k) { return call('storage?' + q({ name: C.name, key: k })).then(function (r) { return !!r.exists; }); },
    set: function (k, v) { return call('storage', { name: C.name, key: k, value: v }).then(function () { return true; }); },
    delete: function (k) { return call('storage', { name: C.name, key: k, delete: true }).then(function () { return true; }); },
    list: function (p) { return call('storage?' + q({ name: C.name, list: p || '' })).then(function (r) { return r.keys; }); },
    all: function () { return call('storage?' + q({ name: C.name })).then(function (r) { return r.data; }); },
  };
  /* Agent -> live page without a rewrite: 'artifact state-set <name> <key> <json>' changes
   * the value server-side and every watcher fires within ~2 s. */
  storage.watch = function (k, fn, ms) {
    var last;
    function tick() {
      if (document.hidden) return;
      storage.get(k).then(function (v) { var s = JSON.stringify(v); if (s !== last) { last = s; try { fn(v); } catch (e) { console.error(e); } } }, function () {});
    }
    tick();
    var t = setInterval(tick, ms || 2000);
    return function () { clearInterval(t); };
  };

  /* -- core API ---------------------------------------------------------------- */
  var lastSend = 0;
  function send(text, opts) {
    opts = opts || {};
    text = String(text == null ? '' : text);
    if (!text.trim()) return Promise.reject(new Error('dsh.send: empty message'));
    var now = Date.now();
    if (now - lastSend < 1500) return Promise.reject(new Error('dsh.send: too fast'));
    lastSend = now;
    return call('send', { name: C.name, session: session, text: text, mode: 'submit' }).then(function (r) {
      if (!opts.quiet) toast('Sent to chat');
      toParent({ type: 'dsh:sent', text: text });
      return r;
    }, function (e) { toast('Not sent: ' + e.message, true); throw e; });
  }
  function context(v, opts) {
    var text = typeof v === 'string' ? v : JSON.stringify(v);
    return call('send', { name: C.name, session: session, text: text, data: typeof v === 'string' ? null : v, mode: 'context' }).then(function (r) {
      if (!(opts && opts.quiet)) toast('Saved for the agent');
      toParent({ type: 'dsh:context' });
      return r;
    });
  }
  function media(kind, payload) {
    payload = Object.assign({ kind: kind, name: C.name, session: session }, payload || {});
    return call('media', payload).then(function (r) {
      if (r.job) return poll(r.job, payload.onProgress);
      return r;
    });
  }
  function poll(id, onProgress) {
    return new Promise(function (resolve, reject) {
      (function tick() {
        call('job?' + q({ id: id })).then(function (r) {
          if (onProgress) try { onProgress(r); } catch (e) {}
          if (r.status === 'done') resolve(r);
          else if (r.status === 'failed') reject(new Error(r.error || 'job failed'));
          else setTimeout(tick, 4000);
        }, reject);
      })();
    });
  }
  function blobToB64(blob) {
    return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result).split(',')[1]); }; fr.onerror = rej; fr.readAsDataURL(blob); });
  }

  var dsh = {
    version: 2, name: C.name, session: session, framed: framed, public: PUBLIC,
    send: send, context: context, storage: storage, toast: toast,
    ai: function (prompt, o) {
      o = o || {};
      return call('ai', { prompt: prompt, system: o.system, model: o.model, json: !!o.json, maxTokens: o.maxTokens, messages: o.messages, name: C.name })
        .then(function (r) { return o.json ? (r.json != null ? r.json : JSON.parse(r.text)) : r.text; });
    },
    image: function (prompt, o) { return media('image', Object.assign({ prompt: prompt }, o)).then(function (r) { return r.url; }); },
    tts: function (text, o) { return media('tts', Object.assign({ text: text }, o)).then(function (r) { return r.url; }); },
    video: function (prompt, o) { return media('video', Object.assign({ prompt: prompt }, o)).then(function (r) { return r.url; }); },
    music: function (prompt, o) { return media('music', Object.assign({ prompt: prompt }, o)).then(function (r) { return r.url; }); },
    transcribe: function (blob, o) { return blobToB64(blob).then(function (b64) { return media('stt', Object.assign({ audio: b64, mime: blob.type }, o)); }).then(function (r) { return r.text; }); },
    capabilities: function () { return call('capabilities'); },
    compose: function (text) {
      if (framed) { toParent({ type: 'dsh:compose', text: String(text) }); return Promise.resolve(true); }
      try { navigator.clipboard.writeText(String(text)); toast('Copied - paste it into the chat'); } catch (e) {}
      return Promise.resolve(false);
    },
    reload: function () { location.reload(); },
  };
  dsh.speak = dsh.tts;
  window.dsh = dsh;
  if (!window.artifact) window.artifact = dsh;

  /* -- compatibility aliases ------------------------------------------------- */
  if (!window.claude) window.claude = { complete: function (p) { return dsh.ai(typeof p === 'string' ? p : JSON.stringify(p)); } };
  if (!('storage' in window)) {
    window.storage = {
      get: function (k) { return storage.get(k).then(function (v) { if (v === null) throw new Error('Key not found: ' + k); return { key: k, value: v, shared: false }; }); },
      set: function (k, v) { return storage.set(k, v).then(function () { return { key: k, value: v, shared: false }; }); },
      delete: function (k) { return storage.delete(k).then(function () { return { key: k, deleted: true, shared: false }; }); },
      list: function (p) { return storage.list(p).then(function (keys) { return { keys: keys, prefix: p, shared: false }; }); },
    };
  }
  if (!window.openai) {
    var oa = {
      theme: matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      displayMode: 'inline', locale: navigator.language, toolInput: {}, toolOutput: null, widgetState: null,
      sendFollowUpMessage: function (a) { return send(a && a.prompt != null ? a.prompt : a); },
      setWidgetState: function (s) { oa.widgetState = s; return storage.set('__widgetState', s); },
      openExternal: function (a) { window.open(a && a.href ? a.href : a, '_blank', 'noopener'); },
      callTool: function () { return Promise.reject(new Error('callTool is not available in dsh artifacts; use dsh.send or dsh.ai')); },
      requestDisplayMode: function () { return Promise.resolve({ mode: 'inline' }); },
    };
    window.openai = oa;
    if (!PUBLIC) storage.get('__widgetState').then(function (v) { oa.widgetState = v; }, function () {});
  }

  /* -- declarative two-way UI ------------------------------------------------- */
  function fieldText(form) {
    var fd = new FormData(form), lines = [], obj = {};
    fd.forEach(function (v, k) {
      if (v instanceof File) return;
      if (obj[k] !== undefined) obj[k] = [].concat(obj[k], v); else obj[k] = v;
    });
    Object.keys(obj).forEach(function (k) {
      var label = form.querySelector('[name="' + k + '"]');
      var lab = label && label.closest('label') ? label.closest('label').textContent.trim().split('\n')[0] : k;
      lines.push('- ' + (lab || k) + ': ' + [].concat(obj[k]).join(', '));
    });
    return { obj: obj, text: lines.join('\n') };
  }
  document.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest && ev.target.closest('[data-dsh-send],[data-dsh-context]');
    if (!el) return;
    ev.preventDefault();
    if (el.hasAttribute('data-dsh-send')) send(el.getAttribute('data-dsh-send') || el.textContent.trim());
    else context(el.getAttribute('data-dsh-context') || el.textContent.trim());
    el.setAttribute('data-dsh-done', '');
  }, true);
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-dsh-form')) return;
    ev.preventDefault();
    var mode = form.getAttribute('data-dsh-form') || 'submit';
    var f = fieldText(form);
    var title = form.getAttribute('data-dsh-title') || 'Form';
    storage.set('form:' + title, f.obj).catch(function () {});
    var p = mode === 'context' ? context({ form: title, values: f.obj }) : send(title + ' submitted:\n' + f.text);
    p.then(function () { form.setAttribute('data-dsh-done', ''); });
  }, true);

  /* -- error capture ------------------------------------------------------------ */
  var errs = 0;
  function reportError(message, stack, where) {
    if (errs++ > 4) return;
    var m = String(message || 'error');
    toParent({ type: 'dsh:error', message: m, stack: String(stack || ''), where: where });
    if (!PUBLIC && session) call('error', { name: C.name, session: session, message: m, stack: String(stack || ''), where: where }).catch(function () {});
  }
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target !== window && e.target.tagName) { reportError('failed to load ' + e.target.tagName.toLowerCase() + ' ' + (e.target.src || e.target.href || ''), '', 'resource'); return; }
    reportError(e.message, e.error && e.error.stack, (e.filename || '') + ':' + (e.lineno || ''));
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason; reportError(r && r.message ? r.message : String(r), r && r.stack, 'promise');
  });

  /* -- pick-and-ask (driven by the sidebar) -------------------------------------- */
  var picking = false, hoverBox;
  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 5 && el !== document.body) {
      var s = el.tagName.toLowerCase();
      if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
      var cls = [].slice.call(el.classList || []).filter(function (c) { return !/^(dsh|is-|has-)/.test(c); }).slice(0, 2);
      if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
      var sib = el.parentElement ? [].filter.call(el.parentElement.children, function (x) { return x.tagName === el.tagName; }) : [];
      if (sib.length > 1) s += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
      parts.unshift(s);
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function nearestHeading(el) {
    var n = el;
    while (n && n !== document.body) {
      var p = n.previousElementSibling;
      while (p) { if (/^H[1-4]$/.test(p.tagName)) return p.textContent.trim().slice(0, 120); p = p.previousElementSibling; }
      n = n.parentElement;
    }
    return '';
  }
  function setPick(on) {
    picking = on;
    if (!hoverBox) {
      hoverBox = document.createElement('div');
      hoverBox.setAttribute('data-dsh-ui', '');
      hoverBox.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #d8694c;background:rgba(216,105,76,.12);border-radius:3px;transition:all .06s;display:none';
      document.documentElement.appendChild(hoverBox);
    }
    hoverBox.style.display = 'none';
    document.documentElement.style.cursor = on ? 'crosshair' : '';
  }
  document.addEventListener('mousemove', function (e) {
    if (!picking) return;
    var r = e.target.getBoundingClientRect();
    hoverBox.style.display = 'block';
    hoverBox.style.left = r.left + 'px'; hoverBox.style.top = r.top + 'px';
    hoverBox.style.width = r.width + 'px'; hoverBox.style.height = r.height + 'px';
  }, true);
  document.addEventListener('click', function (e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    setPick(false);
    var html = el.outerHTML || '';
    toParent({ type: 'dsh:picked', selector: cssPath(el), tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400),
      heading: nearestHeading(el), html: html.length > 600 ? html.slice(0, 600) + '...' : html });
  }, true);
  document.addEventListener('keydown', function (e) { if (picking && e.key === 'Escape') { setPick(false); toParent({ type: 'dsh:picked', cancelled: true }); } }, true);

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    var d = e.data || {};
    if (d.type === 'dsh:pick') setPick(!!d.on);
    else if (d.type === 'dsh:highlight' && d.selector) {
      try { var el = document.querySelector(d.selector); if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.animate([{ outline: '3px solid #d8694c' }, { outline: '3px solid transparent' }], { duration: 1600 }); } } catch (x) {}
    } else if (d.type === 'dsh:session' && d.session) { session = d.session; dsh.session = session; }
  });

  /* -- size reporting + ready ---------------------------------------------------- */
  function size() { toParent({ type: 'dsh:size', height: document.documentElement.scrollHeight }); }
  if (framed && window.ResizeObserver) {
    var ro = new ResizeObserver(function () { clearTimeout(size._t); size._t = setTimeout(size, 120); });
    document.addEventListener('DOMContentLoaded', function () { ro.observe(document.documentElement); });
  }
  document.addEventListener('DOMContentLoaded', function () { toParent({ type: 'dsh:ready', title: document.title }); });

  /* -- live reload (keeps the scroll position) ------------------------------------ */
  var SKEY = 'dsh-scroll:' + location.pathname;
  try {
    var saved = sessionStorage.getItem(SKEY);
    if (saved) {
      sessionStorage.removeItem(SKEY);
      var y = +saved;
      var restore = function () { window.scrollTo(0, y); };
      if (document.readyState === 'complete') restore(); else window.addEventListener('load', restore);
    }
  } catch (e) {}
  if (C.etag) {
    var probe = location.pathname + '?' + (location.search ? location.search.slice(1) + '&' : '') + 'artifact-etag=1';
    var etag = C.etag, failures = 0;
    setInterval(function () {
      if (document.hidden || picking) return;
      fetch(probe, { cache: 'no-store', credentials: 'same-origin' }).then(function (r) { return r.text(); }).then(function (t) {
        t = t.trim(); failures = 0;
        if (t && t !== etag && t.charAt(0) === '"') {
          try { sessionStorage.setItem(SKEY, String(window.scrollY)); } catch (e) {}
          location.reload();
        }
      }).catch(function () { failures++; });
    }, 2000);
  }
})();
