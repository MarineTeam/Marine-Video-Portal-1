import * as Sentry from '@sentry/nextjs';

// Replaces sentry.client.config.js, which @sentry/nextjs 9+ no longer loads.
// Inert unless a public DSN is configured — same contract as before.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    tracesSampleRate: 0.1,
  });
}

// Required by @sentry/nextjs 9+ so client-side router transitions are traced.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
