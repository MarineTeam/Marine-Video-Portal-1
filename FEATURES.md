# Marine Video Portal — Features

Current as of **v1.17.1**. Grouped by area; items marked _(admin)_ live in the `/admin` panel.

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
- **Watch history ("Activity" page)** — a viewer can see their own full watch history (title, furthest position, last-watched time), reusing the same progress data behind Continue-watching — no new tracking added. Admins get an extra lookup dropdown to view any approved viewer's history by email.
- **Admin-adjustable video count** _(admin)_ — hard cap enforced in code (bunny.net's API doesn't honor it as a strict limit).
- **Custom ordering** _(admin)_ — drag-to-reorder; newly uploaded videos float to the top (newest first) until placed.
- **Pagination** — 10 per page with Previous/Next.
- Autoplay disabled on all embedded players.
- **Picture-in-Picture** — the embed player's own PiP control is enabled on every watch page (video-watch, share-link, and bundle-member pages), so a viewer can pop the video into a floating window and keep it playing while using other tabs/apps.

## Video playback & security
- Every play uses a **signed, time-limited bunny.net embed token**, generated fresh per request — never a permanent or public URL.
- Direct bunny.net CDN file URLs are never used or exposed by the app.
- Thumbnail requests carry the site's `Referer`, so hotlink protection blocks direct/off-site access while the app still works.
- **Watermark overlay** — playback can show the viewer's own email as a faint, tiled overlay on the player, a deterrent against screen-recording/redistribution. Layered control: an **exemption** (per-viewer) always wins; below that, a **per-share** setting beats a **per-video** setting, which beats a **global default** _(admin, Settings tab)_. Purely visual — never blocks playback, and it's simply absent wherever nothing applies.
- **Geo location whitelist** — restricts video access by country, detected from Vercel's edge network (no external API, no middleware). Two independent lists: `GEO_WHITELIST` for viewers, `ADMIN_GEO_WHITELIST` for admins — each has its own live on/off toggle _(admin, Settings tab)_, both **off by default**. The country lists themselves are env-configured (deploy-time) and shown read-only in the panel. `ADMIN_GEO_BYPASS_EMAILS` lets specific admins skip the admin check entirely regardless of country — a standing safety net an admin arms before traveling, since env var changes need a redeploy to take effect. A country that can't be determined (local dev, non-Vercel hosts) is never blocked.

## Video management _(admin)_
- **Upload directly from the browser to bunny.net** — TUS resumable upload with a progress bar, **drag-and-drop**, and **cancel/retry** for in-progress uploads (a cancelled upload cleans up its half-created video). The Bunny API key never reaches the client.
- **Encoding status** — per-video "Processing %" / "Failed" badges, auto-refreshing while anything is encoding.
- **Rename** videos inline.
- **Delete** videos (removes from bunny.net and prunes them from the saved order).
- **Drag-to-reorder** the library.
- **Search/filter** the library.
- **Collections** — create/delete collections and assign each video to one.
- **Bulk operations** — select multiple videos to **delete** or **assign to a collection** at once, mirroring the bulk-share UX, with per-item success/failure reporting.

