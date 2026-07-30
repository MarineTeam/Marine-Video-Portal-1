import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import {
  getMonitorCalls,
  subscribeMonitorCalls,
  resetMonitorCalls,
  setMonitorRecording,
} from '../lib/monitorClient';

// Cached across client-side navigations so the probe below runs once per full
// page load rather than on every route change.
let enabledCache = null;

function formatMs(ms) {
  if (ms == null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function formatBytes(bytes) {
  if (bytes == null) return '—';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Query Monitor / performance panel — a small floating widget that surfaces,
// for the current view: SSR query count/time (from `pageProps._monitor`,
// attached server-side by lib/monitor.js's withMonitorPage), API calls made
// since the view began (via the `X-Query-Monitor` response header, attached by
// withMonitorApi and collected by lib/monitorClient.js), render time, and
// server memory/uptime.
//
// Enablement comes from the server (/api/monitor, driven by the single
// QUERY_MONITOR_ENABLED env var), never from a build-time flag — otherwise the
// panel can render against an uninstrumented server and sit at a frozen zero.
// Entirely best-effort: any failure leaves a stat blank or the panel hidden,
// and never breaks the page (same posture as ResumablePlayer/push).
export default function QueryMonitor({ ssrStats }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(enabledCache);
  const [open, setOpen] = useState(false);
  const [calls, setCalls] = useState(getMonitorCalls);
  const [server, setServer] = useState(null);
  const [renderMs, setRenderMs] = useState(null);

  useEffect(() => subscribeMonitorCalls(setCalls), []);

  // Ask the server whether the monitor is on, and keep memory/uptime fresh
  // while it is. A 404 (feature off) or 401 (not logged in) hides the panel and
  // stops both the polling and the client-side recording.
  useEffect(() => {
    let cancelled = false;
    let id = null;

    const poll = () =>
      fetch('/api/monitor')
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return;
          const on = Boolean(d && d.enabled);
          enabledCache = on;
          setEnabled(on);
          setMonitorRecording(on);
          if (on) {
            setServer(d);
          } else if (id) {
            clearInterval(id);
            id = null;
          }
        })
        .catch(() => {});

    poll();
    id = setInterval(poll, 10000);
    return () => { cancelled = true; if (id) clearInterval(id); };
  }, []);

  // Initial full page load: use the Navigation Timing API.
  useEffect(() => {
    if (typeof performance === 'undefined') return;
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) setRenderMs(nav.duration);
  }, []);

  // Client-side route transitions: time from navigation start to route ready.
  useEffect(() => {
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
  // would keep showing whatever it captured before the user navigated away.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPageShow = (event) => {
      if (!event.persisted) return;
      resetMonitorCalls();
      const nav = performance.getEntriesByType('navigation')[0];
      setRenderMs(nav ? nav.duration : null);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  if (!enabled) return null;

  // /api/monitor is the panel's own heartbeat — counting it would make the
  // numbers climb on their own even on an idle page.
  const shown = calls.filter((c) => !(c.url || '').startsWith('/api/monitor'));
  const apiQueryCount = shown.reduce((s, c) => s + (c.queryCount || 0), 0);
  const apiQueryMs = shown.reduce((s, c) => s + (c.queryMs || 0), 0);
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
              <span>Initial page load (SSR)</span>
              <span>{ssrStats.queryCount} queries · {formatMs(ssrStats.wallMs)} wall</span>
            </div>
          )}
          <div className="query-monitor-row">
            <strong>API calls this view</strong>
            <span>{shown.length}</span>
          </div>
          {shown.length === 0 && (
            <div className="query-monitor-row">
              <span>No API queries in this view</span>
              <span>—</span>
            </div>
          )}
          {shown.map((c, i) => (
            <div className="query-monitor-row" key={i}>
              <span title={c.url}>{(c.url || '').replace(/^https?:\/\/[^/]+/, '')}</span>
              <span>{c.queryCount} · {formatMs(c.wallMs)}</span>
            </div>
          ))}
          <div className="query-monitor-row">
            <span>Render</span>
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
