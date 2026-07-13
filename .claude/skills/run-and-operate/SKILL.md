---
name: run-and-operate
description: Operations runbook for Marine Video Portal — load when deploying to production, pushing to main, releasing/tagging a version (Changelog + tag + GitHub release), changing or adding Vercel environment variables, investigating a production incident (login/upload/playback broken), reading CI or deploy or runtime logs, rolling back a bad deploy, or inspecting/repairing Upstash Redis data.
---

# Run & Operate: Marine Video Portal

Deploy, release, observe, and recover this system. Everything here is verified against the repo at `C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1` (as of 2026-07-10). The stack: Next.js 14 Pages Router on Vercel, GitHub `MarineTeam/Marine-Video-Portal-1`, GitHub Actions CI, bunny.net Stream, Auth0, Upstash Redis.

The `gh` CLI on the maintainer machine is off-PATH. Always invoke it as:

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" <args>
```

It is already authenticated as `MarineTeam` (as of 2026-07-10).

## When NOT to use this skill

- **Deciding WHAT may ship** (scope, approval, what counts as a safe change) → `change-control`.
- **Setting up a machine or CI to build the project** (Node install, npm scripts, local dev) → `build-and-env`.
- **Looking up what an env var means or its correct value shape** → `config-and-data` (this skill only covers the *procedure* for changing one).
- **Diagnosing a bug** (reproduce, isolate, hypothesize) → `debugging-playbook`; this skill only tells you where the evidence lands and what to check first.
- **Measuring performance or adding instrumentation** → `diagnostics-and-tooling`.
- **CodeQL/Dependabot findings, dependency bumps, hardening plans** → `security-currency-campaign`.
- **Bunny.net URL-signing formulas or API details** → `bunny-reference`.
- **Editing application code**. This skill never justifies a code change; it operates what already exists.

## 1. The pipeline — honestly stated

**A push to `main` triggers GitHub Actions CI and the Vercel production deployment IN PARALLEL. Vercel does NOT wait for CI.**

Verified in-repo (as of 2026-07-10):

- `vercel.json` is exactly `{"git": {"deploymentEnabled": true}}` (plus `$schema`) — it enables git-triggered deploys and configures **nothing else**. There is no checks integration, no `github.silent`, no deploy gating anywhere in the repo.
- `.github/workflows/ci.yml` runs one job (`Build`) on push/PR to `main`: `npm install` → `npm run lint` → `npm test` → `npm run build` on Node 20, with a block of dummy env values (`AUTH0_*`, `BUNNY_*`, `ADMIN_EMAILS`, `KV_REST_API_*`) so module-load code survives the build. `permissions: contents: read`.

**Operational consequence:** a broken push can reach production while CI is still red. CI is not a gate — it is the **alarm**. The discipline that compensates:

1. Push.
2. Immediately watch CI:

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run list --repo MarineTeam/Marine-Video-Portal-1 --limit 5
& "C:\Program Files\GitHub CLI\gh.exe" run watch <run-id> --repo MarineTeam/Marine-Video-Portal-1 --exit-status
```

