---
name: failure-archaeology
description: Load before re-attempting any previously-tried fix or investigating why code is shaped oddly in Marine Video Portal — covers the TUS upload 401 saga, the email_verified near-lockout, silent resume-playback failure, the design revert wars, CodeQL sanitizer/false-positive quirks, deferred Next 15 Dependabot alerts, thumbnail 403s that aren't bugs, admin-gate revert history, and OneDrive git push failures. Consult when a bug report matches a past symptom, when tempted to "clean up" inline validation or signing code, when a push fails with permission errors, or before enforcing email verification.
---

# Failure Archaeology (as of 2026-07-10)

This is the chronicle of every major dead end, rejected fix, and revert in this
repository's history. Read it before re-attempting anything — several "obvious"
fixes below were tried, failed, and are marked **SETTLED — do not reopen**.

**How to use this file:** find your symptom in the index table at the bottom,
jump to the entry, and check the Status line before writing any code. Every
commit hash cited here was verified against git history on 2026-07-10; run
`git show <hash>` to see the full diff and commit message yourself.

**Status meanings:**
- **SETTLED — do not reopen**: the question is answered; re-litigating it wastes time or breaks things.
- **OPEN**: a live hazard with a known workaround but no permanent fix.
- **DEFERRED**: deliberately postponed with a documented rationale; owned elsewhere.

**Terms used below:**
- **TUS**: a resumable-upload HTTP protocol; bunny.net Stream uses it so browsers upload video files directly to `video.bunnycdn.com/tusupload` without proxying through our server.
- **CodeQL**: GitHub's static-analysis security scanner; it opens "alerts" on the repo's Security tab.
- **Dependabot**: GitHub's dependency-vulnerability scanner.
- **SSRF**: server-side request forgery — tricking a server into fetching an attacker-chosen URL.
- **webpack interop**: the translation layer webpack inserts when CommonJS and ES modules import each other; it often moves a library's real exports onto a `.default` property.
- **`getServerSideProps`**: Next.js Pages Router hook that runs on the server before a page renders — the only place a redirect can happen before any HTML reaches the browser.

## When NOT to use this skill

- **Live triage of a brand-new bug** with no matching symptom below — use the `debugging-playbook` skill instead.
- **Deciding whether a change needs maintainer approval** — that is the `change-control` skill (the rules there were forged by the incidents here, but the rules live there).
- **Working the Next 15 upgrade or new dependency alerts** — owned by the `security-currency-campaign` skill; entry 9 here only records why the deferral happened.
- **Looking up how Bunny signing formulas work** — see the `bunny-reference` skill; this file only records how they were mis-diagnosed.
- **General project orientation** — this file is failure history, not architecture documentation.

---

## 1. The TUS upload 401 saga

*The headline entry — this cost more time than any other incident (session record, 2026-07-10, maintainer-confirmed).*

**Symptom** | Every admin video upload failed with: `Upload failed (HTTP 401): tus: unexpected response... url: https://video.bunnycdn.com/tusupload`. Meanwhile `createVideo` (the plain REST call that registers the video before upload) worked fine — the failure was only on the TUS leg.

**Wrong paths tried** | Commit `54d1bcc` (2026-06-30 16:27) changed the signature expiry from Unix seconds to milliseconds on a hunch, asserting in its commit message that "Bunny TUS auth expects the AuthorizationExpire value as a Date.now()-based millisecond timestamp." Still 401. The hunch was exactly backwards — and it shipped as a confident-sounding "fix" five minutes before being reverted.

**Root cause (two-part)** |
1. Bunny TUS expiry must be a Unix timestamp in **SECONDS** (`Math.floor(Date.now() / 1000) + ttl`), as the vendor spec says.
2. Stray whitespace (a trailing newline or space) in the `BUNNY_API_KEY` / `BUNNY_LIBRARY_ID` environment variables corrupted the SHA256 signature. The maddening asymmetry: HTTP silently strips whitespace from header values, so the raw key in the `AccessKey` header still authenticated `createVideo` — but the same whitespace fed into the SHA256 hash produced a wrong signature, so TUS rejected it. One corrupted env value, two different outcomes.

