---
name: bunny-reference
description: Domain reference for bunny.net Stream as used in this repo — load whenever touching video uploads (TUS), playback/embeds, thumbnails, collections, video CRUD, signed tokens, library statistics, env vars BUNNY_*, or any code in lib/bunny.js, pages/api/admin/upload.js, pages/admin.js upload/status UI, components/ResumablePlayer.js, or the watch pages.
---

# bunny.net Stream Reference (as used in Marine Video Portal)

This is the domain reference for bunny.net Stream **as it applies here** — not a vendor
textbook. `lib/bunny.js` is the canonical source; everything below is derived from it and
its consumers. When this document and the code disagree, the code wins — then fix this
document (see Provenance & maintenance).

## When NOT to use this skill

- **Symptom-first debugging** ("uploads 401", "thumbnails broken", "video won't resume") →
  use the `debugging-playbook` skill first; come back here for the underlying formulas.
- **"Why is it built this way?"** (architecture rationale, trade-offs) → `architecture-contract`.
- **Env var / key lookup or rotation** → `config-and-data` is the env/key dictionary; this
  skill only explains what each Bunny key *does*.
- **Running verification scripts** → `diagnostics-and-tooling`.
- Anything not touching video: Auth0, Redis, shares, viewers, theming. Bunny is only the
  video layer.

## 1. Concept map (read this first if you have never used bunny.net)

bunny.net Stream is a hosted video platform. The hierarchy, top-down:

```
Stream Library  ── has: Library ID, its own API key, an embed-token key (Security tab)
  ├── Videos      ── fields used here: guid, title, status, encodeProgress, collectionId,
  │                  thumbnailFileName, views, totalWatchTime, length
  ├── Collections ── fields used here: guid, name, videoCount
  └── Pull Zone / CDN hostname (vz-*.b-cdn.net)
                  ── has its OWN URL-token key and security toggles
                     ("Block Direct URL File Access", URL Token Authentication)
```

Three distinct hosts, three distinct auth mechanisms — never mix them up:

| Host | Purpose | Auth |
|---|---|---|
| `video.bunnycdn.com` | Management API + TUS upload endpoint | `AccessKey` header (API key) for management; SHA256 signature headers for TUS |
| `iframe.mediadelivery.net` | Embed player iframe | `?token=&expires=` embed view token (SHA256 hex) |
| `vz-*.b-cdn.net` (pull zone) | Static CDN files (thumbnails etc.) | `?token=&expires=` URL token (SHA256 **base64url**) |

Env var mapping (this app):

| Env var | What it is | Where it comes from |
|---|---|---|
| `BUNNY_LIBRARY_ID` | Stream Library ID (numeric) | Bunny dashboard, library overview |
| `BUNNY_API_KEY` | The **library's own** API key (not the account key) | Library → API |
| `BUNNY_TOKEN_AUTH_KEY` | Embed token key | Library → Security tab ("Embed View Token Authentication") |
| `BUNNY_CDN_HOSTNAME` | Optional; e.g. `vz-xxxx.b-cdn.net`. Unset ⇒ no thumbnails (UI silently falls back to text list) | Library's pull zone |
| `BUNNY_CDN_TOKEN_KEY` | Optional; pull-zone URL token key, **only when it differs** from the embed key. `getThumbnailUrl` prefers it, falls back to `BUNNY_TOKEN_AUTH_KEY` (lib/bunny.js:172) | Pull zone → Security |

Env values are consumed via `process.env` at request time on Vercel — changing one
**requires a redeploy** to take effect (as of 2026-07-10).

## 2. Management API calls this app makes

Base URL: `https://video.bunnycdn.com/library/{BUNNY_LIBRARY_ID}` (lib/bunny.js:3).
Every call sends header `AccessKey: BUNNY_API_KEY`. Every wrapper throws
`Error("Bunny … error: {status}")` on non-2xx — there is no retry layer; callers catch.

