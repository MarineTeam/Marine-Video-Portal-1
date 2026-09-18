---
name: security-currency-campaign
description: Load when handling Dependabot alerts, CodeQL alerts, dependency upgrades or version bumps, npm audit findings, the Next.js 15 migration, adding email delivery (Resend/SendGrid/share notifications), or planning any security hardening for Marine Video Portal. The flagship campaign plan — decision-gated phases from alert sitrep through triage, patch cadence, the Next 15 major, email, and the hardening backlog, with expected alert counts and fenced-off wrong paths.
---

# Security & Currency Campaign

**North star: production hardening.** The maintainer's named live problem (session record, 2026-07-10, maintainer-confirmed): *"using latest versions of software, email. Secure code. Making sure CodeQL and Dependabot are mostly satisfied."*

This is a multi-session campaign, not a task. Every session that touches security or versions starts at Phase 0 and moves forward only through the gates. Commands are copy-pasteable; run them from the repo root `C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1`. The gh CLI is off-PATH: always call it as `& "C:\Program Files\GitHub CLI\gh.exe"` (PowerShell) or `"/c/Program Files/GitHub CLI/gh.exe"` (Git Bash). It is authed as MarineTeam. There is **no local Node** (as of 2026-07-10) — anything needing npm runs in CI or must be marked as such.

## When NOT to use this skill

- Feature work, UI changes, bug fixes with no dependency or alert dimension — use the relevant feature/architecture skills instead.
- Auth0 login/session *behavior* changes — that is architecture-contract territory; this skill only touches Auth0 as a peer-dependency constraint and as the thing email must NOT be wired into.
- Incident response for a live outage — stabilize first (see run-and-operate / failure-archaeology), then return here for the postmortem hardening item.
- Rotating credentials or editing env values — see config-and-data; this skill only tells you *which* env vars a change needs, not how to manage them.

---

## ⛔ WRONG PATHS — FENCED. Read before doing anything else.

These are not style preferences. Each fence exists because the path is known-destructive (details in failure-archaeology):

1. **NEVER enforce `email_verified`** in any auth gate, callback, or middleware. The Auth0 tenant has **no mail server**; verification emails are never sent, so `email_verified` is false for everyone → enforcing it locks out ALL users including admins. This nearly happened (session record, 2026-07-10, maintainer-confirmed). App-level email delivery (Phase 4) is a completely separate concern and does not change this rule.
2. **NEVER change the SHA256 signing formulas in `lib/bunny.js`** to a "stronger" hash to satisfy a scanner. The three formulas (`signTusUpload`, `signVideoToken`, the `getThumbnailUrl` token) are **vendor-mandated by bunny.net** — they are HMAC-style API signing tokens, not password hashes. Changing the algorithm breaks upload, playback, and thumbnails instantly. The correct response to scanner noise here is dismissal as false positive (Phase 0/1), never a "fix".
3. **NEVER refactor the inline GUID guards in `lib/bunny.js` into a shared helper function.** CodeQL's dataflow analysis does not recognize helper-function sanitizers; extracting them reopens the SSRF-pattern alerts. This was learned the hard way — commit eb4bcdd exists precisely to inline them. They stay inline.
4. **NEVER bump to Next 15 directly on `main`.** The migration is Phase 3 and runs on branch `next-15` behind its own gates. A direct bump on main deploys an unvalidated major to production (Vercel deploys main automatically).
5. **NEVER add a `middleware.js` to "mitigate" the deferred Next.js alerts.** The 14 deferred Dependabot alerts are deferred *because* the vulnerable features (middleware among them) are absent. Adding middleware expands the attack surface and invalidates the entire deferral analysis in one move.

---

## Campaign state (as of 2026-07-10, verified in-session)

