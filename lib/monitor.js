import { AsyncLocalStorage } from 'async_hooks';

// Query Monitor / performance panel. Opt-in via the single env var
// QUERY_MONITOR_ENABLED; unset or falsey -> every helper here is a no-op,
// matching the resilience-by-degradation posture used for push/Sentry.
//
// This is deliberately ONE server-side var, not a server+NEXT_PUBLIC_ pair
// like push uses: the client learns whether the monitor is on at runtime from
// /api/monitor (see lib/monitorClient.js). A build-time client flag meant the
// panel could render while the server wasn't instrumented at all, showing a
// permanently frozen zero — and it made toggling require a rebuild.
const storage = new AsyncLocalStorage();

// Parsed leniently on purpose. A value pasted into Vercel can easily arrive as
// 'true ' or 'True', and this repo has already lost time to invisible
// whitespace in env vars (see the TUS 401 saga) — a strict === 'true' turned
// either of those into a silently disabled feature.
export function monitorEnabled() {
  const raw = (process.env.QUERY_MONITOR_ENABLED || '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes';
}

function round(ms) {
  return Math.round(ms * 100) / 100;
}

// Called by lib/redis.js's instrumentation on every Redis command. No-op
// outside of a withMonitorApi/withMonitorPage context (e.g. cron-ish or
// fire-and-forget calls), so this never throws and never needs its own guard
// at call sites.
export function recordQuery(command, ms) {
  const store = storage.getStore();
  if (!store) return;
  store.queries.push({ command, ms: round(ms) });
}

function snapshot(store, wallMs) {
  const queryMs = store.queries.reduce((sum, q) => sum + q.ms, 0);
  return {
    queryCount: store.queries.length,
    queryMs: round(queryMs),
    wallMs: round(wallMs),
    queries: store.queries,
  };
}

// Wrap an API route handler. When enabled, runs it inside the AsyncLocalStorage
// context so Redis calls get attributed to this request, then attaches the
// stats as a response header just before the response is sent (res.json/res.end
// are monkey-patched for the duration of this call only).
export function withMonitorApi(handler) {
  return async (req, res) => {
    if (!monitorEnabled()) return handler(req, res);
    const store = { queries: [] };
    const start = process.hrtime.bigint();
    const attach = () => {
      if (res.headersSent) return;
      try {
        const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
        res.setHeader('X-Query-Monitor', JSON.stringify(snapshot(store, wallMs)));
      } catch (e) {
        // never let monitoring break the response
      }
    };
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      attach();
      return originalJson(body);
    };
    const originalEnd = res.end.bind(res);
    res.end = (...args) => {
      attach();
      return originalEnd(...args);
    };
    return storage.run(store, () => handler(req, res));
  };
}

// Wrap a page's getServerSideProps. When enabled, attaches `_monitor` stats
// onto the resolved props (redirects/notFound results pass through untouched).
export function withMonitorPage(gssp) {
  return async (ctx) => {
    if (!monitorEnabled()) return gssp(ctx);
    const store = { queries: [] };
    const start = process.hrtime.bigint();
    const result = await storage.run(store, () => gssp(ctx));
    if (result && result.props) {
      const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
      result.props._monitor = snapshot(store, wallMs);
    }
    return result;
  };
}
