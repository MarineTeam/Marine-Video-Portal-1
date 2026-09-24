import { Auth0Client } from '@auth0/nextjs-auth0/server';

// The Auth0 v4 client (Next 16 needs v4; v3 stopped at Next 15). Configured so
// that NOTHING outside this repo has to change on upgrade:
//
//   * the sign-in URLs stay where v3 put them — /api/auth/login, /logout and
//     /callback — so the Auth0 dashboard's Allowed Callback URL still matches
//     and every existing link keeps working. v4 serves them from proxy.js, not
//     from a pages/api route;
//   * the env vars keep their v3 names. v4 reads AUTH0_DOMAIN and
//     APP_BASE_URL; this repo's Vercel project has AUTH0_ISSUER_BASE_URL and
//     AUTH0_BASE_URL, so they are read here and passed in. The v4 names win
//     when both are set. AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET and AUTH0_SECRET
//     are the same in both.
//
// The profile route stays at v4's default, /auth/profile, which the useUser
// hook fetches; it is not a dashboard setting.
const env = (name) => (process.env[name] || '').trim();

function domainFromEnv() {
  if (env('AUTH0_DOMAIN')) return env('AUTH0_DOMAIN');
  const issuer = env('AUTH0_ISSUER_BASE_URL');
  if (!issuer) return undefined;
  try {
    return new URL(issuer).host;
  } catch {
    return undefined;
  }
}

export const auth0 = new Auth0Client({
  domain: domainFromEnv(),
  appBaseUrl: env('APP_BASE_URL') || env('AUTH0_BASE_URL') || undefined,
  routes: {
    login: '/api/auth/login',
    logout: '/api/auth/logout',
    callback: '/api/auth/callback',
  },
});

// The signed-in session, or null — the same shape v3's getSession(req, res)
// returned (`session.user.email`), so the ~50 call sites read it unchanged.
// `res` is accepted and ignored: v4 reads the cookie from the request alone,
// and proxy.js is what keeps a rolling session fresh.
export async function getSession(req) {
  return auth0.getSession(req);
}
