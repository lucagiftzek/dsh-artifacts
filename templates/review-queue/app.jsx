// Review queue: approve / edit / reject one card at a time, with keyboard shortcuts.
// Template from ~/estate/templates/artifacts/review-queue (see its README.md). Edit data.json, not this file.
const { useState, useEffect, useMemo, useRef } = React;

const TONES = {
  green: 'bg-emerald-100 text-emerald-800', amber: 'bg-amber-100 text-amber-800', red: 'bg-rose-100 text-rose-800',
  gray: 'bg-stone-200 text-stone-700', blue: 'bg-sky-100 text-sky-800',
};
const hasDash = (t) => /[\u2013\u2014]|\s-+\s|--/.test(t || '');

function Badge({ tone, children, title }) {
  return <span title={title || ''} className={'text-xs px-2 py-0.5 rounded-full ' + (TONES[tone] || TONES.gray)}>{children}</span>;
}

function Evidence({ ev }) {
  if (!ev || !ev.text) return null;
  const hl = ev.highlight || '';
  const i = hl ? ev.text.toLowerCase().indexOf(hl.toLowerCase()) : -1;
  return (
    <div className="text-sm rounded-lg bg-amber-50 dark:bg-stone-800 border border-amber-200 dark:border-stone-700 p-3 space-y-1">
      <div className="text-[11px] uppercase tracking-wide text-stone-500">{ev.label || 'Evidence'}</div>
      <div className="break-words">{i >= 0 ? <>{ev.text.slice(0, i)}<mark className="bg-yellow-200 dark:bg-yellow-700 dark:text-white px-0.5 rounded">{ev.text.slice(i, i + hl.length)}</mark>{ev.text.slice(i + hl.length)}</> : ev.text}</div>
      {ev.url ? <div className="text-xs text-stone-500 break-all">from <a className="underline" href={ev.url} target="_blank" rel="noopener noreferrer">{ev.url.replace(/^https?:\/\//, '')}</a></div> : null}
    </div>
  );
}

function Card({ it, ans, onSave, cfg, active, onActivate }) {
  const status = (ans && ans.status) || 'pending';
  const subject = ans && ans.subject != null ? ans.subject : (it.subject || '');
  const body = ans && ans.body != null ? ans.body : (it.body || '');
  const edited = !!(ans && ans.edited);
  const [editing, setEditing] = useState(false);
  const [dS, setDS] = useState(subject);
  const [dB, setDB] = useState(body);
  useEffect(() => { if (!editing) { setDS(subject); setDB(body); } }, [subject, body, editing]);
  const bad = cfg.noDashes && editing && (hasDash(dS) || hasDash(dB));
  const saveEdit = (approve) => {
    if (cfg.noDashes && (hasDash(dS) || hasDash(dB))) return;
    const ed = dS.trim() !== (it.subject || '') || dB.replace(/\s+$/, '') !== (it.body || '').replace(/\s+$/, '');
    onSave(it, approve ? 'approved' : status, { subject: dS.trim(), body: dB.replace(/\s+$/, '') + '\n', edited: ed });
    setEditing(false);
  };
  const border = status === 'approved' ? 'border-emerald-500' : status === 'rejected' ? 'border-rose-500 opacity-80' : 'border-stone-200 dark:border-stone-700';
  return (
    <article data-card={it.id} onClick={onActivate} className={'rounded-xl border-2 bg-white dark:bg-stone-900 p-4 space-y-3 shadow-sm scroll-mt-4 ' + border + (active ? ' ring-4 ring-orange-400' : '')}>
      <header className="flex flex-wrap items-start gap-2 justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold break-words">{it.title}</h2>
          {it.subtitle ? <div className="text-xs text-stone-500 break-all">{it.link ? <a className="underline" href={it.link} target="_blank" rel="noopener noreferrer">{it.link.replace(/^https?:\/\//, '')}</a> : null}{it.link ? ' · ' : ''}{it.subtitle}</div> : null}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {(it.badges || []).map((b, i) => <Badge key={i} tone={b.tone} title={b.title}>{b.text}</Badge>)}
          {status !== 'pending' && <Badge tone={status === 'approved' ? 'green' : 'red'}>{status}{edited ? ' (edited)' : ''}</Badge>}
        </div>
      </header>
      {editing ? (
        <div className="space-y-2">
          {it.subject != null && <><label className="block text-xs uppercase tracking-wide text-stone-500">Subject</label>
          <input value={dS} onChange={(x) => setDS(x.target.value)} className="w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-transparent p-2 text-sm" /></>}
          <label className="block text-xs uppercase tracking-wide text-stone-500">Text</label>
          <textarea value={dB} onChange={(x) => setDB(x.target.value)} rows={18} className="w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-transparent p-2 text-sm font-mono leading-snug" />
          {bad && <div className="p-2 rounded bg-rose-100 text-rose-800 text-sm">No em dash, en dash or spaced hyphen allowed. Please reword before saving.</div>}
          <div className="flex gap-2">
            <button disabled={bad} onClick={() => saveEdit(true)} className="flex-1 py-3 rounded-lg font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">Save and approve</button>
            <button disabled={bad} onClick={() => saveEdit(false)} className="px-4 py-3 rounded-lg border border-stone-300 dark:border-stone-600 text-sm disabled:opacity-40">Save only</button>
            <button onClick={() => setEditing(false)} className="px-4 py-3 rounded-lg border border-stone-300 dark:border-stone-600 text-sm">Cancel</button>
          </div>
        </div>
      ) : (
        (it.subject != null || it.body) ? <div className="rounded-lg border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-950 p-3">
          {it.subject != null && <div className="text-sm"><span className="text-stone-500">Subject:</span> <strong className="break-words">{subject}</strong></div>}
          {it.body ? <pre className="mt-2 text-sm whitespace-pre-wrap break-words font-sans leading-relaxed">{body}</pre> : null}
          {cfg.footer ? <div className="mt-2 text-xs text-stone-500 whitespace-pre-wrap break-words">{cfg.footer}</div> : null}
        </div> : null
      )}
      {(it.fields || []).length ? <div className="grid sm:grid-cols-2 gap-3 text-sm">
        {it.fields.map((f, i) => <div key={i}><div className="text-[11px] uppercase tracking-wide text-stone-500">{f.label}</div>
          {f.href ? <a className="underline break-all" href={f.href} target="_blank" rel="noopener noreferrer">{f.value}</a> : <div className="break-words">{f.value}</div>}
          {f.note ? <div className="text-xs text-stone-500">{f.note}</div> : null}</div>)}
      </div> : null}
      <Evidence ev={it.evidence} />
      {it.note ? <div className="text-xs rounded bg-stone-100 dark:bg-stone-800 p-2">{it.note}</div> : null}
      {!editing && (
        <div className="flex gap-2">
          <button onClick={() => onSave(it, 'approved', {})} className={'flex-1 py-3 rounded-lg font-medium text-white ' + (status === 'approved' ? 'bg-emerald-800 ring-2 ring-emerald-300' : 'bg-emerald-600 hover:bg-emerald-700')}>{cfg.approveLabel || 'Approve'}</button>
          {cfg.editable !== false && <button onClick={() => setEditing(true)} className="flex-1 py-3 rounded-lg font-medium bg-amber-500 hover:bg-amber-600 text-white">Edit</button>}
          <button onClick={() => onSave(it, 'rejected', {})} className={'flex-1 py-3 rounded-lg font-medium text-white ' + (status === 'rejected' ? 'bg-rose-800 ring-2 ring-rose-300' : 'bg-rose-600 hover:bg-rose-700')}>{cfg.rejectLabel || 'Reject'}</button>
          {status !== 'pending' && <button onClick={() => onSave(it, 'pending', {})} className="px-3 py-3 rounded-lg border border-stone-300 dark:border-stone-600 text-sm">Undo</button>}
        </div>
      )}
    </article>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [filter, setFilter] = useState('pending');
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);
  const ansRef = useRef({}); const activeRef = useRef(null); const shownRef = useRef([]); const saveRef = useRef(null);

  useEffect(() => {
    fetch('data.json').then((r) => r.json()).then(setData).catch((e) => setError('Could not load data: ' + e));
    dsh.storage.get('answers').then((v) => { ansRef.current = v || {}; setAnswers(v || {}); setLoaded(true); }).catch(() => setLoaded(true));
    if (dsh.storage.watch) dsh.storage.watch('answers', (v) => { ansRef.current = v || {}; setAnswers(v || {}); });
  }, []);

  const save = async (it, status, extra) => {
    const prev = ansRef.current[it.id] || {};
    const next = { ...ansRef.current };
    const subject = extra.subject != null ? extra.subject : (prev.subject != null ? prev.subject : it.subject);
    const body = extra.body != null ? extra.body : (prev.body != null ? prev.body : it.body);
    const edited = extra.edited != null ? extra.edited : !!prev.edited;
    if (status === 'pending' && !edited) delete next[it.id];
    else next[it.id] = { status, edited, subject, body, title: it.title, ts: new Date().toISOString() };
    ansRef.current = next; setAnswers(next);
    try { await dsh.storage.set('answers', next); } catch (err) { setError('Save failed: ' + err); }
    try { await dsh.context({ type: (data && data.answerType) || 'review-answer', id: it.id, title: it.title, status, edited, subject, body, ts: new Date().toISOString() }); } catch (err) {}
    if (dsh.toast) dsh.toast(it.title + ': ' + status + (edited ? ' (edited)' : ''));
  };

  const list = data ? data.items : [];
  const counts = useMemo(() => {
    const c = { all: list.length, pending: 0, approved: 0, rejected: 0, edited: 0 };
    list.forEach((it) => { const a = answers[it.id]; const s = (a && a.status) || 'pending'; c[s] = (c[s] || 0) + 1; if (a && a.edited) c.edited++; });
    return c;
  }, [list, answers]);
  const shown = list.filter((it) => {
    const a = answers[it.id]; const s = (a && a.status) || 'pending';
    if (filter === 'edited') { if (!(a && a.edited)) return false; } else if (filter !== 'all' && s !== filter) return false;
    if (q) { const t = (it.title + ' ' + (it.subtitle || '') + ' ' + (it.body || '')).toLowerCase(); if (!t.includes(q.toLowerCase())) return false; }
    return true;
  });

  // Keyboard: 1 approve, 3 reject (the highlighted card, then the next one), J and K move down and up.
  const effectiveActive = shown.some((x) => x.id === activeId) ? activeId : (shown[0] ? shown[0].id : null);
  shownRef.current = shown; activeRef.current = effectiveActive; saveRef.current = save;
  useEffect(() => {
    const go = (id) => {
      setActiveId(id); activeRef.current = id;
      if (id) setTimeout(() => { const el = document.querySelector('[data-card="' + id + '"]'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 60);
    };
    const onKey = (ev) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const t = ev.target; const tag = (t && t.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      const l = shownRef.current; if (!l.length) return;
      let idx = l.findIndex((x) => x.id === activeRef.current); if (idx < 0) idx = 0;
      const cur = l[idx]; const k = (ev.key || '').toLowerCase();
      if (k === '1' || k === '3') {
        ev.preventDefault();
        const nx = l[idx + 1] || l[idx - 1] || null;
        saveRef.current(cur, k === '1' ? 'approved' : 'rejected', {});
        go(nx ? nx.id : null);
      } else if (k === 'j') { ev.preventDefault(); go((l[idx + 1] || cur).id); }
      else if (k === 'k') { ev.preventDefault(); go((l[idx - 1] || cur).id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const cfg = data || {};
  const tabs = [['pending', 'Pending'], ['approved', 'Approved'], ['edited', 'Edited'], ['rejected', 'Rejected'], ['all', 'All']];
  const kbd = 'px-1.5 py-0.5 rounded border border-stone-400';
  return (
    <main className="max-w-2xl mx-auto p-3 sm:p-5 space-y-4">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">{cfg.title || 'Review queue'}</h1>
        {cfg.intro ? <p className="text-sm text-stone-500">{cfg.intro}</p> : null}
        <p className="text-xs text-stone-600 dark:text-stone-400"><kbd className={kbd}>1</kbd> {(cfg.approveLabel || 'approve').toLowerCase()}, <kbd className={kbd}>3</kbd> {(cfg.rejectLabel || 'reject').toLowerCase()} (the highlighted card, then the next one), <kbd className={kbd}>J</kbd> and <kbd className={kbd}>K</kbd> move down and up. Click a card to highlight it.</p>
      </header>
      {error && <div className="p-2 rounded bg-rose-100 text-rose-800 text-sm">{error}</div>}
      <section className="grid grid-cols-4 gap-2 text-center" aria-label="Counters">
        {[['Total', counts.all, 'bg-stone-200 dark:bg-stone-800'], ['Pending', counts.pending, 'bg-amber-100 text-amber-900'], ['Approved', counts.approved, 'bg-emerald-100 text-emerald-900'], ['Rejected', counts.rejected, 'bg-rose-100 text-rose-900']].map(([l, n, c]) => (
          <div key={l} className={'rounded-lg py-2 ' + c}><div className="text-xl font-bold">{n}</div><div className="text-[11px] uppercase tracking-wide">{l}</div></div>
        ))}
      </section>
      <nav className="flex gap-1 overflow-x-auto" aria-label="Filter">
        {tabs.map(([k, l]) => <button key={k} onClick={() => setFilter(k)} className={'px-3 py-2 rounded-full text-sm whitespace-nowrap ' + (filter === k ? 'bg-orange-600 text-white' : 'bg-stone-200 dark:bg-stone-800')}>{l} ({counts[k]})</button>)}
      </nav>
      <input value={q} onChange={(x) => setQ(x.target.value)} placeholder="Search" className="w-full rounded-lg border border-stone-300 dark:border-stone-600 bg-transparent p-2 text-sm" />
      {!data || !loaded ? <p>Loading</p> : shown.length === 0 ? <p className="text-stone-500 py-6 text-center">Nothing in this filter.</p> :
        shown.map((it) => <Card key={it.id} it={it} ans={answers[it.id]} onSave={save} cfg={cfg} active={it.id === effectiveActive} onActivate={() => setActiveId(it.id)} />)}
      {data && (data.excluded || []).length ? (
        <details className="rounded-lg border border-stone-300 dark:border-stone-700 p-3">
          <summary className="cursor-pointer font-medium">Left out ({data.excluded.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">{data.excluded.map((x) => <li key={x.id}><strong>{x.name}</strong>: {x.why}</li>)}</ul>
        </details>
      ) : null}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
