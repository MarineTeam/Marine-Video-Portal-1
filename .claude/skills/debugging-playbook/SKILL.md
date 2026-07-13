---
name: debugging-playbook
description: Symptom-to-fix triage runbook for Marine Video Portal failures — upload "HTTP 401 tus unexpected response", "Couldn't start upload", videos stuck "Processing 0%", homepage shows title list instead of thumbnail grid, thumbnails broken or 403, resume playback not working, Auth0 login loop / "Missing state cookie" / "issuerBaseURL must be a valid uri", signed-in user sees "not approved", 429 "Too many requests", Redis reads look empty, CI lint failure no-html-link-for-pages, git push "unable to open loose object", gh command not found. Use whenever debugging a user-visible error or operational failure in this repo.
---

# Debugging Playbook — Marine Video Portal

Symptom-first triage for this project's **known, real** failure modes. Each entry gives the exact
first diagnostic, causes ranked by observed likelihood, the fix, and the history of why —
so you never re-fight a settled battle.

> **Wrong skill?** The full routing table is in "When NOT to use this skill" at the bottom. Quick version: understanding *why* code is shaped oddly → `failure-archaeology`; an unexplained NEW symptom with no entry here → `research-methodology`; about to change or release code → `change-control`.

**Terms used once, defined here:**

- **Bunny / bunny.net Stream** — the video host. A *library* holds videos; it has a numeric
  `BUNNY_LIBRARY_ID` and a library-scoped `BUNNY_API_KEY`. Playback goes through tokenized
  iframe embeds; thumbnails come from the library's CDN *pull zone* (`BUNNY_CDN_HOSTNAME`).
- **TUS** — resumable-upload protocol. The browser uploads video bytes directly to
  `https://video.bunnycdn.com/tusupload` using `tus-js-client` (see `pages/admin.js`),
  authorized by a SHA256 signature minted server-side in `lib/bunny.js` (`signTusUpload`).
- **KV / Redis** — Upstash Redis reached through Vercel's KV env vars
  (`KV_REST_API_URL` / `KV_REST_API_TOKEN`). Every key is prefixed `pvp:` by `k()` in `lib/redis.js`.
- **player.js** — the embed-control protocol library used by `components/ResumablePlayer.js`
  for resume-playback and progress saves.

**Environment constraints (as of 2026-07-10):** the maintainer's Windows machine has **no Node/npm**
— verification happens via CI (`.github/workflows/ci.yml`: lint → vitest → build) and the Vercel
deployment. The repo lives under OneDrive. `gh` is installed but off-PATH (entry 13). Env-var
changes in Vercel apply **only to new deployments** — always redeploy after changing one
(README "Environment variables").

---

## Quick triage table

| # | Symptom (user-visible) | First place to look |
|---|---|---|
| 1 | Upload fails: `Upload failed (HTTP 401): tus: unexpected response…` | `signTusUpload` in `lib/bunny.js`; Bunny env vars in Vercel |
| 2 | Upload fails: `Couldn't start upload: …` or non-401 HTTP | Response of `POST /api/admin/upload` in DevTools Network |
| 3 | Video stuck at "Processing 0%" forever | Was the upload failed/canceled? Orphaned record |
| 4 | Homepage shows a plain title list, not the thumbnail grid | `BUNNY_CDN_HOSTNAME` env var + last deploy time |
| 5 | Thumbnails broken/403 **inside the app** | `BUNNY_CDN_TOKEN_KEY` vs `BUNNY_TOKEN_AUTH_KEY` mismatch |
| 5b | Thumbnail URL pasted **directly into browser** returns 403 | NOT A BUG — hotlink protection. Do not "fix" |
| 6 | Resume playback not working (video restarts at 0:00) | Browser console for `ResumablePlayer:` warnings |
| 7 | Login loop, "Missing state cookie", "issuerBaseURL must be a valid uri" | `AUTH0_BASE_URL` / `AUTH0_ISSUER_BASE_URL` values |
| 8 | Signed-in user sees "You're signed in, but not approved" | `pvp:approved_viewers` Redis set; which email they used |
| 9 | `429 Too many requests — slow down.` | `lib/ratelimit.js` sliding window |
| 10 | Redis reads come back empty/nil | Missing `pvp:` prefix or wrong KV env-var names |
| 11 | CI lint fails on `@next/next/no-html-link-for-pages` | `.eslintrc.json` — rule is intentionally off |
| 12 | `git push` fails: `unable to open loose object … Permission denied` | OneDrive file lock — wait and retry |
| 13 | `gh: command not found` | Use the full path to gh.exe |

---

