// Client half of the Query Monitor. Deliberately separate from lib/monitor.js:
// that one is server-only (async_hooks/AsyncLocalStorage). This module is safe
// in the browser bundle and owns the store of observed API calls, so pages can
// signal a "view change" (see resetMonitorCalls) without importing a React
// component just to reach a side-effecting helper.
//
// There is NO build-time client flag. Whether the monitor is on is decided
// server-side by QUERY_MONITOR_ENABLED and learned at runtime via /api/monitor,
// so a single env var toggles the whole feature with no rebuild. The trade-off
// is that the fetch wrapper below installs unconditionally: it is a pure
// pass-through that reads one response header and never throws, and it stops
// recording entirely as soon as the server reports the monitor is off.

const MAX_CALLS = 100;

let calls = [];
// Cumulative since the last full page load, deliberately NOT cleared by
// resetMonitorCalls. The first view of a screen includes that page's one-time
// bootstrap fetches, so a per-view number legitimately drops afterwards (the
// admin panel's Videos tab goes 10 -> 2 on revisit). Keeping both numbers is
// what makes that drop read as arithmetic rather than as a bug.
let sinceLoad = { calls: 0, queryCount: 0, queryMs: 0, externalCount: 0, externalMs: 0 };
let recording = true; // until /api/monitor tells us otherwise
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(calls, sinceLoad));
}

export function getMonitorCalls() {
  return calls;
}

export function getSinceLoad() {
  return sinceLoad;
}

// Subscribe to the call log. Fires immediately with the current value and
// returns an unsubscribe function.
export function subscribeMonitorCalls(fn) {
  listeners.add(fn);
  fn(calls, sinceLoad);
  return () => listeners.delete(fn);
}

// Start a fresh view. Call this whenever the user moves to a logically new
// screen that isn't a route change — e.g. the admin panel's tabs, which are
// pure React state. Without it the panel either grows forever (on tabs that
// lazily fetch) or looks frozen (on tabs whose data was loaded once upfront),
// instead of showing what the current view actually cost.
export function resetMonitorCalls() {
  if (calls.length === 0) return;
  calls = [];
  emit();
}

// Called once /api/monitor has answered. When the monitor is off we drop what
// we buffered and stop recording, so a disabled deployment keeps no state.
export function setMonitorRecording(on) {
  recording = Boolean(on);
  if (!recording && calls.length) {
    calls = [];
    sinceLoad = { calls: 0, queryCount: 0, queryMs: 0, externalCount: 0, externalMs: 0 };
    emit();
  }
}

// Installed at module-evaluation time — i.e. on import, before _app renders and
// before any page's own effects fire. Doing this in a useEffect would race
// against other components' data-fetching effects (React runs child effects
// before parent ones), so whichever ran first would use the unpatched fetch and
// be invisible to the monitor.
if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.fetch.__queryMonitorPatched) {
  const originalFetch = window.fetch.bind(window);
  const patched = async (...args) => {
    const res = await originalFetch(...args);
    if (!recording) return res;
    try {
      const raw = res.headers.get('X-Query-Monitor');
      if (raw) {
        const stats = JSON.parse(raw);
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        // The panel's own heartbeat would otherwise make every total climb on
        // its own, on an idle page.
        if (!url.startsWith('/api/monitor')) {
          calls = [...calls, { url, ...stats }].slice(-MAX_CALLS);
          sinceLoad = {
            calls: sinceLoad.calls + 1,
            queryCount: sinceLoad.queryCount + (stats.queryCount || 0),
            queryMs: Math.round((sinceLoad.queryMs + (stats.queryMs || 0)) * 100) / 100,
            externalCount: sinceLoad.externalCount + (stats.externalCount || 0),
            externalMs: Math.round((sinceLoad.externalMs + (stats.externalMs || 0)) * 100) / 100,
          };
          emit();
        }
      }
    } catch (e) {
      // A monitoring wrapper must never affect the request it observes.
    }
    return res;
  };
  patched.__queryMonitorPatched = true;
  window.fetch = patched;
}
