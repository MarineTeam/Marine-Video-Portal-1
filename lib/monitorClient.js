// Client half of the Query Monitor. Deliberately separate from lib/monitor.js:
// that one is server-only (async_hooks/AsyncLocalStorage) and reads the
// server-side QUERY_MONITOR_ENABLED. This module is safe in the browser bundle
// and keys off the NEXT_PUBLIC_ flag, which is inlined at build time.
//
// It owns the store of observed API calls so that pages can signal a "view
// change" (see resetMonitorCalls) without importing a React component just to
// reach a side-effecting helper.
export const MONITOR_CLIENT_ENABLED = process.env.NEXT_PUBLIC_QUERY_MONITOR_ENABLED === 'true';

let calls = [];
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(calls));
}

export function getMonitorCalls() {
  return calls;
}

// Subscribe to the call log. Fires immediately with the current value, and
// returns an unsubscribe function.
export function subscribeMonitorCalls(fn) {
  listeners.add(fn);
  fn(calls);
  return () => listeners.delete(fn);
}

// Start a fresh view. Call this whenever the user moves to a logically new
// screen that isn't a route change — e.g. the admin panel's tabs, which are
// pure React state. Without it the panel either grows forever (on tabs that
// lazily fetch) or looks frozen (on tabs whose data was loaded once upfront),
// instead of showing what the current view actually cost.
export function resetMonitorCalls() {
  if (!MONITOR_CLIENT_ENABLED) return;
  calls = [];
  emit();
}

// The fetch patch runs once, at module-evaluation time — i.e. on import,
// before _app renders and before any page's own effects fire. Doing this in a
// useEffect would race against other components' data-fetching effects
// (React runs child effects before parent ones), so whichever ran first would
// use the unpatched fetch and be invisible to the monitor.
if (MONITOR_CLIENT_ENABLED && typeof window !== 'undefined' && !window.fetch.__queryMonitorPatched) {
  const originalFetch = window.fetch.bind(window);
  const patched = async (...args) => {
    const res = await originalFetch(...args);
    try {
      const raw = res.headers.get('X-Query-Monitor');
      if (raw) {
        const stats = JSON.parse(raw);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        calls = [...calls, { url, ...stats }];
        emit();
      }
    } catch (e) {
      // ignore malformed/absent header
    }
    return res;
  };
  patched.__queryMonitorPatched = true;
  window.fetch = patched;
}
