# Marine Video Portal

A private, invite-only video site built with **Next.js** (Pages Router), hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** for login, and **Upstash Redis** (via Vercel Storage) for admin-managed settings, collections, share links, watch history, and the audit log.

Videos are never public: every play uses a **signed, time-limited bunny.net token** generated fresh on each request. Access is gated to an admin-managed list of approved viewers, with per-recipient private share links for one-off sharing.

---

## How it works

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed live by an admin) see the video library. Everyone else sees a clear "not approved" message after logging in.
- The homepage shows the library — as a **thumbnail grid** when thumbnails are configured, otherwise a title list — with **search**, **collection filters**, and a **Continue watching** strip that resumes videos where the viewer left off. It's paginated and capped at an admin-controlled count.
- Clicking a video opens a watch page that plays it in a tokenized bunny.net embed and remembers playback position.
- Admins manage everything from a tabbed **`/admin`** panel: upload videos, organize the library, manage viewers and share links, adjust the site's color palette, and view analytics and an activity log.
- `/admin` is gated **server-side** (redirects non-admins before any UI is sent) and every `/api/admin/*` route independently returns `403` for non-admins.
- The portal is an **installable PWA** — it can be installed as a standalone app on Windows, Mac, Android, and iOS off the same deployment. The installed app is **viewer-only** (the Admin button is hidden in standalone mode); admin stays available in a normal browser tab.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14 (Pages Router), React 18 |
| Hosting | Vercel |
| Video | bunny.net Stream (tokenized embeds, TUS resumable upload, collections, statistics) |
| Auth | Auth0 (`@auth0/nextjs-auth0`) |
| Data | Upstash Redis (`@upstash/redis`) via Vercel Storage |
| Rate limiting | `@upstash/ratelimit` |
| Error monitoring | Sentry (`@sentry/nextjs`), opt-in |
| Uploads | `tus-js-client` (browser → bunny.net) |
| Playback resume | `player.js` |
| Tests / CI | Vitest + GitHub Actions (lint + test + build) |

---

## Project structure

```
pages/
  _app.js                 Session provider, theme bootstrap, idle-timeout mount
  _document.js            No-flash palette script (applies cached theme pre-paint)
  index.js                Homepage — thumbnail grid/list, search, collections, continue-watching
  admin.js                Tabbed admin panel (server-gated) — Videos/Viewers/Shares/Settings/Activity/Analytics
  api/
    auth/[auth0].js       Auth0 login/logout/callback
    videos.js             Page of videos for approved viewers (search + collection filter, rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history
    theme.js              Public GET palette; admin POST to update it
    admin/
      videos.js           List (ordered) / rename / set-collection / delete
      viewers.js          List (with last-seen) / add (single or bulk) / remove
      settings.js         Homepage video count
      order.js            Custom homepage video order
      share.js            Create a private share link (rate-limited)
      shares.js           List / revoke active share links (with viewed status)
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js            Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
  watch/
    video/[id].js         Plays a library video for an approved viewer (resumable)
    [shareId].js          Plays a video via a private share link (forced login + email match)
components/
  AppShell.js             Header/layout shell
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress
  icons.js                Inline SVG icons
lib/
  auth.js                 Shared isAdmin(email) check, used everywhere
  bunny.js                Bunny API: list/create/update/delete videos, collections, TUS signing,
                          signed embed URLs, thumbnail URLs (token-signed), statistics
  redis.js                Upstash Redis connection + key prefix helper k()
  order.js                Apply custom video order (new uploads float to top, newest first)
  theme.js                Palette presets, validation, CSS-variable mapping
  audit.js                Append-only admin action log (capped)
  ratelimit.js            Sliding-window limiter (fails open)
  __tests__/              Vitest smoke tests (auth, order, theme)
styles/globals.css        Design system (dark glassmorphism, gradient accents, Inter)
sentry.{client,server,edge}.config.js   Opt-in Sentry init (inert without a DSN)
next.config.js            Wrapped with withSentryConfig
vitest.config.js          Test config (node env + dummy env)
.eslintrc.json            next/core-web-vitals
.github/workflows/ci.yml  Lint + test + build on push/PR to main
```

---

## Environment variables (Vercel → Settings → Environment Variables)

### Required

| Key | Description |
|---|---|
| `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate at generate-secret.vercel.app/32. |
| `AUTH0_BASE_URL` | Exact site URL, e.g. `https://your-app.vercel.app` (no trailing slash). |
| `AUTH0_ISSUER_BASE_URL` | Auth0 domain with `https://`, e.g. `https://your-tenant.us.auth0.com` (no trailing slash). |
| `AUTH0_CLIENT_ID` | From the Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From the Auth0 application settings. |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID. |
| `BUNNY_API_KEY` | bunny.net Stream library API key. |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library's Embed View Token Authentication key (Security tab). |
| `ADMIN_EMAILS` | Comma-separated admin emails, e.g. `you@example.com,other@example.com`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when a Redis/Upstash database is connected via Vercel's Storage tab. |

### Optional

| Key | Description |
|---|---|
| `BUNNY_CDN_HOSTNAME` | Library CDN/pull-zone host (e.g. `vz-xxxx-xxx.b-cdn.net`). **Required for thumbnails** — without it the homepage falls back to the title list. |
| `BUNNY_CDN_TOKEN_KEY` | Pull zone's URL Token Authentication key. Only needed if it differs from `BUNNY_TOKEN_AUTH_KEY` and "Block Direct URL File Access" is on. |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Enable Sentry error capture (server / client). Inert if unset. |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Enable Sentry source-map upload during build. |

After adding or changing any variable, **redeploy** — changes only apply to new deployments.

---

## One-time setup checklist

