const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {};

// Sentry wraps the build. Runtime error reporting stays inert until SENTRY_DSN /
// NEXT_PUBLIC_SENTRY_DSN are set (see the sentry.*.config.js files). Source-map
// upload only happens when SENTRY_AUTH_TOKEN/org/project are provided, so builds
// work fine without any Sentry configuration.
module.exports = withSentryConfig(nextConfig, {
  silent: true,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
});
