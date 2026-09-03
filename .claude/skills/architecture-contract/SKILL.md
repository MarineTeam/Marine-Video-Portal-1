---
name: architecture-contract
description: The load-bearing design decisions, invariants, and known-weak points of the Marine Video Portal. Load this BEFORE designing any change, adding a route, page, dependency, or middleware, refactoring auth/Redis/signing code, responding to a security scanner finding, or questioning why something is built the way it is — it explains what each decision protects and exactly what breaks if you violate it.
---

# Architecture Contract — Marine Video Portal

This skill is the contract between you and the people who built this system. Every decision below is load-bearing: it was made for a reason, it has already survived at least one incident or security review, and violating it breaks something specific. Read the decision, the rationale, and the failure mode before touching related code.

The app: a private, invite-only video portal. Next.js 14 **Pages Router** + React 18, deployed on Vercel from GitHub `main` (MarineTeam/Marine-Video-Portal-1), bunny.net Stream for video, Auth0 for login (`@auth0/nextjs-auth0` v3), Upstash Redis as the only mutable store. Repo root: `C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1`.

## When NOT to use this skill

- **Pure styling or copy changes** — editing `styles/globals.css` colors, component layout, or UI text touches no invariant here (but if you touch the theme *system* — `lib/theme.js`, `pages/api/theme.js`, `pages/_document.js` — come back, see Decision 11).
- **You need the exact Bunny signing formula bytes or TUS header names** — use the sibling skill `bunny-reference`; this skill tells you the formulas are frozen and why, not how to re-derive them.
- **You need the Redis key or env-var dictionary** — use `config-and-data`.
- **You want the process gates for making a risky change** (review checklist, deploy sequencing) — use `change-control`.
- **You want the incident history behind an invariant** — use `failure-archaeology`.
- **You are remediating a listed weak point** — use `security-currency-campaign`; section C below only states the weak points, not the remediation plan.

---

## A. Load-bearing decisions

### 1. Pages Router, deliberately NOT App Router

**Decision.** The entire app is Pages Router (`pages/`, `getServerSideProps`, `pages/api/*`). There is no `app/` directory and no `middleware.js` (as of 2026-07-10).

**Why.** The project was born as a browser-only build — see `bunny-vercel-auth0-guide.md`, the founding doc, literally titled "Browser-Only Build": no local tooling, code written in the GitHub web editor, Vercel does the installs. Pages Router was the simple, well-trodden path. That accident became a security posture: many Next.js CVEs target the App Router (RSC payloads), middleware, or i18n routing — surface this app does not have. **14 Dependabot alerts are deferred on exactly this reachability analysis** (session record, 2026-07-10, maintainer-confirmed; `security-currency-campaign` owns the live count — re-verify there rather than trusting this number after any Next upgrade).

**What breaks if violated.** Adding a `middleware.js` file or an `app/` directory — even an empty or "harmless" one — silently activates those code paths in the Next.js runtime, expands the attack surface, and invalidates the deferral rationale for all 14 alerts at once. Nobody will notice until the next audit. Do not add either casually; if you genuinely need them, treat it as a security decision requiring re-triage of every deferred alert (see `change-control`).

### 2. Access model = email string matching, and email_verified is NEVER checked

