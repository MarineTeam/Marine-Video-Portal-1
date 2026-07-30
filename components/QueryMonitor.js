import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

// Inlined at build time (see components/NotifyButton.js for the same
// NEXT_PUBLIC_* pattern). Absent -> render nothing, no network calls at all.
const CLIENT_ENABLED = process.env.NEXT_PUBLIC_QUERY_MONITOR_ENABLED === 'true';

// The fetch patch below runs once, at module-evaluation time — i.e. before
// _app renders, before any page's own effects fire. A `useEffect`-based patch
// loses a race: whichever component's data-fetching effect happens to run
// first (React runs child effects before parent effects, and a page's own
// "load my data" effect can resolve before this component's own effect gets
// a chance to run) makes calls the unpatched fetch and is invisible to the
// monitor — explaining why the panel would "sometimes" pick up a page's
// calls and sometimes not. Patching at import time removes the race entirely.
let monitorCalls = [];
const callListeners = new Set();

function notifyCalls() {
  callListeners.forEach((fn) => fn(monitorCalls));
}

export function resetMonitorCalls() {
  monitorCalls = [];
  notifyCalls();
}

if (CLIENT_ENABLED && typeof window !== 'undefined' && !window.fetch.__queryMonitorPatched) {
  const originalFetch = window.fetch.bind(window);
  const patched = async (...args) => {
    const res = await originalFetch(...args);
    try {
      const raw = res.headers.get('X-Query-Monitor');
      if (raw) {
        const stats = JSON.parse(raw);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        monitorCalls = [...monitorCalls, { url, ...stats }];
        notifyCalls();
      }
    } catch (e) {
      // ignore malformed/absent header
    }
    return res;
  };
  patched.__queryMonitorPatched = true;
  window.fetch = patched;
}

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
// withMonitorApi, tracked by the module-level patch above), client render
// time, and server memory/uptime (best-effort, from /api/monitor). Entirely
// best-effort: any failure here just leaves a stat blank, never breaks the
// page (same posture as ResumablePlayer/push).
export default function QueryMonitor({ ssrStats }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState(monitorCalls);
  const [server, setServer] = useState(null);
  const [renderMs, setRenderMs] = useState(null);

  // Subscribe to the module-level call log.
  useEffect(() => {
    if (!CLIENT_ENABLED) return;
    const onCalls = (next) => setCalls(next);
    callListeners.add(onCalls);
    onCalls(monitorCalls);
    return () => callListeners.delete(onCalls);
  }, []);

  const pollServer = () => {
    fetch('/api/monitor')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d) setServer(d); })
      .catch(() => {});
  };

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
    const onStart = () => { start = performance.now(); resetMonitorCalls(); };
    const onDone = () => { if (start != null) setRenderMs(performance.now() - start); };
    router.events.on('routeChangeStart', onStart);
    router.events.on('routeChangeComplete', onDone);
    return () => {
      router.events.off('routeChangeStart', onStart);
      router.events.off('routeChangeComplete', onDone);
    };
  }, [router.events]);

  // A page restored from the browser's back/forward cache (bfcache) never
  // re-runs React effects or re-fetches anything — without this, the panel
  // would keep showing whatever it captured before the user navigated away,
  // which is exactly the "sometimes it just doesn't update" symptom.
  useEffect(() => {
    if (!CLIENT_ENABLED || typeof window === 'undefined') return;
    const onPageShow = (event) => {
      if (!event.persisted) return;
      resetMonitorCalls();
      pollServer();
      const nav = performance.getEntriesByType('navigation')[0];
      setRenderMs(nav ? nav.duration : null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
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
