// Server and edge Sentry init moved here in @sentry/nextjs 9+: the SDK loads
// this via Next's instrumentation hook instead of reading sentry.server.config.js
// and sentry.edge.config.js directly. Those two files still hold the actual
// init and are imported per runtime below, so their DSN/enabled contract is
// unchanged.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export async function onRequestError(...args) {
  const Sentry = await import('@sentry/nextjs');
  return Sentry.captureRequestError(...args);
}
