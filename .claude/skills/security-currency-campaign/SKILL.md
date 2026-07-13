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

**CodeQL:** 6 findings fixed across commits 40f4feb and eb4bcdd — inline GUID validation in `lib/bunny.js` (must stay inline, see fence 3), ReDoS-prone email regex replaced with string operations (`indexOf`/`lastIndexOf`) in `pages/api/admin/viewers.js`, and `permissions: contents: read` scoped in `.github/workflows/ci.yml`. **3 alerts remain open intentionally** — #7, #8, #9, rule ~"insufficient hash effort" — false positives on the three vendor-mandated SHA256 signing formulas. They are pending **manual dismissal in the GitHub UI** (maintainer declined automated dismissal). Dismissal text to use, verbatim: reason **"False positive"**, note **"HMAC-style API signing token required by bunny.net, not a password hash."**

**Dependabot:** 6 alerts fixed via commit 739c54f (next ^14.2.35, eslint-config-next ^14.2.35, vitest ^3.2.6 — all confirmed in `package.json`). **14 alerts deferred**: patched only in Next 15.x, and verified unreachable because every vulnerable feature is absent from this codebase — no `middleware.js`, no `app/` directory, no `i18n` config, no `next/image`, no `next/script`, no WebSocket usage, no `rewrites()`. The Phase 1 greps re-verify this on demand.

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

**EXPECTED (as of 2026-07-10):** exactly **3 rows** — alerts #7, #8, #9, rule ~insufficient hash effort, all in `lib/bunny.js` — **or 0 rows** if the maintainer has completed the manual dismissal. Either is healthy.

- **If the 3 are still open** → remind the maintainer of the pending UI dismissal (reason "False positive", note "HMAC-style API signing token required by bunny.net, not a password hash."). Do NOT dismiss via API — maintainer declined automation here.
- **If you see a NEW rule id or a new file path** → stop; triage via Phase 1 before anything else.

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

**Q4 — False positive?** Especially anything touching the three signing formulas in `lib/bunny.js` → dismiss with a recorded reason (see the exact dismissal text in Campaign state / Phase 0.2). **NEVER "fix" a hash-strength finding by changing the algorithm** — fence 2, hard rule #2. That breaks upload and playback against the bunny.net contract.

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
- `npx @next/codemod@latest upgrade` exists as candidate migration tooling — confirm it applies to this project before relying on it (requires Node).
- Enumerate breaking changes affecting specifically: (a) Pages Router APIs this repo uses, (b) `next.config.js` being wrapped by `withSentryConfig` — **verify `@sentry/nextjs` ^7.120.3 compatibility with Next 15; a Sentry major bump is likely required (VERIFY, do not assume)**, (c) `eslint-config-next` major bump and any lint-rule churn.
- Output of G1: a written breaking-change list with a verdict per item (affects us / doesn't). No list, no G2.

**G2 — Execute on branch:** bump `next`, `eslint-config-next` (and Sentry if G1 said so) on `next-15`; run the codemod if G1 confirmed it applies; push. **EXPECTED:** CI install+build pass, or a finite enumerated failure list from G1. Fix loop: one failure class per commit, re-push, re-watch. Unexpected failure class not on the G1 list → go back to G1 and extend the research before hacking at it.

**G3 — Runtime gate:** deploy a branch preview. Vercel auto-previews non-main branches — **verify this is enabled before relying on it**: push the branch, then check the Vercel dashboard for a preview deployment attached to `next-15`. On the preview URL, run the FULL validation-and-qa E2E checklists: upload, playback, resume, share, thumbnails, admin gate, palette. All pass or G3 fails.

**G4 — Ship:** maintainer approval (change-control) → merge to main → watch CI and the prod deploy → **EXPECTED: Phase 0 Dependabot count drops from 14 to 0 `next` alerts** → tag the release per run-and-operate.

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
4. **Dismiss-the-3-FPs housekeeping** — the pending manual CodeQL dismissals from Phase 0.2; pure hygiene, maintainer-driven.
5. **Branch protection requiring the CI check on `main`** — closes the "Vercel deploy races CI" gap (Vercel deploys on push; CI green is currently advisory). Needs maintainer approval — it changes the maintainer's own push workflow.

---

## Provenance & maintenance

- **Verified against the repo on 2026-07-11** (campaign facts dated 2026-07-10 per the session record): `package.json` versions (next ^14.2.35, react 18.3.1, @auth0/nextjs-auth0 ^3.5.0, @sentry/nextjs ^7.120.3, @upstash/redis ^1.34.0, @upstash/ratelimit ^2.0.5, eslint-config-next ^14.2.35, vitest ^3.2.6); `.github/workflows/ci.yml` (`permissions: contents: read`, Node 20, dummy build env); `lib/bunny.js` (three SHA256 signing formulas + inline GUID guards); `pages/api/admin/viewers.js` (string-op email validation); `next.config.js` (withSentryConfig wrap, no i18n, no rewrites); all seven feature-absence greps clean in `pages components lib`; commits 739c54f, eb4bcdd, 40f4feb present in history.
- **Session-record facts** (maintainer statements, alert counts, the near-lockout, the declined automated dismissal) are attributed "(session record, 2026-07-10, maintainer-confirmed)" and cannot be re-derived from the repo — treat them as authoritative until the maintainer says otherwise.
- **Update triggers:** re-stamp the expected numbers in Phase 0 whenever alerts are fixed/dismissed/added; record the G1 research answers (React requirement, Sentry compatibility) in Phase 3 the moment they are learned; mark Phase 3 complete and rewrite the Campaign state block when Next 15 ships; strike Phase 4 options once one is chosen.
- **Siblings:** change-control (approval gates referenced throughout), validation-and-qa (the G3/Phase-4 E2E checklists), diagnostics-and-tooling (alert commands and scripts), config-and-data (the three env mirrors), failure-archaeology (the full stories behind the fence box), architecture-contract (the invariants the fences protect).
