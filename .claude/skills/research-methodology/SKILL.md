---
name: research-methodology
description: How a hunch becomes an accepted result in this repo. Load when debugging something unexplained, evaluating a hunch or proposed fix, researching vendor behavior (Bunny, Next.js, Auth0, Upstash), or before claiming a fix works — covers hypothesis discipline, making failures visible, one-variable experiments, sanctioned research sources, the evidence bar, and stop rules.
---

# Research Methodology (as of 2026-07-10)

This skill is the discipline that turns "I think I know what's wrong" into a result this repo accepts. It exists because this project has no local Node runtime on the maintainer machine (as of 2026-07-10) — every hypothesis about runtime behavior is tested through CI and the deployed app, so undisciplined guessing is expensive and slow. The repo's own git history contains both a textbook failure of this discipline and a textbook success, four commits apart, in the same afternoon. Both are narrated below.

## When NOT to use this skill

- **The symptom is already triaged.** Check `debugging-playbook` first — if the symptom is listed there with a known cause, apply the known fix. Do not re-research settled questions.
- **The battle was already fought.** Check `failure-archaeology` before forming hypotheses about anything that smells like a past incident. Falsified hypotheses are recorded there precisely so you do not re-falsify them.
- **The change is mechanical.** Renames, copy edits, dependency bumps with vendor-verified changelogs — these need `change-control` hygiene and `validation-and-qa` evidence, not a research loop.
- **You need a measurement command, not a method.** `diagnostics-and-tooling` has the concrete commands; this skill tells you what to measure and when to believe it.

## 1. The core loop

Run every investigation through these five steps, in order. Skipping step 1 or step 2 is how you end up shipping coincidences.

1. **Make the failure visible first.** You cannot reason about a blank error. If the symptom is "it fails" with no detail — or worse, "nothing happens" — your first change is instrumentation, not a fix. Exemplar: commit `ff36a97` ("Surface real upload-error details") shipped *before* any fix attempt on the upload 401 — it put the actual HTTP status and message into the failed upload row and logged the full error to the console. Only after that did the real debugging start.
2. **Write the hypothesis AND its predicted observable before acting.** The form is: "If H is true, doing X will show exactly Y." A hypothesis without a prediction is a vibe. Use the hypothesis card in section 7.
3. **Change one variable.** One experiment, one change, one small revertable commit (see `change-control`). If your fix commit changes two things and the symptom disappears, you learned nothing about which one mattered — see the 8e81183 caveat in section 2.
4. **Compare predicted vs actual.** If the prediction held, the hypothesis is supported. If the symptom vanished but not for the reason you predicted, you have a coincidence, not a result — keep investigating until the mechanism is explained. Predicted-then-observed beats observed-then-rationalized, always.
5. **Record the outcome.** Minimum: a commit body that states the mechanism (all four exemplar commits below do this). If it was a multi-hypothesis battle, write it into `failure-archaeology` so the falsified branches are never re-explored.

## 2. Worked example A — the TUS 401 saga (2026-06-30, lib/bunny.js)

Browser TUS uploads to Bunny Stream returned HTTP 401. Direct API calls from the server (`createVideo`, which authenticates with an `AccessKey` header) worked fine with the same secret. Three commits, ~10 minutes apart, tell the whole story:

**Step 0 — visibility (`ff36a97`, 16:22).** The upload UI showed only a stuck progress bar. This commit surfaced the real failure (HTTP status + message in the UI, full error in console) and wrapped the `tus-js-client` import so a load failure reported instead of hanging at 0%. No fix yet — just eyes.

**Hypothesis 1 (`54d1bcc`, 16:27) — FALSIFIED.** H1: "Bunny expects the `AuthorizationExpire` value as a millisecond timestamp; signing with seconds makes Bunny treat the upload as expired." Prediction: switching `expires` to `Date.now()`-based milliseconds fixes the 401. The commit shipped, the 401 persisted, H1 was falsified and the change reverted in the next commit. Note the failure mode: H1 was plausible, confidently worded in the commit body — and wrong. Plausibility is not evidence.

**Research step.** Before hypothesis 2, the vendor spec was consulted: Bunny's official TUS documentation says the expiry is a Unix timestamp in **seconds**. That single lookup falsified H1's premise directly and should have happened *before* H1 shipped. Lesson: read the vendor spec before hypothesis #2 — better, before hypothesis #1.

