---
name: change-control
description: Load before committing, pushing, reverting, releasing, tagging, or rolling back ANY change in this repo — it defines the change classes (docs / internal / UI / auth / signing / dependency), the gate each must pass, the three non-negotiables (never risk admin lockout, never break upload/playback, ask before user-visible changes), the direct-to-main push workflow where Vercel deploys independently of CI, the Changelog/tag/release runbook, and the revert-only rollback doctrine.
---

# Change Control — Marine Video Portal

How changes are classified, gated, reviewed, released, and rolled back in this repo. Written for someone with zero context on this project. Follow it as a runbook.

**One-paragraph orientation.** This is a private, invite-only video portal: Next.js 14 (Pages Router) + React 18, deployed on Vercel straight from GitHub `main` (`MarineTeam/Marine-Video-Portal-1`). Videos live on **bunny.net Stream** ("Bunny") — a video CDN the browser talks to directly via **TUS** (a resumable-upload protocol) and tokenized iframe embeds. Sign-in is **Auth0**; data is Upstash Redis. Node is NOT installed on the maintainer's Windows machine — all verification happens through GitHub Actions CI. The GitHub CLI is installed but off PATH; always call it as `& "C:\Program Files\GitHub CLI\gh.exe"` (as of 2026-07-10).

## When NOT to use this skill

| You actually want to… | Use sibling skill |
|---|---|
| Diagnose a bug or a failing behavior | `debugging-playbook` |
| Understand why past commits/reverts happened in depth | `failure-archaeology` |
| Learn the system's structure, data flow, invariants | `architecture-contract` |
| Look up Bunny API endpoints, signing formulas, embed params | `bunny-reference` |
| Change env vars, Redis keys, Vercel/Auth0 settings | `config-and-data`, `build-and-env` |
| Run, operate, or monitor the deployed site | `run-and-operate`, `diagnostics-and-tooling` |
| Execute the manual E2E test pass this skill keeps citing | `validation-and-qa` |
| Write or restructure docs | `docs-and-writing` |
| Triage CodeQL/Dependabot security findings | `security-currency-campaign` |
| Research an unfamiliar library or vendor behavior | `research-methodology` |

This skill is only the **process**: what gate a change must pass and how it lands, ships, and rolls back.

## 1. The three non-negotiables

Every rule below exists because of a specific incident in this repo's history. Learn the incident; the rule follows.

### 1.1 NEVER risk admin lockout

**Incident** (session record, 2026-07-10, maintainer-confirmed): a fix enforcing Auth0 `email_verified` was fully written, then canceled pre-push, because this Auth0 tenant has **no mail server** — verification emails are never sent, so `email_verified` is `false` for **every** user. Enforcing it would have locked out everyone, including the admin. The correct control on this tenant is disabling sign-ups, never verifying email.

**Rule:** any change touching auth or access control requires a **written lockout analysis** before push. Minimum contents:

- [ ] Who can be denied access after this change? Enumerate the user classes.
- [ ] Can the admin (emails in the `ADMIN_EMAILS` env var) still sign in if the new condition is false/missing for them? Prove it, don't assume it.
- [ ] Does the change depend on any Auth0 claim actually being populated on THIS tenant? (`email_verified` is false for everyone here — check what else might be.)
- [ ] If it locks you out anyway, what is the recovery path that does not require being signed in?

### 1.2 NEVER break upload/playback

**Incident — the TUS 401 saga** (verify: `git show -s ff36a97 54d1bcc 8e81183`):

1. `ff36a97` — uploads failed opaquely; first commit just surfaced the real error details.
2. `54d1bcc` — **wrong fix**: switched the TUS signature expiry to milliseconds, on the theory Bunny wanted `Date.now()`-style values. It doesn't.
3. `8e81183` — **real fix**: Bunny TUS expiry is a Unix timestamp in **seconds**, and env values must be `.trim()`ed — a stray newline in `BUNNY_API_KEY` is silently dropped from the `AccessKey` header (so video creation works) but corrupts the SHA-256 signature (so the upload 401s).

The three Bunny signing formulas in `lib/bunny.js` are **exact vendor contracts** (line numbers as of 2026-07-10, HEAD `739c54f`):

| Function | Line | Formula |
|---|---|---|
| `signTusUpload` | ~43 | SHA-256 hex of `libraryId + apiKey + expires(seconds) + videoId` |
| `getThumbnailUrl` | ~161 | SHA-256 base64-url of `tokenKey + path + expires` (CDN token auth) |
| `signVideoToken` / `getEmbedUrl` | ~199 | SHA-256 hex of `BUNNY_TOKEN_AUTH_KEY + videoId + expires` |

CodeQL flags these as "weak hashes." That is a **false positive**: they are not password hashes, they are Bunny's mandated URL-token scheme. Changing the algorithm, the field order, or the expiry unit breaks the product. Do not "fix" them.

