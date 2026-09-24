import { auth0 } from './lib/auth0';

// Next.js 16 network boundary (the file Next 15 called middleware.js).
//
// It does exactly two things, both Auth0 v4's: it serves the sign-in routes
// (/api/auth/login, /logout, /callback and /auth/profile — see lib/auth0.js)
// and it keeps rolling sessions fresh. It makes NO access decision. Every page
// and API route still checks the session and the caller's role itself, exactly
// as it did when this repo had no middleware at all, so a request that somehow
// skipped this file would reach the same checks — which is the point of never
// putting a guard here.
//
// It exists only because Next 16 needs Auth0 v4 and v4 has no other way to
// mount its routes. The decision is recorded in the architecture contract
// (Decision 1) and the security campaign (fence 5).
export async function proxy(request) {
  return auth0.middleware(request);
}

export const config = {
  matcher: [
    // Everything except static assets — the broad matcher is what keeps a
    // rolling session alive on ordinary page and API traffic. PWA assets
    // (manifest, service worker, icons, the admin-set icon route) are left out
    // so they are served without session-cookie churn, and so are scheduled
    // jobs (api/cron), whose caller is Vercel's cron runner and whose only
    // gate is CRON_SECRET (lib/cronAuth.js).
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|manifest.webmanifest|sw.js|icon-192.png|icon-512.png|icon.svg|apple-touch-icon.png|api/app-icon|api/cron/).*)',
  ],
};