**Hypothesis 2 (`8e81183`, 16:32) — CONFIRMED.** The tell was the *asymmetry*: header auth (`createVideo`) worked, signature auth (TUS) failed, same secret. An asymmetric failure across two auth paths sharing one secret points at value-handling, not the secret itself. H2: "Whitespace in the env values (a stray trailing newline/space) is silently dropped from the `AccessKey` HTTP header — so header auth works — but is faithfully hashed into the SHA256 signature — so signature auth fails." Prediction: `.trim()` on `BUNNY_LIBRARY_ID` and `BUNNY_API_KEY` fixes the 401 *and* explains why `createVideo` worked all along. Confirmed against the deployed app (session record, 2026-07-10, maintainer-confirmed). The fix lives in `lib/bunny.js` `signTusUpload()` today, with the mechanism documented in an inline comment.

One-variable caveat: `8e81183` bundled the seconds revert with the trim. That was acceptable only because the seconds value was independently established by the vendor spec — it was a documented fact being restored, not a second experiment. When you can't cite a spec for one of the changes, split the commit.

**Lessons:** (a) vendor spec beats intuition — check it before guessing at wire-format details; (b) an asymmetric failure between two paths using the same secret indicts how the value is handled, not the value; (c) a falsified hypothesis honestly recorded (`54d1bcc` is still in history, unsquashed) is worth more than a clean-looking log.

## 3. Worked example B — the player.js silent failure (2026-06-30, components/ResumablePlayer.js)

Resume-from-last-position silently did nothing. No error, no console output, playback itself fine — the symptom was the *absence* of behavior. You cannot form a hypothesis about a blank; commit `3ddd10b` shows the sequence:

**Step 1 — instrumentation before fix.** Warnings were added to the bail-out paths so silence became signal. The pattern is still in the current code: `console.warn('ResumablePlayer: player.js Player constructor not found')` when constructor resolution fails, and `console.warn('ResumablePlayer: failed to init player.js', e)` when `new Player(...)` throws. For silent failures, ship observability first, fix second — the warnings stay in as permanent tripwires.

**Hypothesis from inspecting the module shape.** The old code did `Player = mod.default || mod.Player || mod`. Under webpack interop, `player.js` puts its whole export namespace (`{ Player, Receiver, ... }`) on `mod.default`, so the code called `new` on a namespace object — which threw, and the throw was swallowed, disabling resume with zero output. Prediction: resolving the constructor at `module.default.Player` makes resume work *and* makes the new warnings never fire. The current code implements exactly this: `const ns = mod && mod.default ? mod.default : mod; const Player = (ns && ns.Player) || (mod && mod.Player);`.

**Result.** Both halves of the prediction held; resume confirmed working in production by the maintainer (session record, 2026-07-10, maintainer-confirmed).

**Design lesson:** the host feature survived the entire bug's lifetime — playback always worked because ResumablePlayer treats player.js as an enhancement: every failure path returns and leaves the iframe alone. When you add an enhancement, design its failure modes so the host feature degrades gracefully; when you debug one, remember that graceful degradation is precisely what makes its failures silent, so instrument the bail-outs.

## 4. Researching vendor behavior — the sanctioned sources, in order

When the question is "what does the vendor actually do," consult in this order and stop at the first authoritative answer:

1. **Official docs** — Bunny (docs.bunny.net), Next.js (nextjs.org/docs), Auth0 (auth0.com/docs), Upstash (upstash.com/docs). This is where the TUS-expiry-is-seconds fact lived the whole time.
2. **The vendor's own blog / changelog / release notes** — for behavior changes, deprecations, incident history.
3. **GitHub advisories via `gh api`** — security facts MUST come from the API, not from memory or training data. This repo's Dependabot triage was done that way: the body of commit `739c54f` records the method — each alert enumerated, matched against actual code paths (no middleware.js, no app/ directory, no next/image usage, etc.), and the unpatchable ones deferred with explicit reasoning. Note: `gh.exe` is installed but off-PATH on this machine; see the memory note for its full path.
4. **Community sources (Stack Overflow, GitHub issues, forums) last** — treat as leads, not facts. Verify against a source from tiers 1–3 before acting on anything found here.

**Cache what you learn.** A vendor fact verified once belongs in the relevant reference skill (`bunny-reference` for Bunny behavior, etc.) so it is researched exactly once. The seconds-vs-milliseconds fact cost a shipped-and-reverted commit; it should never cost anything again.

