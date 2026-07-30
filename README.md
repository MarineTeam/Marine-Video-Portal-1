# Marine Video Portal

A private, invite-only video site built with **Next.js** (Pages Router), hosted on **Vercel**, using **bunny.net Stream** for video storage/playback, **Auth0** for login, and **Upstash Redis** (via Vercel Storage) for admin-managed settings, collections, share links, watch history, and the audit log.

Videos are never public: every play uses a **signed, time-limited bunny.net token** generated fresh on each request. Access is gated to an admin-managed list of approved viewers, with per-recipient private share links for one-off sharing.

## Architecture at a glance

- **No video bytes touch this server.** Uploads stream from the admin's browser straight to bunny.net over resumable TUS, authorized by a server-signed ticket — the Bunny API key stays server-side and never reaches the client.
- **Playback is always tokenized.** Each play uses a short-lived signed Bunny embed URL, so a raw, shareable video URL is never exposed.
- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare `session.user.email` against admin-managed lists.
- **All state lives in Redis.** Approved viewers, collections, custom ordering, share links, watch progress, push subscriptions, the theme, and the audit log are stored in Upstash Redis under the `pvp:` key prefix — editable live from `/admin`, no redeploy.

---

## How it works

- Visiting the site requires logging in via Auth0.
- Only **approved viewers** (managed live by an admin) see the video library. Everyone else sees a clear "not approved" message after logging in.
- The homepage shows the library — as a **thumbnail grid** when thumbnails are configured, otherwise a title list — with **search**, **collection filters**, and a **Continue watching** strip that resumes videos where the viewer left off. It's paginated and capped at an admin-controlled count.
- Clicking a video opens a watch page that plays it in a tokenized bunny.net embed and remembers playback position. Picture-in-Picture is enabled on every watch page, so a viewer can pop the player into a floating window and keep it playing while using other tabs/apps.
- An **Activity** page shows a viewer their own watch history; admins can also look up any approved viewer's history there.
- Admins manage everything from a tabbed **`/admin`** panel: upload videos, organize the library, manage viewers and share links, adjust the site's color palette, and view analytics and an activity log.
- `/admin` is gated **server-side** (redirects non-admins before any UI is sent) and every `/api/admin/*` route independently returns `403` for non-admins.
- The portal is an **installable PWA** — it can be installed as a standalone app on Windows, Mac, Android, and iOS off the same deployment. Admins get the full admin panel in the installed app too (the Admin button is shown for admin accounts everywhere, standalone or browser tab).

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
| Push | Web Push / VAPID (`web-push`), opt-in |
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
  watch/
    [shareId].js          Individual private-link watch page (view + playback tracking)
    bundle/[bundleId].js  Consolidated listing of everything currently shared with one recipient
    video/[id].js         Watch page for approved viewers (by video GUID)
  api/
    auth/[auth0].js       Auth0 login/logout/callback
    videos.js             Page of videos for approved viewers (search + collection filter, rate-limited)
    collections.js        Collection list for the homepage filter (approved viewers)
    progress.js           Per-viewer playback progress / watch history
    theme.js              Public GET palette; admin POST to update it
    share/[shareId]/track.js  Records player.js playback events (play/progress/completed) for a share link
    push/
      subscribe.js        Store a viewer's Web Push subscription
      unsubscribe.js      Remove a Web Push subscription
    admin/
      videos.js           List (ordered, with watermark mode) / rename / set-collection / set-watermark-mode / delete (single or bulk)
      viewers.js          List (with last-seen) / add (single or bulk) / remove
      settings.js         Homepage video count
      watermark.js        Global watermark default + exemption list (add/remove)
      order.js            Custom homepage video order
      share.js            Bulk share creation — N videos × M recipients, optional watermark override (rate-limited)
      shares.js           List / bulk resend / bulk revoke / extend expiry (single or bulk)
      private-list.js     Per-video private access list — list / diff-add (share + optional email) / remove (revoke)
      upload.js           Create Bunny video + signed TUS auth (rate-limited)
      collections.js      Create / list / delete collections
      audit.js            Recent admin actions
      analytics.js        Views, watch time, 30-day chart, most-watched
      video-analytics.js  Per-video rollup of existing share tracking (shares, recipients, views, completion)
      broadcast.js        Send a manual push broadcast to viewers + admins