3. If CI fails, pull the failing step's log and act (Section 5 for rollback):

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run view <run-id> --repo MarineTeam/Marine-Video-Portal-1 --log-failed
```

Never push-and-walk-away. A red CI run means production is probably already serving the bad commit (unless the Vercel build itself failed — check the Vercel dashboard to know which).

## 2. Where output lands

| Symptom / question | Look here | Notes |
|---|---|---|
| Lint, test, or build failure after a push | GitHub Actions logs (`run view <id> --log-failed`) | CI runs the same `npm run build` Vercel does, but with dummy env vars |
| Vercel build failed / which deploy is live | Vercel dashboard → project → **Deployments** (build logs per deploy) | The Vercel build can fail even when CI passes (real env vars differ from CI dummies) |
| Runtime API errors in production (5xx from `/api/*`) | Vercel dashboard → **Functions** / **Logs** | This is the only place server-side runtime errors land today |
| Application error monitoring | **Sentry — currently INERT** (as of 2026-07-10) | Code is wired (`sentry.client.config.js`, `sentry.server.config.js`, `sentry.edge.config.js`) but no DSN is set. Activation = set `SENTRY_DSN` (server/edge) + `NEXT_PUBLIC_SENTRY_DSN` (client) in Vercel + redeploy (Section 4) |
| Client-side issues: upload progress, `/api/progress` beacons, ResumablePlayer warnings | Browser DevTools console + Network tab | Nothing client-side is reported server-side while Sentry is inert |
| CodeQL / Dependabot findings | GitHub repo → **Security** tab | Owned by `security-currency-campaign` — do not freelance fixes from here |

## 3. Release runbook — the proven sequence

Tags `v1.0.0` through `v1.5.0` all exist and are annotated; GitHub releases exist for recent versions with titles like `v1.5.0 - Thumbnails & analytics` (verified 2026-07-10). Mirror this exactly.

**Versioning convention observed in the Changelog:** patch bump (`v1.1.3`, `v1.1.4`) = fixes and small single tweaks; minor bump (`v1.2.0`…`v1.5.0`) = feature batches. Verify against the Changelog history before choosing a number.

**(a) Append the Changelog entry.** File is `Changelog` (no extension, repo root). The format is bare — copy it exactly: a line containing only `vX.Y.Z`, then one plain line per feature/fix. No dates, no headings, no bullets, no blank line between entries. Real example from the file:

```
v1.5.0
Video thumbnails on the homepage grid and admin library
Analytics dashboard (views, watch time, 30-day chart, most-watched)
```

**(b) Commit with the established message pattern** (verified: `Update Changelog: v1.5.0`, `Update Changelog: v1.4.0`, etc.):

```powershell
git add Changelog
git commit -m "Update Changelog: vX.Y.Z"
```

**(c) Push and watch CI to green** (see Section 1 — the deploy is already racing you):

```powershell
git push origin main
& "C:\Program Files\GitHub CLI\gh.exe" run watch <run-id> --repo MarineTeam/Marine-Video-Portal-1 --exit-status
```

**(d) Tag the release commit (annotated) and push the tag:**

```powershell
git tag -a vX.Y.Z <sha> -m "One-line summary of the release"
git push origin vX.Y.Z
```

**(e) Create the GitHub release** (title style verified against existing releases):

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" release create vX.Y.Z --verify-tag --title "vX.Y.Z - Short name" --notes "What shipped, one line per item."
```

**(f) Verify both refs actually landed on the remote** (do not skip — see Section 8 for why):

```powershell
git ls-remote origin refs/heads/main refs/tags/vX.Y.Z
```

Both lines must appear and `refs/heads/main` must be the release sha.

## 4. Env var change procedure

Env vars live in **Vercel → project → Settings → Environment Variables**. The procedure:

1. Edit/add the variable in the Vercel dashboard (check `config-and-data` for the variable's meaning and correct shape).
2. **Paste carefully — no leading/trailing whitespace.** Whitespace in a pasted value corrupted Bunny TUS signatures once and produced upload 401s; the fix commit `8e81183` ("Fix TUS upload 401: revert to seconds expiry, trim env values") exists because of it.
3. **REDEPLOY.** Env var changes NEVER apply to existing deployments — the running deployment keeps the values it was built with. Vercel dashboard → Deployments → latest → Redeploy (or push a commit).
4. **Verify the affected surface**, not just the deploy status. Example: after setting `BUNNY_CDN_HOSTNAME`, confirm thumbnails actually render on the homepage grid. Every env var has a user-visible surface; find it and look at it.

Special case — auth/access vars (`AUTH0_*`, `ADMIN_EMAILS`): a change here can lock out the admin or every viewer. Before editing, do the written lockout analysis `change-control` requires (who could this lock out? does the admin path survive?), and remember `email_verified` must never be enforced — no mail server (see `architecture-contract` and `failure-archaeology`).

Special case — activating Sentry: set both `SENTRY_DSN` and `NEXT_PUBLIC_SENTRY_DSN`, redeploy, then confirm events arrive by triggering a test error. Until then Sentry is inert by design (see `sentry.*.config.js` at repo root).

## 5. Rollback options, ranked by speed

| Rank | Method | Speed | Status |
|---|---|---|---|
| 1 | Vercel dashboard → Deployments → pick the last good deployment → **Promote to Production** | Minutes, no git | Standard Vercel capability — **candidate procedure, not yet exercised on this project** (as of 2026-07-10) |
| 2 | `git revert <bad-sha>` + `git push origin main` | One CI/deploy cycle | **Proven pattern here**: the admin-gate change went through exactly this — `71f3aff` (add) → `be51f05` (revert) → `b7f3f8d` (reapply). History-preserving and re-appliable |

Rules:

- Option 1 buys time; it does not fix `main`. After promoting, still revert the bad commit so the next push doesn't re-ship the breakage.
- The revert-then-reapply chain is the sanctioned way to un-ship and later re-ship a change — the fix returns as a fresh commit on top.
- **NEVER `git push --force` or `git reset` shared history on `main`.** No exceptions. If history looks wrong, revert forward.

## 6. Data operations (Upstash Redis)

Inspect via the Upstash console (or the Vercel integration's data browser). Facts verified in code (as of 2026-07-10):

- **All app keys carry the `pvp:` prefix** (`lib/redis.js`, `PREFIX = 'pvp:'`). A key without it is not ours.
- **Share links are `pvp:share:{id}` with a TTL.** Deleting one revokes the link — this is literally what the admin UI revoke does (`redis.del` in `pages/api/admin/shares.js`). The TTL is the expiry; `pages/watch/[shareId].js` re-`set`s with the remaining TTL when marking viewed.
- **Audit trail is `pvp:audit_log`** — a Redis list, newest first (`lpush`), capped at 200 entries (`ltrim`, `lib/audit.js`). Read with `LRANGE pvp:audit_log 0 99`. Check it first when asking "who changed what".
- **No backup/restore routine exists** (as of 2026-07-10). This is the **top production-hardening gap**: a fat-fingered `DEL`/`FLUSHDB` or an Upstash incident loses viewers, shares, ordering, settings, and watch history with no recovery path. The candidate plan belongs to `security-currency-campaign` — raise it there, do not improvise one mid-incident.
- **Direct Redis writes are last-resort surgery.** Prefer the admin UI or the `/api/admin/*` endpoints — they keep the audit log honest and respect invariants (TTLs, list shapes). If you must write directly: read the key first, note its exact shape, and log what you did.

## 7. Incident quick cards — the three crown jewels

For all three: `debugging-playbook` owns triage method, `bunny-reference` owns signing formulas, and read `failure-archaeology` **before** attempting any "clever" fix — most clever fixes here have been tried and reverted before.

### Login broken

1. Is it everyone or one user? One user → check they're in the approved viewers list (admin UI) before touching anything.
2. Auth0 status page + Auth0 dashboard logs (failed logins show the real error).
3. Vercel Functions logs for `/api/auth/*` errors; recent env var changes to `AUTH0_*` (Section 4 — did someone forget to redeploy?).
4. **Do NOT enforce `email_verified`** — Auth0 has no mail server; enforcing it locks out everyone (session record, 2026-07-10, maintainer-confirmed). Disable sign-ups instead.
5. Then → `debugging-playbook`.

### Upload broken

1. Browser DevTools first — upload is client → bunny.net TUS, so the failing request and status code are in the Network tab, not Vercel logs.
2. **401 on TUS?** This is the known failure class: signature expiry units or whitespace-corrupted env values — the TUS signature is built from `BUNNY_API_KEY` and `BUNNY_LIBRARY_ID` (NOT `BUNNY_TOKEN_AUTH_KEY`, which signs playback embeds, not uploads) — see commit `8e81183` and Section 4 before anything else.
3. Check bunny.net status and the Stream library dashboard.
4. Formulas and header expectations → `bunny-reference`. Prior failed attempts → `failure-archaeology`.

### Playback broken

1. One video or all? One → check its encoding status in admin (encoding indicator) and in the bunny.net dashboard.
2. All → token-auth signing: recent changes to `BUNNY_TOKEN_AUTH_KEY` / CDN hostname env vars, redeploy done or not (Section 4).
3. Browser console for ResumablePlayer warnings and the embed URL's response code in the Network tab.
4. Expired share link is not an incident — `pvp:share:{id}` TTL ran out, which is the feature working. Re-issue the link.
5. Formulas → `bunny-reference`; triage → `debugging-playbook`.

## 8. Push failure quirk (OneDrive)

The repo lives under OneDrive, which intermittently locks `.git` object files. Symptom: `git push` fails with `unable to open loose object ... Permission denied` (session record, 2026-07-10, maintainer-confirmed).

- **Remedy: retry the push.** The lock is transient.
- **Before assuming failure, verify what actually moved:**

```powershell
git ls-remote origin refs/heads/main refs/tags/vX.Y.Z
```

A single invocation pushing both a branch and a tag once succeeded for the tag while failing for the branch (session record, 2026-07-10, maintainer-confirmed). Never trust the push's exit status alone in either direction — check the remote refs.

## Related skills

| Skill | Owns |
|---|---|
| `change-control` | What may ship, approval, change scope |
| `build-and-env` | Machine/CI setup, building the project |
| `config-and-data` | Env var dictionary and data shapes |
| `debugging-playbook` | Triage method for any bug |
| `diagnostics-and-tooling` | Measurement and instrumentation |
| `security-currency-campaign` | Scanners (CodeQL/Dependabot), dependency currency, hardening plans (incl. the Redis backup gap) |
| `bunny-reference` | bunny.net API and URL-signing formulas |
| `failure-archaeology` | What was already tried and why it failed |

## Provenance & maintenance

- Authored 2026-07-10 by Claude (Fable 5) from direct inspection of the repo at commit `739c54f`: `vercel.json`, `.github/workflows/ci.yml`, `Changelog`, `lib/redis.js`, `lib/audit.js`, `pages/api/admin/shares.js`, `pages/watch/[shareId].js`, `sentry.*.config.js`, `git tag -l`, `git log`, `git for-each-ref`, and `gh release list`.
- Items marked "(session record, 2026-07-10, maintainer-confirmed)" come from live operating sessions, not from code — re-verify them if the repo moves off OneDrive or the toolchain changes.
- Re-verify on change: **vercel.json** (any addition beyond `git.deploymentEnabled` may invalidate Section 1's parallel-pipeline warning — especially if a CI-gating/checks integration is ever configured, rewrite Section 1); **ci.yml** (new jobs or a deploy step change the alarm-vs-gate framing); **Changelog format and tag/release style** (Section 3 mirrors observed practice — if practice changes, update the runbook, don't fight it); **Sentry** (once DSNs are set, Section 2's "inert" row and Section 4's activation note are stale); **Redis backup** (once a backup routine exists, rewrite the Section 6 gap paragraph to document it).
- Date-stamped facts say "(as of 2026-07-10)". Anything undated was true at authoring time; treat it with the same suspicion.
