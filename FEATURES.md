# Marine Video Portal — Features

Current as of **v1.7.0**. Grouped by area; items marked _(admin)_ live in the `/admin` panel.

## Authentication & access control
- Login required for every page via Auth0.
- Two-tier access: **admins** (fixed `ADMIN_EMAILS` list) and **approved viewers** (managed live by admins, no redeploy needed).
- Logged-in users who aren't approved see a clear "not approved" message instead of any video data.
- **Server-side admin gate** — `/admin` checks the session + admin email in `getServerSideProps` and redirects non-admins before any admin UI is sent; every `/api/admin/*` route also independently returns `403`.
- Centralized admin-check logic in one shared helper (`lib/auth.js`).
- **Auto sign-out after 30 minutes of inactivity** (protects a portal left open on a shared machine).
- **API rate limiting** (sliding window) on the video list, upload, and share-creation endpoints; fails open so an infrastructure hiccup never blocks real users.
- Auth0 sign-ups can be disabled tenant-wide so strangers can't self-register. (Access is by email identity, so this is the primary guard against self-registering as an approved/admin address.)

## Homepage & viewer experience
- **Modern dark design** — glassmorphism, gradient accents, Inter typography.
- **Admin-adjustable color palette** _(admin)_ — 7 presets plus custom hex colors, applied to **all** visitors; cached client-side with a no-flash pre-paint script so returning visitors never see a color flicker.
- **Video thumbnails** — the homepage upgrades to a responsive **thumbnail grid** (16:9 cards with a play overlay) when thumbnails are configured, and falls back to a clean title list otherwise. The admin library shows thumbnails too. Thumbnail URLs are **CDN token-signed** so they work with "Block Direct URL File Access" enabled.
- **Search** — viewers can search the whole library by title (debounced).
- **Collections / categories** — filter the homepage by collection via chips.
- **Resume playback & Continue-watching** — videos remember where each viewer left off (via player.js); the homepage shows a Continue-watching strip with progress bars. Degrades gracefully if the player protocol is unavailable.
- **Admin-adjustable video count** _(admin)_ — hard cap enforced in code (bunny.net's API doesn't honor it as a strict limit).
- **Custom ordering** _(admin)_ — drag-to-reorder; newly uploaded videos float to the top (newest first) until placed.
- **Pagination** — 10 per page with Previous/Next.
- Autoplay disabled on all embedded players.

## Video playback & security
- Every play uses a **signed, time-limited bunny.net embed token**, generated fresh per request — never a permanent or public URL.
- Direct bunny.net CDN file URLs are never used or exposed by the app.
- Thumbnail requests carry the site's `Referer`, so hotlink protection blocks direct/off-site access while the app still works.

## Video management _(admin)_
- **Upload directly from the browser to bunny.net** — TUS resumable upload with a progress bar, **drag-and-drop**, and **cancel/retry** for in-progress uploads (a cancelled upload cleans up its half-created video). The Bunny API key never reaches the client.
- **Encoding status** — per-video "Processing %" / "Failed" badges, auto-refreshing while anything is encoding.
- **Rename** videos inline.
- **Delete** videos (removes from bunny.net and prunes them from the saved order).
- **Drag-to-reorder** the library.
- **Search/filter** the library.
- **Collections** — create/delete collections and assign each video to one.

## Private share links (per-recipient sharing) _(admin)_
- Generate a one-off private link for any video, tied to a specific recipient email.
- **Forced login** — opening the link requires an Auth0 login and only plays if the logged-in email matches the one specified.
- Wrong-account attempts show a generic mismatch message — **the intended recipient's email is never revealed**.
- **Adjustable expiry** per link (default 72 hours, capped at 720 / 30 days).
- **Viewed status** — each active link shows whether the recipient has opened it yet (stamped on first play, preserving remaining TTL).
- **Active link visibility** — every live link with recipient and exact expiry.
- **Instant revocation** — kill any active link immediately, one click.
- Expired/revoked links show a clean "expired or doesn't exist" message.

