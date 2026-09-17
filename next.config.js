const { withSentryConfig } = require('@sentry/nextjs');

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Baseline response hardening. Deliberately NOT a full CSP: the pre-paint
  // theme script in pages/_document.js and Next's own bootstrap are inline, so
  // a script-src policy would need nonces threaded through both — separate
  // work. frame-ancestors is the part that closes a real hole and needs no
  // nonce.
  //
  // Referrer-Policy is strict-origin-when-cross-origin, NOT no-referrer:
  // bunny.net thumbnail hotlink protection reads the Referer, so suppressing it
  // entirely breaks every thumbnail. Sending the origin cross-origin satisfies
  // Bunny while keeping share ids, which live in the URL path, off the wire.
  //
  // No Strict-Transport-Security on purpose: Vercel sets it on its own domains,
  // and a wrong max-age/includeSubDomains is cached by browsers and cannot be
  // withdrawn quickly.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // /admin has one-click destructive actions; framing it anywhere is
          // clickjacking. Both headers, since X-Frame-Options is what older
          // browsers honour and frame-ancestors is what current ones do.
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()',
          },
        ],
      },
    ];
  },
};

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