**CodeQL:** 6 findings fixed across commits 40f4feb and eb4bcdd — inline GUID validation in `lib/bunny.js` (must stay inline, see fence 3), ReDoS-prone email regex replaced with string operations (`indexOf`/`lastIndexOf`) in `pages/api/admin/viewers.js`, and `permissions: contents: read` scoped in `.github/workflows/ci.yml`. **Open alerts, re-checked 2026-09-18: five — #7, #8, #9, #11, #12.** All triaged false positives; all pending **manual dismissal in the GitHub UI** (maintainer declined automated dismissal).

- **#7, #8, #9, and now #12** — rule ~"insufficient hash effort", all in `lib/bunny.js` (lines 86, 212, 263, 291). Four instances of the same vendor-mandated SHA256 signing family, not password hashes. Fence 2 governs: never "fix" these.
- **#11** — rule ~"Polynomial regular expression used on uncontrolled data", `lib/videoMeta.js:83`. Triaged 2026-09-18, see below.
- **#10** (rule ~SSRF, `components/SharePlayer.js:22`) — **no longer listed as of 2026-09-18**, so the maintainer has dismissed it. Its rationale is kept in this file in case the rule re-fires.

Dismissal text for #7/#8/#9 **and #12**, verbatim: reason **"False positive"**, note **"HMAC-style API signing token required by bunny.net, not a password hash."**

#12 (`lib/bunny.js:263`, added ~2026-09-14, triaged 2026-09-18) is the CDN thumbnail token — `sha256(key + path + expires)` base64-encoded, byte-identical in shape to the one already flagged at line 212. It is a fourth instance of a formula family already triaged, not a new problem, and fence 2 forbids "fixing" it.

Dismissal text for #11, verbatim: reason **"False positive"**, note **"Measured linear, not polynomial: 400,000 characters parse in ~1ms with flat scaling. The ambiguous `\s*[-–—:]?\s*` is never backtracked into because the pattern ends `(.*)$`, which cannot fail; the timestamp prefix is bounded to ~8 characters. Reachable only via POST /api/admin/videos, gated by requireCapability('videos:manage'), and bounded by the 1mb body limit."**

Rationale, and the method worth reusing (`lib/videoMeta.js:83`, rule ~polynomial regex, added ~2026-09-14, triaged 2026-09-18). The regex is
`/^(\d{1,2}(?::\d{1,2}){1,2})\s*[-–—:]?\s*(.*)$/` and the flag is *understandable* — `\s*[-–—:]?\s*` is two unbounded runs around an optional character, which is quadratically ambiguous in isolation. It is nonetheless unreachable, for two independent reasons:

1. **Measured, not reasoned.** Timed at 1k / 10k / 100k / 400k characters across five input shapes chosen to exploit the ambiguity (timestamp + long whitespace + label; whitespace with no label; whitespace either side of the dash; a failing prefix with a long tail; all whitespace). Flat linear throughout — ~0.8-1.5ms at 400,000 characters, a 400x size increase. **Do not skip this step and argue from the pattern alone**; the same reasoning applied to fable-video's `isValidEmail` regex in the same session produced a confident wrong answer twice before measurement settled it.
2. **Mechanism that explains the measurement.** The pattern ends `(.*)$`, which cannot fail, so once the bounded timestamp prefix matches the remainder matches on the first attempt and the engine never backtracks into the ambiguous region. The prefix `\d{1,2}(?::\d{1,2}){1,2}` is fully bounded (~8 characters), so a non-matching prefix fails immediately.

**Not "uncontrolled data" either.** The only production path is `lib/videoMetaStore.js:52` <- `pages/api/admin/videos.js:76`, whose first statement is `requireCapability(req, res, 'videos:manage')`. CodeQL treats `req.body` as untrusted without modelling the guard. Input is further bounded by Next's default 1mb body limit, output by `MAX_CHAPTERS = 100` and `MAX_CHAPTER_LABEL = 120`.

**If you do decide to change it anyway**, note that the sanctioned local precedent is the one in the Campaign state above: the ReDoS-prone email regex in `pages/api/admin/viewers.js` was replaced with `indexOf`/`lastIndexOf` string operations, not with a "cleverer" regex.