components/
  AppShell.js             Header/layout shell
  IdleTimeout.js          30-minute inactivity auto sign-out
  ResumablePlayer.js      Wraps the Bunny embed via player.js for resume + progress
  SharePlayer.js          Wraps the Bunny embed on share-link pages, reports play/progress/completed
  Watermark.js            Tiled, non-interactive viewer-email overlay shown when the layered setting resolves "on"
  NotifyButton.js         Per-device push opt-in/out toggle
  icons.js                Inline SVG icons
lib/
  auth.js                 Shared isAdmin(email) check, used everywhere
  bunny.js                Bunny API: list/create/update/delete videos, collections, TUS signing,
                          signed embed URLs, thumbnail URLs (token-signed), statistics
  redis.js                Upstash Redis connection + key prefix helper k()
  order.js                Apply custom video order (new uploads float to top, newest first)
  theme.js                Palette presets, validation, CSS-variable mapping
  audit.js                Append-only admin action log (capped)
  push.js                 Web Push helpers (VAPID send, announce-once guard, self-pruning)
  mail.js                 Resend email helper for share/bundle emails (inert without RESEND_API_KEY)
  shareBundle.js          Share-record helpers, grace-period TTL/expiry, and per-recipient bundling
  ratelimit.js            Sliding-window limiter (fails open)
  watermark.js            Layered watermark resolution (exemption > share > video > global default)
  __tests__/              Vitest smoke tests (auth, order, theme, push, shareBundle, watermark)
