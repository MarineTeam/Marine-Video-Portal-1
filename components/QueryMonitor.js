import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import {
  getMonitorCalls,
  getSinceLoad,
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

// Query Monitor / performance panel — a floating widget that reports, for the
// current view: Redis query count/time, outbound Bunny API count/time, the
// page's server-render cost, client render time, and process stats.
//
// Two totals are shown on purpose. "This view" resets whenever the user moves
// to a new screen (route change, or an admin tab — see resetMonitorCalls),
// which means the first visit to a screen includes that page's one-time
// bootstrap fetches and a later revisit does not. "Since page load" is
// cumulative, so that legitimate drop is visibly arithmetic.
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
  const [sinceLoad, setSinceLoad] = useState(getSinceLoad);
  const [server, setServer] = useState(null);
  const [renderMs, setRenderMs] = useState(null);

  useEffect(
    () =>
      subscribeMonitorCalls((nextCalls, nextTotals) => {
        setCalls(nextCalls);
        setSinceLoad(nextTotals);
      }),
    []
  );

  // Ask the server whether the monitor is on, and keep process stats fresh
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

  const viewQueries = calls.reduce((s, c) => s + (c.queryCount || 0), 0);
  const viewQueryMs = calls.reduce((s, c) => s + (c.queryMs || 0), 0);
  const viewExt = calls.reduce((s, c) => s + (c.externalCount || 0), 0);
  const viewExtMs = calls.reduce((s, c) => s + (c.externalMs || 0), 0);

  return (
    <div className="query-monitor" role="complementary" aria-label="Performance monitor">
      <button className="query-monitor-toggle" onClick={() => setOpen((o) => !o)}>
        <span className="badge badge-ok">QM</span>
        {viewQueries} q · {formatMs(viewQueryMs)}
        {viewExt > 0 ? ` · ${viewExt} api · ${formatMs(viewExtMs)}` : ''}
      </button>
      {open && (
        <div className="query-monitor-panel">
          <div className="query-monitor-row">
            <strong>This view</strong>
            <span>{calls.length} request{calls.length === 1 ? '' : 's'}</span>
          </div>
          <div className="query-monitor-row">
            <span>Redis queries</span>
            <span>{viewQueries} · {formatMs(viewQueryMs)}</span>
          </div>
          <div className="query-monitor-row">
            <span>Bunny API calls</span>
            <span>{viewExt} · {formatMs(viewExtMs)}</span>
          </div>
          {calls.length === 0 && (
            <div className="query-monitor-row">
              <span>No requests in this view</span>
              <span>—</span>
            </div>
          )}
          {calls.map((c, i) => (
            <div className="query-monitor-row" key={i}>
              <span title={c.url}>{(c.url || '').replace(/^https?:\/\/[^/]+/, '')}</span>
              <span>
                {c.queryCount || 0}q
                {c.externalCount ? ` · ${c.externalCount}api` : ''} · {formatMs(c.wallMs)}
              </span>
            </div>
          ))}

          <div className="query-monitor-row">
            <strong>Since page load</strong>
            <span>{sinceLoad.calls} request{sinceLoad.calls === 1 ? '' : 's'}</span>
          </div>
          <div className="query-monitor-row">
            <span>Redis / Bunny</span>
            <span>
              {sinceLoad.queryCount} · {formatMs(sinceLoad.queryMs)} / {sinceLoad.externalCount} ·{' '}
              {formatMs(sinceLoad.externalMs)}
            </span>
          </div>

          {ssrStats && (
            <>
              <div className="query-monitor-row">
                <strong>Server render (this page)</strong>
                <span>{formatMs(ssrStats.wallMs)} wall</span>
              </div>
              <div className="query-monitor-row">
                <span>Redis / Bunny</span>
                <span>
                  {ssrStats.queryCount} · {formatMs(ssrStats.queryMs)} /{' '}
                  {ssrStats.externalCount || 0} · {formatMs(ssrStats.externalMs || 0)}
                </span>
              </div>
              {(ssrStats.queries || []).map((q, i) => (
                <div className="query-monitor-row" key={`q${i}`}>
                  <span>{q.command}</span>
                  <span>{formatMs(q.ms)}</span>
                </div>
              ))}
            </>
          )}

          <div className="query-monitor-row">
            <span>Client render</span>
            <span>{formatMs(renderMs)}</span>
          </div>
          {server && (
            <>
              {/* Labelled "instance", not "server": on Vercel each API route is
                  its own serverless function, so these describe whichever
                  instance answered /api/monitor — not the one that rendered the
                  page — and uptime resets on every cold start. */}
              <div className="query-monitor-row">
                <span>Instance memory (RSS)</span>
                <span>{formatBytes(server.memory?.rss)}</span>
              </div>
              <div className="query-monitor-row">
                <span>Instance uptime</span>
                <span>
                  {server.uptime < 60
                    ? `${Math.round(server.uptime)}s`
                    : `${Math.round(server.uptime / 60)}m`}
                  {server.serverless ? ' (per-instance)' : ''}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