## 1. Upload fails — `Upload failed (HTTP 401): tus: unexpected response…`

**THE flagship trap of this repo.** The exact message is built in `pages/admin.js`
(`onError` in `beginUpload`): `Upload failed (HTTP 401): <tus-js-client message>`.
The 401 comes from Bunny rejecting the TUS `AuthorizationSignature` header.

**First diagnostic** — read the signature formula and confirm it still matches the code:

```powershell
git log --oneline -3 -- lib/bunny.js
```

Then open `lib/bunny.js` → `signTusUpload`. As of 2026-07-10 the correct implementation is:

```js
const libraryId = (process.env.BUNNY_LIBRARY_ID || '').trim();
const apiKey    = (process.env.BUNNY_API_KEY   || '').trim();
const expires   = Math.floor(Date.now() / 1000) + expiresInSeconds;   // Unix SECONDS
sha256(`${libraryId}${apiKey}${expires}${videoId}`)  // hex digest
```

**Likely causes, ranked:**

1. **Whitespace/newline in `BUNNY_API_KEY` or `BUNNY_LIBRARY_ID` in Vercel.**
   This is the insidious one: the HTTP stack silently strips whitespace from the `AccessKey`
   *header*, so `createVideo` (step 1 of the upload) **succeeds** — but the raw, untrimmed value
   goes into the SHA256 TUS signature, which then never matches what Bunny computes → 401 only
   at the TUS step. Fixed by `.trim()` inside `signTusUpload` (commit `8e81183`,
   "Fix TUS upload 401: revert to seconds expiry, trim env values"). If it recurs, the trims
   were probably removed — restore them, and re-paste the env values cleanly in
   Vercel → Settings → Environment Variables, then redeploy.
2. **Expiry unit regression.** Bunny expects the expiry as a Unix timestamp in **seconds**.
   A plausible-looking "fix" once switched it to **milliseconds** (commit `54d1bcc`) and made
   every signature invalid; it was reverted in `8e81183`. If you see `Date.now() + …` without
   `/ 1000` in `signTusUpload`, that is the bug. Do not repeat this.
3. **Wrong library API key.** `BUNNY_API_KEY` must be the Stream **library** API key for the
   exact library in `BUNNY_LIBRARY_ID` (Bunny dashboard → Stream → your library → API).
   An account-level or other-library key signs "correctly" but for the wrong scope → 401.

**Fix:** in order — verify the code matches the formula above (`git show 8e81183` shows the
canonical version); re-paste both Bunny env values in Vercel with no surrounding whitespace;
confirm key ↔ library pairing in the Bunny dashboard; redeploy; retry the upload
(the Retry button resumes the same TUS upload; Discard/Cancel deletes the half-created video —
see `retryUpload`/`cancelUpload` in `pages/admin.js`).

**History:** `54d1bcc` (bad ms "fix") → `8e81183` (revert to seconds + trim). Both touched only
`lib/bunny.js`.

---

## 2. Upload fails — `Couldn't start upload: …` or other HTTP errors

`Couldn't start upload:` (exact prefix, `pages/admin.js` `beginUpload`) means step 1 —
`POST /api/admin/upload`, which creates the empty video record on Bunny — failed before TUS
even started.

**First diagnostic:** DevTools → Network → the `POST /api/admin/upload` request. Read status +
JSON body.

**Likely causes, ranked:**

1. **502 with `Bunny create-video error: <status>`** — Bunny rejected `createVideo`
   (`lib/bunny.js`): bad/expired `BUNNY_API_KEY`, wrong `BUNNY_LIBRARY_ID`, or Bunny outage.
2. **429 `Too many requests — slow down.`** — rate limiter tripped (entry 9). Wait ~10 s, retry.
3. **403 `Forbidden`** — the logged-in account is not in `ADMIN_EMAILS`.
4. **`Upload library failed to load — try redeploying so tus-js-client installs.`** — the
   dynamic `import('tus-js-client')` failed; usually a broken deploy. Redeploy.

A 401 **during the TUS transfer** is entry 1, not this entry.

---

## 3. Video stuck at "Processing 0%" forever

The badge text is `Processing <n>%` (`videoStatusBadge` in `pages/admin.js`; Bunny status
0–3 = encoding, 4 = finished, 5/6 = Failed).

**First diagnostic:** leave the `/admin` Videos tab open ~1 minute. While any video has
status < 4, the page re-fetches every **4 seconds** (`useEffect` on `videos` in
`pages/admin.js`), so *real* encoding visibly advances. A video pinned at 0% with no movement
is not encoding — Bunny never received its bytes.

**Likely causes, ranked:**