Dismissal text for #10, verbatim: reason **"False positive"**, note **"Client-side fetch() to a fixed-prefix same-origin relative path (`/api/share/` + shareId); shareId cannot redirect the request to another host, and server-side it's only ever used as a Redis lookup key, never to construct an outbound request."** Rationale: the flagged `fetch()` runs in the browser (a `useEffect` in a React component), not on the server, so "server-side request forgery" doesn't apply by definition; and even read as a generic untrusted-URL check, the literal `/api/share/` prefix means `shareId` is confined to a path segment and can never turn the string into a protocol-relative or cross-origin URL. Checked the server counterpart (`pages/api/share/[shareId]/track.js`) too — `shareId` is only ever used as a Redis lookup key (`getShare(shareId)`), never to build an outbound request. No code changed; this is the same class of scanner noise as #7-#9, just a different rule.

**Phase 3 (Next 15) EXECUTED 2026-09-17** — see the entry below and `failure-archaeology` #9. `next ^14.2.35 → ^15.5.25`, `eslint-config-next ^14.2.35 → ^15.5.25`, `@sentry/nextjs ^7.120.3 → ^10.75.0`; React stays 18.3.1 and `@auth0/nextjs-auth0` stays v3 (both verified sufficient). `npm audit` went **9 findings (1 critical, 6 high, 2 moderate) → 3 (1 high, 2 moderate)** — and all 3 are the *same* postcss advisory counted three times as it propagates up the chain `postcss → next → @auth0/nextjs-auth0`, so there is exactly one root cause left. What remains, and why it is not closable by this phase:
- **`postcss <=8.5.22` (high, 4 advisories)** — bundled *by `next` itself* through `16.3.0-preview.10`, so it is only fixed by **Next 16.3.x**. Next 16 requires `@auth0/nextjs-auth0` v4 (v3 peers stop at `^15.2.3`), and v4 is middleware-based — which **fence 5 forbids** and the README calls a deliberate architectural choice. So this is not a version bump; it is an auth-architecture decision. Build-time only, not reachable from a request.
- ~~`@vitest/mocker` (moderate)~~ — **closed in the same PR**: `vitest ^3.2.6 → ^4.1.11`. Dev-only and never shipped, so the major carried no runtime risk; all 294 tests pass on v4.
**Old note, still true for the original 14:** **Dependabot:** 6 alerts fixed via commit 739c54f (next ^14.2.35, eslint-config-next ^14.2.35, vitest ^3.2.6 — all confirmed in `package.json`). **14 alerts deferred**: patched only in Next 15.x, and verified unreachable because every vulnerable feature is absent from this codebase — no `middleware.js`, no `app/` directory, no `i18n` config, no `next/image`, no `next/script`, no WebSocket usage, no `rewrites()`. The Phase 1 greps re-verify this on demand.

---

## PHASE 0 — SITREP (run first, EVERY session)

Get the current alert picture before touching anything.

**0.1 Open Dependabot alerts** (PowerShell):

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" api "repos/MarineTeam/Marine-Video-Portal-1/dependabot/alerts?state=open&per_page=100" --paginate --jq '.[] | [.number, .dependency.package.name, .security_advisory.severity, (.security_vulnerability.first_patched_version.identifier // "none"), .security_advisory.summary] | @tsv'
```

**EXPECTED (as of 2026-07-10):** exactly **14 rows**, every package `next`, every first-patched version a **15.x** identifier. If you see that, the deferral holds — no action, proceed to whatever brought you here.

- **If a row shows a package other than `next`** → NEW alert. Stop; triage it via Phase 1 before anything else.
- **If a `next` row shows a patched version within 14.2.x** → patchable now; go to Phase 2.
- **If the count is below 14 with no new packages** → Next 15 migration may have shipped or alerts were dismissed; check `git log` and the alert `dismissed_reason` fields, then update this skill's expected numbers.

**0.2 Open CodeQL alerts** (PowerShell):

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" api "repos/MarineTeam/Marine-Video-Portal-1/code-scanning/alerts?state=open&per_page=100" --paginate --jq '.[] | [.number, .rule.id, .rule.severity, .most_recent_instance.location.path] | @tsv'
```