1. **bunny.net** — create a Stream library, enable **Embed View Token Authentication**, upload videos (or upload them from `/admin` later). Note the CDN/pull-zone hostname for `BUNNY_CDN_HOSTNAME` if you want thumbnails.
2. **Auth0** — create a Regular Web Application. Set Allowed Callback URLs / Logout URLs / Web Origins to the exact production domain. **Disable open sign-ups** (Authentication → Database → "Disable Sign Ups") and add people manually under User Management → Users, so strangers can't self-register.
3. **Vercel** — import the GitHub repo, connect a Redis/Upstash database under Storage, add the environment variables above, deploy.
4. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video count, add approved viewers, upload/organize videos, pick a palette.

---

## Local development

Node/npm are **not required** to deploy (Vercel installs everything), but they're handy for local work and verification.

```bash
npm install       # install dependencies
npm run dev       # local dev server at http://localhost:3000
npm run lint      # ESLint (next/core-web-vitals)
npm test          # Vitest smoke tests
npm run build     # production build
```

You'll need the environment variables above in a local `.env.local` to run against real services.

### CI

Every push / PR to `main` runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml): **lint → test → build**. A broken build fails the check before Vercel deploys it. Consider enabling branch protection to require the check on PRs.

---

## Admin panel (`/admin`)

Tabbed layout, gated server-side to `ADMIN_EMAILS`:

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete, drag-to-reorder, search, encoding-status badges, per-video collection assignment, and per-video private share-link creation. Also a Collections manager (create/delete).
- **Viewers** — add/remove approved emails, **bulk add** (paste a list), and each viewer's **last-seen** time.
- **Shares** — every active private link with recipient, expiry, and **viewed/not-viewed** status; revoke instantly.
- **Settings** — homepage video count, the site **color palette** (7 presets + custom, applied to all visitors), and a content-protection info panel.
- **Activity** — the most recent admin actions (add/remove viewer, share create/revoke, video rename/delete/reorder, settings, palette, collections).
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day views chart, and a most-watched list.

---

## Installing as an app (PWA)

The site is installable as a standalone app off the live deployment — no app store, no separate build:

- **Windows / Mac (Chrome or Edge):** open the site → click the install icon in the address bar → **Install**.
- **Android (Chrome):** menu → **Install app** / **Add to Home screen**.
- **iOS (Safari):** **Share** → **Add to Home Screen**.

The installed app is **viewer-only** — the Admin button is hidden in standalone mode (admin stays available in a normal browser tab). Login is unchanged (same site, same Auth0 flow). The service worker caches nothing, so the app always needs a connection. The app icon is [public/icon.svg](public/icon.svg); note iOS Safari prefers a PNG `apple-touch-icon`, so the iOS home-screen icon may need PNG assets to render the logo cleanly.

## Security notes

- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare `session.user.email`. Because of this, keep Auth0 **sign-ups disabled** (or require verified email) so nobody can self-register as an approved/admin address. Centralized admin logic lives in `lib/auth.js` — update it there only.
- **`/admin` is gated server-side** via `getServerSideProps` (redirects non-admins), and every `/api/admin/*` route independently returns `403`.
- **Playback is always tokenized** — signed, time-limited embed URLs generated per request; no permanent public URL is used or exposed.
- **Share-link mismatches don't reveal** the intended recipient's email.
- **Thumbnails** are served from the CDN and, when a token key is present, are **signed** so they keep working with "Block Direct URL File Access" enabled. Requests from the app carry the site's `Referer`, so hotlink protection still blocks direct/off-site access.
- **Rate limiting** guards the video list, upload, and share-creation endpoints (fails open if the limiter backend is unavailable).
- **Idle sign-out** logs users out after 30 minutes of inactivity.
- Direct bunny.net CDN file URLs (`*.b-cdn.net/.../playlist.m3u8`, `play_720p.mp4`) are never used by the app; if you want them fully locked down, enable **Block Direct URL File Access** on the library's Security tab.

---

## Common issues

- **Thumbnails show as a title list** — `BUNNY_CDN_HOSTNAME` isn't set (or the deploy hasn't picked it up). The grid only appears once the API returns thumbnail URLs.
- **Thumbnails 403 directly but load in the app** — expected: that's referrer-based hotlink protection. The app works; direct/off-site access is blocked.
- **Resume doesn't work** — the Bunny embed must expose the player.js protocol; playback still works either way. Check the browser console/network for `/api/progress` calls.
- **`npm install` fails on deploy** — usually an `ERESOLVE` peer-dependency mismatch between `next` and `@auth0/nextjs-auth0`, or a stray `package-lock.json`/`yarn.lock` committed alongside `package.json`.
- **"issuerBaseURL must be a valid uri"** — `AUTH0_ISSUER_BASE_URL` is missing `https://`, has a trailing slash, or has stray whitespace.
- **"Missing state cookie" on callback** — login was started from a different URL than `AUTH0_BASE_URL` (e.g. an old preview link). Always start from the exact production URL.
- **Upload fails with HTTP 401** — a stray newline/space in `BUNNY_API_KEY`/`BUNNY_LIBRARY_ID` corrupts the TUS signature (the app trims them; re-paste cleanly in Vercel if it recurs).

---

## Scaling notes (Redis/Upstash)

A homepage visit costs a small, fixed number of Redis commands (viewer check, homepage count, video order, last-seen, plus collections/progress reads). At ~1,000 visits/day this stays well under typical free-tier limits. Watch history and the audit log add bounded writes. If traffic grows into the 10,000+ daily-visit range, move the rarely-changing settings (viewer list, count, order, palette) to Vercel Edge Config to cut Redis load, leaving Redis for the TTL-based share links and per-viewer progress.