## People & oversight _(admin)_
- **Approved viewer management** — add/remove emails, with **bulk add** (paste comma/space/newline-separated lists; validated + deduped).
- **Viewer last-seen** — each viewer's most recent activity time.
- **Activity / audit log** — the most recent admin actions (viewer add/remove, share create/revoke, video rename/delete, collection create/delete, settings, palette), each with actor and time. Logging is best-effort so it never breaks the underlying action.
- **Analytics dashboard** — total views, 30-day views, watch time, video count, a 30-day views bar chart, and a most-watched list (from bunny.net video stats + the statistics API).
- **Content-protection panel** — explains the tokenized-playback model and the bunny.net "Block Direct URL File Access" setting.

## Admin panel structure _(admin)_
- **Tabbed layout** — Videos, Viewers, Shares, Settings, Activity, Analytics — so admins jump straight to a section instead of one long scroll. Live count badges on Viewers/Shares.
- All admin API routes return `403` for non-admins rather than exposing any data.

## Installable app (PWA)
- **Installable on desktop and mobile** — Windows, Mac, Android, and iOS can install the portal as a standalone app (web manifest + app icon + service worker). No separate build or app store; it runs off the same Vercel deployment.
- **Login works unchanged** — the installed app is the same site, so Auth0 sign-in behaves exactly as in the browser.
- **Viewer-only when installed** — the Admin button is hidden in standalone (installed) mode; admin stays fully available in a normal browser tab.
- Ships PNG app icons (192/512, maskable, plus a 180px Apple touch icon) so home-screen/taskbar icons render cleanly on every platform including iOS.
- The service worker caches only public static assets (app icons + manifest) — never API responses, authed pages, or video — so nothing private or stale is ever served.

## Push notifications
- **New-video announcements** — approved viewers who opt in with a **"Notify me"** button get a Web Push notification when a newly uploaded video finishes encoding. Each video is announced **exactly once** (an atomic Redis `SADD` guard), and only recently uploaded videos are announced, so enabling the feature never back-blasts the existing library.
- **Manual broadcasts** _(admin)_ — send a custom push message to everyone from the Settings tab.
- **Targeted & self-cleaning** — sends reach only **currently-approved** viewers and admins (a removed viewer stops receiving them even if their device subscription lingers); dead subscriptions (HTTP 404/410 from the push service) are pruned automatically.
- **Viewer-controlled** — the button toggles notifications on/off per device; unsubscribing is always allowed. Clicking a notification opens the relevant video.
- **Inert until configured** — the whole feature (button, broadcast form, sends) stays hidden and silent unless `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` are set, so it never breaks a deployment that doesn't use it.

## Platform, quality & observability
- Hosted on Vercel; dependencies install automatically during deploy (no local Node/npm required to ship).
- Settings, viewers, order, collections, share records, watch history, push subscriptions, and the audit log are stored in Upstash Redis (via Vercel Storage), editable live from `/admin` without redeploying. All keys are namespaced with a `pvp:` prefix.
- **Opt-in Sentry error monitoring** — client/server/edge configs; inert until `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` are set.
- **CI pipeline** — GitHub Actions runs lint + tests + build on every push/PR to `main`, catching breakage before Vercel deploys.
- **Smoke tests** — Vitest coverage for the auth check, video-ordering logic, theme helpers, and push logic.

## Configuration knobs (environment)
- `BUNNY_CDN_HOSTNAME` — enables thumbnails.
- `BUNNY_CDN_TOKEN_KEY` — signs thumbnail URLs when the pull-zone token key differs from the embed key.
- `SENTRY_*` — enable error monitoring and source-map upload.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — enable push notifications (both required; generate with `npx web-push generate-vapid-keys`). `VAPID_SUBJECT` optionally overrides the contact URI.

## Known gaps / not yet implemented
- **Automatic email delivery of share links** (admin still copies the link and sends it manually).
- **Access-request flow** — no self-serve way for unapproved users to request access; admins must know who to add.
- **`email_verified` enforcement** — access checks trust the email claim; pair with Auth0 sign-up controls (see Security notes in the README).
- **In-app admin management** — admins are configured via `ADMIN_EMAILS`, not the UI.
- **Captions/transcripts, comments/ratings, scheduled publish/expiry** — not implemented.