**EXPECTED (as of 2026-09-18):** exactly **5 rows** — #7, #8, #9, #12 (rule ~insufficient hash effort, all in `lib/bunny.js` at lines 86, 212, 291, 263) and #11 (rule ~polynomial regex, `lib/videoMeta.js:83`) — **or fewer** as the maintainer completes manual dismissals. Any subset of these five is healthy; anything else is new.

Note how the count moved, because it is the shape to expect again: #10 came off the list (dismissed), and #11 and #12 appeared ~2026-09-14. **A rising count is not automatically a regression** — CodeQL periodically flags additional instances of a formula family it already flagged, which is exactly what #12 is. Check whether a new alert is a new *location of a known pattern* before treating it as a new *problem*.

- **If #7, #8, #9, or #12 are still open** → remind the maintainer of the pending UI dismissal (reason "False positive", note "HMAC-style API signing token required by bunny.net, not a password hash."). Do NOT dismiss via API — maintainer declined automation here.
- **If #11 is still open** → same treatment, dismissal text in Campaign state above (reason "False positive", note re: measured-linear regex behind `videos:manage`).
- **If a NEW alert appears on a rule id already listed here, at a new line inside `lib/bunny.js`** → it is almost certainly a fifth instance of the vendor-signing family. Confirm the flagged expression is a bunny.net signing formula (compare it against the four at lines 86, 212, 263, 291), then treat it exactly like #7/#8/#9/#12 — same dismissal text, no code change, fence 2 applies.
- **If you see a NEW rule id, or a file path outside `lib/bunny.js` and `lib/videoMeta.js`** → stop; triage via Phase 1 before anything else.

**Gate P0:** you can state the exact open counts and account for every line. Anything unexplained → Phase 1 now.

---

## PHASE 1 — TRIAGE PROTOCOL (decision tree for any new alert)

Run each new alert through these questions **in order**. Do not skip to fixing.

**Q1 — Is the vulnerable code path reachable?** Run the feature-absence greps (Git Bash, from repo root). These are the campaign's standing evidence for the 14-alert deferral; scope them to app code (`pages components lib`) — do NOT grep the whole repo, or you'll false-positive on the skill docs in `.claude/skills/` that mention these features:

```bash
ls middleware.js                                  # expect: No such file or directory
ls app/                                           # expect: No such file or directory
grep -n "i18n" next.config.js                     # expect: no output (exit 1)
grep -rn "next/image" pages components            # expect: no output (exit 1)
grep -rn "next/script" pages components           # expect: no output (exit 1)
grep -rni "websocket" pages components lib        # expect: no output (exit 1)
grep -n "rewrites" next.config.js                 # expect: no output (exit 1)
```

All seven clean (as of 2026-07-10, verified). If an alert's vulnerable feature is one of these and the grep is still clean → **unreachable**, go to Q3 (defer). If a grep now HITS in app code, the deferral for that feature is void — treat the alert as reachable and continue to Q2.

**Q2 — Is it patched within the current major (^14.2.x for next, or a compatible semver bump for anything else)?** → **Bump now**, CI-gated, via Phase 2. This is the happy path.

**Q3 — Patched only in the next major?** → **Document and defer.** Record here (in this skill, under Campaign state): alert number, package, why unreachable (cite the specific grep from Q1 as evidence), and which future migration closes it (usually Phase 3). A deferral without a reachability argument is not a deferral, it's neglect.

**Q4 — False positive?** Especially anything touching the four signing formulas in `lib/bunny.js` (lines 86, 212, 263, 291) → dismiss with a recorded reason (see the exact dismissal text in Campaign state / Phase 0.2). **NEVER "fix" a hash-strength finding by changing the algorithm** — fence 2, hard rule #2. That breaks upload and playback against the bunny.net contract.

