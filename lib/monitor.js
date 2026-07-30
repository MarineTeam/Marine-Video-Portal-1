import { AsyncLocalStorage } from 'async_hooks';

// Query Monitor / performance panel. Entirely opt-in via QUERY_MONITOR_ENABLED
// (server) + NEXT_PUBLIC_QUERY_MONITOR_ENABLED (client, inlined at build —
// see lib/push.js for the same on/off-by-env-pair pattern). Absent or not
// exactly 'true' -> every helper here is a no-op, matching the
// resilience-by-degradation posture used for push/Sentry.
const storage = new AsyncLocalStorage();

export function monitorEnabled() {
  return process.env.QUERY_MONITOR_ENABLED === 'true';
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