public/
  manifest.webmanifest    PWA manifest
  sw.js                   Service worker (caches only icons + manifest)
  icon-192.png / icon-512.png / apple-touch-icon.png / icon.svg   App icons
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
| `BUNNY_API_KEY` | bunny.net Stream library API key (server-side only). |
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
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Enable **push notifications** (new-video announcements + admin broadcasts). Set **both** to turn the feature on; leave unset and the "Notify me" button and broadcast form stay hidden. Generate a keypair with `npx web-push generate-vapid-keys`. `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is baked in at build time — changing it needs a rebuild, not just a restart. |
| `VAPID_SUBJECT` | Contact URI for push (a `mailto:` address or https URL). Defaults to `mailto:<first ADMIN_EMAILS entry>`. |
| `RESEND_API_KEY` | Enable **emailing share links** to their recipient (via [Resend](https://resend.com)). Unset → the "Email the link" checkbox and "Resend email" button stay hidden and nothing is ever sent. |
| `MAIL_FROM` | From address for share-link emails, e.g. `Marine Video Portal <share@yourdomain.com>` (must be a Resend-verified sender). Defaults to `onboarding@resend.dev` for testing. |
| `GEO_WHITELIST` | Comma-separated ISO country codes (e.g. `US,CA,GB`) allowed for **viewers**, when the viewer geo toggle is switched on in the Settings tab (that toggle defaults to off). Read-only in the admin panel; edit here and redeploy to change the list. |
| `QUERY_MONITOR_ENABLED` / `NEXT_PUBLIC_QUERY_MONITOR_ENABLED` | Enable the **Query Monitor / performance panel** (Redis query count & timing, memory, render time) shown as a floating widget on every page. Set **both** to `true` to turn it on; leave unset (or `false`) and nothing is added — no widget, no instrumentation overhead. The admin Settings tab shows whether it's currently enabled. `NEXT_PUBLIC_QUERY_MONITOR_ENABLED` is baked in at build time — changing it needs a rebuild, not just a restart. |
| `ADMIN_GEO_WHITELIST` | Same, but for **admins** — a separate list, separate toggle (also off by default). Gates both video watch pages and the `/admin` panel itself for admin accounts. |
| `ADMIN_GEO_BYPASS_EMAILS` | Comma-separated admin emails that always skip the admin geo check, regardless of country or the toggle. Arm this **before** traveling — it's a standing safety net, not an in-the-moment fix, since env var changes need a redeploy. |

After adding or changing any variable, **redeploy** — changes only apply to new deployments.

---

## One-time setup checklist

1. **bunny.net** — create a Stream library, enable **Embed View Token Authentication**, upload videos (or upload them from `/admin` later). Note the CDN/pull-zone hostname for `BUNNY_CDN_HOSTNAME` if you want thumbnails.
2. **Auth0** — create a Regular Web Application. Set Allowed Callback URLs / Logout URLs / Web Origins to the exact production domain. **Disable open sign-ups** (Authentication → Database → "Disable Sign Ups") and add people manually under User Management → Users, so strangers can't self-register. (Because access is by email identity, this is the primary guard against someone self-registering as an approved/admin address.)
3. **Vercel** — import the GitHub repo, connect a Redis/Upstash database under Storage, add the environment variables above, deploy.
4. Log in with an `ADMIN_EMAILS` account → `/admin` → set the homepage video count, add approved viewers, upload/organize videos, pick a palette.

---

## Local development

Node/npm are **not required** to deploy (Vercel installs everything), but they're handy for local work and verification. Node 18+ recommended.

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

- **Videos** — upload (drag-and-drop, progress, cancel/retry), rename, delete, drag-to-reorder, search, encoding-status badges, per-video collection assignment, a per-video **watermark override** (Default/Always/Never), a collapsible **per-video analytics** panel, a per-video quick private share form (any number of recipient emails at once, a viewer-**tag** picker to add a whole tagged group in one click, its own watermark selector, and an optional **"email the link(s) to the recipient(s)"** checkbox when email is configured), and a collapsible **Private list** panel per video (a persistent, editable access list, also with a tag picker — see below). Multi-select checkboxes for **bulk delete** and **bulk collection assignment**. Also a Collections manager (create/delete).
- **Viewers** — add/remove approved emails, **bulk add** (paste a list), per-viewer **tags** (e.g. "Team A") for grouping, and each viewer's **last-seen** time.
- **Shares** — a **bulk-share** form (pick any number of videos × any number of recipients — every pair gets its own link, one email per recipient, with its own watermark selector); every active private link with recipient, expiry, **view count/last-viewed**, **playback status** (plays, furthest % watched, completed), and a durable **"Copy bundle link"** button when the link is part of a bundle; multi-select checkboxes for **bulk resend / bulk revoke / bulk un-revoke / bulk extend / bulk delete permanently**; and per-link **extend**, **un-revoke** (restore a revoked link in place), and **delete permanently** (only allowed once a link is already revoked).
- **Settings** — homepage video count, the site **color palette** (7 presets + custom, applied to all visitors), the **watermark global default** and its exemption list, the **geo location whitelist** on/off toggles (viewer and admin, each off by default, country lists shown read-only), a **push broadcast** composer, and a content-protection info panel.
- **Activity** — the most recent admin actions (add/remove viewer, share create/revoke/un-revoke/delete, video rename/delete/reorder, settings, palette, collections).
- **Analytics** — total views, 30-day views, watch time, video count, a 30-day views chart, a most-watched list, and a **per-video analytics** list (shares, recipients, views, started, completed + rate, avg progress) rolled up from existing share data.

---

## Installing as an app (PWA)

The site is installable as a standalone app off the live deployment — no app store, no separate build:

- **Windows / Mac (Chrome or Edge):** open the site → click the install icon in the address bar → **Install**.
- **Android (Chrome):** menu → **Install app** / **Add to Home screen**.
- **iOS (Safari):** **Share** → **Add to Home Screen**.

The installed app is the **full portal** — admins see the Admin button and can manage everything from the installed app, exactly as in a normal browser tab. Login is unchanged (same site, same Auth0 flow). App icons are provided as PNG (192/512 + a 180px Apple touch icon) and SVG, so home-screen/taskbar icons render cleanly on all platforms including iOS. The service worker caches only the app icons and manifest (never authed pages, API, or video), so the app still needs a connection to use.

---

## Push notifications (opt-in)

Push is completely **inert unless both `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` are set** — with no keys, the "Notify me" button and broadcast composer never appear and nothing is ever sent.

- **New-video announcements** — a video is announced once it finishes encoding, and only if it was uploaded recently (so enabling push never back-blasts the existing library). An atomic Redis guard ensures each video is announced exactly once even across concurrent admin polls.
- **Manual broadcasts** — admins can send a custom push to everyone from the Settings tab.
- **Targeted & self-cleaning** — sends reach only currently-approved viewers and admins; a removed viewer stops receiving them, and dead subscriptions (HTTP 404/410) are pruned automatically.

Generate a keypair with `npx web-push generate-vapid-keys`.

---

## Emailing share links (opt-in)

Share links can be delivered to their recipient by email through [Resend](https://resend.com), and re-sent later from the Shares tab. Like push, the feature is **inert unless `RESEND_API_KEY` is set** — with no key, the "Email" checkboxes and "Resend email" buttons never appear and nothing is ever sent, so the admin simply copies links by hand as before.

- **On create** — the bulk-share form (or a video's quick-share form) emails each recipient once, listing only their own links.
- **Resend** — every active link in the Shares tab has a "Resend email" button that re-delivers it to the original recipient (rate-limited, like link creation); it can also be done in bulk for several selected links at once.
- **Best-effort** — a mail failure never blocks link creation; the link is stored either way and can be copied or resent.

Set `RESEND_API_KEY` and (recommended) `MAIL_FROM` to a Resend-verified sender. Emails are sent server-side via Resend's REST API — no extra dependency, nothing built into the client bundle.

---

## Bulk sharing, bundles, and expiry extension

- **Bulk share** — the Shares tab's bulk-share form takes any number of selected videos and any number of recipient emails. Every (video, recipient) pair gets its own **independently revocable** private link. Each recipient is emailed **once** listing only their own links, never anyone else's.
- **Bundles ("same email, same place")** — once a recipient has 2 or more active links (from one bulk action, or accumulated one at a time over separate actions), they're grouped into one **bundle**: a single listing page (`/watch/bundle/[id]`) showing everything currently shared with that email, gated by the exact same Auth0-login + email-match check as an individual link. A bundle is a pure grouping of link IDs — it never caches a link's title or status, so revoking, expiring, or extending one member shows up on the bundle page instantly. A brand-new recipient's first-ever link still gets a simple standalone email; from their second link onward, every notification becomes one consolidated "here's everything currently active for you" email instead of a new standalone one. Pre-existing (pre-bundling) links for the same email are swept into the bundle automatically the first time it forms.
- **View and playback tracking, per link** — every link tracks its own **view count and last-viewed time** (server-recorded on each page load), plus real playback signal reported by the Bunny embed's player.js events: **plays**, **furthest % watched**, and **completed**. A page view alone (opening the link) is tracked separately from actually pressing play, so you can tell who opened a link versus who watched it.
- **Extend** — push a link's expiry out in place (same URL, no new link, no re-notification) instead of revoking and re-sharing. Works even on a link that's already lapsed but wasn't revoked (it extends from now, not from the stale old expiry); a genuinely revoked link can't be "extended" back to life, since revoking deletes it outright. Extending a bundled link also extends the bundle's own expiry so the bundle page doesn't lapse before its members do. Extend is available per-link or in bulk across several selected links.
- **Grace period, not instant deletion** — a link's Redis record now outlives its logical expiry by 30 days before it's actually purged, specifically so an admin can still notice and extend an expired-but-not-revoked link. Viewer-facing pages and APIs still treat it as expired the moment its `expiresAt` passes; only the underlying record sticks around a while longer.

---

## Private access list per video

Every video's **Videos** tab row has a collapsible **Private list** panel — a YouTube/Drive-style "share with specific people" list, layered on top of the Share/Bulk Share machinery above rather than a separate system. It shows everyone currently listed for that video and a form to add more:

- **Persistent and editable** — the panel stays put on the row; open it any time to see or change who has access, instead of generating a one-off link you have to go find again.
- **A list member is a share record, but the list only knows its own** — under the hood, adding someone creates a normal share (`lib/shareBundle.js`), tagged `privateList: true` so the list can tell its own tokens apart from anything else. Every membership check (who's shown, what "already on the list" means, what "remove" revokes) filters on that tag — the list never looks at, and never touches, a share it didn't create.
- **Adding only affects new people** — paste in any number of emails (comma/space/newline-separated), or use the **"Add viewers tagged…" picker** to add everyone carrying a given tag in one click (same picker as Bulk Share); only the ones *not already active on this list* get a new share (and a notification, if enabled). Emails already on the list are left completely alone: no duplicate share, no re-sent email. If that video/email pair already has a *separate* share from Create Link or Bulk Share, the list can't see it — adding here still creates a brand-new, independently-revocable token alongside it.
- **"Notify new people by email" checkbox** — on by default, matching Google Drive/YouTube's own sharing dialogs. Unchecking it still creates a fully live share for every newly added email — they just aren't emailed about it; the admin can share the link by hand or resend the notification later from the Shares tab.
- **Removing revokes only the list's own token, immediately** — taking an email off the list soft-revokes the one share the list itself created for that video/email. Any other active share to that same video/email — from Create Link, Bulk Share, or a stray earlier one — is untouched; "remove" is never a global "cut off this person's access to this video" action, since the list can only revoke what it made. Removing from one video's list never affects any other video's list either. If the removed share was part of a bundle, only that one video quietly drops off the bundle page next load — every other bundled video is unaffected. Adding that email back later is a **fresh invite**: a brand-new share and (if notifications are on) a new email, since the revoked one no longer counts as "on the list."
- **Expiry** — list shares use the same 30-day expiry cap as every other share (`private-list.js`'s `MAX_HOURS`); extend one in place from the Shares tab if it's about to lapse, same as any other link.

---

## Watermarking

Playback can overlay the logged-in viewer's own email as a faint, tiled, non-interactive overlay — a deterrent against screen-recording or redistribution, not an access control. It's purely CSS on top of the player (there's no change to the Bunny embed itself, and none of the signing formulas are touched): if nothing resolves "on," the overlay simply isn't rendered, so playback is never at risk from this feature.

The setting is **layered**, most specific wins, and an exemption always overrides everything:

1. **Exemption** _(Settings tab)_ — an admin-managed list of emails (viewer or admin) who are never watermarked, full stop.
2. **Per-share** _(Shares tab, both the single- and bulk-share forms)_ — Default / Always / Never, set when the link is created.
3. **Per-video** _(Videos tab)_ — Default / Always / Never, per video.
4. **Global default** _(Settings tab)_ — the fallback when nothing more specific is set.

"Default" at the share or video layer means *not explicitly set* — only `Always`/`Never` are ever stored, so most shares and videos simply inherit whatever the layer below them resolves to.

---

## Geo location whitelist

Restricts video access by country, detected from Vercel's `x-vercel-ip-country` header (populated on every serverless function invocation on Vercel's network — no external geolocation API, no middleware). There are **two independent whitelists**:

- **Viewers** — `GEO_WHITELIST` (comma-separated ISO country codes), gated by its own on/off toggle in the Settings tab. Covers the video list, direct watch pages, and private share links.
- **Admins** — `ADMIN_GEO_WHITELIST`, a *separate* list with its own toggle. Covers the same video pages **and** the `/admin` panel itself for admin accounts.

Both toggles default to **off**, so a fresh deployment behaves exactly as before until an admin opts in. The country lists themselves are env-configured (deploy-time) and shown **read-only** in the panel — only the toggles are live-editable.

A country that can't be determined (local development, a non-Vercel host, a missing header) always **fails open** — it's never blocked, the same fail-open philosophy the rate limiter already uses.

**`ADMIN_GEO_BYPASS_EMAILS`** lets specific admin emails skip the admin geo check entirely, regardless of country or the toggle. This is a standing safety net an admin arms *before* traveling, not an in-the-moment fix — changing it (or `ADMIN_GEO_WHITELIST`, or the toggle, since all env var changes need a redeploy to take effect) is slower than the Redis-backed toggle alone. If an admin is ever locked out of `/admin` by their own whitelist, recovery is: edit the relevant env var (or disable the toggle) in Vercel, then redeploy.

---

## Security notes

- **Access is by email identity.** Admin, approved-viewer, and share-recipient checks all compare `session.user.email`. Because of this, keep Auth0 **sign-ups disabled** so nobody can self-register as an approved/admin address. Centralized admin logic lives in `lib/auth.js` — update it there only.
- **`/admin` is gated server-side** via `getServerSideProps` (redirects non-admins), and every `/api/admin/*` route independently returns `403`.
- **Playback is always tokenized** — signed, time-limited embed URLs generated per request; no permanent public URL is used or exposed.
- **Share-link mismatches don't reveal** the intended recipient's email — the bundle page and the playback-tracking endpoint use the exact same generic mismatch message.
- **No middleware, by design.** The bundle page and the share-tracking API each carry their own `getSession` + email-match check via `getServerSideProps` / handler code, the same pattern every other page/route in this app uses. There is deliberately no `middleware.js` gating routes centrally; adding one would expand the app's Next.js attack surface (Pages Router only, no App Router/middleware — see "Architecture at a glance" above).
- **Thumbnails** are served from the CDN and, when a token key is present, are **signed** so they keep working with "Block Direct URL File Access" enabled. Requests from the app carry the site's `Referer`, so hotlink protection still blocks direct/off-site access.
- **Rate limiting** guards the video list, upload, and share-creation endpoints (fails open if the limiter backend is unavailable).
- **Idle sign-out** logs users out after 30 minutes of inactivity.
- **Geo location whitelist is optional and off by default.** When an admin turns it on, it's an additional gate on top of email identity, not a replacement for it — and admins are gated by their *own* separate whitelist/toggle (`ADMIN_GEO_WHITELIST`), not an automatic bypass. See "Geo location whitelist" above for the lockout-recovery path.
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