**Gate P1:** after triage, every open alert count from Phase 0 must be explained line-by-item: fixed, deferred-with-evidence, or dismissed-with-reason. No "misc".

---

## PHASE 2 — CURRENCY CADENCE (monthly patch-line audit)

Purpose: stay current *within* the 14.2.x line (and within-major for everything else) without waiting for alerts.

**2.1 Check for newer patch releases.** The canonical command (**requires Node or CI — no local Node as of 2026-07-10**):

```bash
npm view next versions --json | grep '"14\.2\.'
```

Node-free fallback that works on this machine today (PowerShell, hits the npm registry directly):

```powershell
(Invoke-RestMethod https://registry.npmjs.org/next).versions.PSObject.Properties.Name | Where-Object { $_ -like '14.2.*' } | Select-Object -Last 5
```

**EXPECTED (as of 2026-07-10):** latest 14.2.x is 14.2.35 and `package.json` already carries `^14.2.35`. If a newer 14.2.x exists → bump.

**2.2 Bump.** Edit `package.json` (next AND eslint-config-next move together on the same 14.2.x version). A within-14.2.x patch bump follows the normal direct-to-`main` flow — there is no PR gate in this repo (see change-control §3.1). No local `npm install` is possible, so the lockfile-free flow is: commit → push → let CI's `npm install` resolve.

