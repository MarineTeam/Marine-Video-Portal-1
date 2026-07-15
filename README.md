# Marine Video Portal

A private, invite-only video portal. Approved viewers sign in to watch a curated
library; an admin uploads and organizes the videos, controls who has access, and
shares individual videos through expiring, email-bound links.

The app is a [Next.js](https://nextjs.org) (Pages Router) site that stores no video
bytes itself: uploads and playback go straight to [bunny.net Stream](https://bunny.net),
sign-in is handled by [Auth0](https://auth0.com), and all application state lives in
[Upstash Redis](https://upstash.com).

## Stack

| Concern            | Service / library                                   |
| ------------------ | --------------------------------------------------- |
| Framework          | Next.js 14 + React 18                               |
| Authentication     | Auth0 (`@auth0/nextjs-auth0`)                        |
| Video hosting      | bunny.net Stream (TUS uploads, signed embeds)       |
| Data store         | Upstash Redis (`@upstash/redis`)                    |
| Rate limiting      | Upstash Ratelimit (`@upstash/ratelimit`)            |
| Push notifications | Web Push / VAPID (`web-push`)                        |
| Error monitoring   | Sentry (optional)                                   |

## How it fits together

- **Viewers** sign in with Auth0. A viewer only sees the library if their email is
  on the approved-viewer allowlist (or they are an admin). Everyone else is signed
  in but told they aren't approved yet.
- **Uploads** never pass through this server. The admin's browser asks the API for a
  signed TUS ticket, then streams the file directly to Bunny. The Bunny API key stays
  server-side.
- **Playback** uses short-lived signed Bunny embed URLs, so a raw video URL can't be
  shared or hotlinked.
- **State** — approved viewers, share links, custom ordering, watch progress, the
  audit log, push subscriptions, and the theme — all lives in Redis under the `pvp:`
  key prefix.

## Local development

Requires Node 18+.

```bash
npm install
npm run dev        # http://localhost:3000
```

Other scripts:

```bash
npm run build      # production build
npm run start      # serve the production build
npm run lint       # Next.js / ESLint
npm run test       # Vitest unit tests (lib/)
```

Create `.env.local` with the variables below before running. Without them, sign-in,
the video library, and uploads won't work.

## Environment variables

### Required

| Variable                 | What it is                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| `AUTH0_SECRET`           | Long random string used to encrypt the session cookie             |
| `AUTH0_BASE_URL`         | This app's URL, e.g. `http://localhost:3000` or the prod domain   |
| `AUTH0_ISSUER_BASE_URL`  | Your Auth0 tenant URL, e.g. `https://your-tenant.us.auth0.com`    |
| `AUTH0_CLIENT_ID`        | Auth0 application client ID                                       |
| `AUTH0_CLIENT_SECRET`    | Auth0 application client secret                                   |
| `ADMIN_EMAILS`           | Comma-separated admin emails (full access to the admin panel)     |
| `BUNNY_LIBRARY_ID`       | bunny.net Stream library ID                                       |
| `BUNNY_API_KEY`          | bunny.net Stream library API key (server-side only)               |
| `BUNNY_TOKEN_AUTH_KEY`   | Bunny token-authentication key used to sign embed URLs            |
| `KV_REST_API_URL`        | Upstash Redis REST URL                                            |
| `KV_REST_API_TOKEN`      | Upstash Redis REST token                                          |

### Optional

| Variable                      | Enables                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `BUNNY_CDN_HOSTNAME`          | Direct thumbnail URLs (e.g. `vz-xxxx.b-cdn.net`); grid view needs this  |
| `BUNNY_CDN_TOKEN_KEY`         | Signs thumbnail URLs when "Block Direct URL File Access" is on          |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY`| Web Push (new-video alerts + admin broadcast) — public VAPID key        |
| `VAPID_PRIVATE_KEY`           | Web Push — private VAPID key                                            |
| `VAPID_SUBJECT`               | Web Push contact, e.g. `mailto:admin@example.com` (defaults to admin)   |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` | Sentry error reporting                                        |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | Sentry source-map upload at build time         |

Push notifications are **inert** unless both VAPID keys are set — no buttons, no
sends, no errors. Sentry is likewise inert until its DSN is configured.

## Deployment

The app is built to deploy on Vercel:

1. Import the repo into Vercel.
2. Connect an Upstash Redis (KV) store — Vercel injects `KV_REST_API_URL` /
   `KV_REST_API_TOKEN` automatically.
3. Add the remaining environment variables (above) for Production and Preview.
4. In Auth0, set the app's Allowed Callback URL to `{AUTH0_BASE_URL}/api/auth/callback`
   and Allowed Logout URL to `{AUTH0_BASE_URL}`.
5. Deploy.

To bootstrap access, put your own email in `ADMIN_EMAILS`, sign in, then add approved
viewers from the admin panel.

## Project layout

```
pages/
  index.js               Home — video grid, search, collections, continue-watching
  admin.js               Admin panel (server-gated to admins)
  watch/video/[id].js    Approved-viewer playback
  watch/[shareId].js     Email-bound share-link playback
  api/                   Auth, videos, collections, progress, push, admin/*
lib/
  bunny.js               Bunny Stream API + URL signing
  auth.js                Admin check
  redis.js               Upstash Redis client + key prefix
  order.js               Custom video ordering
  audit.js               Admin action log
  push.js                Web Push helpers
  ratelimit.js           Per-route sliding-window limiter
  theme.js               Accent theme presets + CSS variables
components/               AppShell, players, icons, notify button
public/                  PWA manifest, service worker, icons
```

## License

Private / unlicensed. All rights reserved.