| Function (lib/bunny.js) | HTTP call | Body / params | Returns | Consumers |
|---|---|---|---|---|
| `listVideos` (11–19) | `GET /videos?page=1&itemsPerPage={n}&orderBy=date` | `itemsPerPage` default 100 | `data.items \|\| []` (raw Bunny video objects) | pages/api/videos.js, pages/api/admin/videos.js, pages/api/admin/analytics.js, pages/watch/video/[id].js |
| `createVideo` (23–39) | `POST /videos` | `{ title }` | new video's `guid` — creates an **empty record**; bytes arrive later via TUS | pages/api/admin/upload.js |
| `updateVideoTitle` (57–75) | `POST /videos/{id}` | `{ title }` | `true` | pages/api/admin/videos.js |
| `deleteVideo` (77–87) | `DELETE /videos/{id}` | — | `true` | pages/api/admin/videos.js |
| `listCollections` (89–97) | `GET /collections?page=1&itemsPerPage=100&orderBy=name` | — | `[{ id, name, videoCount }]` (mapped from `guid`) | pages/api/collections.js, pages/api/admin/collections.js |
| `createCollection` (99–115) | `POST /collections` | `{ name }` | `{ id, name }` | pages/api/admin/collections.js |
| `deleteCollection` (117–127) | `DELETE /collections/{id}` | — | `true`. Videos survive, become uncategorized | pages/api/admin/collections.js |
| `setVideoCollection` (129–150) | `POST /videos/{id}` | `{ collectionId }` (`''` clears it) | `true` — same endpoint as rename; Bunny merges partial updates | pages/api/admin/videos.js |
| `getLibraryStatistics` (187–197) | `GET /statistics?dateFrom={YYYY-MM-DD}&dateTo={YYYY-MM-DD}` | both params optional | raw stats JSON; `viewsChart` is a `{date: count}` map (see pages/api/admin/analytics.js:34) | pages/api/admin/analytics.js |

### GUID validation — keep it INLINE

`GUID_RE` (lib/bunny.js:9) is a standard UUID regex. Every function that interpolates a
caller-supplied id into a URL path (`updateVideoTitle`, `deleteVideo`, `deleteCollection`,
`setVideoCollection`) validates the id **inside the function body**, immediately before the
`fetch`. Do not "clean this up" into a shared `assertGuid()` helper: CodeQL's SSRF dataflow
analysis only recognizes a sanitizer in the **same function** as the sink. Commit 40f4feb
added validation via a helper and the alerts stayed open; eb4bcdd inlined the checks and
they cleared. Any refactor that hoists these guards re-opens the CodeQL alerts.

## 3. The three signing formulas (exact — NEVER change the algorithm)

All three are **vendor-mandated**: Bunny's servers compute the same SHA256 on their side.
Changing the hash algorithm, input order, or encoding breaks the feature completely.
CodeQL "use of a broken or weak cryptographic algorithm" alerts on these lines are **false
positives** — these are not password hashes; dismiss them, do not "fix" them.

### 3a. TUS upload authorization — `signTusUpload` (lib/bunny.js:43–55)

```
signature = SHA256hex( libraryId + apiKey + expires + videoId )
expires   = Math.floor(Date.now() / 1000) + 86400        // Unix SECONDS
```

- `libraryId` and `apiKey` are `.trim()`ed (lines 46–47). This is load-bearing: a stray
  trailing newline in a Vercel env value is silently dropped from the `AccessKey` header
  (so `createVideo` works) but is hashed into the signature (so TUS returns 401). That
  asymmetry made the notorious 401 saga maddening to diagnose. Commit 54d1bcc was the
  wrong fix (switched to millisecond expiry — Bunny expects seconds); 8e81183 is the real
  fix (revert to seconds + trim env values). Hashes verified against git log 2026-07-10.
- Flow: browser `POST /api/admin/upload` (admin-gated, rate-limited —
  pages/api/admin/upload.js:8–27) → server calls `createVideo(title)` then
  `signTusUpload(videoId)` → returns `{ videoId, libraryId, signature, expires, title }`.
  The API key never reaches the browser.
- Browser then uploads with `tus-js-client` (dynamically imported, pages/admin.js:179–185)
  to `https://video.bunnycdn.com/tusupload` with this exact config (pages/admin.js:187–214):

```js
new Upload(file, {
  endpoint: 'https://video.bunnycdn.com/tusupload',
  retryDelays: [0, 3000, 5000, 10000, 20000],
  headers: {
    AuthorizationSignature: meta.signature,   // hex SHA256 from 3a
    AuthorizationExpire: String(meta.expires),// SECONDS, stringified
    VideoId: meta.videoId,
    LibraryId: String(meta.libraryId),
  },
  metadata: { filetype: file.type, title: meta.title },
  onError / onProgress / onSuccess: …
})
```

- Retry reuses the same `Upload` instance — TUS resumes where it left off
  (pages/admin.js:220–226). Cancel aborts the TUS upload **and** deletes the half-created
  video record from Bunny (pages/admin.js:229–247).

