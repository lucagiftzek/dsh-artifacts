// Template video-page from ~/estate/templates/artifacts/video-page (see its README.md).
// Everything comes from data.json; improve the template there, not per use.
const { useState, useEffect, useRef, useMemo } = React;

function secs(at) {
  if (typeof at === 'number') return at;
  const p = String(at || '0').split(':').map(Number);
  return p.reduce((acc, v) => acc * 60 + (isFinite(v) ? v : 0), 0);
}
function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + r : m + ':' + r;
}
function Paragraphs({ text, className }) {
  if (!text) return null;
  return String(text).split(/\n\s*\n/).map((p, i) => <p key={i} className={className}>{p}</p>);
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(0);
  const [dur, setDur] = useState(0);
  const video = useRef(null);

  useEffect(() => {
    fetch('data.json', { cache: 'no-store' }).then((r) => r.json()).then(setData)
      .catch((e) => setError('Could not load data.json: ' + e.message));
  }, []);

  const chapters = useMemo(() => (data?.chapters || []).map((c) => ({ ...c, t: secs(c.at) })).sort((a, b) => a.t - b.t), [data]);
  const transcript = useMemo(() => (data?.transcript || []).map((c) => ({ ...c, t: secs(c.at) })), [data]);
  const total = dur || secs(data?.duration) || (chapters.length ? chapters[chapters.length - 1].t * 1.1 : 0);
  const active = chapters.reduce((acc, c, i) => (c.t <= now + 0.25 ? i : acc), -1);
  const activeLine = transcript.reduce((acc, c, i) => (c.t <= now + 0.25 ? i : acc), -1);

  useEffect(() => {
    if (!data) return;
    document.title = data.title || document.title;
    const m = location.hash.match(/t=([\d:.]+)/);
    if (m && video.current) video.current.currentTime = secs(m[1]);
  }, [data]);

  const seek = (t, play = true) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = t;
    if (play) v.play().catch(() => {});
    history.replaceState(null, '', '#t=' + Math.floor(t));
  };

  if (error) return <main className="max-w-3xl mx-auto p-6"><p role="alert" className="text-[color:var(--accent)]">{error}</p></main>;
  if (!data) return <main className="max-w-3xl mx-auto p-6 text-[color:var(--muted)]">Loading...</main>;

  return (
    <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-6 pb-16">
      <header className="border-b-2 border-[color:var(--accent)] pb-4 mb-6">
        <div className="font-mono text-[11px] tracking-[.14em] uppercase text-[color:var(--accent)] font-semibold">artifact &middot; video</div>
        <h1 className="text-2xl sm:text-3xl font-semibold leading-tight mt-2 mb-1">{data.title}</h1>
        {data.subtitle && <p className="text-[color:var(--muted)] m-0">{data.subtitle}</p>}
        {(data.date || data.author) && <div className="text-sm text-[color:var(--muted)] mt-2 flex gap-3 flex-wrap">{data.date && <span>{data.date}</span>}{data.author && <span>{data.author}</span>}</div>}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section aria-label="Video" className="min-w-0">
          <div className="rounded-lg overflow-hidden bg-black shadow-sm">
            <video ref={video} src={data.src} poster={data.poster || undefined} controls playsInline preload="metadata"
              className="w-full block aspect-video bg-black" aria-label={data.title}
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)} onLoadedMetadata={(e) => setDur(e.currentTarget.duration)}>
              {data.captions && <track kind="subtitles" src={data.captions} srcLang={data.captions_lang || 'en'} label={data.captions_label || 'English'} default />}
            </video>
          </div>

          {chapters.length > 0 && total > 0 && (
            <div className="mt-2 flex gap-[2px] h-2" aria-hidden="true">
              {chapters.map((c, i) => {
                const end = i + 1 < chapters.length ? chapters[i + 1].t : total;
                const w = Math.max(0.5, ((end - c.t) / total) * 100);
                const fill = i < active ? 100 : i === active ? Math.min(100, ((now - c.t) / Math.max(0.01, end - c.t)) * 100) : 0;
                return (
                  <button key={i} tabIndex={-1} onClick={() => seek(c.t)} title={c.title} style={{ width: w + '%' }}
                    className="relative h-full rounded-sm bg-[color:var(--line)] overflow-hidden cursor-pointer border-0 p-0">
                    <span className="absolute inset-y-0 left-0 bg-[color:var(--accent)]" style={{ width: fill + '%' }} />
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-5 max-w-3xl space-y-3">
            <Paragraphs text={data.description} className="m-0" />
            <div className="flex flex-wrap gap-2 text-sm pt-1">
              {data.download !== false && <a href={data.src} download className="px-3 py-1.5 rounded-md border border-[color:var(--accent)] text-[color:var(--accent)] no-underline hover:bg-[color:var(--accent)] hover:text-white">Download video</a>}
              {(data.links || []).map((l, i) => <a key={i} href={l.url} className="px-3 py-1.5 rounded-md border border-[color:var(--line)] text-[color:var(--ink)] no-underline hover:border-[color:var(--accent)]">{l.label}</a>)}
            </div>
          </div>
        </section>

        <aside className="min-w-0 space-y-6">
          {chapters.length > 0 && (
            <nav aria-label="Chapters" className="rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)]">
              <h2 className="text-sm font-semibold px-4 pt-3 pb-2 m-0 border-b border-[color:var(--line)]">Chapters</h2>
              <ol className="list-none m-0 p-1">
                {chapters.map((c, i) => (
                  <li key={i}>
                    <button onClick={() => seek(c.t)} aria-current={i === active ? 'true' : undefined}
                      className={'w-full text-left flex gap-3 px-3 py-2 rounded-md border-0 cursor-pointer bg-transparent text-[color:var(--ink)] hover:bg-[color:var(--bg)] ' + (i === active ? 'bg-[color:var(--bg)] shadow-[inset_3px_0_0_var(--accent)]' : '')}>
                      <span className="font-mono text-xs text-[color:var(--muted)] pt-0.5 min-w-[3.2rem] tabular-nums">{clock(c.t)}</span>
                      <span className="min-w-0">
                        <span className={'block text-sm leading-snug ' + (i === active ? 'font-semibold' : '')}>{c.title}</span>
                        {c.note && <span className="block text-xs text-[color:var(--muted)] leading-snug mt-0.5">{c.note}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            </nav>
          )}

          {transcript.length > 0 && (
            <section aria-label="Transcript" className="rounded-lg border border-[color:var(--line)] bg-[color:var(--panel)]">
              <h2 className="text-sm font-semibold px-4 pt-3 pb-2 m-0 border-b border-[color:var(--line)]">Transcript</h2>
              <div className="max-h-80 overflow-auto p-1">
                {transcript.map((c, i) => (
                  <button key={i} onClick={() => seek(c.t)}
                    className={'w-full text-left flex gap-3 px-3 py-1.5 rounded-md border-0 cursor-pointer bg-transparent text-sm ' + (i === activeLine ? 'text-[color:var(--ink)] bg-[color:var(--bg)]' : 'text-[color:var(--muted)]')}>
                    <span className="font-mono text-xs pt-0.5 min-w-[3.2rem] tabular-nums">{clock(c.t)}</span>
                    <span className="min-w-0">{c.text}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