1. **Orphaned record from a failed or canceled upload** — `createVideo` succeeded but the TUS
   transfer never completed (e.g. entry 1's 401, browser closed mid-upload). The record exists
   with zero bytes and will sit at 0% forever. **Fix:** delete it with the trash button on that
   row in the `/admin` Video Library list (session record, 2026-07-10, maintainer-confirmed).
   Note: the Cancel button already deletes the half-created record when used — orphans come
   from paths that skipped it.
2. **Genuinely slow encode** — large file, Bunny queue. Distinguishable because the percentage
   moves, however slowly.

---

## 4. Homepage shows a title list instead of the thumbnail grid

By design the homepage renders the grid **only** when at least one returned video has a
non-empty thumbnail URL — `const hasThumbs = data.videos.some((v) => v.thumbnail)` in
`pages/index.js`; otherwise it falls back to the title list. `getThumbnailUrl` in
`lib/bunny.js` returns `''` when `BUNNY_CDN_HOSTNAME` is unset, so every thumbnail is empty
and the list wins.

**First diagnostic:** DevTools → Network → `GET /api/videos` → check whether `thumbnail`
fields in the JSON are empty strings.

**Likely causes, ranked:**

1. **`BUNNY_CDN_HOSTNAME` not set** in Vercel (the library pull-zone host,
   e.g. `vz-xxxx-xxx.b-cdn.net`).
2. **The live deploy predates the env var** — env changes only apply to new deployments.
   Redeploy. (README "Common issues" documents both.)

**Fix:** set `BUNNY_CDN_HOSTNAME`, redeploy, hard-refresh.

---

## 5. Thumbnails broken or 403 **inside the app**

Thumbnail URLs are signed with Bunny URL Token Authentication when a key is present:
`getThumbnailUrl` in `lib/bunny.js` uses `BUNNY_CDN_TOKEN_KEY` **falling back to**
`BUNNY_TOKEN_AUTH_KEY` (history: commit `11a9b3d`). Bunny has **two different keys**:
the library's *Embed View* token key (`BUNNY_TOKEN_AUTH_KEY`, used for playback embeds) and
the pull zone's *URL Token Authentication* key. If the pull zone's key differs and only
`BUNNY_TOKEN_AUTH_KEY` is set, thumbnail tokens are computed with the wrong key → CDN 403.

**First diagnostic:** DevTools → Network → a failing `*.b-cdn.net/<guid>/thumbnail.jpg?token=…`
request. In-app 403 with a `token` param present = key mismatch.

**Fix:** copy the pull zone's URL Token Authentication key from the Bunny dashboard into
`BUNNY_CDN_TOKEN_KEY` in Vercel, redeploy. Signing is harmless when token auth is off, so
leaving the keys set is always safe.

### 5b. CRITICAL non-bug — direct paste returns 403

Pasting a thumbnail URL **directly into the browser address bar returns 403 even when the app
displays it fine.** That is referrer-based hotlink protection working **as intended** —
requests from the app carry the site's `Referer`; direct/off-site requests don't
(session record, 2026-07-10, maintainer-confirmed; also README "Common issues" and
"Security notes"). **Do NOT "fix" this.** Do not disable hotlink protection, do not add
referrer workarounds. Only in-app breakage (above) is a real bug.

---

## 6. Resume playback not working

Videos play but restart from 0:00, or progress isn't saved. **Playback continuing to work
while resume silently fails is by design** — `components/ResumablePlayer.js` degrades
gracefully at every step (module comment, and README "Common issues"). Never make playback
depend on resume.

**First diagnostic:**

1. Browser console → filter for `ResumablePlayer:`. Known warnings (exact strings in
   `components/ResumablePlayer.js`): `ResumablePlayer: player.js Player constructor not found`
   and `ResumablePlayer: failed to init player.js`.
2. DevTools → Network → during playback you should see `POST /api/progress` roughly every
   **8 seconds** (saves are throttled to >8000 ms apart), plus one
   `GET /api/progress?videoId=…` at player setup. No POSTs = player.js never attached.

**Likely causes, ranked:**

1. **player.js constructor resolution regression.** `player.js` exports `{ Player, … }`, but
   under webpack interop the whole namespace lands on `module.default`, so the constructor is
   `mod.default.Player`. Calling `new` on the namespace itself fails **silently** — no resume,
   no error. Fixed in commit `3ddd10b` ("Fix resume playback: resolve player.js constructor
   correctly"): the code now resolves `const ns = mod.default ?? mod; const Player = ns.Player
   || mod.Player;` and warns if absent. If the warning appears, re-check that resolution logic.
2. **Bunny embed not exposing the player.js protocol** (embed config change on Bunny's side).
   Nothing to fix app-side; playback still works.
3. **`/api/progress` returning 401/403** — viewer not logged in / not approved (entry 8);
   the player swallows these silently.

---

## 7. Login loop / "Missing state cookie" / "issuerBaseURL must be a valid uri"

Both are documented in README "Common issues" (verified there as of 2026-07-10):

| Error | Cause | Fix |
|---|---|---|
| `Missing state cookie` on callback (often looks like a login loop) | Login was started from a URL different from `AUTH0_BASE_URL` — classically an **old Vercel preview link** | Always start from the exact production URL; set `AUTH0_BASE_URL` to it exactly, no trailing slash |
| `issuerBaseURL must be a valid uri` | `AUTH0_ISSUER_BASE_URL` missing `https://`, has a trailing slash, or contains whitespace | Re-paste as `https://<tenant>.<region>.auth0.com` — no trailing slash, no whitespace; redeploy |

**First diagnostic:** compare the browser's address bar at the moment login started against the
`AUTH0_BASE_URL` value in Vercel. For the issuer error, read the exact env value characters.

---

## 8. Signed-in user unexpectedly sees "You're signed in, but not approved"

Exact hero text in `pages/index.js`, shown when `GET /api/videos` returns 403
`{"error":"not_approved"}`. The check (`pages/api/videos.js`): the session email is
**lowercased** and must be a member of the Redis set `pvp:approved_viewers`
(`redis.sismember(k('approved_viewers'), email)`); admins in `ADMIN_EMAILS` bypass it.

**First diagnostic:** the "not approved" page displays **which email the user is signed in
as** — read it. Then compare against `/admin` → Viewers tab.

**Likely causes, ranked:**

1. **The email genuinely isn't in the set** — never added, or removed.
2. **They authenticated as a different email than the one that was approved** — e.g. they were
   invited on a work address but signed in with a personal Google account. The displayed email
   is authoritative.
3. **Character mismatch** — approval is exact-match on the lowercased string; a typo'd or
   aliased address doesn't count. (The admin add path lowercases and trims — see
   `pages/api/admin/viewers.js` — so mismatches usually come from cause 2.)

**Fix:** add the exact email shown on their screen via `/admin` → Viewers.

**NEVER "fix" this by enforcing `email_verified`.** The Auth0 tenant has **no mail server**,
so no user can ever verify — enforcement locks out **everyone** (session record, 2026-07-10,
maintainer-confirmed; also in project memory). Access control is: Auth0 sign-ups disabled +
admin-managed approved list. Leave it that way.

---

## 9. `429 Too many requests — slow down.`

**First diagnostic:** which endpoint returned it (DevTools Network). Rate-limited routes
(verified): `/api/videos`, `/api/admin/upload`, `/api/admin/share`.

**How it works** (`lib/ratelimit.js`): one Upstash sliding-window limiter, **60 requests per
10 seconds** per caller per route-bucket (as of 2026-07-10). Caller identity = logged-in email,
else first `x-forwarded-for` IP, else `anon`. Keys live under `pvp:rl`.

**Fix:** usually nothing — wait ~10 s. Legitimate single users rarely hit 60/10 s; repeated 429s
suggest a client-side fetch loop (check for a re-render storm) or many users behind one IP
pre-login.

**Design guarantee:** the limiter **fails open** — if the Redis backend errors, `allow()`
returns `true`, so an Upstash outage can never block real users. Don't "harden" it to fail
closed.

---

## 10. Redis reads look empty

**First diagnostic:** are you reading the key **with** the prefix? Every application key is
prefixed `pvp:` by `k()` in `lib/redis.js` (e.g. `approved_viewers` is stored as
`pvp:approved_viewers`). Raw, unprefixed lookups in the Upstash console or ad-hoc scripts
return nil and *look like* data loss.

**Likely causes, ranked:**

1. **Missing `pvp:` prefix** in a manual query or new code that bypassed `k()`.
2. **Wrong env-var names** — the client reads exactly `KV_REST_API_URL` / `KV_REST_API_TOKEN`,
   the names Vercel injects when a Storage database is connected. If the dashboard shows
   different names (e.g. `UPSTASH_REDIS_REST_URL`), the client silently points nowhere
   (comment in `lib/redis.js`).
3. **Pointed at a different Upstash database** than production.

**Fix:** query with the prefix; confirm the two KV env vars exist in Vercel with those exact
names; new code must always wrap keys in `k()`.

---

## 11. CI lint failure — `@next/next/no-html-link-for-pages`

This rule is **intentionally disabled** in `.eslintrc.json`
(`"@next/next/no-html-link-for-pages": "off"`, commit `746313f`). Reason: the app links to
`/api/auth/login` and `/api/auth/logout` with plain `<a>` tags (see `pages/index.js`,
`pages/admin.js`). Those are **API routes** that must perform a full browser navigation —
Next's `<Link>` client-side routing breaks the Auth0 redirect flow.

**Fix:** if the failure appears, someone re-enabled the rule or a config rewrite dropped the
override. Restore the `"off"` entry. **Do not** "fix" the lint error by converting the auth
anchors to `<Link>` — that reintroduces the login breakage.

---

## 12. `git push` fails — `unable to open loose object … Permission denied`

The repo lives under **OneDrive**, whose sync client transiently locks files in `.git`.

**First diagnostic:** none needed — the message itself is the signature.

**Fix:** wait a few seconds and **retry the push**. It clears on its own once OneDrive releases
the lock (session record, 2026-07-10, maintainer-confirmed).

**Do NOT run repair surgery** — no `git fsck` deletions, no object-database rebuilds, no
re-clone reflexes. The repository is not corrupt; it's momentarily locked.

---

## 13. `gh: command not found`

The GitHub CLI is installed but not on PATH on this machine (as of 2026-07-10; session record,
maintainer-confirmed, also in project memory). Use the full path — already authenticated as
`MarineTeam`:

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run list --limit 5
& "C:\Program Files\GitHub CLI\gh.exe" run watch
```

This matters extra here because Node isn't installed locally: **CI is the verification loop**,
and `gh run list` / `gh run watch` is how you read it.

---

## Escalation

After **2 failed fix attempts** on any symptom: **stop**. Write up the symptom + evidence
(exact error text, first-diagnostic output, what you tried) following **research-methodology**,
and check **failure-archaeology** *first* — several "obvious" fixes in this repo are documented
regressions (entry 1's millisecond expiry `54d1bcc`, entry 5b's hotlink "fix", entry 8's
`email_verified` lockout). Do not re-fight settled battles.

---

## When NOT to use this skill

This skill is for **diagnosing live failures**. Reach for a sibling instead when:

| Task | Use instead |
|---|---|
| Making/landing a change safely (branching, revert discipline) | `change-control` |
| Why past fixes/reverts happened; settled battles | `failure-archaeology` |
| System design, invariants, what talks to what | `architecture-contract` |
| Bunny API semantics beyond these symptoms | `bunny-reference` |
| Env vars, Redis keys, data shapes reference | `config-and-data` |
| Build pipeline, dependency, deploy-config issues | `build-and-env` |
| Routine operations (deploys, admin tasks) | `run-and-operate` |
| Tooling setup, logs, inspection techniques | `diagnostics-and-tooling` |
| Writing/running tests, pre-merge verification | `validation-and-qa` |
| README/docs edits | `docs-and-writing` |
| Dependency/security update campaigns | `security-currency-campaign` |
| Structured investigation of a *novel* problem | `research-methodology` |

---

## Provenance & maintenance

All claims verified against the working tree and git history on **2026-07-10**. Facts marked
"(session record, 2026-07-10, maintainer-confirmed)" are from the maintainer's session and are
not repo-visible. Re-verify before trusting after major refactors:

- TUS signature formula + trims + seconds expiry: `git log --oneline -5 -- lib/bunny.js` and read `signTusUpload` in `lib/bunny.js` (canonical fix: `git show 8e81183`; bad ms fix: `git show 54d1bcc`)
- Upload error strings & 4 s encode poll: `git grep -n "Upload failed\|Couldn't start upload\|4000" pages/admin.js`
- Grid-vs-list gate: `git grep -n hasThumbs pages/index.js`
- Thumbnail token key fallback: `git grep -n "BUNNY_CDN_TOKEN_KEY" lib/bunny.js`
- ResumablePlayer warnings & 8 s save throttle: `git grep -n "ResumablePlayer:\|8000" components/ResumablePlayer.js` (fix: `git show 3ddd10b`)
- Approved-viewer check: `git grep -n "approved_viewers" pages/api/videos.js`
- Rate-limit window & fail-open: `git grep -n "slidingWindow\|return true" lib/ratelimit.js`
- Redis prefix & KV names: `git grep -n "pvp:\|KV_REST_API" lib/redis.js`
- Lint override: `git grep -n "no-html-link-for-pages" .eslintrc.json` (rationale: `git show 746313f`)
- Auth0 error docs: README.md "Common issues" section
- CI pipeline order: `.github/workflows/ci.yml`
