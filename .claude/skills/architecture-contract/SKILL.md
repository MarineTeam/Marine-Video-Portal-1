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

**Decision.** Three tiers, all keyed on lowercase email strings:

| Tier | Source of truth | Check | Where |
|---|---|---|---|
| Admin | `ADMIN_EMAILS` env var (comma-separated; each entry trimmed + lowercased) | `isAdmin(email)` | `lib/auth.js` — the ONLY admin check in the codebase |
| Approved viewer | Redis set `pvp:approved_viewers` | `redis.sismember(k('approved_viewers'), email)` | `pages/api/videos.js`, `pages/api/progress.js`, `pages/watch/video/[id].js` |
| Share recipient | Share record in Redis (`share:{id}`) | exact match `share.email !== session.user.email.toLowerCase()` | `pages/watch/[shareId].js` |

**Why.** The portal is invite-only for a small known audience; email strings the admin typed are the natural identity. **INVARIANT: `email_verified` is never checked anywhere.** The Auth0 tenant has no mail server, so `email_verified` is `false` for every account; enforcing it locks out everyone including admins (session record, 2026-07-10, maintainer-confirmed). The self-registration risk this leaves open (anyone could sign up claiming any email) is mitigated one layer up: **Auth0 sign-ups are disabled** at the tenant (tenant setting, documented in `README.md`).

**What breaks if violated.** Add an `email_verified` check → total lockout, every user, immediately. Add a second admin-check mechanism → the two drift and one becomes a bypass. Re-enable Auth0 sign-ups without adding email verification infrastructure → anyone can mint an account for an email on a share link.

### 3. Defense in depth on /admin: server gate PLUS per-route 403s

**Decision.** Two independent layers, both mandatory:

1. `getServerSideProps` in `pages/admin.js` — no session → redirect to login; session but not admin → redirect to `/`. A non-admin never receives the admin UI shell HTML/JS.
2. Every one of the 10 routes in `pages/api/admin/*` (as of 2026-07-10) independently calls `getSession` + `isAdmin` and returns 403 `Forbidden`.

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

**Why — stated plainly as intended behavior.** The cap is presentation (a tidy homepage), not a security boundary. Access control is binary: approved viewers see the library, period. Do not "harden" the watch page to only allow videos currently on the homepage — that is not the model, and it would break search results, resume-watching links, and share flows.

**What breaks if violated.** Treating the cap as access control creates a false sense of restriction (the GUIDs are enumerable via search anyway) and breaks legitimate deep links.

### 9. Rate limiter FAILS OPEN by design

**Decision.** `allow()` in `lib/ratelimit.js` wraps `limiter.limit()` in try/catch and **returns `true` on any error**. Sliding window: 60 requests / 10 s per `bucket:caller` (as of 2026-07-10). Applied to exactly three routes as of 2026-07-10: `pages/api/videos.js`, `pages/api/admin/upload.js`, `pages/api/admin/share.js`.

**Why.** Availability over strictness: the limiter's backend is the same Redis as everything else, and a Redis hiccup must never lock real users out of a portal whose whole job is playing videos. The limiter blunts abuse; it is not a security control.

**What breaks if violated.** Make it fail closed and the next Upstash blip takes the whole site down for everyone — the exact outage mode this design precludes.

### 10. Resilience-by-degradation: optional features must never break their host

**Decision.** Two features are explicitly best-effort:
- **Resume playback** (`components/ResumablePlayer.js`): `player.js` is dynamic-imported in try/catch; if the library fails to load, the constructor isn't found, or the progress fetch fails, the function returns early and **the video still plays** in a plain iframe. Progress saves at most every 8 s and its `fetch` swallows errors.
- **Audit logging** (`lib/audit.js`): `logAudit()` never throws — the write is try/catch-swallowed. The log is a capped Redis list (`lpush` + `ltrim` to 200 entries, as of 2026-07-10), so it cannot grow unbounded.

**Why.** Playback and admin actions are the product; resume-position and audit trails are conveniences. A broken convenience must degrade to absence, not take the core feature down with it.

**What breaks if violated.** Let `logAudit` throw and a Redis blip starts failing every admin action it decorates. Make ResumablePlayer's setup errors fatal and a CDN hiccup on player.js blanks the player. Preserve the swallow-and-degrade shape in any refactor.

### 11. Theme system: public GET, admin POST, hex-validated everywhere, pre-paint script

**Decision.** The two-color palette lives in Redis (`pvp:theme`). `GET /api/theme` is **public** (no session check — `pages/api/theme.js`) so the login page is themed for logged-out visitors; `POST /api/theme` is admin-only and rejects anything that isn't `#rrggbb` (`isValidHex` in `lib/theme.js`). Clients cache the palette in `localStorage` (`mvp_theme`), and an inline script in `pages/_document.js` re-applies it before first paint. That script is the app's ONLY `dangerouslySetInnerHTML`, it is a static string (no interpolation), and it re-validates both values against `/^#[0-9a-fA-F]{6}$/` before touching the DOM.