**2.3 CI watch.**

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run watch --repo MarineTeam/Marine-Video-Portal-1
```

**EXPECTED: green** — install, lint, test, build all pass (ci.yml runs Node 20, builds with dummy env values; verified 2026-07-10).

- **If `npm install` fails with ERESOLVE** → check the `@auth0/nextjs-auth0` peer-dependency range FIRST (currently ^3.5.0; this peer conflict is the historical gotcha recorded in README common issues). Do not `--force` past it — resolve the actual range or hold the bump.
- **If build fails** → read the CI log, fix on the branch, re-push. Never merge red.

**2.4 Merge → confirm Vercel prod deploy is healthy → re-run Phase 0** to confirm alert counts moved as predicted.

**Gate P2:** CI green after the push, Phase 0 numbers re-verified after the Vercel deploy. A within-14.2.x patch bump is not a user-visible change, so it needs no maintainer approval. (The Next 15 *major* is the exception — Phase 3 runs on a branch and does require approval.)

---

## PHASE 3 — NEXT 15 MIGRATION (the deferred debt; largest single item)

Closing the 14 deferred Dependabot alerts requires the Next 15 major. This is the biggest planned change in the campaign. It is gate-locked; do not start G2 until G0 and G1 are fully passed.

**G0 — Preconditions (all must hold):**
- Node installed locally, OR the maintainer explicitly accepts CI-only iteration (every fix attempt costs a full CI round-trip — slower, but workable).
- Work happens on branch `next-15`. **NEVER on main** (fence 4).
- Maintainer informed before starting: this is a user-visible-risk change (change-control gate).

**G1 — Research gate (VERIFY-FIRST; do not assert any of this from memory):**
- Read the official upgrade guide at nextjs.org/docs (App Router *and* Pages Router upgrade sections — this repo is Pages Router).
- **Confirm the React version requirement for Pages Router on Next 15.** Do NOT assume Next 15 forces React 19 for Pages Router — verify against the guide, then **record the answer in this skill** so future sessions don't re-research it.
  - **ANSWERED 2026-09-17 — React 19 is NOT required.** `next@15.5.25`'s own `peerDependencies` are `react: ^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0` (same for 16.3.5). The upgrade guide's "minimum versions of react and react-dom is now 19" line is written for the App Router and is contradicted by the package metadata. **Confirmed empirically**: the migration shipped on `react`/`react-dom` 18.3.1 pinned, and `npm run build` compiled successfully. Do not re-research; do not bump React as part of a Next upgrade unless a build actually fails.
- `npx @next/codemod@latest upgrade` exists as candidate migration tooling — confirm it applies to this project before relying on it (requires Node).
- Enumerate breaking changes affecting specifically: (a) Pages Router APIs this repo uses, (b) `next.config.js` being wrapped by `withSentryConfig` — **ANSWERED 2026-09-17: a Sentry major bump IS required.** `@sentry/nextjs@7.120.4` peers `next: ^10.0.8 || ^11.0 || ^12.0 || ^13.0 || ^14.0` and hard-fails install against Next 15 with ERESOLVE. Sentry 8.55.2, 9.47.1 and 10.75.0 all peer `^15.0.0-rc.0`; the migration took **^10.75.0** to match both sibling repos and the "latest versions" north star. Two consequences: the root `withSentryConfig` export is deprecated (import from `@sentry/nextjs/config` instead, it is dropped in v11), and **Sentry 9+ no longer reads `sentry.client.config.js`** — browser init moves to `instrumentation-client.js` (which must also export `onRouterTransitionStart`), and `instrumentation.js` must `register()` the server/edge configs per `NEXT_RUNTIME`. Both files now exist; `sentry.client.config.js` was deleted, (c) `eslint-config-next` major bump and any lint-rule churn.
- Output of G1: a written breaking-change list with a verdict per item (affects us / doesn't). No list, no G2.

**G2 — Execute on branch:** bump `next`, `eslint-config-next` (and Sentry if G1 said so) on `next-15`; run the codemod if G1 confirmed it applies; push. **EXPECTED:** CI install+build pass, or a finite enumerated failure list from G1. Fix loop: one failure class per commit, re-push, re-watch. Unexpected failure class not on the G1 list → go back to G1 and extend the research before hacking at it.

**G3 — Runtime gate:** deploy a branch preview. Vercel auto-previews non-main branches — **verify this is enabled before relying on it**: push the branch, then check the Vercel dashboard for a preview deployment attached to `next-15`. On the preview URL, run the FULL validation-and-qa E2E checklists: upload, playback, resume, share, thumbnails, admin gate, palette. All pass or G3 fails.

**WHAT ACTUALLY HAPPENED (2026-09-17/18) — this gate did not run as written, and the record should say so rather than imply otherwise.**

- Branch previews ARE enabled (confirmed — a preview attached to the branch within seconds of each push). But **Vercel Deployment Protection SSO-gates preview URLs**, so an agent cannot probe one from outside: every request 302s to `vercel.com/sso-api`. A human logged into Vercel browses it normally. Plan for that: preview-based G3 is a human step here, not an automatable one.
- Rather than run the checklists on the preview, the maintainer **promoted the branch deployment straight to production** (see run-and-operate §5, rank 1, and its forward-promotion rule). Next 15 then served production for ~16 hours before the merge, which is stronger evidence that the major works than any preview could give — but it inverted the gate: the change shipped first and was validated after.
- What that made verifiable, and was verified against live production: **deny-by-default holds on the Next 15 build.** `/admin` → 307 to `/api/auth/login`; `/api/videos`, `/collections`, `/progress`, `/me` → 401; `/api/admin/viewers`, `/videos`, `/settings` → 403; `/api/manifest` → 200 (public by design); `/` and `/activity` → 200 with `"pageProps":{}`, carrying no video/title/guid/email keys. Because production is not SSO-gated, this part *is* agent-checkable — reuse it.
- **What was NOT verified, and still is not: upload (§3.1) and resume (§3.3).** Those are precisely the two documented silent-failure modes (the TUS 401 saga; the player.js interop bug where playback works but resume never attaches). They need a human on the deployed site with real content. `validation-and-qa` §3 is explicit that a `next` bump requires them, so **Phase 3 is shipped but not fully evidenced** — recorded here per that skill's own rule that unverified-and-said-so is acceptable and unverified-and-implied-verified is how those two bugs shipped.

**Lesson for the next major:** the gate assumed preview → validate → merge. Reality was promote → validate-what-you-can → merge. If that is the real workflow, rewrite G3 around production rather than the preview, and keep the E2E items as an explicit human checklist instead of a gate an agent can claim to have passed.

**G4 — Ship:** maintainer approval (change-control) → merge to main → watch CI and the prod deploy → **EXPECTED: Phase 0 Dependabot count drops from 14 to 0 `next` alerts** → tag the release per run-and-operate.

**DONE 2026-09-18:** PR #26 squash-merged as `5235b70`. Note the ordering was inverted — production already ran Next 15 via the forward promotion, so the merge's job was reconciling `main` with the live state and closing the divergence, not shipping. Re-run Phase 0 to confirm the 14 `next` alerts are actually gone; that number has not been re-checked since the merge.

**ROLLBACK (if prod breaks post-merge):** `git revert` the merge commit and push, AND/OR promote the previous deployment in the Vercel dashboard (instant, no build). Then reopen at G1 with the new failure recorded.

---

## PHASE 4 — EMAIL DELIVERY (the maintainer's named gap)

Constraint framing first: the Auth0 tenant has **no mail server, and that's fine**. What's wanted is **app-level email** (e.g., sending share links from `pages/api/admin/share.js` — file exists, currently copy-link only). App-level email ≠ Auth0 verification email. **`email_verified` stays UNENFORCED regardless of what gets built here** — hard rule #1, near-lockout history (session record, 2026-07-10, maintainer-confirmed).

Ranked menu:

**Option 1 — Resend (RECOMMENDED).** API-based, free tier ~100 emails/day (verify current limits at resend.com before promising), no SMTP anywhere. Steps:
1. Maintainer creates the Resend account (account creation is a maintainer action, not yours).
2. Verify a sending domain, or start with Resend's test sender for the E2E gate.
3. Add `RESEND_API_KEY` to the env mirrors per config-and-data: Vercel prod (real value), a dummy in `ci.yml`'s build env so module-load code can't throw in CI, and a dummy in `vitest.config.js`'s `test.env` if any test imports the sender module. (A local `.env.local` is only needed to run the app locally.)
4. Extend `pages/api/admin/share.js` to *optionally* send the share link by email (opt-in parameter; copy-link behavior unchanged when absent).
5. Audit-log every send (same audit path the admin endpoints already use).
6. **E2E gate:** send a share email to yourself, verify it is received AND the contained link plays the video. No pass, no ship.

**Option 2 — SendGrid.** Same shape, heavier setup (sender identity verification, larger SDK). Choose only if the maintainer has an existing SendGrid relationship.

**Option 3 — Status quo (manual copy of share links).** **Explicitly acceptable.** Email is an enhancement, not an emergency; do not treat its absence as a defect to rush.

**Fences for this phase:** do NOT wire Auth0 SMTP or verification email as part of this work — out of scope, and the verification path stays dead by design. Do NOT auto-send email without the maintainer approving the template first — email is user-visible output (change-control gate).

---

## PHASE 5 — HARDENING BACKLOG (north star; all items are CANDIDATES, ranked)

None of these are commitments; each needs its own change-control approval. Ranked by value-per-risk:

1. **Activate Sentry** — code already shipped and inert (`next.config.js` wraps `withSentryConfig`; runtime reporting waits on `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN`, verified 2026-07-10). Set the DSN pair in the env mirrors and redeploy. Cheapest observability win available.
2. **Rate-limit `/api/progress`** — the only unlimited write path (`@upstash/ratelimit` ^2.0.5 is already a dependency; reuse the existing limiter pattern).
3. **Redis backup/export routine** — Upstash backup features or a scheduled export. **VERIFY Upstash's current backup offering for this plan tier before promising anything** (as of 2026-07-10, unverified).
4. **Dismiss-the-FPs housekeeping** — the pending manual CodeQL dismissals from Phase 0.2 (#7, #8, #9, #12 hash; #11 polynomial regex); pure hygiene, maintainer-driven. Count is five as of 2026-09-18; #10 is already done.
5. **Branch protection requiring the CI check on `main`** — closes the "Vercel deploy races CI" gap (Vercel deploys on push; CI green is currently advisory). Needs maintainer approval — it changes the maintainer's own push workflow.

---

## Provenance & maintenance

- **Verified against the repo on 2026-07-11** (campaign facts dated 2026-07-10 per the session record): `package.json` versions (next ^14.2.35, react 18.3.1, @auth0/nextjs-auth0 ^3.5.0, @sentry/nextjs ^7.120.3, @upstash/redis ^1.34.0, @upstash/ratelimit ^2.0.5, eslint-config-next ^14.2.35, vitest ^3.2.6); `.github/workflows/ci.yml` (`permissions: contents: read`, Node 20, dummy build env); `lib/bunny.js` (three SHA256 signing formulas + inline GUID guards); `pages/api/admin/viewers.js` (string-op email validation); `next.config.js` (withSentryConfig wrap, no i18n, no rewrites); all seven feature-absence greps clean in `pages components lib`; commits 739c54f, eb4bcdd, 40f4feb present in history.
- **Session-record facts** (maintainer statements, alert counts, the near-lockout, the declined automated dismissal) are attributed "(session record, 2026-07-10, maintainer-confirmed)" and cannot be re-derived from the repo — treat them as authoritative until the maintainer says otherwise.
- **Update triggers:** re-stamp the expected numbers in Phase 0 whenever alerts are fixed/dismissed/added; record the G1 research answers (React requirement, Sentry compatibility) in Phase 3 the moment they are learned; mark Phase 3 complete and rewrite the Campaign state block when Next 15 ships; strike Phase 4 options once one is chosen.
- **2026-07-22 update:** CodeQL alert #10 (SSRF, `components/SharePlayer.js:22`) triaged as a false positive — see Campaign state and Phase 0.2 for the reasoning and dismissal text. No code changed. Expected CodeQL row count in Phase 0.2 moved from 3 to 4 accordingly.
- **2026-09-18 update:** alert list re-read from the GitHub UI. #10 is gone (maintainer dismissed it); #11 (polynomial regex, `lib/videoMeta.js:83`) and #12 (insufficient hash effort, `lib/bunny.js:263`) appeared ~2026-09-14. Both triaged false positives — #12 is a fourth instance of the vendor-signing family already covered by fence 2; #11 was **measured**, not argued (1k chars → 0.09ms, 400k chars → 0.81ms across five input shapes: flat linear, not polynomial). Expected CodeQL row count in Phase 0.2 moved from 4 to 5. No code changed.
- **Re-verified against the repo on 2026-09-18**, after the Next 15 major shipped: `package.json` now reads next ^15.5.25, eslint-config-next ^15.5.25, @sentry/nextjs ^10.75.0, vitest ^4.1.11; react/react-dom stay 18.3.1 and @auth0/nextjs-auth0 stays ^3.5.0 (both deliberate — see Phase 3). `.github/workflows/ci.yml` now pins **Node 24** on checkout@v5/setup-node@v5; Node 20 ships npm 10.9.x, whose arborist crashes with `Cannot read properties of null (reading 'edgesOut')` on this tree — do not lower it. `lib/bunny.js` now has **four** SHA256 signing formulas (a CDN thumbnail token was added at line 263 ~2026-09-14). The 2026-07-11 stamp above is kept as the historical record; where the two disagree, this one is current.
- **Siblings:** change-control (approval gates referenced throughout), validation-and-qa (the G3/Phase-4 E2E checklists), diagnostics-and-tooling (alert commands and scripts), config-and-data (the three env mirrors), failure-archaeology (the full stories behind the fence box), architecture-contract (the invariants the fences protect).