### 3b. Embed view token — `signVideoToken` / `getEmbedUrl` (lib/bunny.js:199–209)

```
token   = SHA256hex( BUNNY_TOKEN_AUTH_KEY + videoId + expires )
expires = Math.floor(Date.now() / 1000) + expiresInSeconds   // default 3600
url     = https://iframe.mediadelivery.net/embed/{libraryId}/{videoId}
          ?token={token}&expires={expires}&autoplay=false
```

- Requires "Embed View Token Authentication" to be **enabled** on the library's Security
  tab (as of 2026-07-10). With it enabled, an embed URL without a valid token is refused —
  this is what makes every play a fresh signed, time-limited URL.
- Consumers: pages/watch/video/[id].js:39 (1-hour token, per page load, server-side) and
  pages/watch/[shareId].js.
- Note `signVideoToken` does **not** trim `BUNNY_TOKEN_AUTH_KEY` — the same whitespace trap
  as 3a applies if the env value is ever re-pasted with a newline.

### 3c. Thumbnail CDN URL token — `getThumbnailUrl` (lib/bunny.js:161–185)

```
path    = /{video.guid}/{video.thumbnailFileName || 'thumbnail.jpg'}
expires = Math.floor(Date.now() / 1000) + ttlSeconds          // default 86400
token   = base64url( SHA256( key + path + expires ) )
          // base64 digest, then: strip '\n', '+'→'-', '/'→'_', '=' stripped
url     = https://{BUNNY_CDN_HOSTNAME}{path}?token={token}&expires={expires}
```

- Key preference: `BUNNY_CDN_TOKEN_KEY`, else `BUNNY_TOKEN_AUTH_KEY` (line 172).
- Encoding differs from 3a/3b: **base64url, not hex**. Do not unify them.
- Returns `''` when `BUNNY_CDN_HOSTNAME` is unset (line 166) → callers pass the empty
  string through as `thumbnail` and the UI silently falls back to a text-only list
  (pages/admin.js:874 renders the `<img>` only if `v.thumbnail` is truthy). "No
  thumbnails" is therefore a **configuration state, not a bug**.
- Returns the **unsigned** base URL when no key is set (line 173). Signing when token auth
  is off on the pull zone is harmless — Bunny ignores the params — so it always signs when
  a key exists.

## 4. Video status codes (as consumed here)

Bunny's `status` field on a video, interpreted by `videoStatusBadge`
(pages/admin.js:439–447):

| status | Meaning here | UI behavior |
|---|---|---|
| 0–3 | Still processing/encoding | Badge "Processing {encodeProgress}%"; admin page re-polls `/api/admin/videos` every 4 s while any video has `status < 4` (pages/admin.js:100–106) |
| 4 | Finished | No badge; video is playable |
| 5–6 | Failed | Red "Failed" badge |

Records stuck at "Processing 0%" are leftovers from failed or canceled uploads (the
`createVideo` record exists but no bytes ever arrived); they are safe to delete
(session record, 2026-07-10, maintainer-confirmed). The cancel path already tries to clean
these up automatically (pages/admin.js:229–247).

## 5. Security toggles and their observable behavior

Two **independent** protection systems — enabling one does not enable the other:

| Toggle (Bunny dashboard) | Governs | Effect when ON |
|---|---|---|
| "Embed View Token Authentication" (library → Security) | The iframe player | Embed URLs need the 3b token or playback is refused. This app requires it ON (as of 2026-07-10) |
| "Block Direct URL File Access" (pull zone) | Raw CDN files (`vz-*.b-cdn.net/...`) | Unsigned/invalid-token CDN URLs return **403**. Signed thumbnails (3c) still work IN THE APP because the browser sends the site's `Referer`; pasting the same signed URL directly into the address bar 403s **BY DESIGN** — that is hotlink protection working, not a bug (session record, 2026-07-10, maintainer-confirmed) |

When triaging "thumbnail 403": test **inside the app first**. A direct-paste 403 with
working in-app thumbnails is the expected end state.

## 6. Resume protocol (player.js over the Bunny embed)

Bunny's embed iframe speaks the open **player.js** protocol.
`components/ResumablePlayer.js` wraps the iframe and drives it:

