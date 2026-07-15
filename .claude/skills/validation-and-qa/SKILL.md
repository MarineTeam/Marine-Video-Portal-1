---
name: validation-and-qa
description: Load before declaring ANY change done, when writing or modifying tests, or when deciding what evidence a given change class requires — defines the evidence ladder (CI green vs vitest vs deployed manual E2E), the acceptance gate for each change class (auth, signing/upload, UI, dependency, docs), step-by-step manual E2E checklists for upload, playback, resume, share links, thumbnails, admin gate, palette, and rate limiting, plus the house rules for writing vitest tests in lib/__tests__/.
---

# Validation & QA

How to prove a change to the Marine Video Portal actually works (as of 2026-07-10). Written for someone with zero context on this project who must answer one question: **is this change proven, or does it merely compile?**

Core constraint that shapes everything below: the maintainer machine has no local Node (as of 2026-07-10), so **CI is the only compiler** and **the deployed Vercel app is the only integration environment**. You cannot run the app locally. Every claim of "it works" is either backed by CI, by a vitest unit test, or by someone exercising the deployed site — there is no fourth option.

## When NOT to use this skill

- You are deciding **whether/how a change may land or roll back** — that is `change-control` (gates, direct-to-main workflow, revert doctrine). This skill defines the *evidence*; change-control defines the *process*.
- A check has already **failed** and you are hunting the cause — go to `debugging-playbook`.
- You need the **commands** to measure or inspect something (API probes, git forensics) — `diagnostics-and-tooling`.
- You are cutting a **release** or operating the deployed app — `run-and-operate`.
- You are researching *why* something is the way it is — `research-methodology`.
- The change is a pure comment/typo fix inside a doc file — read the docs-only gate below (10 seconds) and move on; don't run checklists that exercise nothing.

## 1. The evidence ladder

Evidence comes in exactly three rungs. Climbing one rung never substitutes for the rung above it.

### Rung 1 — CI green (lint + vitest + build): the floor, never the ceiling

CI (`.github/workflows/ci.yml`, single `Build` job, Node 20) runs `npm run lint`, `npm test`, `npm run build`. The build step injects **dummy env values** (`AUTH0_CLIENT_ID: 'dummy'`, `BUNNY_API_KEY: 'dummy'`, `KV_REST_API_URL: 'https://example.com'`, etc. — see ci.yml lines 41–51) whose only job is to keep module-load code from throwing. CI therefore proves:

- the code parses, lints, and type-flows through `next build`
- pure-logic invariants covered by vitest still hold

CI **cannot** prove anything about Bunny, Auth0, or Redis. It exercises zero integration reality — no request ever reaches a real service.

History proving the gap (verify with `git show -s --format="%h %s" 8e81183 3ddd10b`):

- **The TUS 401 saga** — `8e81183` "Fix TUS upload 401: revert to seconds expiry, trim env values". The upload-signing code built green; the SHA256 signature was silently corrupted by an untrimmed env value and a wrong expiry unit, and every real upload got HTTP 401. Only a real upload against real Bunny exposed it.
- **The player.js silent failure** — `3ddd10b` "Fix resume playback: resolve player.js constructor correctly". The resume wrapper built green; under webpack interop the `Player` constructor was on `mod.default.Player`, not `mod.Player`, so resume silently never attached. Playback still worked, so nothing errored — only watching a video on the deployed site and noticing it didn't resume revealed it.

Both passed builds. Both only surfaced in real use. That is why rung 1 is a floor.

### Rung 2 — vitest pure-logic tests: protects invariants

`npm test` runs `vitest run` over `lib/__tests__/*.test.js` (three files as of 2026-07-10: `auth.test.js`, `order.test.js`, `theme.test.js`). These protect:

- **Auth matching** (`isAdmin`): case-insensitive match against `ADMIN_EMAILS`, rejects falsy input. A regression here is a lockout or a privilege leak.
- **Ordering** (`applyOrder`): unordered (new) videos float to the top newest-first; saved order follows; ghost ids ignored; every video returned exactly once. This is why a fresh upload appears at the top of the homepage.
- **Theme validation** (`isValidHex`, `normalizeTheme`, `hexToRgba`, `themeVars`): only `#rrggbb` accepted, invalid input falls back to defaults — the guard that keeps a bad palette from breaking every page's CSS.

Rung 2 proves logic, not wiring. A perfect `applyOrder` test says nothing about whether `/api/videos` can reach Bunny.

### Rung 3 — deployed manual E2E: the ONLY proof for integration

