---
name: config-and-data
description: Environment-variable and Redis-key dictionaries for the Marine Video Portal. Load this skill when adding, renaming, or removing an env var or Redis key, wondering what a key stores or which file reads/writes it, debugging empty data / auth failures / upload 401s caused by misconfiguration, or configuring a fresh Vercel deployment (which value goes where and what breaks when it's wrong).
---

# Config & Data Dictionary (as of 2026-07-10)

This skill is the single source of truth for **what configuration exists and where data lives**: every environment variable, every Redis key, the three places env values must be mirrored, and the checklists for adding new ones. Every row below was derived by grepping the code on 2026-07-10 — file citations are the proof. If code has changed since, re-derive per "Provenance & maintenance" at the bottom.

Architecture in one line: Next.js 14 Pages Router on Vercel; Auth0 for login (`@auth0/nextjs-auth0`); bunny.net Stream for video storage/playback; Upstash Redis via Vercel KV for all app state. All Redis keys go through `k()` in `lib/redis.js`, which prepends the `pvp:` prefix.

## When NOT to use this skill

- **What the Bunny values *mean* (library vs. pull zone, where to find each key in the Bunny dashboard)** → sibling skill `bunny-reference`.
- **Setting up a local machine / `.env.local`** → sibling skill `build-and-env`.
- **How to redeploy, restart, or operate the running site** → sibling skill `run-and-operate` (this skill tells you *that* a redeploy is required after an env change, not *how*).
- **Why `k()` prefixing is a hard invariant / overall design rationale** → sibling skill `architecture-contract`.
- **Writing feature code that merely calls existing helpers** (e.g. using `getEmbedUrl` or `logAudit`) — you don't need the dictionaries for that; just read the helper.

## 1. Environment variable dictionary

All values live in **Vercel project settings** (production truth). None are committed to the repo.

| Name | Required? | Consumed by | Purpose | Default / absent behavior | Notes |
|---|---|---|---|---|---|
| `AUTH0_SECRET` | Yes | `@auth0/nextjs-auth0` SDK (implicitly — no app-code read) | Encrypts the session cookie | SDK throws at init → login broken | 32-byte hex; generate at generate-secret.vercel.app/32 (README.md:96) |
| `AUTH0_BASE_URL` | Yes | SDK (implicitly) **and** `pages/api/admin/share.js:33` (builds share `watchUrl`) | Exact canonical site URL | SDK throws; share links malformed | **Exact-match matters**: login started from any other URL → "Missing state cookie" on callback (README.md:182). No trailing slash. |
| `AUTH0_ISSUER_BASE_URL` | Yes | SDK (implicitly) | Auth0 tenant domain, with `https://` | SDK throws: "issuerBaseURL must be a valid uri" (README.md:181) | No trailing slash, no whitespace |
| `AUTH0_CLIENT_ID` | Yes | SDK (implicitly) | Auth0 application ID | Login broken | From Auth0 app settings |
| `AUTH0_CLIENT_SECRET` | Yes | SDK (implicitly) | Auth0 application secret | Login broken | From Auth0 app settings |
| `ADMIN_EMAILS` | Yes | `lib/auth.js:4` | Who passes `isAdmin()` — gates `/admin` and every `pages/api/admin/*` route | Empty admin list → everyone gets 403 from admin routes | Comma-separated; each entry is `.trim().toLowerCase()`d, empties filtered (`lib/auth.js:4-7`) |
| `BUNNY_LIBRARY_ID` | Yes | `lib/bunny.js` (every API call: lines 13, 25, 46, 62, 82, 91, 101, 122, 137, 192, 208) | Bunny Stream library ID, part of every API URL and the TUS signature | All Bunny calls fail | `.trim()`ed in `signTusUpload` (`lib/bunny.js:46`) — see whitespace rule below |
| `BUNNY_API_KEY` | Yes | `lib/bunny.js` (AccessKey header on every call; TUS signature at line 47) | Bunny Stream library API key | All Bunny calls 401 | `.trim()`ed in `signTusUpload` (`lib/bunny.js:47`) |
| `BUNNY_TOKEN_AUTH_KEY` | Yes | `lib/bunny.js:201` (`signVideoToken` → embed URLs), `lib/bunny.js:172` (thumbnail-signing fallback) | Library's Embed View Token Authentication key | Embed tokens compute wrong → player rejects playback | From the library's Security tab (README.md:103) |
| `BUNNY_CDN_HOSTNAME` | No | `lib/bunny.js:162` (`getThumbnailUrl`) | CDN/pull-zone host for direct thumbnail URLs — the **thumbnails on/off switch** | `getThumbnailUrl` returns `''` (`lib/bunny.js:166`) → homepage renders a title list instead of a thumbnail grid (README.md:177) | Scheme prefix and trailing slashes are stripped defensively (`lib/bunny.js:162-165`) |
| `BUNNY_CDN_TOKEN_KEY` | No | `lib/bunny.js:172` | Signs thumbnail URLs when the pull zone has "Block Direct URL File Access" on | Fallback chain: `BUNNY_CDN_TOKEN_KEY \|\| BUNNY_TOKEN_AUTH_KEY \|\| ''` — no key → unsigned URL (fine when token auth is off) | Only set it when it differs from `BUNNY_TOKEN_AUTH_KEY` (README.md:112) |
| `KV_REST_API_URL` | Yes | `lib/redis.js:7` | Upstash Redis REST endpoint | Redis client constructed at **module load** with undefined URL → every route touching Redis errors / returns empty | Auto-injected by Vercel when a Storage database is connected. If your dashboard shows `UPSTASH_REDIS_REST_URL` instead, the names don't match — see `lib/redis.js:3-5` comment |
| `KV_REST_API_TOKEN` | Yes | `lib/redis.js:8` | Upstash Redis REST token | Same as above | Same as above |
| `SENTRY_DSN` | No | `sentry.server.config.js:3`, `sentry.edge.config.js:3` | Server/edge error capture | Inert — Sentry stays disabled | |
| `NEXT_PUBLIC_SENTRY_DSN` | No | `sentry.client.config.js:3` | Browser error capture | Inert | `NEXT_PUBLIC_` = baked in at build time; changing it requires a rebuild, not just a restart |
| `SENTRY_ORG` | No | `next.config.js:12` | Source-map upload during build | Inert — build works fine without (comment at `next.config.js:6-9`) | |
| `SENTRY_PROJECT` | No | `next.config.js:13` | Source-map upload | Inert | |
| `SENTRY_AUTH_TOKEN` | No | `next.config.js:14` | Source-map upload | Inert | |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | No | `lib/push.js` (server) + `components/NotifyButton.js` (client, inlined at build) | Public half of the Web Push VAPID keypair — the **push on/off switch** (both keys required) | `pushEnabled()` returns false → NotifyButton renders null, subscribe/broadcast return 503, no sends | `NEXT_PUBLIC_` = inlined at build; changing it needs a rebuild. Generate with `npx web-push generate-vapid-keys` |
| `VAPID_PRIVATE_KEY` | No | `lib/push.js` (`webpush.setVapidDetails`, lazily inside `configure()`) | Private half of the VAPID keypair | Same as above (feature inert) | Server-only; never inlined. Trimmed in `lib/push.js` |
| `VAPID_SUBJECT` | No | `lib/push.js` `configure()` | Contact URI web-push attaches to sends (`mailto:` or https URL) | Falls back to `mailto:<first ADMIN_EMAILS>` or `mailto:admin@example.com` | Only needed to override the default |
| `NEXT_TELEMETRY_DISABLED` | No (CI only) | `.github/workflows/ci.yml:17` (job-level env) | Silences Next.js telemetry in CI | Telemetry pings in CI logs | Never read by app code |

### Cross-cutting rules (read before touching any env var)

1. **Whitespace is invisible and deadly.** A stray newline/space pasted into a Vercel value is silently dropped from HTTP headers (so most calls still work) but **corrupts anything cryptographic**. Root cause of a real incident: whitespace in `BUNNY_API_KEY`/`BUNNY_LIBRARY_ID` corrupted the TUS SHA256 signature → upload HTTP 401 while every other Bunny call succeeded. Fixed by `.trim()`ing in `signTusUpload` (`lib/bunny.js:44-47`, commit `8e81183` "Fix TUS upload 401: revert to seconds expiry, trim env values"; session record, 2026-07-10, maintainer-confirmed). The signing paths trim defensively now, but re-paste cleanly anyway — not every consumer trims.
2. **A Vercel env change applies ONLY on the next deployment.** Editing a value in the dashboard does nothing to the running site. Redeploy after every change (procedure: sibling skill `run-and-operate`), then verify.
3. **`AUTH0_BASE_URL` is exact-match.** Login must start from precisely that URL. Starting from an old preview URL or a different casing/host → state-cookie mismatch → "Missing state cookie" on the callback (README.md:182).

## 2. The three env mirrors

When a **build- or test-relevant** env var is added, three places must stay in sync — module-load code (the Redis client at `lib/redis.js:6` and the Auth0 SDK) is constructed at import time and would throw during `next build` or `vitest` if its inputs are absent:

| Mirror | File | Role |
|---|---|---|
| (a) Vercel project settings | — (dashboard) | Production truth; only place with real values |
| (b) CI build env | `.github/workflows/ci.yml` (build step `env:` block, lines 37-51) | Dummy values so `next build` survives module-load construction |
| (c) Test env | `vitest.config.js` (`test.env`, lines 9-13) | Same reason, for tests that import Redis-touching modules |

Current dummy set in `.github/workflows/ci.yml` (verified 2026-07-10):

```yaml
AUTH0_SECRET: '0000000000000000000000000000000000000000000000000000000000000000'
AUTH0_BASE_URL: 'https://example.com'
AUTH0_ISSUER_BASE_URL: 'https://example.us.auth0.com'
AUTH0_CLIENT_ID: 'dummy'
AUTH0_CLIENT_SECRET: 'dummy'
BUNNY_LIBRARY_ID: '0'
BUNNY_API_KEY: 'dummy'
BUNNY_TOKEN_AUTH_KEY: 'dummy'
ADMIN_EMAILS: 'admin@example.com'
KV_REST_API_URL: 'https://example.com'
KV_REST_API_TOKEN: 'dummy'
```

Current dummy set in `vitest.config.js` (verified 2026-07-10):

```js
env: {
  ADMIN_EMAILS: 'admin@example.com, second@example.com',
  KV_REST_API_URL: 'https://example.com',
  KV_REST_API_TOKEN: 'dummy',
},
```

Dummies only need to be **present and well-formed**, not valid — nothing in CI actually calls Auth0/Bunny/Redis. Note the test `ADMIN_EMAILS` deliberately includes a space after the comma to exercise the trimming in `lib/auth.js`.

## 3. Redis key dictionary

Every key MUST go through `k()` from `lib/redis.js:13`, which prepends `pvp:`. A raw string key is a bug (rationale: sibling skill `architecture-contract`).

| Key pattern | Type | Written by | Read by | TTL / cap | Growth profile |
|---|---|---|---|---|---|
| `pvp:approved_viewers` | set of lowercase emails | `pages/api/admin/viewers.js:49` (SADD), `:58` (SREM) | `viewers.js:28` (SMEMBERS); membership checks (SISMEMBER) in `pages/api/videos.js:17`, `pages/api/progress.js:12`, `pages/api/collections.js:12`, `pages/watch/video/[id].js:22` | none | Bounded by admin action (explicit add/remove) |
| `pvp:viewer_last_seen` | hash email → ms timestamp | `pages/api/videos.js:24`, `pages/watch/video/[id].js:28` (HSET on approved-viewer activity); field HDEL on viewer removal `viewers.js:59` | `viewers.js:30` (HGETALL, for the admin "last seen" column) | none | **Unbounded-growth hardening candidate** — no TTL; one field per viewer that ever loaded the site; cleanup depends entirely on the DELETE path being used |
| `pvp:viewer_tags` | hash email → JSON array of tag strings (added v1.15.0) | `pages/api/admin/viewers.js` PATCH (HSET on save, or HDEL when the tag list is cleared); field HDEL on viewer removal | `viewers.js` GET (HGETALL, merged into each viewer row); admin UI reads it client-side to resolve a picked tag to its member emails for Bulk Share | none | Bounded by admin action; capped per-viewer at 20 tags / 40 chars each (`MAX_TAGS_PER_VIEWER`, `MAX_TAG_LENGTH` in `viewers.js`) |
| `pvp:role_admins` | set of lowercase emails (added v1.19.0) | `lib/roles.js` `grantRole` (SADD) / `revokeRole` (SREM), via `pages/api/admin/roles.js` (admin-only) | `lib/roles.js` `getRole` (SISMEMBER, on every gated request), `listRoleGrants` (SMEMBERS) | none | Bounded by admin action. **`ADMIN_EMAILS` is a separate always-wins floor** — `getRole` short-circuits on it before reading this key, and an env admin cannot be written here as a demotion |
| `pvp:role_managers` | set of lowercase emails (added v1.19.0) | same as `role_admins`; the two are mutually exclusive — granting one SREMs the other | same as `role_admins` | none | Bounded by admin action |
| `pvp:groups` | hash groupId (uuid) → JSON `{id, name, collectionIds[], videoIds[], createdAt, createdBy}` (added v1.19.0) | `lib/groups.js` `createGroup`/`updateGroup` (HSET), `deleteGroup` (HDEL), via `pages/api/admin/groups.js` | `lib/groups.js` `listGroups`/`getGroup`/`resolveAccess` (HGETALL/HGET) | none | Bounded by admin action; capped at 200 groups (`MAX_GROUPS`), names capped at 60 chars |
| `pvp:group_members:{groupId}` | set of lowercase emails (added v1.19.0) | `lib/groups.js` `addGroupMembers` (SADD), `removeGroupMember`/`removeUserFromAllGroups` (SREM), `deleteGroup` (DEL) | `listGroups` (SMEMBERS) | none | Bounded by admin action; cleared when the group is deleted or the viewer is removed |
| `pvp:user_groups:{email}` | set of groupIds — reverse index of `group_members` (added v1.19.0) | maintained alongside `group_members` by the same `lib/groups.js` functions | `lib/groups.js` `resolveAccess` (SMEMBERS — **on every viewer-facing request**, which is why the reverse index exists rather than scanning every group) | none | One key per grouped viewer; DEL'd by `removeUserFromAllGroups` when a viewer is removed. A stale id pointing at a deleted group is ignored by `resolveAccess`, so it widens toward the default rather than locking anyone out |
| `pvp:homepage_video_count` | number | `pages/api/admin/settings.js:22` (SET, validated 1-1000) | `settings.js:12`, `pages/api/videos.js:26` | none | Single value; absent → code defaults to `2` (`settings.js:13`, `videos.js:27`) |
| `pvp:video_order` | JSON array of Bunny video guids | `lib/order.js:12` `setOrder` (via `pages/api/admin/order.js:17` POST) | `lib/order.js:7` `getOrder` (via `order.js:10` GET and `videos.js:32`) | none | Single value; grows with library size only. Videos absent from the array float to the top, newest first (`lib/order.js:18-33`) |
| `pvp:theme` | JSON `{accent1, accent2}` (#rrggbb, lowercased) | `pages/api/theme.js:24` (admin-only POST) | `theme.js:10` (public GET — the login page needs the palette too) | none | Single value |
| `pvp:share:{uuid}` | JSON `{videoId, title, email, expiresAt}` + `viewedAt` after first view; private-list.js additionally stamps `privateList: true` | `pages/api/admin/share.js:25-29` (SET with `ex:` TTL); `pages/api/admin/private-list.js` (SET, same shape plus `privateList: true` — the tag is how the list tells its own tokens apart from a Create Link/Bulk Share to the same video/email, which it otherwise never sees or touches); `pages/watch/[shareId].js:36` rewrites with the **remaining** TTL to stamp `viewedAt`; DEL on revoke `shares.js:32` | `pages/watch/[shareId].js:19`, `pages/api/admin/shares.js:16`, `pages/api/admin/private-list.js` (GET/POST/DELETE all filter on `privateList: true`) | EX ≤ 30 days (`Math.min(expiresInHours, 720) * 3600`, `share.js:22`; private-list.js uses the same 720h cap unconditionally) | Self-expiring — safe |
| `pvp:active_shares` | set of share uuids | `share.js:30` (SADD); `private-list.js` (SADD, same set); SREM on revoke `shares.js:33` | `shares.js:12` (SMEMBERS); `private-list.js` (SMEMBERS, to compute each video's current member list) | none — **lazily pruned**: `shares.js:17-20` SREMs any id whose `pvp:share:{id}` has expired, but only when an admin opens the shares list | Bounded in practice by the lazy prune; stale ids linger until the next admin GET |
| `pvp:audit_log` | list of `{at, actor, action, detail}` | `lib/audit.js:9-10` `logAudit` — LPUSH + LTRIM to cap 200. Call sites: `viewers.js` (viewer.add/remove), `share.js` (share.create), `shares.js` (share.revoke), `private-list.js` (privatelist.add/privatelist.remove, share.email), `settings.js` (settings.homepage_count), `theme.js` (theme.update), `admin/videos.js` (video.rename/delete/collection), `admin/collections.js` (collection.create/delete), `admin/broadcast.js` (push.broadcast) | `lib/audit.js:17` `getAudit` (via `pages/api/admin/audit.js:10`) | LTRIM cap 200 entries | Hard-capped — safe. `logAudit` never throws (`lib/audit.js:6-13`) |
| `pvp:progress:{email}` | hash videoId → `{seconds, duration, title, at}` | `pages/api/progress.js:34` (HSET on player heartbeat) | `progress.js:20` (HGET), `:23` (HGETALL) | none | **Unbounded-growth hardening candidate** — one hash per viewer, one field per video ever watched; nothing deletes it, not even viewer removal |
| `pvp:push_subs:{email}` | hash endpoint → JSON Web Push subscription | `pages/api/push/subscribe.js` (HSET, field = subscription endpoint), pruned on 404/410 by `lib/push.js` `sendToEmails` | `lib/push.js` `sendToEmails` (HGETALL per targeted email) | none — **self-pruning**: dead subscriptions HDEL'd on send | One hash per subscriber, one field per device. Not deleted on viewer removal, but `targetEmails()` only sends to currently-approved viewers/admins, so a removed viewer never receives sends |
| `pvp:announced_videos` | set of Bunny video guids already push-announced | `lib/push.js` `maybeAnnounceReady` (SADD; the return value is the atomic once-only guard) | same (SADD idempotency check) | none | Grows by one guid per video ever announced; bounded by library size. Videos older than 24h are never added (freshness gate in `isFreshReady`) |
| `pvp:rl:*` | @upstash/ratelimit sliding-window internals | `lib/ratelimit.js:6-11` — `Ratelimit.slidingWindow(60, '10 s')`, `prefix: k('rl')` | same library | windows expire automatically | Self-expiring. Identifier = `{bucket}:{email-or-IP}`; buckets in use: `videos` (`pages/api/videos.js:12`), `share` (`pages/api/admin/share.js:14`, also reused by `private-list.js`'s POST — same bucket, not a new one), `upload` (`pages/api/admin/upload.js:13`), `push` (`pages/api/push/subscribe.js`). Limiter **fails open** on backend errors (`lib/ratelimit.js:26-33`) |

## 4. Checklists

### Adding a new env var

- [ ] Code reads it with a **safe default / inert-when-absent behavior** (follow `BUNNY_CDN_HOSTNAME`'s pattern at `lib/bunny.js:162-166`: `(process.env.X || '').trim()` and a graceful `''` return). Never let absence throw at request time.
- [ ] `.trim()` the value if it feeds anything cryptographic or URL-building (whitespace rule above).
- [ ] Add a row to README.md's env table — required section (~line 96) or optional section (~line 111).
- [ ] Is it touched during `next build` (module-load construction, `next.config.js`, or any `NEXT_PUBLIC_*`)? → add a dummy to the `env:` block of the build step in `.github/workflows/ci.yml`.
- [ ] Is it touched by any module a test imports? → add it to `test.env` in `vitest.config.js`.
- [ ] Add the real value in Vercel project settings.
- [ ] **Redeploy** (env changes are inert until the next deployment).
- [ ] Verify on production, and add the row to the dictionary in **this skill**.

### Adding a new Redis key

- [ ] **Always wrap with `k()`** from `lib/redis.js` — never a raw string (the `pvp:` prefix is an invariant; see `architecture-contract`).
- [ ] Decide **TTL or explicit cap** up front. Follow an existing pattern: `EX` TTL like `pvp:share:{uuid}` (`share.js:25-29`), or LPUSH+LTRIM cap like `pvp:audit_log` (`lib/audit.js:9-10`). If it must be unbounded, write the justification into this skill's dictionary — `viewer_last_seen` and `progress:{email}` are the existing (flagged) exceptions.
- [ ] Document the row in **this skill's** key dictionary (pattern, type, writers, readers, TTL, growth).
- [ ] If an **admin action mutates it**, add a `logAudit(actor, 'noun.verb', detail)` call — copy the pattern from any `pages/api/admin/*` route (e.g. `viewers.js:50`).
- [ ] Consider whether the route writing it needs rate limiting via `allow(callerId(req, session, 'bucket'))` from `lib/ratelimit.js` — currently applied to `videos`, `share`, and `upload`.

## 5. Fresh deployment config

The full one-time sequence (Bunny library → Auth0 tenant → Vercel project → KV store) lives in **README.md's one-time setup section** — do not duplicate it here. This skill owns the layer underneath: *which value goes where, and what breaks when it's wrong.*

| Symptom | Root cause | Fix |
|---|---|---|
| "Missing state cookie" on Auth0 callback | Login started from a URL that isn't exactly `AUTH0_BASE_URL` (old preview link, wrong host) | Always start from the exact production URL; correct the var and redeploy (README.md:182) |
| "issuerBaseURL must be a valid uri" at boot | `AUTH0_ISSUER_BASE_URL` missing `https://`, trailing slash, or stray whitespace | Re-paste cleanly, redeploy (README.md:181) |
| Video upload fails with HTTP 401 (everything else works) | Invisible whitespace in `BUNNY_API_KEY` / `BUNNY_LIBRARY_ID` corrupts the TUS SHA256 signature — headers drop the whitespace so `createVideo` still succeeds, making this maddening to spot | App now trims in `signTusUpload` (`lib/bunny.js:44-47`); if it recurs, re-paste both values cleanly in Vercel and redeploy (commit `8e81183`; session record, 2026-07-10, maintainer-confirmed) |
| Homepage shows a plain title list instead of the thumbnail grid | `BUNNY_CDN_HOSTNAME` unset (or set after the last deploy) — `getThumbnailUrl` returns `''` (`lib/bunny.js:166`) | Set it to the library's CDN host (e.g. `vz-xxxx.b-cdn.net`), redeploy (README.md:177) |
| Thumbnails 403 while the grid renders | Pull zone has "Block Direct URL File Access" on and the signing key is wrong | Set `BUNNY_CDN_TOKEN_KEY` (only if it differs from `BUNNY_TOKEN_AUTH_KEY`); see `lib/bunny.js:156-173` |
| Player loads but refuses playback | `BUNNY_TOKEN_AUTH_KEY` wrong/missing → embed token signature invalid (`lib/bunny.js:199-204`) | Copy the Embed View Token Authentication key from the library's Security tab |
| All app data empty (no viewers, no theme, no shares) but login works | Redis env names don't match what the code reads — code wants `KV_REST_API_URL`/`KV_REST_API_TOKEN`; some Upstash setups inject `UPSTASH_REDIS_REST_URL`/`_TOKEN` instead (`lib/redis.js:3-5`) | Connect the store via Vercel's Storage tab (injects the KV_ names), or add the KV_ names manually with the same values |
| `/admin` returns 403 for the owner | Email not in `ADMIN_EMAILS`, or casing/whitespace mismatch pre-dating a redeploy | Entries are trimmed+lowercased at read (`lib/auth.js:4-7`), so fix the list and redeploy |

## Provenance & maintenance

Derived from source on **2026-07-10** at commit `739c54f`. Nothing here came from memory — every row cites the file that proves it. Facts marked "(session record, 2026-07-10, maintainer-confirmed)" come from the maintainer's debugging session of that date and are additionally commit-verified where noted.

To re-derive when the code moves:

- **Env dictionary**: `grep -rn "process.env." --include='*.js' lib/ pages/ next.config.js sentry.*.config.js` — anything not in the table is new. Remember the five `AUTH0_*` vars are consumed implicitly by `@auth0/nextjs-auth0` (`handleAuth()` in `pages/api/auth/[auth0].js`) and won't all appear in app-code grep output.
- **Key dictionary**: `grep -rn "k('" --include='*.js' lib/ pages/` (also catch template forms: `grep -rn 'k(`' --include='*.js' lib/ pages/`).
- **Audit call sites**: `grep -rn "logAudit(" --include='*.js' pages/`.
- **Rate-limit buckets**: `grep -rn "allow(callerId" --include='*.js' pages/`.
- **CI/test mirrors**: read the `env:` blocks in `.github/workflows/ci.yml` (build step) and `vitest.config.js` directly — they are short.
- Cross-check the result against README.md's env table (required ~line 96, optional ~line 111); disagreements mean one of the two is stale — fix both.
