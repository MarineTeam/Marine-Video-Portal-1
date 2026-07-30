import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

// Inlined at build time (see components/NotifyButton.js for the same
// NEXT_PUBLIC_* pattern). Absent -> render nothing, no network calls at all.
const CLIENT_ENABLED = process.env.NEXT_PUBLIC_QUERY_MONITOR_ENABLED === 'true';

function formatMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Query Monitor / performance panel — a small floating widget that surfaces,
// for the current page: SSR query count/time (from `pageProps._monitor`,
// attached server-side by lib/monitor.js's withMonitorPage), any API calls
// made after load (via the `X-Query-Monitor` response header, attached by
// withMonitorApi), client render time, and server memory/uptime (best-effort,
// from /api/monitor). Entirely best-effort: any failure here just leaves a
// stat blank, never breaks the page (same posture as ResumablePlayer/push).
export default function QueryMonitor({ ssrStats }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState([]);
  const [server, setServer] = useState(null);
  const [renderMs, setRenderMs] = useState(null);

  // Initial full page load: use the Navigation Timing API.
  useEffect(() => {
    if (!CLIENT_ENABLED || typeof performance === 'undefined') return;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) setRenderMs(nav.duration);
  }, []);

  // Client-side route transitions: time from navigation start to route ready.
  useEffect(() => {
    if (!CLIENT_ENABLED) return;
    let start = null;
    const onStart = () => { start = performance.now(); setCalls([]); };
    const onDone = () => { if (start != null) setRenderMs(performance.now() - start); };
    router.events.on('routeChangeStart', onStart);
    router.events.on('routeChangeComplete', onDone);
    return () => {
      router.events.off('routeChangeStart', onStart);
      router.events.off('routeChangeComplete', onDone);
    };
  }, [router.events]);

  useEffect(() => {
    if (!CLIENT_ENABLED || typeof window === 'undefined' || window.fetch.__queryMonitorPatched) return;
    const originalFetch = window.fetch.bind(window);
    const patched = async (...args) => {
      const res = await originalFetch(...args);
      try {
        const raw = res.headers.get('X-Query-Monitor');
        if (raw) {
          const stats = JSON.parse(raw);
          const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
          setCalls((prev) => [...prev, { url, ...stats }]);
        }
      } catch (e) {
        // ignore malformed/absent header
      }
      return res;
    };
    patched.__queryMonitorPatched = true;
    window.fetch = patched;
  }, []);

  useEffect(() => {
    if (!CLIENT_ENABLED) return;
    let cancelled = false;
    const poll = () => {
      fetch('/api/monitor')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setServer(d); })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 10000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!CLIENT_ENABLED) return null;

  const apiQueryCount = calls.reduce((s, c) => s + (c.queryCount || 0), 0);
  const apiQueryMs = calls.reduce((s, c) => s + (c.queryMs || 0), 0);
  const totalQueryCount = (ssrStats?.queryCount || 0) + apiQueryCount;
  const totalQueryMs = (ssrStats?.queryMs || 0) + apiQueryMs;

  return (
    <div className="query-monitor" role="complementary" aria-label="Performance monitor">
      <button className="query-monitor-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="badge badge-ok">QM</span>
        {totalQueryCount} queries · {formatMs(totalQueryMs)}
        {ssrStats ? ` · SSR ${formatMs(ssrStats.wallMs)}` : ''}
      </button>
      {open && (
        <div className="query-monitor-panel">
          <div className="query-monitor-row">
            <strong>Queries</strong>
            <span>{totalQueryCount} ({formatMs(totalQueryMs)})</span>
          </div>
          {ssrStats && (
            <div className="query-monitor-row">
              <span>Server render</span>
              <span>{ssrStats.queryCount} queries · {formatMs(ssrStats.wallMs)} wall</span>
            </div>
          )}
          {calls.map((c, i) => (
            <div className="query-monitor-row" key={i}>
              <span title={c.url}>{(c.url || '').replace(/^https?:\/\/[^/]+/, '')}</span>
              <span>{c.queryCount} · {formatMs(c.wallMs)}</span>
            </div>
          ))}
          <div className="query-monitor-row">
            <span>Client render</span>
            <span>{formatMs(renderMs)}</span>
          </div>
          {server && (
            <>
              <div className="query-monitor-row">
                <span>Server memory (RSS)</span>
                <span>{formatBytes(server.memory?.rss)}</span>
              </div>
              <div className="query-monitor-row">
                <span>Server uptime</span>
                <span>{Math.round(server.uptime / 60)}m</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