Anything touching Bunny, Auth0, Redis, uploads, or playback is proven **only** by exercising the deployed site (Vercel production) with real accounts and real videos. The checklists in §3 are the procedures. If a change class requires E2E and nobody ran it, the change is **not done**, whatever CI says.

## 2. Acceptance gates by change class

Classes match `change-control` (a change spanning classes takes the union of gates). These encode the maintainer's three hard rules: never risk admin lockout, never break upload/playback, ask before user-visible changes.

| Change class | Required evidence before "done" |
|---|---|
| Auth/access-touching (admin gate, viewer allowlist, Auth0 config, session/idle) | **Written lockout analysis BEFORE push** (below) + CI green + E2E: admin-gate checklist §3.6 and a sign-in as both admin and viewer |
| Signing/upload/playback-touching (lib/bunny.js, upload API, TUS flow, embed URLs, player) | CI green + **full upload E2E (§3.1) AND playback E2E (§3.2) on the deployed site. No exceptions.** |
| User-visible UI (anything a viewer or admin sees) | **Maintainer approval BEFORE shipping** (screenshot or one-paragraph description) + CI green + eyeball the affected page deployed |
| Dependency bump | CI green + smoke the affected surface. If the bump touches `tus-js-client`, `player.js`, or `next`/`react` it moves the signing/upload/playback surface → run the FULL upload (§3.1), playback (§3.2), and resume (§3.3) E2E, because a broken build passes CI but upload/playback only prove out on the deployed app (change-control's stricter dependency gate governs) |
| Docs-only | Review only. No checklist, no E2E. |

**Lockout analysis** (write it down — a paragraph in the commit message or PR description counts):

1. Enumerate who could be denied access after this change (admins? approved viewers? share recipients?).
2. Prove the admin path survives: trace how an `ADMIN_EMAILS` account still reaches `/admin` after the change.
3. Check the failure mode: if the new check errors at runtime, does it fail open or locked?
4. **Never gate on `email_verified`.** Auth0 here has no mail server, so no account can ever verify — enforcing it locks out everyone including admins. Disable sign-ups instead (session record, 2026-07-10, maintainer-confirmed).

## 3. Manual E2E checklists

Run these against the **deployed** site. Each step pairs an action with the observation that proves it. If an observation doesn't match, stop and switch to `debugging-playbook`. A tester needs: one admin account (email in `ADMIN_EMAILS`), one approved-viewer account, one non-approved account, and a small test video file.

### 3.1 Upload (required for any signing/upload change)

1. Sign in as admin, open `/admin` → the admin page loads with the **Videos** tab active.
2. Drag a small video file onto the dropzone → dropzone highlights; hint changes to "Selected: *filename*".
3. Click **Upload** → button reads "Uploading N%" and a progress bar climbs from 0 to 100. (Under the hood: `POST /api/admin/upload` creates the Bunny record and returns a TUS signature; the browser streams bytes directly to `https://video.bunnycdn.com/tusupload`.)
4. When the bar completes → upload controls reset, and the new video appears in the Video Library list with a **"Processing N%"** badge (Bunny status 0–3; the page auto-re-polls every 4 s while any video is still encoding).
5. Wait for encoding → the badge disappears (status 4). A **"Failed"** badge (status 5/6) means the E2E failed — investigate.
6. Confirm the new video sits at the **TOP** of the admin library list (unordered videos float to the top, newest first — `applyOrder`).
7. Open the homepage as a viewer → the new video appears at the top of the grid/list there too.
8. Failure sidebar: if step 3 dies with "Upload failed (HTTP 401)", that is the TUS-signature class of bug (`8e81183`) — check `BUNNY_LIBRARY_ID`/`BUNNY_API_KEY` in Vercel for stray whitespace before touching code. The **Retry** button resumes the same TUS upload; **Cancel/Discard** aborts and deletes the half-created Bunny record.

### 3.2 Playback (required for any signing/playback change)

1. From the homepage, click any video → lands on `/watch/video/{id}` and the video plays inside a Bunny iframe.
2. Inspect the iframe `src` → it points at `iframe.mediadelivery.net/embed/{libraryId}/{videoId}` and the URL contains `token=`, `expires=`, and `autoplay=false`. Missing token/expires means signing is broken even if playback appears to work (the Bunny library may not be enforcing token auth — still a failure).
3. Video actually plays with sound when you press play.

### 3.3 Resume / continue-watching

1. Play a video for **at least 15 seconds** with DevTools Network open → observe `POST /api/progress` firing roughly every 8 seconds (client throttles saves to one per 8 s of playback).
2. Reload the page → playback resumes near where you left off (resume only triggers when saved position > 5 s and not within the last 10 s of the video — a 10-second test clip will NOT resume; use a longer video).
3. Go to the homepage → a **Continue watching** card for that video appears with a partial progress bar (cards show only positions > 5 s and < 95 % of duration).
4. Silent-failure check (the `3ddd10b` class of bug): if playback works but never resumes and the console shows "ResumablePlayer: player.js Player constructor not found", the player.js interop broke again. Playback degrading gracefully is by design — which is exactly why only this checklist catches it.

### 3.4 Share links

1. In `/admin` → Videos tab, on any video row enter a **second account's** email and click **Create link** → a URL of the form `{site}/watch/{shareId}` appears with a copy button.
2. Open the link signed in as the **WRONG** account (not the recipient email) → page shows the generic message "This link isn't valid for your account…" with a "Log out and try a different account" button. **It must NOT reveal the intended recipient's email.** If it does, that is a privacy regression — fail.
3. Open the link as the **correct** account → the video plays.
4. Back in `/admin` → Shares tab → that link's badge has flipped from "Not viewed" to **"Viewed"** (first view is recorded, preserving the link's remaining TTL).
5. Click **Revoke** → link disappears from the list. Reload the share URL → "This link has expired or does not exist." Revocation is immediate.

