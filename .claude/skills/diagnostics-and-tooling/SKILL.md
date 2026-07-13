---
name: diagnostics-and-tooling
description: Measurement-first diagnostics for the Marine Video Portal — load when you need to check scanner alerts (Dependabot, CodeQL), CI run status or failed-step logs, Bunny Stream connectivity or TUS upload signatures, remote git truth, production liveness, or to gather before/after evidence before changing anything. Covers the gh CLI full-path invocations, git ls-remote, the public /api/theme smoke test, browser Network-tab evidence protocols for uploads and resume, and ready-to-run scripts (check-alerts.ps1, watch-ci.ps1, verify-bunny-env.ps1, sign-tus.js).
---

# Diagnostics & Tooling — measure, don't eyeball

(as of 2026-07-10)

This skill is the measurement toolbox. Every claim about this system — "CI is green",
"the alerts are patched", "uploads work" — must trace to a command output, an HTTP
status, or a Network-tab observation. Run the command, paste the number. If you did
not measure it, say so explicitly.

**Environment facts you need first** (session record, 2026-07-10, maintainer-confirmed):

- gh CLI is installed but **off-PATH**. Always invoke it by full path:
  `& "C:\Program Files\GitHub CLI\gh.exe" ...` — it is already authenticated as
  `MarineTeam`.
- **No local Node** on the maintainer machine. Node scripts here cannot be run
  locally; they run in CI, on Vercel, or on any other machine with Node.
- Repo: `MarineTeam/Marine-Video-Portal-1`. CI workflow file is
  `.github/workflows/ci.yml`, workflow display name `CI` (verified in the repo).
- Shell is PowerShell 5.1. **Quoting trap:** an argument containing embedded double
  quotes gets mangled on the way to a native exe, which silently breaks jq filters
  like `select(.state=="open")`. Every command below avoids embedded `"` in jq
  (state filtering moves into the URL as `?state=open`). Verified live 2026-07-11.

## When NOT to use this skill

- **You are about to change something.** This skill only observes. Process and
  approval live in change-control; fix workflows live in debugging-playbook.
- **The question is answered by reading the repo.** "What does signTusUpload hash?"
  — read `lib/bunny.js`, don't call Bunny.
- **You need Bunny API semantics** (status codes' meanings, encoding states,
  endpoint catalog) — that's bunny-reference. This skill only proves connectivity
  and credentials.
- **You are deciding what to do about alerts.** Measuring alert counts is here;
  triage and patch strategy are security-currency-campaign.
- **You want to run the app locally.** There is no local Node; see run-and-operate
  and build-and-env. Nothing in this skill starts a server.
- **The output would leak secrets into a transcript or commit.** The Bunny
  commands need the real API key; treat their output as sensitive and never paste
  the key, full signatures for still-valid windows, or share tokens.

## Measurement command cookbook

Expected-output blocks below marked "real output" were captured live against this
repo on 2026-07-11; treat the specific numbers as examples, not current state —
re-measure, don't reuse.

### CI: latest run id and conclusion

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run list --repo MarineTeam/Marine-Video-Portal-1 --workflow=ci.yml --limit 1 --json databaseId,conclusion,status,displayTitle
```

Expected output (real output, 2026-07-11):

```json
[{"conclusion":"success","databaseId":29069160341,"displayTitle":"Patch Dependabot alerts: bump next to 14.2.35, vitest to 3.2.6","status":"completed"}]
```

`conclusion` is empty while `status` is `queued`/`in_progress`.

### CI: watch a run to completion

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run watch <databaseId> --repo MarineTeam/Marine-Video-Portal-1 --exit-status
```

Expected: live-updating step list, then exits 0 on success / non-zero on failure.
(Standard gh subcommand; not exercised at authoring time — no run was in progress.)

### CI: failed-step logs only

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run view <databaseId> --repo MarineTeam/Marine-Video-Portal-1 --log-failed
```

Expected: only the log lines of failed steps (`Lint`, `Test`, or `Build` — the three
gating steps in ci.yml). Empty output means nothing failed. (Standard gh subcommand;
not exercised at authoring time — latest run had succeeded.)

### Dependabot: open alerts, summarized

Proven in this repo. Note `?state=open` in the URL — do NOT use
`select(.state=="open")` in the jq from PowerShell (quoting trap above).

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" api "repos/MarineTeam/Marine-Video-Portal-1/dependabot/alerts?state=open&per_page=100" --paginate --jq '.[] | {number, package: .security_vulnerability.package.name, severity: .security_vulnerability.severity, patched: .security_vulnerability.first_patched_version.identifier, summary: .security_advisory.summary}'
```

Expected output, one JSON object per alert (real output excerpt, 2026-07-11 — 14
open alerts, all `next`, every fix version in the 15.x major):

