---
name: docs-and-writing
description: Load when editing README.md, FEATURES.md, or the Changelog, writing commit messages or release notes, archiving or promoting docs, auditing the stale founding guide, or deciding which document records what for the Marine Video Portal — covers the docs-of-record map, Changelog format, commit-message house style, release-note style, templates, and voice rules.
---

# Docs & Writing — Marine Video Portal

All claims verified against the repo, git history, and published GitHub releases (as of 2026-07-10).

This skill answers three questions: **which file records what**, **what exact format each record uses**, and **what voice all project writing uses**. Follow it when touching any `.md` file in the repo root, the `Changelog`, a commit message, or a GitHub release.

## When NOT to use this skill

- **Deciding whether/when to release, version-number choice, tagging mechanics** — that is release process, owned by the `change-control` skill. This skill only covers the *words* in the Changelog entry, release notes, and commits.
- **Running release/deploy commands** (`gh release create`, tag pushes) — see `run-and-operate`.
- **Writing an incident/failure post-mortem** — those go to `failure-archaeology`, not README/FEATURES.
- **Definition-of-done checks before shipping** — `validation-and-qa` owns that checklist (docs updates are one item on it; this skill tells you *how* to write them).
- **Writing code comments or test names** — not covered here; follow the surrounding code.
- **Authoring brand-new skills** — that is the external `skill-creator` plugin (not one of this library's 13 skills); this skill only establishes that `.claude/skills/` is a docs-of-record location (see below).

## The docs-of-record map

| File | Status | Role | Update trigger |
|---|---|---|---|
| `README.md` | **CURRENT** (rewritten at v1.5.0-era, commit `bf66707`) | Setup, env vars, project structure, security notes, troubleshooting, scaling notes | Env vars change, setup steps change, project structure changes, or a new common issue has earned its place in "Common issues" |
| `FEATURES.md` | **CURRENT** | Grouped feature inventory + "Known gaps / not yet implemented" (the honest not-done list) | Any feature ships, or a known gap closes or opens |
| `Changelog` | **CURRENT, append-only** (no file extension) | Release log, one block per version | Every release, appended at the bottom. **Never rewrite old entries.** |
| `README-v1.0.md` | **ARCHIVED** (snapshot promoted out at `bf66707`) | Historical record of the v1.0-era README | Never update; never delete |
| `FEATURES-v1.0.md` | **ARCHIVED** (snapshot promoted out at `bf66707`) | Historical record of the v1.0-era feature list | Never update; never delete |
| `README-original.md` | **ARCHIVED** (oldest) | The very first README | Frozen. Never update; never delete |
| `bunny-vercel-auth0-guide.md` | **FOUNDING DOCUMENT — operationally STALE** | The original browser-only build recipe the project grew from | Never update its content to "fix" it; it documents origins, not practice. See the stale-claims list below |

Archive convention (established at `bf66707` "Promote rewritten README and FEATURES; archive v1.0 docs"): when a doc is rewritten wholesale, the old version is renamed to `<name>-vX.Y.md` and left frozen; the rewrite takes the canonical name.

### The founding guide: known-stale claims (do not follow)

`bunny-vercel-auth0-guide.md` is historically precious — it is the recipe the whole site was built from — but its code samples predate almost every hardening pass. Each claim below was verified stale against current code on 2026-07-10:

- **Its watch-page sample leaks the recipient email**: the guide's `pages/watch/[shareId].js` mismatch error interpolates `share.email` and the visitor's email into the message. Current `pages/watch/[shareId].js` deliberately returns a generic "This link isn't valid for your account" message — the intended recipient's address is never revealed (this is a listed security property in README.md and FEATURES.md).
- **Its homepage embeds videos directly** in iframes ("latest 2 videos"). Current `pages/index.js` renders a thumbnail grid / title list linking to `/watch/video/[id]` watch pages; no iframe on the homepage.
- **It pins `next` 14.2.5**. Current `package.json` has `next ^14.2.35` (bumped at `739c54f` for Dependabot alerts).
- **Its Redis samples use raw keys** (`share:${shareId}`). Current code namespaces every key through the `k()` helper in `lib/redis.js` with the `pvp:` prefix. Copying a guide snippet writes to the wrong keyspace and silently misses all real data.
- **Its share API has no rate limiting and no audit logging**. Current `pages/api/admin/share.js` rate-limits via `lib/ratelimit.js` and appends to the audit log via `logAudit()`.

**RULE: never copy code from the guide.** If you need a working pattern, read the current file it evolved into.

## The skills directory is also docs-of-record

`.claude/skills/` now records operational knowledge (build/env, Bunny API facts, debugging playbooks, release process, etc.). When reality changes, find the owning skill and follow its own "Provenance & maintenance" section to re-verify and update it. Skills outrank assistant memory for durability: two assistant-memory notes existed — the Auth0 no-mail-server / never-enforce-`email_verified` fact and the gh-CLI install path — and both are now encoded in skills; keep the skills authoritative (session record, 2026-07-10, maintainer-confirmed).

## Commit message house style

Derived from recent history (`8e81183`, `0dbbe2c`, `739c54f` and the last ~40 commits):

- **Imperative subject, ≤ ~65 characters.** "Fix TUS upload 401: revert to seconds expiry, trim env values" — not "Fixed" or "Fixes". A `Verb: detail, detail` shape is common for fixes.
- **One logical change per commit.** Feature batches get one commit with a bulleted body (`0dbbe2c`), not ten fragments; unrelated changes get separate commits.
- **The body explains WHY, and for fixes, tells the failure story** — what broke, why, and what the fix does about it. The TUS-fix body (`8e81183`) is the exemplar:

  > - Bunny TUS expiry is a Unix timestamp in SECONDS (revert the ms change)
  > - Trim BUNNY_API_KEY / BUNNY_LIBRARY_ID before hashing: a stray newline or
  >   space is dropped from the AccessKey header (so createVideo works) but
  >   corrupts the signature, causing HTTP 401 on the TUS upload

  The Dependabot commit (`739c54f`) is the exemplar for *deliberate deferral*: it records exactly which alerts were closed, which were deferred, and the evidence (checked code paths) justifying the deferral — so the next reader doesn't re-litigate it.
- **AI-authored commits carry the trailer** `Co-Authored-By: Claude <model> <noreply@anthropic.com>` with the actual model name (e.g. `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`); present on 35 of the last 40 commits.
- Changelog-update commits use the fixed subject `Update Changelog: vX.Y.Z`.

## Changelog format (exact)

The `Changelog` file (no extension, repo root) is a bare version line followed by plain description lines — **no bullets, no dates, no markdown headers, no blank lines between blocks**:

```
v1.5.0
Video thumbnails on the homepage grid and admin library
Analytics dashboard (views, watch time, 30-day chart, most-watched)
```

Append the new block at the bottom. Never rewrite, reformat, or "clean up" old entries — one early line (`v1.0.1a fixed video count bug`) breaks the pattern; leave such anomalies alone.

## Release notes style

Verified against published GitHub releases v1.0.1–v1.5.0 (`gh release view`):

- **Title:** `vX.Y.Z - Short human name` — e.g. `v1.5.0 - Thumbnails & analytics`, `v1.3.0 - Hardening & search`, `v1.1.3 - Upload fix`. Hyphen with spaces, name in plain sentence case, a few words.
- **Body:** a short bullet list in **user-facing language** — what a viewer or admin experiences, not internal refactoring detail. An optional one-line theme sentence may precede the bullets (v1.3.0: "Reliability, security, and viewer-experience improvements:").
- **Note env/config requirements when relevant.** The v1.5.0 exemplar ends: "Note: thumbnails require BUNNY_CDN_HOSTNAME (and optionally BUNNY_CDN_TOKEN_KEY) set in the environment." If a feature is inert without a variable, say so in the notes.
- Fix releases briefly state the symptom and cause (v1.1.3 names the HTTP 401 and the stray-newline signature corruption).

## Templates

### Changelog entry (append to `Changelog`)

```
vX.Y.Z
One plain line per shipped change, user-visible phrasing
Another change line if the release has several
```

### Release notes block

```
Title: vX.Y.Z - Short human name

- User-facing description of change 1 (what viewers/admins see; name the tab or page)
- User-facing description of change 2

Note: <feature> requires <ENV_VAR> (and optionally <OTHER_VAR>) set in the environment.
```

Drop the `Note:` line if nothing needs configuration.

### Commit message skeleton

```
Imperative summary of the one logical change (≤ ~65 chars)

Why the change exists. For a fix: what broke, the root cause, and how
this resolves it. For a deferral/tradeoff: what was checked and why
the remainder is safe to postpone.

Co-Authored-By: Claude <model> <noreply@anthropic.com>
```

(Trailer only when AI-authored; use the real model name.)

### New known-gap line (for `FEATURES.md` → "Known gaps / not yet implemented")

```
- **<Capability name>** — <one plain sentence of what does not exist and, if useful, the current manual workaround>.
```

Model it on the existing entries, e.g. "**Automatic email delivery of share links** (admin still copies the link and sends it manually)."

### Stale-doc audit checklist

Before trusting or propagating any claim from a doc (especially the founding guide or an archive):

1. Identify each concrete claim: file paths, env var names, package versions, code snippets, API shapes, key names.
2. `grep` each claim against the current code (`package.json` for versions, `lib/` and `pages/` for patterns, README env table for variables).
3. For code samples: diff the sample against the current file it evolved into; assume the current file wins.
4. For behavior claims ("the homepage shows X"): read the current page/route, don't trust the prose.
5. Record what you verified (and when) in whatever you write — date-stamp volatile claims.
6. If a CURRENT doc (README.md / FEATURES.md) turned out stale, fix it in the same change; if an ARCHIVED doc is stale, leave it — that's what archives are.

## Voice rules (all project docs)

- **Plain language.** Say what the thing does. No marketing adjectives ("blazing", "seamless", "powerful").
- **State what is NOT done as plainly as what is.** The FEATURES.md "Known gaps / not yet implemented" section is the model — the honest not-done list is a feature of the docs, not an embarrassment.
- **Date-stamp volatile claims** (versions, quotas, pricing-tier limits, "current as of" statements). FEATURES.md opens with "Current as of **v1.5.0**" — keep that anchor accurate.
- **User-facing docs describe experience; commit bodies describe cause.** Don't let internal jargon leak into README/FEATURES/release notes, and don't let vague experience-speak replace root causes in commits.
- Bold the load-bearing terms (env var names, feature names, security properties), sparingly.

## Sibling skills

- `change-control` — the release process itself (when to version, how to cut a release); this skill only supplies the words.
- `run-and-operate` — the actual release/deploy commands.
- `failure-archaeology` — where incident write-ups live.
- `validation-and-qa` — definition-of-done, which includes "docs updated per docs-and-writing".

## Provenance & maintenance

**Sources (all verified 2026-07-10):** every doc file read in full (`README.md`, `FEATURES.md`, `Changelog`, `README-v1.0.md`, `FEATURES-v1.0.md`, `README-original.md`, `bunny-vercel-auth0-guide.md`); stale-guide claims checked against `pages/watch/[shareId].js`, `pages/index.js`, `lib/redis.js`, `pages/api/admin/share.js`, `package.json`; commit style from `git log` (exemplars `8e81183`, `0dbbe2c`, `739c54f`); release style from `gh release list` / `gh release view` v1.0.1–v1.5.0. Facts marked "(session record, 2026-07-10, maintainer-confirmed)" come from the maintainer session of that date, not the repo.

**To re-verify / update this skill:**
- Docs map: `ls` the repo root for `*.md` + `Changelog`; re-read the header of any file whose role you assert. If a new archive appears (e.g. `README-v1.5.md`), add a row.
- Stale-guide list: re-run the checks above; if current code changes (e.g. the `pvp:` prefix is renamed — `lib/redis.js` says the prefix may change with the app name), update the corresponding bullet.
- Commit style: `git log --format='%B' -20` and confirm subjects/trailers still match before asserting.
- Release style: `gh release view <latest>` (gh.exe lives at `C:\Program Files\GitHub CLI\gh.exe`, off PATH) and compare against the templates.
- Update the "(as of ...)" date whenever you re-verify, and this section's verified date.

**Owner of last resort:** if this skill and reality disagree, reality wins — fix the skill in the same change, per "The skills directory is also docs-of-record".