**Evidence** | `ff36a97` (2026-06-30 16:22) first surfaced the real error text in the UI and console — before this, uploads just failed opaquely, and diagnosis was impossible. `54d1bcc` (16:27) is the wrong milliseconds fix. `8e81183` (16:32) is the real fix: revert to seconds, `.trim()` both env values before hashing, and widen the default signing window to 24h (`expiresInSeconds = 86400`). The fixed function is `signTusUpload` in `lib/bunny.js` (line 43 as of 2026-07-10).

**Status** | **SETTLED — do not reopen.** Expiry stays in seconds. The `.trim()` calls stay. If a TUS 401 ever recurs, check the env values in Vercel for whitespace *first*, and read Bunny's spec *before* forming hypotheses.

**Lessons** | (1) Read the vendor spec before hypothesizing — the seconds/milliseconds guess was checkable in one documentation lookup. (2) Env hygiene: always `.trim()` env values that feed cryptographic operations. (3) Make errors visible first: `ff36a97` (surfacing the real error) is what made the diagnosis possible at all; it landed *before* either fix attempt.

---

## 2. The email_verified near-lockout

*(session record, 2026-07-10, maintainer-confirmed — no commits exist because the change was canceled at the push step)*

**Symptom** | None yet — this was a disaster averted, not a disaster experienced. Recorded here because the same "fix" will look attractive again to anyone doing a security pass.