- Dynamic `import('player.js')`; under webpack ESM/CJS interop the whole namespace lands on
  `mod.default`, so the constructor is resolved as `(mod.default ?? mod).Player`
  (ResumablePlayer.js:39–46). Getting this wrong fails **silently** (no player, no resume,
  video still plays) — fixed in commit 3ddd10b. A `console.warn` now fires if the
  constructor cannot be found.
- Saved position is fetched from `/api/progress?videoId=` **before** constructing the
  player (lines 50–55) so the seek can fire immediately on `ready`.
- On `ready`: read duration, then `trySeek()` (lines 64–66). Seek only happens when
  `savedSeconds > 5` and not within the last 10 s of the video (lines 25–30).
- Some players ignore a seek issued while paused, so the seek is **retried once** on the
  first `timeupdate` where playback is still more than 2 s behind the saved position
  (lines 68–76).
- Progress is saved to `POST /api/progress` at most every ~8 s of `timeupdate` events
  (lines 77–81), fire-and-forget with `.catch(() => {})`.
- Contract: playback must **never** depend on any of this. Every failure path (`import`
  fails, constructor missing, fetch fails, seek throws) returns/ignores and leaves the
  plain iframe playing.

## 7. Traps table

| Trap | Symptom | Rule |
|---|---|---|
| Whitespace in env values | TUS 401 while management API works (see 3a); or bad embed/thumbnail tokens | Trim on paste; `signTusUpload` and `getThumbnailUrl` trim defensively, `signVideoToken` does not |
| Seconds vs milliseconds expiry | Instant 401/403 on everything signed | All three formulas use Unix **seconds** (`Math.floor(Date.now()/1000)`). Never `Date.now()` raw (that was wrong-fix 54d1bcc) |
| `itemsPerPage` is not a strict result cap | More/fewer videos shown than expected | The app fetches up to 100 and slices manually — homepage cap in pages/api/videos.js:42, pagination at :45–48. Change limits there, not by trusting Bunny's paging |
| Env change didn't apply | Old behavior persists after editing Vercel env | Env changes need a **Vercel redeploy** (as of 2026-07-10) |
| Thumbnail 403 on direct paste | "Thumbnails are broken!" reports | Expected with "Block Direct URL File Access" ON — verify in-app first (section 5) |
| "Fixing" the SHA256 usage | Everything signed breaks | Formulas are vendor-mandated (section 3); CodeQL weak-hash alerts here are false positives |
| Hoisting GUID guards into a helper | CodeQL SSRF alerts re-open | Guards must stay inline in each function (section 2) |
| `getThumbnailUrl` returns `''` | No thumbnails anywhere, no errors | `BUNNY_CDN_HOSTNAME` unset — configuration state, not a bug (section 3c) |
| Bunny library API key vs account API key | 401 on every management call | `BUNNY_API_KEY` must be the **library's** key (library → API), not the account-level key |

## Sibling skills

- `debugging-playbook` — symptom-first triage (start there when something is broken).
- `architecture-contract` — why the system is shaped this way.
- `config-and-data` — env/key dictionary (names, formats, rotation).
- `diagnostics-and-tooling` — verification scripts.

## Provenance & maintenance

- **Canonical source:** `lib/bunny.js` — this document was derived from it line by line on
  2026-07-10, plus its consumers: pages/api/admin/upload.js, pages/admin.js (TUS client
  config, status badges, 4 s polling), components/ResumablePlayer.js, pages/api/videos.js,
  pages/api/admin/videos.js, pages/api/admin/collections.js, pages/api/collections.js,
  pages/api/admin/analytics.js, pages/watch/video/[id].js, pages/watch/[shareId].js.
- **Commit hashes cited** (verified via `git log`, 2026-07-10): 54d1bcc (401 wrong fix,
  millisecond expiry), 8e81183 (401 real fix, seconds + trim), 3ddd10b (player.js
  constructor interop), 40f4feb (CodeQL fixes, helper-based validation — insufficient),
  eb4bcdd (inline validation that cleared the alerts).
- **Session-record facts** (2026-07-10, maintainer-confirmed, not derivable from code):
  orphaned 0%-processing records are deletable; direct-paste thumbnail 403 is intended
  hotlink-protection behavior.
- **Line numbers** reference the files as of commit 739c54f (2026-07-10). After editing
  lib/bunny.js or the cited consumers, re-verify line references and update the tables —
  especially if you add/remove functions, change a signing formula input, or alter the
  status-badge thresholds.
- **When code and this document disagree, the code wins.** Update this file in the same PR
  as any change to lib/bunny.js.