```json
{"number":19,"package":"next","patched":"15.5.16","severity":"low","summary":"Next.js's Middleware / Proxy redirects can be cache-poisoned"}
{"number":14,"package":"next","patched":"15.5.16","severity":"high","summary":"Next.js vulnerable to server-side request forgery in applications using WebSocket upgrades"}
...
```

Empty output = zero open alerts. Non-zero exit = token scope or Dependabot not
enabled — read the stderr message before concluding anything.

### CodeQL: open alerts

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" api "repos/MarineTeam/Marine-Video-Portal-1/code-scanning/alerts?state=open&per_page=100" --paginate --jq '.[] | {number, rule: .rule.id, severity: .rule.severity, path: .most_recent_instance.location.path, line: .most_recent_instance.location.start_line}'
```

Expected output (real output, 2026-07-11 — 3 open alerts):

```json
{"line":202,"number":9,"path":"lib/bunny.js","rule":"js/insufficient-password-hash","severity":"warning"}
{"line":178,"number":8,"path":"lib/bunny.js","rule":"js/insufficient-password-hash","severity":"warning"}
{"line":52,"number":7,"path":"lib/bunny.js","rule":"js/insufficient-password-hash","severity":"warning"}
```

Context: those three flag the SHA256 *signing* hashes in `lib/bunny.js` (TUS
signature, CDN token, embed token) — Bunny's protocol dictates SHA256 there; they
are not password hashes. Whether/how to dismiss them is a
security-currency-campaign decision, not yours to make while measuring.

### Remote truth: what is actually on origin

Never argue from local state; ask the remote.

```powershell
git ls-remote origin refs/heads/main "refs/tags/*"
```

Expected output (real output excerpt, 2026-07-11):

```
739c54f773b4349ce155259012f4e71a6ee59943  refs/heads/main
0785a3010609a3ad99748ea06f3fe4861cd8acbc  refs/tags/v1.0.0
...
07d496531f190c43bbe2489221952bcb377a5d68  refs/tags/v1.5.0^{}
```

Annotated tags show twice; the `^{}` line is the commit the tag points at.

### Production smoke test — no login needed

`GET /api/theme` is the **only unauthenticated endpoint** (verified in
`pages/api/theme.js`: GET is public so the palette loads on the login page). A 200
proves the whole serving path end-to-end: DNS → Vercel → Next.js → Upstash Redis
(the handler does a live `redis.get`).

```powershell
Invoke-RestMethod -Uri "https://<production-domain>/api/theme"
```

Expected output (shape from `lib/theme.js`; values are whatever the admin last saved,
defaults shown):

```
accent1  accent2
-------  -------
#2dd4bf  #3b82f6
```

The production domain is not committed to the repo — read it from the Vercel
dashboard or the `AUTH0_BASE_URL` env var (session record, 2026-07-10). A 500 here
usually means Redis env/connectivity; a timeout means Vercel/DNS. (Command shape
verified by inspection against `pages/api/theme.js`; not executed at authoring time
— production URL not recorded in the session.)

### Bunny API connectivity (needs the real key — output is sensitive)

```powershell
Invoke-RestMethod -Uri "https://video.bunnycdn.com/library/$env:BUNNY_LIBRARY_ID/videos?page=1&itemsPerPage=1" -Headers @{ AccessKey = $env:BUNNY_API_KEY }
```

Expected: HTTP 200 with `totalItems`, `itemsPerPage`, and an `items` array of at most
one video object (title, guid, status...). **401 = bad/mismatched key. 404 = wrong
library id.** Treat the response as sensitive (video titles + guids) and never echo
the key. Prefer `scripts/verify-bunny-env.ps1` below — it adds the whitespace check
and never prints the key. (Endpoint shape matches `lib/bunny.js listVideos`; the
401 path was exercised live with dummy credentials 2026-07-11; the 200 path needs
the real key.)

### Browser-side evidence: uploads (admin)

The upload path is two hops; evidence for each lives in DevTools → Network:

1. `POST /api/admin/upload` → expect **200** with JSON
   `{videoId, libraryId, signature, expires, title}` (from
   `pages/api/admin/upload.js`). 403 = not admin; 429 = rate-limited; 502 = Bunny
   createVideo failed server-side.
2. Requests to `https://video.bunnycdn.com/tusupload` (tus-js-client, see
   `pages/admin.js` — the creation POST carries request headers
   `AuthorizationSignature`, `AuthorizationExpire`, `VideoId`, `LibraryId`, then
   PATCH requests stream the bytes). Expect **201** on creation and **204** on
   PATCHes. **401 on the tusupload POST while step 1 returned 200** is the classic
   signature corruption — go straight to `verify-bunny-env.ps1` and
   `sign-tus.js`.

### Browser-side evidence: resume / watch progress

