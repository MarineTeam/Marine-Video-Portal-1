# Private Video Portal

A private video site built with **Next.js**, hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** for login, and **Upstash Redis** (via Vercel Storage) for admin-managed settings and private share links.

## How it works

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed by an admin) see the video list on the homepage. Everyone else sees a "not approved" message after logging in.
- The homepage shows a list of video titles, in an order the admin controls, capped at a count the admin controls, paginated 10 per page. Clicking a title opens a watch page where the video actually plays.
- Videos are never public. Every play uses a **signed, time-limited bunny.net token**, generated fresh on each request — never a permanent public URL.
- Admins can generate a **private share link** for a specific video and a specific recipient email, with an adjustable expiry (defaults to 72 hours, capped at 720). The admin copies the link from the panel and sends it to the recipient manually (no automatic email is sent).
- The share link (`/watch/{shareId}`) forces an Auth0 login and only plays the video if the logged-in email matches the one the admin specified — no email is shown if it doesn't match, to avoid leaking the intended recipient's address.
- Admins can see every currently active share link (recipient, video, expiry) and **revoke any of them instantly**, before their natural expiry.
- `/admin` is restricted to a fixed list of admin emails (`ADMIN_EMAILS`) via a single shared helper (`lib/auth.js`), used by every protected route.

## Project structure

```
pages/
  _app.js                       Auth0 session provider wrapper
  index.js                      Homepage — paginated, ordered video list (approved viewers only)
  admin.js                      Admin panel — settings, viewers, ordering, shares
  api/
    auth/[auth0].js              Auth0 login/logout/callback routes
    videos.js                     Returns a page of video titles for approved viewers
    admin/
      videos.js                   Full video list (ordered), admin only
      viewers.js                   Add/remove/list approved viewer emails
      settings.js                  Get/set homepage video count
      order.js                     Get/set custom homepage video order
      share.js                     Create a private share record + send email
      shares.js                    List/revoke active share links
  watch/
    video/[id].js                 Plays a video for an approved viewer (clicked from homepage)
    [shareId].js                  Plays a video via a private share link (forced login + email match)
lib/
  auth.js                        Shared isAdmin(email) check, used everywhere
  bunny.js                       bunny.net API calls + signed embed URL generation (autoplay off)
  redis.js                       Connection to the Upstash/Vercel KV database
  order.js                       Helpers for applying a custom video order
```

## Environment variables (Vercel → Settings → Environment Variables)

| Key | Description |
|---|---|
| `AUTH0_SECRET` | Random 32-byte hex string encrypting the session cookie. Generate at generate-secret.vercel.app/32. |
| `AUTH0_BASE_URL` | Exact site URL, e.g. `https://private-video-portal.vercel.app` (no trailing slash). |
| `AUTH0_ISSUER_BASE_URL` | Auth0 domain with `https://`, e.g. `https://your-tenant.us.auth0.com` (no trailing slash). |
| `AUTH0_CLIENT_ID` | From Auth0 application settings. |
| `AUTH0_CLIENT_SECRET` | From Auth0 application settings. |
| `BUNNY_LIBRARY_ID` | bunny.net Stream library ID. |
| `BUNNY_API_KEY` | bunny.net Stream library API key. |
| `BUNNY_TOKEN_AUTH_KEY` | bunny.net library's Embed View Token Authentication key (Security tab). |
| `ADMIN_EMAILS` | Comma-separated admin emails, e.g. `you@example.com,other@example.com`. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Auto-injected when a Redis/Upstash database is connected via Vercel's Storage tab. |

After adding or changing any variable, redeploy — changes only apply to new deployments.

## One-time setup checklist

1. **bunny.net**: create a Stream library, enable **Embed View Token Authentication**, upload videos.
2. **Auth0**: create a Regular Web Application. Set Allowed Callback URLs / Logout URLs / Web Origins to the exact production domain. To stop random public sign-ups, enable "Disable Sign Ups" under Authentication → Database, then add approved people manually under User Management → Users.
3. **Vercel**: import the GitHub repo, connect a Redis/Upstash database under Storage, add all environment variables above, deploy.
4. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video count, add approved viewer emails, reorder videos as desired.

## Admin panel features (`/admin`)

- **Homepage Settings** — set how many videos appear on the homepage in total.
- **Approved Viewers** — add/remove emails allowed to see the homepage video list.
- **Active Private Links** — see every live share link with recipient + expiry, and revoke any of them instantly.
- **Video Library** — full list of videos with ↑/↓ buttons to set homepage display order, plus a per-video form to create a private share link (recipient email + expiry hours, default 72). The generated link appears in the panel for you to copy and send manually.

## Security notes

- Direct bunny.net CDN URLs (e.g. `*.b-cdn.net/{id}/playlist.m3u8` or `play_720p.mp4`) are **not used anywhere in this app**, but are publicly accessible by default if someone obtains one directly, since they're governed by a separate "CDN Token Authentication" system on the Pull Zone — distinct from the embed token auth this app already uses. If you want to close that off entirely even though it's unused, enable **Block Direct URL File Access** on the library's Security tab (and set Allowed Domains if you do, to avoid breaking thumbnails/previews).
- Share-link mismatch errors deliberately don't reveal the intended recipient's email, to avoid leaking it to someone who guesses or forwards a link.
- Centralized admin-check logic lives in `lib/auth.js` — update there only, never re-add a local `isAdmin` copy in a route file.

## Common issues

- **`npm install` fails on deploy** — usually a version mismatch between `next` and `@auth0/nextjs-auth0`'s peer dependency requirement (check the build log for `ERESOLVE`), or a stray `package-lock.json`/`yarn.lock` committed alongside `package.json`.
- **"issuerBaseURL must be a valid uri"** — `AUTH0_ISSUER_BASE_URL` is missing `https://`, has a trailing slash, or has stray whitespace.
- **"Missing state cookie" on callback** — login was started from a different domain/URL than `AUTH0_BASE_URL` (e.g. an old preview deployment link). Always start from the exact production URL.
- **Logout doesn't redirect back** — check Auth0's **Allowed Logout URLs** field; it's separate from Allowed Callback URLs.
- **Homepage shows more/fewer videos than expected** — bunny.net's `itemsPerPage` isn't a strict cap, so the app trims to the exact count itself in code; confirm that slicing logic is still present in `pages/api/videos.js` if this regresses.

## Scaling notes (Redis/Upstash)

Each homepage visit costs a small, fixed number of Redis commands (viewer approval check, homepage count, video order — 3 total, plus 1 more per video clicked through to watch). At roughly 1,000 visits/day, total usage lands well under typical free-tier command limits (around 150,000/month against a 500,000 ceiling). If usage later grows into the 10,000+ daily-visit range, moving the rarely-changing admin settings (viewer list, count, order) to Vercel Edge Config would meaningfully reduce Redis load, leaving Redis to handle only the share-link feature it's actually needed for (TTL/expiry).
