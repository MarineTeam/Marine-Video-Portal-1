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
let recording = true; // until /api/monitor tells us otherwise
const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(calls));
}

export function getMonitorCalls() {
  return calls;
}

// Subscribe to the call log. Fires immediately with the current value and
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
        calls = [...calls, { url, ...stats }].slice(-MAX_CALLS);
        emit();
      }
    } catch (e) {
      // A monitoring wrapper must never affect the request it observes.
    }
    return res;
  };
  patched.__queryMonitorPatched = true;
  window.fetch = patched;
}