From `components/ResumablePlayer.js` (verified): at player setup one
`GET /api/progress?videoId=<guid>`; during playback one `POST /api/progress` roughly
every 8 seconds (8000 ms throttle at line 78) with body
`{videoId, seconds, duration, title}` → expect **200** `{"ok":true}` each time.
No POSTs while playing = player.js never attached (playback still works by design).
401/403 = not logged in / not an approved viewer.

## Scripts

All in `scripts/` next to this file. Run PowerShell scripts as:
`powershell -ExecutionPolicy Bypass -File <path>`. Each script's header comment
carries its own usage and honest verification status; summary:

| Script | Purpose | Exit codes | Verification status |
|---|---|---|---|
| `check-alerts.ps1` | One-shot summary of open Dependabot + CodeQL alerts (tables + severity counts, graceful "None.") | 0 queries ok, 1 a query failed, 2 no gh | **Executed end-to-end 2026-07-11**: 14 Dependabot + 3 CodeQL, matching the GitHub UI |
| `watch-ci.ps1` | Latest ci.yml run: report conclusion, or watch a live run to completion; non-zero on failure | 0 success, 1 failed run, 2 query error | **Executed 2026-07-11** (already-completed fast path, exit 0). Live-watch branch is a standard gh call, not exercised |
| `verify-bunny-env.ps1` | Flags edge whitespace in Bunny creds (TUS-401 killer, commit 8e81183), then live-tests the trimmed key. Never prints the key | 0 pass, 1 whitespace/non-200, 2 missing input | **Executed 2026-07-11**: missing-input, whitespace-flag (U+000A detected), and Bunny 401 paths live-tested; only the HTTP-200 path is by inspection (needs the real key) |
| `sign-tus.js` | Recompute the TUS signature exactly as `lib/bunny.js signTusUpload` does, to diff against server output when debugging upload 401s | 0 printed, 2 bad input | **Verified by inspection** (Node not installed on authoring machine); formula mirrored from `lib/bunny.js`; runs where Node is available |

`sign-tus.js` workflow for a TUS 401: capture `{signature, expires, videoId,
libraryId}` from the `POST /api/admin/upload` response in the Network tab, then run
`node sign-tus.js <libraryId> <apiKey> <videoId> <expires>` somewhere Node exists.
Same signature = env values match your local copy (look at expiry/clock instead);
different signature = the deployed env differs (whitespace, stale deploy, wrong
library).

## Evidence discipline

- **Before/after numbers for every fix claim.** "Patched the alerts" means:
  open-alert count before (`check-alerts.ps1`) → change → count after. "Fixed CI"
  means: run id + conclusion before and after. "Fixed uploads" means: the failing
  HTTP status before, the 200/201/204 chain after.
- **Paste expected vs actual.** Every command above has an expected-output block;
  when reality differs, quote both. The diff IS the finding.
- **If you didn't measure it, say so.** "Should work", "probably green" are not
  results. This skill's own scripts model that: each carries an explicit
  verification status, including what was NOT exercised.
- **One measurement per claim.** A 200 from `/api/theme` proves serving+Redis; it
  does not prove login, playback, or uploads. Match the probe to the claim.
- For turning a hunch into a tested hypothesis (one variable at a time, stop
  rules), load **research-methodology**. For what evidence a change class needs
  before you may call it done, load **validation-and-qa**.

## Provenance & maintenance

- Authored 2026-07-11 (task dated 2026-07-10) directly from repo ground truth:
  `.github/workflows/ci.yml` (workflow name `CI`), `lib/bunny.js` (signing
  formulas), `pages/api/theme.js`, `pages/api/progress.js`,
  `pages/api/admin/upload.js`, `pages/admin.js` (TUS headers, lines 187–195),
  `components/ResumablePlayer.js` (8000 ms throttle, line 78), and commit
  `8e81183` (TUS-401 whitespace/seconds fix).
- Facts marked "(session record, 2026-07-10, maintainer-confirmed)" — gh full
  path and auth, no local Node, production URL location — came from the
  maintainer session and cannot be re-derived from the repo; re-confirm them if
  the machine changes.
- All gh/git commands marked "real output" were executed 2026-07-11 on the
  maintainer machine; commands marked "not exercised" or "by inspection" are
  labeled as such inline — keep that honesty when editing.
- Re-verify this file when any of these move: the CI workflow file/name, the
  signing formulas in `lib/bunny.js`, the public-GET status of `/api/theme`, the
  TUS header set in `pages/admin.js`, the gh install path, or Node becoming
  available locally (which would let `sign-tus.js` be executed and its status
  upgraded).
- Siblings: run-and-operate (start/operate the app), debugging-playbook (fix
  workflows), security-currency-campaign (alert triage/patch strategy),
  validation-and-qa (acceptance evidence), research-methodology (hypothesis
  protocol), bunny-reference (Bunny API semantics).