## Private share links (per-recipient sharing) _(admin)_
- **Private list** — a persistent, editable per-video access list (YouTube/Drive-style "share with specific people"), layered on the same share records as Create Link/Bulk Share rather than a separate system. Every share the list creates is tagged as its own, so the list only ever knows about and acts on tokens it created itself — a separate Create Link/Bulk Share to the same video/email is invisible to it. Adding emails only creates a share (and, unless the on-by-default **"Notify new people by email"** checkbox is unchecked, sends the notification) for the ones not already active *on that list*; emails already listed are left untouched — no duplicate share, no re-sent email. Removing an email revokes only the list's own share for that video, immediately — any other active share to that video/email (from another flow) is unaffected, and other videos' lists are untouched too; re-adding that email later is a fresh invite. A viewer-**tag** picker ("Add viewers tagged…") adds everyone carrying a given tag to the list in one click, same as Bulk Share.
- **Create link** — generate a private link for any video, targeting **any number of recipient emails at once** (comma/space/newline-separated), each getting their own **independently revocable** link. A viewer-**tag** picker adds everyone carrying a given tag to the recipient list in one click.
- **Bulk share** — select any number of videos and any number of recipients at once; every (video, recipient) pair gets its own **independently revocable** link. Each recipient is emailed **once**, listing only their own links, never anyone else's. A **"Share collection…"** picker checks every video in a chosen collection into the picklist in one click; a viewer-**tag** picker does the same for the recipient list. Both only pre-populate the existing picklists — link creation runs exactly the same either way.
- **Forced login** — opening a link requires an Auth0 login and only plays if the logged-in email matches the one specified.
- Wrong-account attempts show a generic mismatch message — **the intended recipient's email is never revealed**.
- **Adjustable expiry** per link (default 72 hours, capped at 720 / 30 days).
- **Extend** — push a link's expiry out in place (same link, no re-share, no re-notification), singly or in bulk across selected links. Works even on a link that's lapsed but wasn't revoked (extends from now); a revoked link can't be resurrected this way. Extending a bundled link also extends its bundle's expiry.
- **Bundles ("same email, same place")** — once a recipient has 2+ active links (from one action or accumulated over several), they're grouped into one **bundle**: a single listing page gated by the same login + email-match check, showing everything currently shared with them. The bundle is a pure grouping of link IDs — never a cached copy of a link's title or status — so revoking, expiring, or extending one member is reflected on the bundle page instantly. A recipient's first-ever link still gets a simple email; every notification after that is one consolidated bundle email instead of a new standalone one. Links shared before bundling existed are swept into a recipient's first bundle automatically.
- **Email delivery** _(opt-in)_ — the share form emails links straight to recipients via [Resend](https://resend.com) (single-link or the consolidated bundle email, as applicable), so the admin no longer has to copy-and-send by hand. Best-effort: a mail failure never blocks link creation.
- **Resend** — each active link has a "Resend email" button that re-delivers its current notification (single link or bundle) to the original recipient; also available in **bulk** across selected links, rate-limited like link creation.
- **Inert until configured** — email-related buttons/checkboxes stay hidden unless `RESEND_API_KEY` is set; without it, sharing works exactly as before (copy the link manually).
- **View tracking** — each active link records a **view count and last-viewed time**, updated on every page load (not just the first).
- **Real playback tracking** — the Bunny embed's player.js events report **plays**, **furthest % watched**, and **completion** back to the link, so you can tell who actually watched versus who just opened the page.
- **Active link visibility** — every live link with recipient, **creation date**, exact expiry, view/playback stats, and whether it's **part of a bundle** or came in **via Private list**.
- **Persistent bundle-link button** — any share row that's part of a bundle shows a durable "Copy bundle link" button, not just a one-time link surfaced in the bulk-share success toast.
- **Revocation is soft by default** — revoking a link sets it aside (same shareId/token) rather than deleting it outright, one click or in **bulk** across selected links.
- **Un-revoke** — restore a revoked link in place, singly or in bulk, with no new link and no re-notification needed.
- **Delete permanently** — a separate, deliberate action (singly or in bulk) that actually removes a link's record for good. Only allowed on a link that's already revoked, so it's always a second step, never a shortcut around revoke on a link that's still live.
- Expired/revoked links show a clean "expired or doesn't exist" message.

## People & oversight _(admin)_
- **Approved viewer management** — add/remove emails, with **bulk add** (paste comma/space/newline-separated lists; validated + deduped).
- **Viewer tags** — label approved viewers (e.g. "Team A") from the Viewers tab; Bulk Share can add everyone carrying a given tag to the recipient list in one click instead of pasting emails. Tags are capped at 20 per viewer / 40 characters each and are cleaned up when a viewer is removed.
- **Viewer last-seen** — each viewer's most recent activity time.
- **Activity / audit log** — the most recent admin actions (viewer add/remove, share create/revoke, video rename/delete, collection create/delete, settings, palette), each with actor and time. Logging is best-effort so it never breaks the underlying action.
- **Analytics dashboard** — total views, 30-day views, watch time, video count, a 30-day views bar chart, and a most-watched list (from bunny.net video stats + the statistics API).
- **Per-video analytics** — rolls up each video's existing share data: shares created, unique recipients, views, started, completed and completion rate, and average furthest progress. Reads only fields already tracked per share — adds no new tracking. Shown both as a collapsible panel per video (Videos tab) and as one combined list, sorted by shares, in the Analytics tab.
- **Content-protection panel** — explains the tokenized-playback model and the bunny.net "Block Direct URL File Access" setting.
- **Maintenance / stale-data cleanup** _(admin, Settings tab)_ — one-click sweep that removes share **bundles** whose links have all expired or been revoked, stale `active_shares` references, and orphaned watch-history records left behind by removed viewers. Reports how many of each were removed; a no-op run says so.

## Admin panel structure _(admin)_
- **Tabbed layout** — Videos, Viewers, Shares, Settings, Activity, Analytics — so admins jump straight to a section instead of one long scroll. Live count badges on Viewers/Shares.
- All admin API routes return `403` for non-admins rather than exposing any data.

## Installable app (PWA)
- **Installable on desktop and mobile** — Windows, Mac, Android, and iOS can install the portal as a standalone app (web manifest + app icon + service worker). No separate build or app store; it runs off the same Vercel deployment.
- **Login works unchanged** — the installed app is the same site, so Auth0 sign-in behaves exactly as in the browser.
- **Full admin in the installed app** — admin accounts see the Admin button and can manage everything from the installed (standalone) app, exactly as in a normal browser tab. (Admin access is still gated server-side, so nothing sensitive is exposed to non-admins either way.)
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
- `RESEND_API_KEY` — enable emailing/resending share links via Resend. `MAIL_FROM` optionally sets the from address (a Resend-verified sender; defaults to `onboarding@resend.dev`).
- `GEO_WHITELIST` — comma-separated ISO country codes allowed for viewers when the viewer geo toggle is on _(admin, Settings tab)_; the toggle itself defaults to off.
- `ADMIN_GEO_WHITELIST` — same, but for admins, with its own separate toggle (also off by default).
- `ADMIN_GEO_BYPASS_EMAILS` — comma-separated admin emails that always skip the admin geo check regardless of country; arm this before travel, since env var changes need a redeploy.

## Known gaps / not yet implemented
- **Access-request flow** — no self-serve way for unapproved users to request access; admins must know who to add.
- **`email_verified` enforcement** — access checks trust the email claim; pair with Auth0 sign-up controls (see Security notes in the README).
- **In-app admin management** — admins are configured via `ADMIN_EMAILS`, not the UI.
- **Captions/transcripts, comments/ratings, scheduled publish/expiry** — not implemented.