**Rule:** any change touching signing, upload, or playback code needs **end-to-end upload + playback proof** before it's considered done — upload a real video through the admin panel and play it back as a viewer (procedure in `validation-and-qa`). CI cannot catch these: it builds with dummy Bunny credentials.

### 1.3 ASK before user-visible changes

**Incident — the design revert wars** (verify: `git log --oneline | Select-String "dark navy|readme-share-comment"`):

- "Dark navy design": `79975fb` (apply) → `fd28c64` (revert) → `1393375` (reapply) → `1e25015` (revert again). Four commits of churn because a look was imposed rather than proposed.
- The `fix/readme-share-comment` merge was reverted/reapplied **three times**: `1d96c8e` (merge) → `bf016c5` (revert) → `68123b4` (reapply) → `06b7efd` (revert) → `4e559b1` (reapply) → `2333dc0` (revert).

**Rule: propose, don't impose.** Anything a viewer or admin will *see* — layout, colors, wording, navigation, behavior of visible controls — gets described to the maintainer and approved **before** it is pushed. A screenshot or a one-paragraph description is enough. Silent UI pushes are how this repo accumulated six revert commits.

## 2. Change classification

Classify every change before touching code. A change spanning classes takes the **union** of gates (and the strictest class wins on approval).

| Class | Examples | Gates required |
|---|---|---|
| Docs-only | README, FEATURES.md, comments, this skill | CI green (runs on every push anyway) |
| Internal code | refactors, lib helpers, API internals, tests, no behavior change visible to users | CI green |
| User-visible UI | pages/, components/, styles/, wording, layout | CI green + **maintainer approval before push** (§1.3) + eyeball the deployed page |
| Auth-or-access-touching | Auth0 config/callbacks, admin gate, viewer allowlist, session/idle logic | CI green + **written lockout analysis** (§1.1) + maintainer approval + manual sign-in test as admin AND viewer |
| Signing-or-upload-touching | `lib/bunny.js`, TUS client code, embed/thumbnail URLs, related env handling | CI green + **E2E upload + playback proof** (§1.2, per `validation-and-qa`) + maintainer approval |
| Dependency bump | package.json version changes | CI green + read the dep's changelog for breaking changes + E2E upload/playback if the dep touches `next`, `tus-js-client`, or `player.js` |

**Changelog + release** is a separate, batching gate: user-visible features and fixes get a `Changelog` entry and eventually a version tag (§4); internal fixes and security patches historically do not (e.g. `40f4feb`, `eb4bcdd`, `739c54f` shipped with no version bump). One release can batch several commits.

## 3. How changes land

### 3.1 Workflow shape