**Decision.** Four tiers, all keyed on lowercase email strings (roles and groups added 2026-08-30 — see Decision 13; before that there were two tiers plus shares, and `lib/auth.js`'s `isAdmin` was the only admin check):

| Tier | Source of truth | Check | Where |
|---|---|---|---|
| Admin | `ADMIN_EMAILS` env var (the always-wins floor) OR Redis set `pvp:role_admins` | `getRole(email) === 'admin'` | `lib/roles.js` — the ONLY place that decides what a caller may do |
| Manager | Redis set `pvp:role_managers` | `getRole(email) === 'manager'` | `lib/roles.js` |
| Approved viewer | Redis set `pvp:approved_viewers`, narrowed by group grants | `redis.sismember(k('approved_viewers'), email)` then `resolveAccess(email)` | `pages/api/videos.js`, `pages/api/collections.js`, `pages/api/progress.js`, `pages/watch/video/[id].js` |
| Share recipient | Share record in Redis (`share:{id}`) | exact match `share.email !== session.user.email.toLowerCase()` | `pages/watch/[shareId].js` |

`lib/auth.js`'s `isAdmin(email)` still exists and still means exactly one thing — "is this email in `ADMIN_EMAILS`". It is the floor primitive `lib/roles.js` consumes, not a second admin check. Nothing outside `lib/roles.js` should call it.

**Amended 2026-08-31 (Decision 14).** The "`email_verified` is NEVER checked" invariant below is superseded: it may now be enforced, but only through the opt-in, staff-exempt, fail-open mechanism in `lib/verification.js`. The underlying fact that produced the original invariant is unchanged — this tenant has no mail server, so the claim is `false` for effectively every account, and enabling enforcement without reading the blast-radius panel first will lock out every viewer it counts.

**Why.** The portal is invite-only for a small known audience; email strings the admin typed are the natural identity. **INVARIANT: `email_verified` is never checked anywhere.** The Auth0 tenant has no mail server, so `email_verified` is `false` for every account; enforcing it locks out everyone including admins (session record, 2026-07-10, maintainer-confirmed). The self-registration risk this leaves open (anyone could sign up claiming any email) is mitigated one layer up: **Auth0 sign-ups are disabled** at the tenant (tenant setting, documented in `README.md`).

**What breaks if violated.** Add an `email_verified` check → total lockout, every user, immediately. Add a second admin-check mechanism → the two drift and one becomes a bypass. Re-enable Auth0 sign-ups without adding email verification infrastructure → anyone can mint an account for an email on a share link.

### 3. Defense in depth on /admin: server gate PLUS per-route 403s

**Decision.** Two independent layers, both mandatory:

1. `getServerSideProps` in `pages/admin.js` — no session → redirect to login; session but not admin or manager → redirect to `/`. A plain viewer never receives the admin UI shell HTML/JS.
2. Every one of the 18 routes in `pages/api/admin/*` (as of 2026-08-30) independently calls `requireCapability(req, res, '<capability>')` and returns 403 `Forbidden`. Hiding a tab or section from a manager in the UI is presentation only — the route behind it re-checks.

**Why.** Either layer alone has a known failure mode: client-only gating ships the admin bundle to attackers and trusts the browser; API-only gating means a future refactor of the page could leak admin data through props. The API layer is the real security boundary; the page gate stops UI enumeration.

**What breaks if violated.** Remove the page gate → logged-in non-admins load the full admin interface and probe every endpoint. Remove or forget a per-route check → that route is open to any logged-in user, because nothing else protects `pages/api/*`. Any refactor of `pages/admin.js` or any new file in `pages/api/admin/` must preserve BOTH layers.

### 4. Three exact signing formulas in lib/bunny.js — vendor contracts, frozen

**Decision.** `lib/bunny.js` implements three token formulas. They are byte-exact contracts with bunny.net. Never alter the algorithm, input concatenation order, output encoding, or time unit:

| Purpose | Formula | Encoding | Notes |
|---|---|---|---|
| TUS upload auth (`signTusUpload`) | `SHA256(libraryId + apiKey + expires + videoId)` | hex | `expires` = Unix timestamp in **SECONDS** |
| Embed view token (`signVideoToken` / `getEmbedUrl`) | `SHA256(BUNNY_TOKEN_AUTH_KEY + videoId + expires)` | hex | appended to `iframe.mediadelivery.net` embed URLs |
| Thumbnail CDN token (`getThumbnailUrl`) | `SHA256(key + path + expires)` | base64url (`+`→`-`, `/`→`_`, `=` stripped) | key = `BUNNY_CDN_TOKEN_KEY`, falling back to `BUNNY_TOKEN_AUTH_KEY` |

**Why.** These are bunny.net's URL Token Authentication and TUS presigning schemes — the server on the other end recomputes the exact same hash. Two hard-won details are baked in: (a) the TUS presigner and the thumbnail-CDN signer `.trim()` their env values, because a stray newline in a Vercel env var is silently dropped from the `AccessKey` HTTP header (so plain API calls keep working) but corrupts the SHA256 input → TUS returns 401 with no useful error. (The embed-view-token signer `signVideoToken` does not trim `BUNNY_TOKEN_AUTH_KEY`, and does not need to.) That was the TUS 401 saga, fixed in commit `8e81183` ("Fix TUS upload 401: revert to seconds expiry, trim env values"). (b) TUS expiry is seconds, not milliseconds — same commit.

**CodeQL false positive on record.** CodeQL flags these as "use of a broken or weak cryptographic hashing algorithm on passwords." They are not password hashes; they are vendor-mandated URL token formats. The finding is dismissed with rationale on record — do not "fix" them with bcrypt/HMAC-SHA512/etc., which breaks the vendor contract outright.

**What breaks if violated.** Any deviation — reordered concatenation, milliseconds, un-trimmed input, different digest or encoding — produces tokens Bunny rejects: uploads 401, videos won't play, thumbnails 403. Failures are silent and total.

### 5. Uploads go browser → Bunny directly via TUS

**Decision.** Video bytes never pass through this app's servers. `pages/api/admin/upload.js` only (a) creates the empty video record via `createVideo()` and (b) returns a signed TUS authorization (`signTusUpload`). The browser (`pages/admin.js`, dynamic-importing `tus-js-client`) then streams the file to `https://video.bunnycdn.com/tusupload` with headers `AuthorizationSignature`, `AuthorizationExpire`, `VideoId`, `LibraryId`.

**Why.** Vercel serverless function bodies cap at ~4.5MB — proxying video uploads is impossible on this platform. The presigning split also keeps `BUNNY_API_KEY` server-side forever: the browser only ever sees a time-limited signature scoped to one videoId.

**What breaks if violated.** Route uploads through an API route → hard failure on any real video file (body too large). Send the API key to the browser to "simplify" → full library takeover by any admin-page visitor (and the key is in every browser devtools trace).

### 6. Redis is the single mutable store; every key goes through k()

**Decision.** All mutable state (viewers, shares, order, theme, progress, audit, settings, rate-limit counters) lives in one Upstash Redis, and every key is built with `k(key)` from `lib/redis.js`, which applies the `pvp:` prefix. The rate limiter passes `prefix: k('rl')` for the same reason (`lib/ratelimit.js`).

**Why.** One prefix namespaces the app inside a possibly-shared Redis and makes every key greppable/migratable as a unit. Raw-key access is a bug by definition: it either misses existing data (reads) or creates orphan keys outside the namespace (writes).

**What breaks if violated.** A raw `redis.get('approved_viewers')` silently reads an empty/wrong key → viewers appear unapproved; raw writes create data no other code can find. Both fail without errors.

### 7. Video ordering: unordered videos float to the TOP, newest first

**Decision.** `applyOrder(videos, order)` in `lib/order.js`: videos present in the admin's saved order appear in that order; videos ABSENT from the saved order (i.e. newly uploaded) go on top, sorted newest-first, ahead of the saved order.

**Why.** New uploads must be visible immediately without the admin re-dragging the list — invisible-until-curated uploads read as "upload failed."

**What breaks if violated.** Flip it to append-at-bottom and new uploads vanish below the fold or below the homepage cap (Decision 8); the admin thinks Bunny lost the file. Verify any change against `lib/__tests__/order.test.js`, which pins this behavior.

### 8. Homepage video count is a DISPLAY cap, not access control

**Decision.** `pages/api/videos.js` slices the default (unfiltered) list to `pvp:homepage_video_count` (default 2, as of 2026-07-10). Search (`?q=`) and collection filters look across the whole library. And any approved viewer can watch ANY video by GUID via `/watch/video/[id]` (`pages/watch/video/[id].js`) — its gate is approved-viewer-or-admin, nothing per-video.

**Why — stated plainly as intended behavior.** The cap is presentation (a tidy homepage), not a security boundary. Do not "harden" the watch page to only allow videos currently on the homepage — that is not the model, and it would break search results, resume-watching links, and share flows.

**Amended 2026-08-30 (Decision 13).** Access is no longer strictly binary: an approved viewer placed in a group sees only what their groups grant, and `/watch/video/[id]` enforces that. The rest of this decision stands unchanged — the homepage cap is still presentation, group gating is a separate axis from it, and a viewer in no group still sees the whole library. The original binary model is exactly what an ungrouped viewer still gets.

**What breaks if violated.** Treating the cap as access control creates a false sense of restriction (the GUIDs are enumerable via search anyway) and breaks legitimate deep links.

### 9. Rate limiter FAILS OPEN by design

**Decision.** `allow()` in `lib/ratelimit.js` wraps `limiter.limit()` in try/catch and **returns `true` on any error**. Sliding window: 60 requests / 10 s per `bucket:caller` (as of 2026-07-10). Applied to exactly three routes as of 2026-07-10: `pages/api/videos.js`, `pages/api/admin/upload.js`, `pages/api/admin/share.js`.

**Why.** Availability over strictness: the limiter's backend is the same Redis as everything else, and a Redis hiccup must never lock real users out of a portal whose whole job is playing videos. The limiter blunts abuse; it is not a security control.

**What breaks if violated.** Make it fail closed and the next Upstash blip takes the whole site down for everyone — the exact outage mode this design precludes.

### 10. Resilience-by-degradation: optional features must never break their host

**Decision.** Three features are explicitly best-effort:
- **Resume playback** (`components/ResumablePlayer.js`): `player.js` is dynamic-imported in try/catch; if the library fails to load, the constructor isn't found, or the progress fetch fails, the function returns early and **the video still plays** in a plain iframe. Progress saves at most every 8 s and its `fetch` swallows errors.
- **Audit logging** (`lib/audit.js`): `logAudit()` never throws — the write is try/catch-swallowed. The log is a capped Redis list (`lpush` + `ltrim` to 200 entries, as of 2026-07-10), so it cannot grow unbounded.
- **Push auto-announce** (`lib/push.js` `maybeAnnounceReady`, added v1.7.0): called from `GET /api/admin/videos` inside a try/catch — a push-send or Redis failure must never break the admin video listing. The whole push feature is also **inert unless both VAPID keys are set** (`pushEnabled()`), the same opt-in/inert posture as Sentry (Decision 12): no keys → button hidden, routes 503, no sends, nothing throws.

**Why.** Playback and admin actions are the product; resume-position and audit trails are conveniences. A broken convenience must degrade to absence, not take the core feature down with it.

**What breaks if violated.** Let `logAudit` throw and a Redis blip starts failing every admin action it decorates. Make ResumablePlayer's setup errors fatal and a CDN hiccup on player.js blanks the player. Preserve the swallow-and-degrade shape in any refactor.

### 11. Theme system: public GET, admin POST, hex-validated everywhere, pre-paint script

**Decision.** The two-color palette lives in Redis (`pvp:theme`). `GET /api/theme` is **public** (no session check — `pages/api/theme.js`) so the login page is themed for logged-out visitors; `POST /api/theme` is admin-only and rejects anything that isn't `#rrggbb` (`isValidHex` in `lib/theme.js`). Clients cache the palette in `localStorage` (`mvp_theme`), and an inline script in `pages/_document.js` re-applies it before first paint. That script is the app's ONLY `dangerouslySetInnerHTML`, it is a static string (no interpolation), and it re-validates both values against `/^#[0-9a-fA-F]{6}$/` before touching the DOM.

**Why.** Public GET: the login page renders pre-auth, so the palette endpoint can't require auth. Pre-paint script: without it, returning visitors flash default colors. Hex validation at BOTH the write (API) and the read (inline script): localStorage is attacker-influenceable on a shared machine and Redis contents shouldn't be blindly trusted by a script injected into every page — validation is what makes the static `dangerouslySetInnerHTML` safe.

**What breaks if violated.** Auth-gate the GET → unstyled login page. Interpolate anything dynamic into the `_document.js` script or drop its hex check → you've built an XSS gadget into every page load. Skip validation on POST → stored values flow to inline styles portal-wide.

**Amended 2026-09-03.** `GET /api/theme` now also returns the admin-set portal name (`pvp:site_name`), and `POST` accepts it — the endpoint is already public and already fetched once per page load, so the name needed no second round-trip. Three properties are load-bearing:

- **The name is NOT in the pre-paint script.** `localStorage.mvp_theme` stays colors-only, so the inline script's input is still nothing but two hex-validated strings. The name rides its own key (`mvp_site_name`) and is rendered through React, which escapes it. Putting an admin-supplied free-text string into that script would turn the app's only `dangerouslySetInnerHTML` into an XSS gadget on every page load — the exact thing this decision exists to prevent.
- **The name is cleaned on write** (`cleanSiteName` in `lib/branding.js`: control characters stripped, whitespace collapsed, clamped to 40 chars), and blank always resolves back to the default so the portal can never be left unnamed.
- **GET now fails soft.** The palette read is wrapped and `getSiteName()` swallows its own errors, so an Upstash blip yields default colors and the default name instead of a 500 on the public endpoint that renders the login page. It previously 500ed; that was pre-existing, and inconsistent with the degradation posture in Decision 10.

`lib/branding.js` is pure and client-safe; `lib/brandingStore.js` holds the Redis access and is server-only — the same split as `lib/theme.js` vs the API route, and for the same client-bundle reason as Decision 13's note about `lib/roles.js`.

### 12. Sentry is opt-in/inert; CI builds on dummy env vars

**Decision.** `withSentryConfig` wraps the build in `next.config.js`, but runtime reporting is inert until `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` are set (`sentry.client.config.js`, `sentry.server.config.js`, `sentry.edge.config.js`), and source-map upload only happens when `SENTRY_AUTH_TOKEN`/org/project exist. CI (`.github/workflows/ci.yml`) builds with a block of **dummy** env values (`AUTH0_*`, `BUNNY_*`, `ADMIN_EMAILS`, `KV_REST_API_*`).

**Why.** The Redis client (`lib/redis.js`) and Auth0 SDK construct at module load — a Next.js build imports API routes, so a build with missing env vars throws before it compiles anything. CI only needs values that are *present and well-formed*, not valid; real values live in Vercel. Sentry stays wired but silent so enabling it later is one env var, not a code change.

**What breaks if violated.** Delete the CI env block → every CI build fails at module load. Add a new module-load-time client without adding its dummy var to `ci.yml` → same. Hardcode a DSN → error telemetry from every fork/preview goes somewhere it shouldn't.

### 13. Roles are capability-gated; groups narrow access and are opt-in

**Decision (2026-08-30, v1.19.0).** Two related additions:

- **Roles.** Three tiers — Admin, Manager, Viewer — resolved by `getRole()` in `lib/roles.js`. Admin and Manager grants live in Redis (`pvp:role_admins`, `pvp:role_managers`) so they can be handed out from the UI. `ADMIN_EMAILS` is an **always-wins floor**: `getRole` short-circuits on it, and `grantRole`/`revokeRole` refuse to demote one. Routes name a **capability** (`videos:manage`, `settings:manage`, `roles:manage`, …), never a role; the map is at the top of `lib/roles.js` and unknown names fail closed.
- **Groups.** A group is a named set of viewers plus grants (collection ids and video guids), stored in `pvp:groups` + `pvp:group_members:{id}` with a reverse index `pvp:user_groups:{email}`. `resolveAccess(email)` gates `pages/api/videos.js`, `pages/api/collections.js`, and `pages/watch/video/[id].js`.

**Why.**

- The env-var floor is the lockout-recovery path. If the Redis grants are emptied, corrupted, or mis-edited, an `ADMIN_EMAILS` address still gets in, and it can be fixed from the Vercel dashboard without a deploy. `getRole` also degrades to the env floor on a Redis error — that can only ever *remove* a grant, never invent one, so it cannot escalate anybody. This is the "never risk admin lockout" non-negotiable, made concrete.
- **Groups are opt-in: a viewer in NO group is unrestricted and sees the whole library.** That is what makes this feature deployable at all — it changes nothing for anyone until an admin deliberately places someone in a group. Group gating also runs strictly *after* the approved-viewer check, so it can only narrow what an already-approved viewer sees.
- `resolveAccess` fails **open** (to `UNRESTRICTED`) on a Redis error, the same posture as `lib/ratelimit.js` and for the same availability reason: an Upstash blip must not blank the library for legitimately approved viewers.
- Share links are deliberately untouched by groups. `/watch/[shareId]` carries its own per-recipient token, so an admin can still share one video with someone whose groups wouldn't show it. Groups gate the library; shares gate one video each.

**What breaks if violated.**

- Make an `ADMIN_EMAILS` admin demotable "for consistency" → you have removed the only recovery path from a bad grant edit.
- Flip groups to default-deny (no group = see nothing) without first granting every existing viewer a group → the library blanks for every viewer at once on deploy, and it looks exactly like an outage.
- Make `resolveAccess` fail closed → an Upstash hiccup empties everyone's library.
- Call `isAdmin` from `lib/auth.js` in a route instead of going through `lib/roles.js` → that route silently ignores every Redis-granted admin. (It fails closed, so it's a denial rather than a bypass — but it's still drift, and drift is what Decision 2 exists to prevent.)
- Reference a `lib/roles.js` export from the *component* body of `pages/admin.js` → `lib/redis.js` and Node's `async_hooks` get pulled into the client bundle and the build fails. Keep those imports inside `getServerSideProps` and pass booleans through props.

### 14. email_verified enforcement is opt-in, staff-exempt, and fails open

**Decision (2026-08-31).** `email_verified` MAY now be enforced, but only through `lib/verification.js`, which is built so that the 2026-07-10 near-lockout cannot recur. Four guards, all mandatory:

1. **Off by default**, stored in Redis (`pvp:require_email_verified`), toggled from the admin Settings tab. Shipping the code changes nothing.
2. **Staff are always exempt** — admins and managers are never subject to it, whatever the toggle says. This is the recovery path: an admin can always reach `/admin` and switch it back off.
3. **Env bypass list** `EMAIL_VERIFIED_BYPASS_EMAILS`, mirroring `ADMIN_GEO_BYPASS_EMAILS`.
4. **Fails open** — any error reading the flag admits the caller.

Plus a fifth, non-negotiable property: **absence of the claim is not failure.** Only an explicit `email_verified === false` blocks; a token that doesn't carry the field admits the caller.

The app also **passively records** the observed claim per account (`pvp:email_verified_seen`) without enforcing anything, and the Settings panel reports how many observed viewers enabling it would block, by name. The API refuses to enable enforcement without `confirm: true`.

**Why the reversal.** Decision 2's "never checked anywhere" was a *constraint of the tenant*, not a principle: no mail server means the claim is `false` for everyone, so blanket enforcement is an outage. The maintainer asked for the capability on 2026-08-31. The resolution is that the dangerous part was never the check — it was enforcing an unsatisfiable claim, invisibly, with no exemption for the person who would have to undo it. All three of those are now structurally impossible.

**What breaks if violated.** Remove the staff exemption → the first admin to sign in after the toggle is locked out of the only UI that can turn it off, exactly reproducing the 2026-07-10 scenario. Treat an absent claim as `false` → every account on a token without the field is blocked. Make it fail closed → a Redis blip locks out the portal. Enforce it on `/watch/[shareId]` → every share link breaks the moment the toggle goes on (share recipients are the population *least* likely to be verified); shares are deliberately out of scope.

### 15. Scheduled publish/expiry is additive; access requests never grant

**Decision (2026-08-31).** Two smaller additions sharing one shape:

- **Schedules** (`lib/schedule.js`, `pvp:video_schedule`): optional `publishAt`/`expiresAt` per video. A video with **no entry** behaves exactly as before. Both bounds are independently optional; clearing both deletes the entry rather than storing nulls. Staff bypass so they can preview an unpublished video. Enforced in `pages/api/videos.js` and `pages/watch/video/[id].js`.
- **Access requests** (`lib/accessRequests.js`, `pvp:access_requests`): a signed-in but unapproved user can ask for access. The module **never writes to `pvp:approved_viewers`** — only `pages/api/admin/access-requests.js` does, behind `viewers:manage`.

**Why.** Both follow Decision 13's opt-in rule for the same reason: a default that hides content or narrows access on deploy is indistinguishable from an outage. And keeping the grant in the capability-gated route means there is exactly one place in the codebase that can widen the approved set.

**What breaks if violated.** Make an absent schedule mean "not published" → the entire library disappears on deploy. Let `lib/accessRequests.js` add the viewer directly → a self-serve endpoint reachable by anyone who can sign in becomes a self-approval endpoint.

---

## B. Invariants checklist

Walk this list on every review that touches auth, API routes, Redis, or `lib/bunny.js`. Every line must hold:

- [ ] Every route in `pages/api/admin/*` calls `requireCapability` and 403s otherwise (18 routes, as of 2026-08-30). `lib/roles.js` is the only place that decides what a caller may do; `lib/auth.js`'s `isAdmin` is its `ADMIN_EMAILS` floor primitive and is called from nowhere else.
- [ ] `ADMIN_EMAILS` is still an always-wins floor: `getRole` short-circuits on it, and `grantRole`/`revokeRole` refuse to demote an env admin. `/api/admin/roles` still refuses any change leaving zero admins.
- [ ] Group gating still runs AFTER the approved-viewer check, and a viewer in no group still resolves to `UNRESTRICTED` (Decision 13 — flipping this to default-deny blanks the library for every viewer at once).
- [ ] `pages/admin.js` imports from `lib/roles.js` ONLY inside `getServerSideProps` (it reaches `lib/redis.js` → `async_hooks`; referencing an export in the component body pulls that into the client bundle and fails the build).
- [ ] `pages/admin.js` still has its `getServerSideProps` gate (redirect non-session → login, non-staff → `/`).
- [ ] Every Redis key goes through `k()` (`lib/redis.js`); no raw string keys anywhere, including limiter prefixes.
- [ ] No `middleware.js` file, no `app/` directory (Decision 1 — this is a security posture, not a style choice).
- [ ] The three signing formulas in `lib/bunny.js` are byte-exact per Decision 4; TUS expiry in Unix **seconds**; the TUS and thumbnail-CDN signers `.trim()` their env inputs (the embed-view-token signer `signVideoToken` does NOT trim — not a bug, don't "fix" it).
- [ ] `getEmbedUrl` output ends with `autoplay=false`.
- [ ] `GET /api/theme` is public; `POST /api/theme` is admin-only; all color values hex-validated on write AND in the `_document.js` pre-paint script.
- [ ] GUID validation (`GUID_RE.test(...)`) stays **INLINE** inside each mutating function in `lib/bunny.js` (`updateVideoTitle`, `deleteVideo`, `deleteCollection`, `setVideoCollection`). CodeQL's dataflow analysis only recognizes it as an SSRF sanitizer when inline — extracting it to a shared helper re-opens the findings (commit `eb4bcdd`).
- [ ] The share-mismatch error in `pages/watch/[shareId].js` never reveals the intended recipient's email — it says the link "isn't valid for your account," nothing more.
- [ ] `email_verified` is enforced ONLY via `lib/verification.js` (Decision 14): off by default, staff unconditionally exempt, env bypass honoured, fails open, and an absent claim admits. Never gate `/watch/[shareId]` on it.
- [ ] An unscheduled video and an ungrouped viewer both behave exactly as they did before those features existed (Decisions 13 and 15).
- [ ] `lib/accessRequests.js` never writes `pvp:approved_viewers`; only `pages/api/admin/access-requests.js` does, behind `viewers:manage`.
- [ ] Every admin route authorizes BEFORE checking `req.method`, so an unauthorized caller gets 403 rather than 405 (`lib/__tests__/apiGates.test.js` pins this).
- [ ] `allow()` in `lib/ratelimit.js` fails open; `logAudit()` in `lib/audit.js` never throws; `ResumablePlayer` failures never block playback.
- [ ] `BUNNY_API_KEY` never appears in any response payload or client bundle; browsers only ever receive TUS signatures.

## C. Known-weak points

Stated plainly. These are accepted risks with named mitigations, not secrets. Do not "discover" them as new findings; do not fix them as drive-bys inside unrelated changes (see `change-control`). Remediation is tracked in `security-currency-campaign`.

| # | Weakness | Current mitigation | Hardening candidate |
|---|---|---|---|
| 1 | Email trust is unverifiable — `email_verified` can never be enforced (no Auth0 mail server), so identity = "controls an Auth0 login whose email string matches" | Auth0 tenant sign-ups disabled; invite-only viewer set | Add a mail provider to Auth0, then (and only then) revisit verification |
| 2 | `/api/progress` has **no rate limit** and writes to Redis on every playback tick (~8 s per active viewer) (`pages/api/progress.js`) | None — accepted for current audience size | Add the standard `allow(callerId(...))` guard like `pages/api/videos.js` |
| 3 | `pvp:viewer_last_seen` and per-user `pvp:progress:{email}` hashes grow unbounded — no TTL, no pruning, entries persist after viewer removal | Partly mitigated: `sweepOrphanedProgress` in `lib/maintenance.js` clears orphaned progress hashes, and viewer removal now also clears group memberships (`removeUserFromAllGroups`). `viewer_last_seen` is still unbounded | TTLs on `viewer_last_seen` |
| 4 | No Redis backup/restore story — losing the Upstash DB loses viewers, shares, order, theme, progress, audit | None yet | North star: production hardening — Upstash backups or a scheduled export |
| 5 | Vercel deploys `main` independently of CI (`vercel.json` enables git deploys; `ci.yml` has no deploy gate) — a broken push CAN reach production; **CI is an alarm, not a gate** (as of 2026-07-10) | CI failure notification prompts a fix/revert | Vercel "require CI checks" or deploy-hook gating |
| 6 | Thumbnails silently degrade when `BUNNY_CDN_HOSTNAME` is unset — `getThumbnailUrl` returns `''` and the homepage falls back to a list layout; looks like a UI bug, is actually config | Documented fallback; UI handles empty thumbnails | Startup/env-check warning surfacing the missing var |

## Sibling skills

| Skill | Use it for |
|---|---|
| `bunny-reference` | Exact signing-formula details, TUS headers, Bunny API endpoints |
| `config-and-data` | Redis key dictionary, env-var dictionary |
| `change-control` | The gates protecting the invariants above when you must change one |
| `failure-archaeology` | The incidents that forged these invariants (TUS 401 saga, CodeQL rounds, admin-gate regression) |
| `security-currency-campaign` | Remediation plan for the weak points in section C |

## Provenance & maintenance

- **Ground truth**: every code claim above was verified against the working tree at commit `739c54f` on 2026-07-10 by reading the cited files: `lib/auth.js`, `lib/bunny.js`, `lib/redis.js`, `lib/order.js`, `lib/ratelimit.js`, `lib/audit.js`, `lib/theme.js`, `pages/admin.js`, `pages/index.js`, `pages/_document.js`, `pages/api/theme.js`, `pages/api/progress.js`, `pages/api/videos.js`, `pages/api/admin/*.js` (all 10), `pages/watch/[shareId].js`, `pages/watch/video/[id].js`, `components/ResumablePlayer.js`, `next.config.js`, `vercel.json`, `.github/workflows/ci.yml`, `styles/globals.css`, `package.json`, and the founding doc `bunny-vercel-auth0-guide.md`. Commits `8e81183` (TUS 401 fix) and `eb4bcdd` (inline GUID sanitizer) verified in git history.
- **Session facts**: items marked "(session record, 2026-07-10, maintainer-confirmed)" — the email_verified lockout constraint and the 14-alert Dependabot deferral rationale — come from maintainer sessions, not from code, and cannot be re-derived by reading the repo.
- **Volatile facts** are date-stamped "(as of 2026-07-10)": route counts, rate-limit parameters, default homepage count, audit cap, which routes are rate-limited, dependency versions, and the absence of `middleware.js`/`app/`. Re-verify each against the tree before relying on it after significant changes.
- **2026-08-31 update (roles/groups follow-on)**: Decisions 14 and 15 added (opt-in email_verified enforcement; scheduled publish/expiry and access requests). Decision 2's `email_verified` invariant superseded in place with its original rationale retained. Verified against `lib/verification.js`, `lib/schedule.js`, `lib/accessRequests.js`, `pages/api/admin/{verification,access-requests}.js`, `pages/api/access-request.js`, and the re-gated `pages/api/admin/broadcast.js`. 209 vitest cases passing (including a new route-handler gate suite), lint and build green.
- **2026-08-30 update (v1.19.0, roles and groups)**: Decision 13 added; Decisions 2, 3 and 8 amended in place with their originals retained; invariants checklist extended; weak point #3 downgraded. Verified against `lib/roles.js`, `lib/groups.js`, `lib/auth.js`, `lib/maintenance.js`, all 18 files in `pages/api/admin/`, `pages/api/me.js`, `pages/api/videos.js`, `pages/api/collections.js`, `pages/api/progress.js`, `pages/api/theme.js`, `pages/admin.js`, `pages/index.js`, `pages/activity.js`, `pages/watch/video/[id].js`, and `pages/watch/[shareId].js`. `npm run lint`, `npm test` (62 passing) and `npm run build` all green at the time of writing.
- **When to update this skill**: whenever a decision in section A is deliberately changed (record the new rationale, don't delete the old one), a weak point in section C is remediated (move it to a "retired risks" note with the fixing commit), or a new invariant is forged by an incident (add it to B and cross-link `failure-archaeology`).
