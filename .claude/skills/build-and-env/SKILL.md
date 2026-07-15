---
name: build-and-env
description: Load when setting up a machine to work on Marine-Video-Portal, installing Node/npm, running builds, tests, or lint locally, watching CI, writing .env.local, or hitting environment/toolchain errors — npm ERESOLVE peer conflicts, "gh is not recognized", PowerShell 5.1 syntax failures (&&, ternary), OneDrive "unable to open loose object" git errors, CRLF warnings, or next build failing on missing env vars.
---

# Build & Environment: Marine Video Portal

Next.js 14 (Pages Router) + React 18 private video site. Repo: `MarineTeam/Marine-Video-Portal-1` on GitHub. CI: GitHub Actions (`.github/workflows/ci.yml`). Deploys: Vercel, automatically on push to `main`.

Local repo path on the maintainer machine: `C:\Users\fs_of\OneDrive\Documents\GitHub\Marine-Video-Portal-1` (note: under OneDrive — see quirks table).

## When NOT to use this skill

- **Deploying, releasing, or operating the live site** → see `run-and-operate`.
- **What an env var means or where its real value lives** → see `config-and-data` (this skill only lists which vars exist and why builds need dummies).
- **Fixing application bugs** (auth loops, playback, thumbnails) → see `debugging-playbook`.
- **Writing or extending tests** beyond running them → see `validation-and-qa`.
- **Changing CI policy, branch protection, or review process** → see `change-control`.

## 1. Current reality: CI is the only compiler (as of 2026-07-10)

Node and npm are NOT installed on the maintainer machine (as of 2026-07-10). You cannot run `npm install`, `npm run build`, or `npm test` locally until you install Node (section 2). The working loop is:

1. Edit files locally.
2. Commit and push.
3. CI verifies (lint → test → build).
4. Vercel deploys `main` automatically.

Until Node is installed, treat CI as your compiler: push, then watch the run. The `gh` CLI is installed but OFF-PATH (as of 2026-07-10), so always call it by full path:

```powershell
# List the latest CI run (grab the run ID from the output)
& "C:\Program Files\GitHub CLI\gh.exe" run list --workflow=ci.yml --limit 1

# Watch it to completion; exits non-zero if the run fails
& "C:\Program Files\GitHub CLI\gh.exe" run watch <id> --exit-status
```

Git Bash equivalent (no `&` call operator; quote the path directly):

```bash
"/c/Program Files/GitHub CLI/gh.exe" run list --workflow=ci.yml --limit 1
"/c/Program Files/GitHub CLI/gh.exe" run watch <id> --exit-status
```

`gh` is already authenticated as `MarineTeam` (as of 2026-07-10). If a run fails, get the log:

```powershell
& "C:\Program Files\GitHub CLI\gh.exe" run view <id> --log-failed
```

## 2. Installing Node locally (optional but recommended)

Installing Node unblocks local dev (`npm run dev`), local lint/test/build, and faster iteration than the push-and-watch loop.

```powershell
winget install -e --id OpenJS.NodeJS.LTS
```

