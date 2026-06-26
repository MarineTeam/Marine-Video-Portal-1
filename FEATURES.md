# Private Video Portal — Features

## Authentication & access control
- Login required for every page via Auth0.
- Two-tier access: **admins** (fixed email list via `ADMIN_EMAILS`) and **approved viewers** (managed live by admins, no redeploy needed).
- Logged-in users who aren't approved viewers see a clear "not approved" message instead of any video data.
- Centralized admin-check logic in a single shared helper (`lib/auth.js`) — used by every protected route, so there's one place to update if the rule ever changes.
- Auth0 sign-ups can be disabled tenant-wide (via Auth0's Database connection settings) so random strangers can't create their own account and reach the "not approved" screen at all.

## Homepage
- Shows a list of video titles (not embedded players) — clicking a title opens a dedicated watch page.
- **Admin-adjustable video count** — admin sets exactly how many videos are visible in total; enforced as a hard cap in code (not just requested from bunny.net, since bunny's API doesn't reliably honor it as a strict limit).
- **Admin-controlled custom ordering** — videos appear in whatever order the admin sets (↑/↓ controls in `/admin`), not just bunny's upload-date order, since bunny.net has no native reordering feature.
- **Pagination** — 10 videos per page, with Previous/Next controls, once the visible count exceeds 10.
- Autoplay disabled on all embedded video players.

## Video playback & security
- Every video play uses a **signed, time-limited bunny.net embed token**, generated fresh per request — never a permanent or public URL.
- Direct bunny.net CDN file URLs (`*.b-cdn.net/.../playlist.m3u8`, `play_720p.mp4`, etc.) are never used or exposed by the app. (Documented separately: these are public by default unless bunny's own "Block Direct URL File Access" setting is enabled — unrelated to anything this app does, but worth knowing.)

## Private share links (per-recipient sharing)
- Admin can generate a one-off private link for any video, tied to a specific recipient's email address.
- **Forced login required** — opening the link requires an Auth0 login, and the video only plays if the logged-in email matches the one the admin specified when creating the link.
- Wrong-account attempts show a generic mismatch message — **the intended recipient's email is never revealed** in that error, to prevent leaking it to someone who guesses or forwards the link.
- **Adjustable expiry per link** — admin sets hours until expiry when creating it (defaults to 72, capped at 720 / 30 days).
- **Active link visibility** — admin panel lists every currently live share link with its recipient and exact expiry time.
- **Instant revocation** — admin can kill any active link immediately, before its natural expiry, with one click.
- Expired or revoked links show a clean "expired or doesn't exist" message rather than erroring.

## Admin panel (`/admin`)
- Homepage video count setting.
- Approved viewer management (add/remove emails).
- Video library list with reorder controls and per-video share-link creation.
- Active share link list with revoke buttons.
- All admin API routes return 403 for non-admin accounts rather than exposing any data.

## Infrastructure
- Hosted entirely on Vercel; dependencies installed automatically during deploy (no local Node/npm setup required).
- Settings, approved-viewer list, video order, and share-link records are all stored in a Redis database (Upstash, connected via Vercel Storage) — editable live from `/admin` without redeploying.
- Usage stays well within typical free-tier database command limits at moderate traffic (~1,000 visits/day ≈ 150,000 Redis commands/month against a 500,000 ceiling); notes included on migrating low-write settings data to Vercel Edge Config if traffic grows substantially (10,000+ daily visits).

## Not yet implemented
- Automatic email delivery of share links (admin currently copies the generated link and sends it manually).
- Bulk actions (e.g. approving/removing multiple viewers at once, bulk re-sharing).
- Visibility into *who has requested access but hasn't been approved yet* (currently admins must already know who to approve).