### 3.5 Thumbnails

1. With `BUNNY_CDN_HOSTNAME` set in Vercel → homepage renders the **grid** view and thumbnail images load in-app. (Unset, `getThumbnailUrl` returns `''` and the homepage falls back to the text **list** view — that fallback is by design, not a bug.)
2. Copy a thumbnail's direct URL and paste it into a fresh browser tab → **403 is EXPECTED** — Bunny referrer protection blocks direct loads; images loading in-app while direct paste 403s is correct behavior, not a failure (session record, 2026-07-10, maintainer-confirmed).

### 3.6 Admin gate (required for any auth/access change)

1. Sign in as an approved **non-admin** viewer and browse to `/admin` → server-side redirect straight to the homepage. The admin shell must **never render**, not even for a flash (the gate is in `getServerSideProps`, not client-side).
2. As the same non-admin, probe an admin API — e.g. `fetch('/api/admin/videos')` from the console → HTTP **403** `{"error":"Forbidden"}`.
3. Sign in as an admin → `/admin` loads normally. (This half of the check is the lockout guard — always run both directions.)

### 3.7 Palette

1. In `/admin` → Settings → Appearance, pick a preset or edit a hex field → the whole page live-previews the new accent colors immediately.
2. Click **Save palette** → button flips to "Saved!". Invalid hex (not `#rrggbb`) is rejected with an alert before any request is made.
3. Load the site in an incognito window or as another account → pages show the **new** palette. On a repeat load in that same window there is **no flash** of old colors (an inline script in `_document.js` applies the last-known palette from localStorage before first paint). A brief default-palette flash on a truly first-ever visit is expected — localStorage is empty until `/api/theme` responds once.

### 3.8 Rate limit (light-touch — do not sustain)

1. From a signed-in session, fire a quick burst at `/api/videos` (e.g. paste a 70-iteration `fetch` loop in the console — the limit is a sliding window of 60 requests per 10 s per caller per route) → later requests return HTTP **429** `{"error":"Too many requests — slow down."}`.
2. **Then stop.** Wait ~10 s and confirm one normal request succeeds again. Note: the limiter fails **open** on backend errors — a burst that never 429s could mean the limiter can't reach Redis, which is worth a look, not a shrug.

### 3.9 Push notifications (required for any `lib/push.js`, SW push, or subscribe/broadcast change)

Requires `NEXT_PUBLIC_VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` set in Vercel and a redeploy — with keys absent the whole feature is inert by design (button hidden, routes 503), so there is nothing to E2E and CI green is the gate. With keys set:

1. **Opt in.** As an approved viewer on the homepage, the **"Notify me"** button shows. Click it → browser permission prompt → grant → button flips to "Notifications on". (Chrome/Edge desktop or Android. iOS only exposes push to an **installed** PWA — add to home screen first.)
2. **Auto-announce.** Keep `/admin` open on the Videos tab, upload a video, and let it finish encoding (the admin poll is the announce trigger). When the processing badge clears (status 4) the subscribed device gets **one** "New video available" notification. Re-poll/refresh must **not** produce a second one (the `pvp:announced_videos` SADD guard). Clicking it opens `/watch/video/<id>`.
3. **Manual broadcast.** `/admin` → Settings → Notifications → type a message → **Send broadcast** → the status line reports "Sent to N devices" and subscribed devices receive it.
4. **Targeting + pruning.** A removed viewer stops receiving sends even if still subscribed (targeting reads the live approved set). Revoke a subscription at the OS/browser level, broadcast again → the send response's `pruned` count reflects the dead endpoint being HDEL'd from `pvp:push_subs:{email}`.
5. **Degradation.** Confirm the admin video list still loads normally even if a send would fail — announce is wrapped best-effort and must never break the listing (Decision 10 in `architecture-contract`).

## 4. Writing tests

- Runner: `npm test` → `vitest run`, `environment: 'node'`. Tests live in `lib/__tests__/*.test.js` (config includes `lib/**/*.test.js`).
- Dummy env comes from `vitest.config.js`: `ADMIN_EMAILS: 'admin@example.com, second@example.com'`, plus dummy `KV_REST_API_URL`/`KV_REST_API_TOKEN` so importing modules that construct the Redis client doesn't throw. **Auth tests depend on those exact ADMIN_EMAILS values** — change the config string and `auth.test.js` breaks.
- House rules (follow the three existing files):
  - **Pure logic only.** No network calls, no Redis client construction in test scope, no mocking of fetch. If the code under test needs a live service, it belongs in a §3 checklist, not a vitest file.
  - `describe`/`it`/`expect`, one behavior per `it`, plain synchronous assertions.
  - Test through the public export of the `lib/` module; build tiny literal fixtures inline (see `order.test.js`'s `vid()` helper).
- New shared logic in `lib/` SHOULD land with a test in the same commit — that is the existing bar.
- Page components and API handlers are currently **untested** (they are integration-heavy: sessions, Redis, Bunny). Do not pretend otherwise. Adding a handler-test harness (mocked req/res + mocked lib layer) is a **candidate improvement**, not an existing practice — if you add one, say so explicitly rather than presenting it as convention.
- Remember you cannot run vitest locally (no Node) — push and let CI run it, per `change-control`'s CI-is-the-alarm workflow.

## 5. Definition of done

A change is done when ALL of these hold, and you state them explicitly:

1. **CI green** on the commit as it landed (lint + test + build).
2. **Class-appropriate E2E executed** — name the checklist(s) and the step numbers actually performed ("ran §3.1 steps 1–8 and §3.2 on production, 2026-07-10"), not "tested it".
3. **Changelog entry** if the change is user-visible and being released (see `change-control` §4 — internal fixes historically ship without one).
4. **An honest statement of what was NOT verified.** Every done-claim carries its residual risk: "did not test resume on mobile Safari", "did not re-run share-link E2E, share code untouched". Unverified-and-said-so is acceptable; unverified-and-implied-verified is how the TUS 401 and player.js bugs shipped.

## Provenance & maintenance

- **Ground truth read on 2026-07-10:** `.github/workflows/ci.yml`, `vitest.config.js`, `package.json`, `lib/__tests__/{auth,order,theme}.test.js`, `lib/{auth,bunny,ratelimit}.js`, `pages/admin.js`, `pages/index.js`, `pages/watch/[shareId].js`, `pages/watch/video/[id].js`, `pages/api/{videos,progress}.js`, `pages/api/admin/{upload,share}.js`, `components/ResumablePlayer.js`, `pages/_app.js`, `pages/_document.js`. Commits `8e81183` and `3ddd10b` verified via `git show`.
- **Session-record facts** (2026-07-10, maintainer-confirmed): no local Node on the maintainer machine; Auth0 has no mail server so `email_verified` must never be enforced; thumbnail direct-URL 403 is referrer protection and expected.
- **Maintain by re-verification:** every checklist step maps to specific code cited above. When that code changes, re-read it and update the matching step — do not patch a checklist from memory. If a checklist step's expected observation stops matching reality, treat the *skill* as the bug until proven otherwise, then fix whichever is wrong.
- Numbers that will drift: 4 s encode re-poll, 8 s progress-save cadence, 5 s/95 % resume thresholds, 60-per-10 s rate window, 72 h default / 720 h cap share TTL, Bunny status codes 0–6. Each lives in exactly one source file listed above.
- Siblings: `change-control` (whether/how a change lands), `diagnostics-and-tooling` (measurement commands), `debugging-playbook` (when a check fails), `run-and-operate` (releases), `research-methodology` (evidence discipline).