Close and reopen the terminal (PATH changes don't apply to open sessions), then verify:

```powershell
node -v
npm -v
```

Then, from the repo root:

```powershell
npm install        # resolves fresh every time — no lockfile is committed (see quirks)
npm run dev        # dev server on http://localhost:3000
npm run lint       # next lint
npm test           # vitest run
npm run build      # next build
```

Package scripts (verified in `package.json`): `dev` = `next dev`, `build` = `next build`, `start` = `next start`, `lint` = `next lint`, `test` = `vitest run`.

Key dependency versions (verified in `package.json`, as of 2026-07-10): `next ^14.2.35`, `react 18.3.1` (pinned), `@auth0/nextjs-auth0 ^3.5.0`, `@upstash/redis ^1.34.0`, `@upstash/ratelimit ^2.0.5`, `@sentry/nextjs ^7.120.3`, `tus-js-client ^4.1.0`, `player.js ^0.1.0`, `web-push ^3.6.7` (added v1.7.0, server-side only — push notifications); dev: `eslint ^8.57.1`, `eslint-config-next ^14.2.35`, `vitest ^3.2.6`.

### .env.local for running against real services

`npm run dev` against real Auth0/Bunny/Redis needs a `.env.local` in the repo root with these vars (full dictionary with meanings and where real values live: `config-and-data`):

- `AUTH0_SECRET`, `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`
- `ADMIN_EMAILS`
- `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_AUTH_KEY`
- `KV_REST_API_URL`, `KV_REST_API_TOKEN`
- Optional: `BUNNY_CDN_HOSTNAME` (thumbnails), and others per `config-and-data`

**NEVER commit `.env.local`.** Real values live only in Vercel and your local file.

For `npm run build` without real services, copy the dummy values from the CI workflow's build step (section 4) into your environment — they only need to be present and well-formed.

## 3. Toolchain quirks (this machine)

| Quirk | What to do |
|---|---|
| `gh` off-PATH (as of 2026-07-10) | Always call `& "C:\Program Files\GitHub CLI\gh.exe" ...` (PowerShell) or `"/c/Program Files/GitHub CLI/gh.exe" ...` (Git Bash), or add the directory to PATH. Plain `gh` fails with "not recognized". |
| PowerShell 5.1 is the primary shell | No `&&` / `\|\|` chaining (parser error), no ternary `?:`. Run commands separately, or `A; if ($?) { B }`. Use here-strings for multi-line input. Git Bash is available when you need POSIX syntax. |
| Repo lives under OneDrive | Intermittent `unable to open loose object ... Permission denied` on push while OneDrive holds a file lock — retry once OneDrive releases it. For NEW clones prefer a non-synced path like `C:\dev\` (session record, 2026-07-10, maintainer-confirmed). |
| CRLF warnings on commit | `LF will be replaced by CRLF` is normal on this machine — a warning, not an error. Do not "fix" line endings in response. |
| No `package-lock.json` — by design | Origins of the repo were browser-built; no lockfile is committed (verified via `git ls-files`, as of 2026-07-10). `npm install` resolves fresh on every CI run and every local install, so `ERESOLVE` peer-dependency conflicts (typically `next` vs `@auth0/nextjs-auth0`) can appear without any code change. README "Common issues" covers this. Do not commit a lockfile as a quick fix — that is a policy change (see `change-control`). |

### Pre-approved permissions (`.claude/settings.local.json` — describe only, do not modify)

The project's Claude Code allowlist (as of 2026-07-10) pre-approves: `gh auth status` (both plain and full-path PowerShell forms), `WebFetch` on `raw.githubusercontent.com`, `git add` / `git checkout` / `git merge` / `git push` via Bash, `npx next build` via PowerShell, and one specific version-tag `git rev-parse` one-liner. Anything else prompts. Don't edit this file to widen permissions as part of unrelated work.

## 4. The CI environment (`.github/workflows/ci.yml`)

Verified contents (as of 2026-07-10):

- **Triggers**: push and pull_request to `main`.
- **`permissions: contents: read`** at workflow level — CodeQL-mandated hardening (commit `40f4feb`). Keep it; don't widen permissions without reason.
- **Runner**: `ubuntu-latest`, with `NEXT_TELEMETRY_DISABLED: '1'` at the job level.
- **Node**: version `20` via `actions/setup-node@v4` (local Node LTS from section 2 may be newer — CI's Node 20 is the reference).
- **Steps, in order**: `npm install` → `npm run lint` → `npm test` → `npm run build`. A failure at any step fails the run; Vercel deploys independently of CI, so a red CI does not by itself block the deploy.
- **Dummy env block on the Build step** — 11 vars: `AUTH0_SECRET` (64 zeros), `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `BUNNY_LIBRARY_ID`, `BUNNY_API_KEY`, `BUNNY_TOKEN_AUTH_KEY`, `ADMIN_EMAILS`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

**Why the dummies exist**: `lib/redis.js` constructs the Upstash `Redis` client at module import time (`new Redis({ url: process.env.KV_REST_API_URL, ... })` at top level), and the Auth0 SDK similarly builds its client on import. `next build` imports these modules, so the build throws unless the vars are present and syntactically valid (e.g. `AUTH0_ISSUER_BASE_URL` must parse as a URI). The values never need to work — real values live only in Vercel.

The same trick appears in `vitest.config.js` (`test.env` supplies `ADMIN_EMAILS`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`) so importing `lib/order` etc. doesn't throw during tests.

**RULE**: whenever you add an env var that any build- or test-touched module reads at import time, add a dummy value to BOTH the ci.yml Build step env block AND (if a tested module reads it) `vitest.config.js` `test.env` — otherwise CI breaks on the next push even though the code is correct.

## 5. Lint setup

`.eslintrc.json` (verified, as of 2026-07-10) extends `next/core-web-vitals` with these downgrades:

- `@next/next/no-html-link-for-pages`: **off** — deliberate. `/api/auth/login` and `/api/auth/logout` are API routes that require full-page `<a>` navigation; converting them to `<Link>` to satisfy the rule would break login/logout. Do not re-enable, and do not "fix" those anchors.
- `react-hooks/exhaustive-deps`: warn (not error) — warnings won't fail CI, but don't add new ones casually.
- `no-unused-vars`: warn.
- `react/no-unescaped-entities`: off.
- `@next/next/no-img-element`: off.

History (verified via `git log`): ESLint was introduced and wired into CI in commit `d0128c8` ("Add ESLint (next/core-web-vitals) and wire it into CI"); `no-html-link-for-pages` was disabled in commit `746313f` ("Disable no-html-link-for-pages ESLint rule").

## 6. Test setup

- **Runner**: vitest `^3.2.6` (verified in `package.json`); `npm test` runs `vitest run` (single pass, no watch).
- **Config**: `vitest.config.js` — `environment: 'node'`, `include: ['lib/**/*.test.js']`, plus the `test.env` dummies. Note `ADMIN_EMAILS` is set there to `'admin@example.com, second@example.com'` and the auth tests assert against those exact values — changing that string breaks `lib/__tests__/auth.test.js`.
- **Existing tests** (as of 2026-07-10): `lib/__tests__/auth.test.js`, `lib/__tests__/order.test.js`, `lib/__tests__/theme.test.js`. All pure-logic — no network, no real services, safe to run anywhere Node exists.
- Test files must match `lib/**/*.test.js` or vitest silently ignores them. Adding or designing tests → see `validation-and-qa`.

## 7. What this skill does not cover

- Deploying and releasing (Vercel, tags, rollback) → `run-and-operate`.
- Env var meanings, real values, data stores → `config-and-data`.
- Diagnosing and fixing app bugs → `debugging-playbook`.
- Test-writing standards and QA process → `validation-and-qa`.
- Process, review, and policy changes (e.g. committing a lockfile) → `change-control`.

## Provenance & maintenance

- Verified by direct read on 2026-07-10: `package.json` (scripts, versions), `vitest.config.js`, `.eslintrc.json`, `.github/workflows/ci.yml`, `.claude/settings.local.json`, `lib/redis.js` (module-import client construction), `README.md` "Common issues" (ERESOLVE note), and `git ls-files` (no lockfile committed).
- Commit citations verified via `git log`: `d0128c8` (ESLint intro), `746313f` (no-html-link-for-pages disabled), `40f4feb` (CI permissions hardening).
- Facts marked "(session record, 2026-07-10, maintainer-confirmed)" come from the maintainer's working session, not from repo files.
- Volatile facts to re-check when this skill misbehaves: whether Node/npm is now installed locally; whether `gh` is still off-PATH; dependency versions in `package.json`; the exact env var list in ci.yml's Build step and in `vitest.config.js`.
- If ci.yml, `.eslintrc.json`, `vitest.config.js`, or `package.json` scripts change, update the matching section here in the same PR.