## 5. The evidence bar for "accepted result"

A claim ships here only when backed by at least one of:

- **A repo citation** — file path or commit hash that anyone can check.
- **A CI run conclusion** — a green (or red) run on the actual commit.
- **A deployed-app observation** — screenshot, network trace, or maintainer-confirmed behavior in production.
- **A vendor-doc link** — tier 1–3 from section 4.

"It should work" is not evidence. "It worked on my machine" is not available here (no local Node) and would not clear the bar anyway. And the ordering matters: **predicted-then-observed beats observed-then-rationalized** — a fix whose success you predicted, for a stated mechanism, is a result; a fix that happened to make the symptom vanish is a coincidence wearing a result's clothes.

## 6. Stop rules

- **After 2 falsified fix attempts: stop.** Do not ship hypothesis #3 on momentum. Write down the symptom, the evidence gathered, and each falsified hypothesis with its prediction and observation (use the card below, one per hypothesis). Then, in order: check `failure-archaeology` for prior art, run the research step (section 4), and if neither resolves it, escalate to the maintainer with the write-up. The TUS saga stayed just inside this rule — one falsified attempt, then research, then a confirmed fix.
- **Never leave the system unreleasable between experiments.** Every experiment is a small, revertable commit (see `change-control`). `54d1bcc` was wrong but the system stayed shippable, and the revert was one commit. If your experiment cannot be structured as a safe revertable change, it is too big — shrink it.
- **Silent failure? Instrumentation is not an attempt.** Adding observability (ff36a97, the warnings in 3ddd10b) does not count against the two-attempt budget. It is step 1, always allowed, always first.

## 7. Template — the hypothesis card

Fill this in *before* running the experiment. If you cannot fill in Prediction precisely, you do not have a hypothesis yet.

```
SYMPTOM:      <what is observably wrong, with the real error text/trace — if blank, instrument first>
HYPOTHESIS:   <the proposed mechanism, one sentence>
PREDICTION:   <if H is true, doing X will show exactly Y — and explains any asymmetries in the symptom>
TEST:         <the one change / experiment, as a small revertable commit or a read-only probe>
ONE VARIABLE: <confirm: what is the single thing this test changes? anything else riding along?>
RESULT:       <predicted vs actual — CONFIRMED / FALSIFIED / COINCIDENCE (symptom gone, mechanism unexplained)>
NEXT:         <ship + record | revert + next card | stop rule triggered → write up + research/escalate>
```

Example, filled in from history (H2 of the TUS saga):

```
SYMPTOM:      Browser TUS uploads to Bunny return HTTP 401 (visible since ff36a97); server-side
              createVideo with the same secret works.
HYPOTHESIS:   Trailing whitespace in BUNNY_API_KEY/BUNNY_LIBRARY_ID is dropped from the AccessKey
              header but hashed into the TUS signature.
PREDICTION:   .trim() on both env values fixes the 401 AND explains why header auth worked all along.
TEST:         Add .trim() in signTusUpload (lib/bunny.js), deploy, retry an upload.
ONE VARIABLE: The trim. (The seconds revert rides along — justified separately by the vendor spec.)
RESULT:       CONFIRMED — upload succeeds; asymmetry explained. (8e81183)
NEXT:         Shipped; mechanism recorded in commit body + inline comment.
```

## Provenance & maintenance

- Worked examples verified directly against git history on 2026-07-10: `git show ff36a97 54d1bcc 8e81183 3ddd10b 739c54f`, plus reads of `lib/bunny.js` and `components/ResumablePlayer.js` at HEAD (`739c54f`). Commit quotes and code descriptions match those sources; re-verify against `git show` if this file and history ever disagree — history wins.
- Production-confirmation facts (TUS fix and resume fix observed working in the deployed app) are from the session record, 2026-07-10, maintainer-confirmed.
- Sibling skills referenced: `debugging-playbook` (known symptoms — check before researching), `failure-archaeology` (settled battles and falsified hypotheses), `validation-and-qa` (evidence for shipping), `diagnostics-and-tooling` (measurement commands), `change-control` (experiment hygiene), `bunny-reference` (cache vendor facts there).
- Update this skill when: a new multi-hypothesis battle produces a better worked example; the local-Node situation changes (the no-local-runtime constraint shapes the whole method); or a sanctioned-source tier changes (e.g., a vendor moves its docs).