- **Direct commits to `main`. There is no PR gate.** Branch protection is absent — confirmed `"protected": false` via the GitHub API (as of 2026-07-10), and the history shows it: 146 commits with only 5 merges, the last real PRs being #2/#3 early in the project. Everything since lands directly on `main`.
- **Small, feature-per-commit style.** One coherent change per commit; don't bundle a UI tweak with a dependency bump.
- **Commit message convention** (visible throughout `git log`): imperative subject line ("Add…", "Fix…", "Revert…"), then a body explaining **why** — see `8e81183` or `739c54f` for the house style. AI-assisted commits carry a trailer naming the model, e.g.:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```

### 3.2 CI is the alarm, not the gate

`.github/workflows/ci.yml` runs on every push/PR to `main`: `npm install` → `npm run lint` → `npm test` (vitest) → `npm run build`, on Node 20 with dummy env values so module-load code doesn't throw (as of 2026-07-10).

**Critical wrinkle:** `vercel.json` contains only `"git": { "deploymentEnabled": true }` — Vercel deploys **every push to `main` immediately and independently of CI**. A push that fails CI still reaches production. So:

1. Push.
2. **Immediately** watch CI (PowerShell):

   ```powershell
   & "C:\Program Files\GitHub CLI\gh.exe" run list --workflow=ci.yml --limit 1
   & "C:\Program Files\GitHub CLI\gh.exe" run watch <run-id> --exit-status
   ```

3. If CI goes red, treat it as a production incident, not a build inconvenience: the broken code is likely already deployed. Revert first (§5), investigate second.

Node is not installed on the maintainer's machine (as of 2026-07-10) — you cannot run lint/test/build locally. CI is the only automated verification; respect it accordingly and keep pushes small.

## 4. Release runbook

Verified against the live `Changelog` file, tags `v1.1.3`–`v1.5.0`, and the GitHub releases list (as of 2026-07-10; latest release is `v1.5.0 - Thumbnails & analytics`).

1. **Append a `Changelog` entry** (file `Changelog` at repo root, no extension). Match its exact bare format — a version line, then plain feature lines. **No bullets, no dates, no markdown, no blank separator lines:**

   ```
   v1.6.0
   Short user-facing description of feature one
   Short user-facing description of feature two
   ```

2. **Commit** with the exact house message (see `07d4965`, `e3f83dc`, `b778e5d`):

   ```powershell
   git add Changelog
   git commit -m "Update Changelog: v1.6.0"
   git push origin main
   ```

3. **Watch CI go green** (§3.2) before tagging.

4. **Annotated tag on the Changelog commit** — house convention since `v1.0.8`: the tag message is the short feature name, and the tag points at the "Update Changelog" commit (e.g. `v1.5.0` → `07d4965`):

   ```powershell
   git tag -a v1.6.0 <changelog-commit-sha> -m "Short feature name"
   git push origin v1.6.0
   ```

5. **GitHub release**, title format `vX.Y.Z - Short name` (matches `v1.5.0 - Thumbnails & analytics`, `v1.4.0 - Collections & resume playback`):

   ```powershell
   & "C:\Program Files\GitHub CLI\gh.exe" release create v1.6.0 --verify-tag --title "v1.6.0 - Short name" --notes "One-or-two-line summary of what shipped."
   ```

6. **Verify** both refs are on the remote:

   ```powershell
   git ls-remote origin refs/heads/main refs/tags/v1.6.0
   ```

## 5. Rollback doctrine

| Situation | Action |
|---|---|
| Uncommitted mess in working tree | `git status` to see what's there, then `git restore .` (add `git clean -fd` only after reviewing what it would delete with `git clean -nd`) |
| Committed but **not** pushed | `git reset --soft HEAD~1` is acceptable — history isn't shared yet |
| Committed **and pushed** | `git revert <sha>` — always. **NEVER force-push. NEVER `reset --hard` on shared history.** Vercel redeploys the revert automatically on push. |

**Reverting and reapplying is a proven, first-class pattern here** — not an embarrassment. Live example: `71f3aff` (add server-side admin gate to /admin) → `be51f05` (revert) → `b7f3f8d` (reapply — literally a revert of the revert: `git revert <revert-sha>`). Reverting buys time safely; the work is never lost, and `git revert` of the revert brings it back intact.

**Production emergency** — candidate procedure, not yet exercised (session-adjacent record, 2026-07-10): the Vercel dashboard's "promote previous deployment" (instant rollback to the prior build) should be faster than a git revert + rebuild roundtrip. Treat as first thing to *try* when production is down, but verify it against the dashboard before relying on it in anger.

## 6. Known operational wrinkle: OneDrive

(Session record, 2026-07-10, maintainer-confirmed.) The repo lives under OneDrive (`C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1`). Pushes intermittently fail with:

```
error: unable to open loose object ... Permission denied
```

This is OneDrive briefly holding a file lock, **not** repo corruption. The fix is: wait a few seconds and **retry the push once**. Do not run `git fsck`, re-clone, or otherwise "repair" the repo reflexively — that has never been necessary.

## Provenance & maintenance

Every claim above is repo-verifiable except items marked "(session record …)". Re-verify volatile facts with one-liners (PowerShell; run from repo root):

| Claim | Re-verify with |
|---|---|
| TUS 401 saga commits & rationale | `git show -s --format="%h %s%n%b" ff36a97 54d1bcc 8e81183` |
| Design revert war chains | `git show -s --format="%h %s" 79975fb fd28c64 1393375 1e25015 1d96c8e bf016c5 68123b4 06b7efd 4e559b1 2333dc0` |
| Admin-gate revert/reapply example | `git show -s --format="%h %s" 71f3aff be51f05 b7f3f8d` |
| Three signing formulas & line numbers | `Select-String -Path lib\bunny.js -Pattern "createHash"` |
| Changelog bare format | `Get-Content Changelog -TotalCount 12` |
| "Update Changelog: vX.Y.Z" commit convention | `git log --oneline --grep="Update Changelog"` |
| Annotated-tag convention (message = short name, points at Changelog commit) | `git for-each-ref refs/tags --format="%(refname:short) %(objecttype) %(*objectname:short) %(contents:subject)"` |
| Release title convention & latest version | `& "C:\Program Files\GitHub CLI\gh.exe" release list --limit 5` |
| CI steps and dummy build env | `Get-Content .github\workflows\ci.yml` |
| Vercel deploys independent of CI | `Get-Content vercel.json` (only `git.deploymentEnabled` — no CI coupling) |
| No branch protection on main | `& "C:\Program Files\GitHub CLI\gh.exe" api repos/MarineTeam/Marine-Video-Portal-1/branches/main --jq ".protected"` |
| Direct-to-main history (merge scarcity) | `git log --merges --oneline` vs `git log --oneline | Measure-Object -Line` |
| gh CLI location | `Test-Path "C:\Program Files\GitHub CLI\gh.exe"` |
| npm script names CI relies on | `Get-Content package.json` (scripts block) |

Session-record items (email_verified lockout near-miss, OneDrive push retries, Vercel promote-previous as emergency rollback) cannot be re-derived from the repo; re-confirm with the maintainer if they become load-bearing.