**Why.** Public GET: the login page renders pre-auth, so the palette endpoint can't require auth. Pre-paint script: without it, returning visitors flash default colors. Hex validation at BOTH the write (API) and the read (inline script): localStorage is attacker-influenceable on a shared machine and Redis contents shouldn't be blindly trusted by a script injected into every page — validation is what makes the static `dangerouslySetInnerHTML` safe.

**What breaks if violated.** Auth-gate the GET → unstyled login page. Interpolate anything dynamic into the `_document.js` script or drop its hex check → you've built an XSS gadget into every page load. Skip validation on POST → stored values flow to inline styles portal-wide.

### 12. Sentry is opt-in/inert; CI builds on dummy env vars

**Decision.** `withSentryConfig` wraps the build in `next.config.js`, but runtime reporting is inert until `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` are set (`sentry.client.config.js`, `sentry.server.config.js`, `sentry.edge.config.js`), and source-map upload only happens when `SENTRY_AUTH_TOKEN`/org/project exist. CI (`.github/workflows/ci.yml`) builds with a block of **dummy** env values (`AUTH0_*`, `BUNNY_*`, `ADMIN_EMAILS`, `KV_REST_API_*`).

**Why.** The Redis client (`lib/redis.js`) and Auth0 SDK construct at module load — a Next.js build imports API routes, so a build with missing env vars throws before it compiles anything. CI only needs values that are *present and well-formed*, not valid; real values live in Vercel. Sentry stays wired but silent so enabling it later is one env var, not a code change.

**What breaks if violated.** Delete the CI env block → every CI build fails at module load. Add a new module-load-time client without adding its dummy var to `ci.yml` → same. Hardcode a DSN → error telemetry from every fork/preview goes somewhere it shouldn't.

---

## B. Invariants checklist

Walk this list on every review that touches auth, API routes, Redis, or `lib/bunny.js`. Every line must hold:

- [ ] Every route in `pages/api/admin/*` calls `getSession` + `isAdmin` and 403s otherwise (10 routes, as of 2026-07-10). `isAdmin` in `lib/auth.js` is the only admin check.
- [ ] `pages/admin.js` still has its `getServerSideProps` gate (redirect non-session → login, non-admin → `/`).
- [ ] Every Redis key goes through `k()` (`lib/redis.js`); no raw string keys anywhere, including limiter prefixes.
- [ ] No `middleware.js` file, no `app/` directory (Decision 1 — this is a security posture, not a style choice).
- [ ] The three signing formulas in `lib/bunny.js` are byte-exact per Decision 4; TUS expiry in Unix **seconds**; the TUS and thumbnail-CDN signers `.trim()` their env inputs (the embed-view-token signer `signVideoToken` does NOT trim — not a bug, don't "fix" it).
- [ ] `getEmbedUrl` output ends with `autoplay=false`.
- [ ] `GET /api/theme` is public; `POST /api/theme` is admin-only; all color values hex-validated on write AND in the `_document.js` pre-paint script.
- [ ] GUID validation (`GUID_RE.test(...)`) stays **INLINE** inside each mutating function in `lib/bunny.js` (`updateVideoTitle`, `deleteVideo`, `deleteCollection`, `setVideoCollection`). CodeQL's dataflow analysis only recognizes it as an SSRF sanitizer when inline — extracting it to a shared helper re-opens the findings (commit `eb4bcdd`).
- [ ] The share-mismatch error in `pages/watch/[shareId].js` never reveals the intended recipient's email — it says the link "isn't valid for your account," nothing more.
- [ ] `email_verified` is checked nowhere (Decision 2 — enforcing it is total lockout).
- [ ] `allow()` in `lib/ratelimit.js` fails open; `logAudit()` in `lib/audit.js` never throws; `ResumablePlayer` failures never block playback.
- [ ] `BUNNY_API_KEY` never appears in any response payload or client bundle; browsers only ever receive TUS signatures.

## C. Known-weak points

Stated plainly. These are accepted risks with named mitigations, not secrets. Do not "discover" them as new findings; do not fix them as drive-bys inside unrelated changes (see `change-control`). Remediation is tracked in `security-currency-campaign`.

| # | Weakness | Current mitigation | Hardening candidate |
|---|---|---|---|
| 1 | Email trust is unverifiable — `email_verified` can never be enforced (no Auth0 mail server), so identity = "controls an Auth0 login whose email string matches" | Auth0 tenant sign-ups disabled; invite-only viewer set | Add a mail provider to Auth0, then (and only then) revisit verification |
| 2 | `/api/progress` has **no rate limit** and writes to Redis on every playback tick (~8 s per active viewer) (`pages/api/progress.js`) | None — accepted for current audience size | Add the standard `allow(callerId(...))` guard like `pages/api/videos.js` |
| 3 | `pvp:viewer_last_seen` and per-user `pvp:progress:{email}` hashes grow unbounded — no TTL, no pruning, entries persist after viewer removal | None (audit log is capped; these are not) | TTLs, or prune on viewer removal in `pages/api/admin/viewers.js` |
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
- **When to update this skill**: whenever a decision in section A is deliberately changed (record the new rationale, don't delete the old one), a weak point in section C is remediated (move it to a "retired risks" note with the fixing commit), or a new invariant is forged by an incident (add it to B and cross-link `failure-archaeology`).