**Wrong path tried** | A security-hardening session added `isVerified()` enforcement (checking Auth0's `email_verified` claim) across all authenticated routes. It looked like a textbook improvement: don't trust unverified emails.

**Root cause of why it's wrong** | This Auth0 tenant has **no mail server configured**. Verification emails never send, so `email_verified` is `false` for **every user, permanently** — including the admin. Enforcing the claim locks out the entire user base with no self-service recovery. The maintainer caught this and canceled at the push step; nothing reached the remote.

**Evidence** | No commits (canceled pre-push). A memory note exists for assistant sessions (`no-email-verification.md` in the project memory directory); this skill entry is the durable record for anyone else.

**Status** | **SETTLED — do not reopen.** Never enforce `email_verified` in this codebase. The correct mitigation for unwanted accounts is **disabling sign-ups in the Auth0 tenant** (invite-only), which is the model this portal already uses.

**Lesson** | A security control that assumes infrastructure you don't have is an outage, not a control. Verify the claim's real-world value distribution before gating on it.

---

## 3. Resume playback silent failure

**Symptom** | The resume-playback feature (return to a video, resume where you left off) simply did nothing. No errors in the console, no failed network requests — the video just started from 0:00.

**Wrong path tried** | Assuming `mod.default` was the Player constructor. The original code did `Player = mod.default || mod.Player || mod` and then `new Player(iframe)` — which called `new` on the whole module namespace object.

**Root cause** | The `player.js` package exports `{ Player, Receiver, ... }`; under webpack interop that whole namespace lands on `module.default`, so the constructor is at `mod.default.Player` — one level deeper than assumed. Calling `new` on the namespace object threw, and the throw was swallowed by a bare try/catch, silently disabling resume while playback itself kept working. Silence was the real bug: the feature degraded invisibly.

**Evidence** | `3ddd10b` (2026-06-30 21:09) "Fix resume playback: resolve player.js constructor correctly". Read `components/ResumablePlayer.js` for the current code: interop resolution (`const ns = mod && mod.default ? mod.default : mod; const Player = (ns && ns.Player) || (mod && mod.Player)`), a prefetch of the saved position before player init, a fallback retry of the seek once playback starts, and `console.warn` instrumentation on both failure paths (constructor not found; init threw).

**Status** | **SETTLED.** The interop-resolution shape in `ResumablePlayer.js` is deliberate — don't "simplify" it back to `mod.default || mod`.

**Lesson** | Silent degradation needs at least a `console.warn`. Any catch block that disables a feature must say so somewhere observable.

---

## 4. The design revert wars (early era)

**Symptom** | Not a bug — a process failure. On 2026-06-30, two separate revert/reapply storms churned the repo within a single 22-minute window (15:28–15:50) because user-visible changes shipped without maintainer sign-off.

**The two chains (all hashes verified in git log)** |
- *Dark navy design chain*: `79975fb` (15:39) "Apply Marine Video Portal dark navy design" → `fd28c64` (15:42) revert → `1393375` (15:42) reapply → `1e25015` (15:43) revert. Three flips in four minutes.
- *readme-share-comment chain*: merge `1d96c8e` (15:28) → `bf016c5` (15:30) revert → `68123b4` (15:31) reapply → `06b7efd` (15:32) revert → `4e559b1` (15:34) reapply → `2333dc0` (15:35) revert. Five flips in seven minutes, producing commit subjects three "Reapply"s deep.

**Wrong path** | Shipping sweeping user-visible redesigns (`79975fb` touched 7 files, +432/−288 across every page) and merge decisions unilaterally, then thrashing revert/reapply while the maintainer and the session disagreed about what should stand.

**Resolution** | A fresh design — `206bbff` (15:50) "Redesign with modern glassmorphism theme" — written *with maintainer approval*, superseding the contested dark-navy work entirely. (`d4f0707` restored the prior "marine-video-hub" design system in between; note its author timestamp predates the chain because it re-applies earlier work, `9661fe7`.)

**Status** | **SETTLED.** The glassmorphism theme is the approved design baseline.

**Lesson** | This incident produced the standing **"ask before user-visible changes"** rule — see the `change-control` skill for the rule itself. Also note: every undo in these chains used `git revert` (and revert-of-revert), never history rewriting. That is the sanctioned pattern here (see entry 8).

---

## 5. CodeQL sanitizer shape

**Symptom** | CodeQL SSRF-pattern alerts on `lib/bunny.js` stayed open even after validation was added.

**Wrong path tried** | `40f4feb` (2026-07-09 21:16) added GUID validation via a shared `assertValidGuid()` helper called at the top of `updateVideoTitle`, `deleteVideo`, `deleteCollection`, and `setVideoCollection`. Functionally correct — a throwing helper absolutely sanitizes the input — but CodeQL kept the alerts open.

**Root cause** | CodeQL's SSRF sanitizer detection needs the guard **inline in the same function as the `fetch` call**. Its dataflow analysis does not trace that a helper which throws on bad input sanitizes the caller's variable.

**Evidence** | `eb4bcdd` (2026-07-09 21:21) "Inline the Bunny id validation so CodeQL recognizes it as a sanitizer" — deletes `assertValidGuid()` and inlines the identical `typeof id !== 'string' || !GUID_RE.test(id)` check directly before each fetch. Same behavior, different shape, alerts close. `GUID_RE` is defined at `lib/bunny.js` line 9.

**Status** | **SETTLED — do not reopen.** The inline guards in `lib/bunny.js` look like copy-paste begging for a DRY refactor. **Do not refactor them back into a helper** — that reopens the CodeQL alerts. A comment can't stop every future cleanup pass; this entry is the record of why the duplication is load-bearing.

**Lesson** | Static analyzers grade code shape, not just code behavior. When satisfying a scanner, match the shape it recognizes.

---

## 6. SHA256 "weak hash" false positives

**Symptom** | CodeQL alerts #7, #8, #9 flag three functions in `lib/bunny.js` as "insufficient computational effort" password hashing (plain SHA256, no salt/stretching).

**Why the alerts are wrong** | These are **not password hashes**. They are exact vendor-mandated signature formulas that Bunny's API requires to be plain SHA256:
- `signTusUpload` (line 43 as of 2026-07-10) — TUS upload authorization signature (entry 1).
- `getThumbnailUrl` (line 161) — thumbnail CDN token authentication.
- `signVideoToken` / `getEmbedUrl` (lines 199/206) — embed view token.

Switching to bcrypt/scrypt/argon2 is impossible: Bunny verifies the signature server-side with SHA256. "Fixing" the alert breaks upload and playback outright. (Formula details live in the `bunny-reference` skill.)

**Evidence** | The `40f4feb` commit message (2026-07-09) states the same conclusion: the three alerts "are false positives ... and should be dismissed on GitHub, not changed." Note the alert line numbers cited there (46/157/181) are pre-`eb4bcdd`; current lines are 43/161/199.

**Status** | **SETTLED on the code side — never change the algorithms.** The dismissal itself (marking the alerts false-positive in the GitHub Security tab) was **still pending as of 2026-07-10** — the maintainer declined automated dismissal and will click through the UI personally. If you see these alerts open, that is expected; do not write code in response.

**Lesson** | A scanner category ("password hashing") can misfile vendor-protocol crypto. Classify the alert before treating it.

---

## 7. Thumbnail direct-URL 403 — the "bug" that wasn't

*(session record, 2026-07-10, maintainer-confirmed)*

**Symptom** | Copy a signed thumbnail URL out of the app and paste it into the browser address bar → HTTP 403. The same URL loads fine inside the app. Looks exactly like a signing bug.

**Wrong path risk** | Diving into `getThumbnailUrl` token generation (entry 6's formula) to "fix" the signature. The signature is fine.

**Root cause** | Bunny's CDN hotlink protection is **referrer-based**. Inside the app, the browser sends a `Referer` header from the portal's origin and the CDN allows it. A direct address-bar paste sends no `Referer`, so the CDN returns 403 regardless of a valid token.

**Status** | **SETTLED — expected behavior, a feature not a bug.** It is the hotlink protection working as configured. Do not weaken the token or the referrer rule to make address-bar pastes work.

**Lesson** | Before debugging a 403, ask what differs between the working and failing request — here it was one header, not the code.

---

## 8. Admin gate revert/reapply

**Symptom** | `/admin` was only client-gated (a `useUser` check in React), so a logged-in non-admin could receive the admin UI shell — no data, since every `/api/admin/*` route returns 403, but still an information leak about the admin interface.

**Sequence (all on 2026-07-01, verified)** | `71f3aff` (13:30) added a `getServerSideProps` gate: check `getSession` + `isAdmin`, redirect unauthenticated users to login and non-admins home, keeping client checks and route 403s as defense in depth. → `be51f05` (13:33) reverted it — the maintainer wanted to compare with/without, not because the gate was wrong. → `b7f3f8d` (13:36) reapplied via revert-of-the-revert.

**Status** | **SETTLED — the gate stays.** `pages/admin.js` keeps its `getServerSideProps` gate. If you see the revert in history, it was a deliberate comparison, not a rejection.

**Lesson** | This is also the live demonstration of the sanctioned undo pattern in this repo: **revert the revert** (`git revert <revert-hash>`), never force-push or history rewriting. The full undo rules live in the `change-control` skill.

---

## 9. Dependabot Next-15 deferral

**Symptom** | 19 Dependabot alerts against `next` and `vitest`.

**What was done** | `739c54f` (2026-07-09) patched everything patchable on the 14.2.x line: `next` 14.2.30 → ^14.2.35 (+ matching `eslint-config-next`), closing 5 real alerts (Image Optimization cache-key confusion/content injection, middleware redirect SSRF, two Server Components DoS fixes), and `vitest` ^2.1.9 → ^3.2.6 (UI-server arbitrary-file-read; moot anyway since the script is headless `vitest run`).

**What was deliberately NOT done** | The remaining 14 alerts are only fixed in Next 15 — a major-version migration. Before deferring, the commit verified (greps recorded in the `739c54f` commit message) that **none of the vulnerable code paths exist in this app**: no `middleware.js`, no `app/` directory, no i18n config, no `next/image`, no `next/script`, no WebSocket handling, no `rewrites()`.

**Status** | **DEFERRED — owned by the `security-currency-campaign` skill.** Do not bundle a Next 15 migration into an unrelated change, and do not re-verify the greps from scratch without checking that skill first — but DO re-run the absence checks if the app has since grown any of those features, because the deferral rationale expires the moment one appears.

**Lesson** | "Deferred with verified non-exposure" is a legitimate security posture; "deferred silently" is not. The greps in the commit message are what make this deferral auditable.

---

## 10. OneDrive git locks

*(session record, 2026-07-10, maintainer-confirmed)*

**Symptom** | Intermittent `git push` failures: `unable to open loose object ... Permission denied`. Comes and goes with no code change.

**Wrong path tried** | Assuming repository corruption and reaching for `git fsck` / re-clone plans.

**Root cause** | The repo lives under a OneDrive-synced directory (`C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1`). OneDrive's sync client transiently locks files in `.git/objects` while syncing them, and git hits the lock.

**Fix** | Retry the push. It succeeds once OneDrive releases the lock (seconds).

**Status** | **OPEN hazard** — structural until the repo moves out of the OneDrive-synced tree. Until then: on this exact error, retry before diagnosing anything.

**Lesson** | Environment-induced flakiness mimics corruption. Check what else touches the files (sync clients, antivirus, indexers) before distrusting git.

---

## Index

| # | Incident | Status | One-line takeaway |
|---|----------|--------|-------------------|
| 1 | TUS upload 401 saga | SETTLED — do not reopen | Expiry in Unix seconds + `.trim()` env values; read the vendor spec before hypothesizing |
| 2 | email_verified near-lockout | SETTLED — do not reopen | Never enforce `email_verified` (no mail server → false for everyone); disable sign-ups instead |
| 3 | Resume playback silent failure | SETTLED | Constructor is at `mod.default.Player`; silent catch blocks must `console.warn` |
| 4 | Design revert wars | SETTLED | Ask before user-visible changes; resolved by approved glassmorphism redesign `206bbff` |
| 5 | CodeQL sanitizer shape | SETTLED — do not reopen | Keep GUID guards inline in `lib/bunny.js`; a shared helper reopens the alerts |
| 6 | SHA256 "weak hash" false positives | SETTLED (dismissals pending) | Vendor-mandated signatures, not password hashes; never change the algorithms |
| 7 | Thumbnail direct-URL 403 | SETTLED | Referrer-based hotlink protection working as designed — a feature, not a bug |
| 8 | Admin gate revert/reapply | SETTLED | The `getServerSideProps` gate stays; revert-the-revert is the sanctioned undo |
| 9 | Dependabot Next-15 deferral | DEFERRED | 14 alerts need Next 15; vulnerable features verified absent; owned by security-currency-campaign |
| 10 | OneDrive git locks | OPEN | "Permission denied ... loose object" on push = OneDrive lock; retry, don't re-clone |

---

## Provenance & maintenance

- **Compiled**: 2026-07-10, from read-only git history mining plus the maintainer's session records.
- **Verification**: every commit hash above was confirmed with `git show <hash>` / `git log --oneline --all` on 2026-07-10; dates and diff details come from the actual commits, not memory. Entries 2, 7, and 10 have no commits by nature (canceled pre-push / no code change / environment issue) and are attributed "(session record, 2026-07-10, maintainer-confirmed)".
- **Line numbers** (`lib/bunny.js` 43/161/199, etc.) are as of 2026-07-10 and will drift; the function names (`signTusUpload`, `getThumbnailUrl`, `signVideoToken`, `getEmbedUrl`) are the stable references.
- **Maintaining this file**: add a new entry whenever a fix is reverted, a diagnosis turns out wrong, or a deliberate "do nothing" decision is made — capture it while the wrong paths are still remembered. Use the same fields (Symptom / Wrong paths tried / Root cause / Evidence / Status) and add a row to the index. Change an entry's Status only with maintainer confirmation, and date-stamp the change.
- **Sibling skills**: `change-control` (the standing rules these incidents produced), `debugging-playbook` (live triage for new bugs), `security-currency-campaign` (owns entry 9's deferral), `bunny-reference` (the signing formulas behind entries 1, 6, and 7).
