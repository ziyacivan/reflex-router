# CLAUDE.md

reflex-router: a CLI (`reflex`) that runs the real `claude` behind a loopback proxy and, as decision-making lands, routes work to the cheapest adequate model using a fast decision backend (TypeSafe's Jev, or Laya run locally by the launcher). TypeScript (strict), Node 20+, ESM, zero runtime dependencies.

## Commands

```sh
npm test                                   # typecheck + eslint + all offline tests (must pass before every commit)
node scripts/run-tests.mjs <substring>     # run only test files whose path contains <substring>, e.g. `unit/version`
npm run test:live                          # tests needing a real TYPESAFE_API_KEY; skip themselves without one
npm run build                              # tsc -> dist/
npm run gen:versions                       # regenerate src/wire/tested-versions.generated.ts from test/fixtures/claude-code/*
node bin/reflex.js doctor                  # run the built CLI (after `npm run build`); shows where each setting came from
node bin/reflex.js report [--since 2h] [--usd] [--json]   # summarise ~/.reflex/decisions.jsonl (reads files only); section 0 = workflow profile, 13 = escalations, 14 = effort, 15 = quota exchange rate; --json emits the same sections keyed by section number
node bin/reflex.js report --fingerprints   # unclassified side-call fingerprints as JSON lines (what users send back)
node bin/reflex.js share [--since 7d] [--out f.jsonl]      # structural-only log for calibration; allow-list, writes a file, never uploads
node scripts/report/strip-archive.mjs <in> <out>   # structural copy of an archived log (allow-listed fields) for test/fixtures/report/archives/
node scripts/acceptance/check-archives.mjs # Phase 1 acceptance checks over ~/.reflex/archive/*.jsonl (docs/acceptance-phase1.md)
node --import tsx scripts/calibrate/harvest-corpus.ts <tasks.jsonl> <out.jsonl>   # Jev + every Laya checkpoint over a task corpus; writes numbers only
node --import tsx scripts/calibrate/fit.ts [--model m] [--write] <files...>         # fit/cross-validate the Laya head from harvests and REFLEX_COMPARE logs; --write updates src/backend/laya-calibration.generated.ts
```

Tests run with `--import tsx` and a preloaded guard (`test/support/no-network.ts`) that throws on any non-loopback connection or DNS lookup, including in forked workers. Never weaken it; use the fake upstream and fake backend in `test/support/`.

## Architecture

```
reflex (launcher process)                        src/launcher/
  front door  127.0.0.1:<port>  owns the port for the whole session; buffers, tries the worker, else forwards to the upstream
  supervisor  keeps one worker alive: liveness probe, restart with backoff, crash loop => passthrough
  laya        REFLEX_BACKEND=laya: laya-serve on 127.0.0.1, per-session key, offline, under laya-guard (dies with the launcher)
  claude      spawned with stdio inherited; ANTHROPIC_BASE_URL -> front door; one merged --settings file
worker (child process)                           src/worker/   all routing logic; every failure ends in "forward the original bytes"
src/outcome/  outcome capture (record only): hook settings, hook payload parsing, heuristics, the tracker that joins hooks to decisions
src/delegate/ REFLEX_DELEGATE: the hint text + version (hint.ts, the only place it lives) and which UserPromptSubmit gets it (reply.ts)
src/worker/escalation.ts REFLEX_ESCALATE: the tier arithmetic and the decay of an escalation; the tracker hands signals to the router through TrackerDeps.onSignal
src/wire/effort.ts + src/worker/effort-store.ts  REFLEX_EFFORT: the level by message (Opus 5.5 also top-level; Opus 5, Fable message only) or top-level (Sonnet, where its cache is rewritten anyway). Default: subagents only, by `set` on the first request's own effort-bearing system message (binding-safe). The main chat needs REFLEX_EFFORT_MIDTURN: `set` on its first turn, `insert` (appended message; ties the conversation to reflex) on later ones. Every mark is re-applied by history hash forever, whatever the setting
src/net/      shared forwarding (header sanitising, streaming relay); the only place that talks HTTP upstream
src/backend/  decision backends: jev.ts (the Jev wire client, also used for laya-serve), laya.ts + laya-calibration.ts (feature questions and the fitted head; a feature change bumps FEATURE_VERSION and needs a refit)
src/config.ts the ONLY interpreter of settings (and of process.env); src/env-file.ts only reads/permission-checks ~/.reflex/env and merges it under the process env
src/report/   `reflex report`: tolerant JSONL reader, pure sections 0-15 (0 = workflow profile, 11 = side-call fingerprints, 12 = side-call routing estimate, 13 = escalations, 14 = effort, 15 = quota exchange rate), no network
src/report/share.ts  `reflex share`: the ALLOW-LIST of fields a shared log may contain. Adding a field to the decision record does NOT add it here; that is deliberate and test/unit/share.test.ts pins it
src/wire/     the ONLY place that may know Claude Code / Anthropic request/response shapes: request classification (kind, turn, side_kind), markers, runtime shape checks, SSE usage parsing, quota headers, tested versions, unclassified side-call fingerprints, typed-vs-injected hook prompts
```

Details of what Claude Code sends, with evidence: `docs/wire-format.md`. Redacted real captures: `test/fixtures/claude-code/<version>/`.

## Rules (do not break)

- **Fail-open.** Any error, timeout or unexpected input must end in forwarding the request unchanged, never in a failed Claude Code session. Fallbacks use the model the client asked for, never a fixed tier.
- **Credentials.** Never read, store, log or modify the user's Anthropic credentials; forward auth headers untouched. `TYPESAFE_API_KEY` and all `REFLEX_*`/`TYPESAFE_*` variables are stripped from the environment given to `claude`. Never send the TypeSafe key to Anthropic.
- **Wire format is unstable.** Isolate everything that depends on Claude Code's request/response shapes in `src/wire/`. Treat the Claude Code version as a hint only; verify shape at runtime.
- **Byte-identical passthrough** unless a rewrite is deliberately applied; never re-serialise a body that did not change.
- **Loopback only**, and never edit the user's `~/.claude/settings.json`.
- **No unmeasured claims** (cost, speed, quality) in README or docs. Dollar figures are list-price estimates over recorded token counts and must say so.
- **No telemetry, ever.** reflex opens exactly two kinds of connection: Anthropic (the user's own session) and the decision backend (one question per start of work): TypeSafe Jev, or with `REFLEX_BACKEND=laya` the loopback `laya-serve` the launcher starts with `HF_HUB_OFFLINE=1`. `reflex share` writes a file and never uploads it. A field reaches a shared log only by being named in `src/report/share.ts`.
- **Pricing** lives in `src/pricing.ts` with a "last verified" date and must be checked against Anthropic's pricing page before release (not present yet).
- **Attribution.** Any code adapted from another project is listed in `THIRD_PARTY.md` (tracked, shipped in the npm package) in the same commit.
- **Hook answers carry nothing but the delegation hint and the model-change notice.** Every hook is answered `204` except: with `REFLEX_DELEGATE=1`, a user-typed main-chat `UserPromptSubmit` gets `hookSpecificOutput.additionalContext`; and the first main-chat hook after reflex moved the main chat to a different model gets `systemMessage` (shown to the user, not the model; `src/worker/model-notice.ts`). Never `decision`, `continue` or anything that can block or change a prompt; any failure is a `204`. Changing the hint text means bumping `HINT_VERSION`.
- **Fingerprints hold structure, not text.** `side_fingerprint` keeps at most the redacted preamble of harness text and drops it on any user-text heuristic; a new field or heuristic bumps `FINGERPRINT_VERSION` and must keep `test/unit/fingerprint.test.ts` (no user text lands) green.
- **Outcome capture writes nothing but hashes, counts, rule ids and runner kinds.** Hook payload text (prompts, commands, paths, code) stays in the worker's memory; `decisions.jsonl` never carries it. Every outcome record without a `decision_id` says why (`no_decision`).
- **An outcome signal may raise a tier and may do nothing else.** This replaces the earlier "nothing changes because of an outcome signal", which conflated a privacy guarantee (above, unchanged) with a staging decision that Phase 2b ends. A signal may raise the tier a later request in the same conversation is routed to; it may never lower a tier, never go above the tier the client asked for, never change prompt text, never change a hook answer, never reach the backend, and never leave the machine. It is off unless `REFLEX_ESCALATE=1`, it lives in `src/worker/escalation.ts`, its state is in memory only, and the worst case it can produce is a session running on the model the client asked for — which is every other fail-open path's worst case too. The delegation hint remains a fixed text chosen by `REFLEX_DELEGATE`, never by an outcome.
- **Real-API experiments** run with the user's actual Claude Code settings: no `--model` (or other settings) override in the `claude` invocation, and the experiment's results file records the settings it ran under (model setting, entrypoint, betas seen). State the cost cap before running.
- Small, well-described commits; run `npm test` first. Phase/plan documents are local working files (`docs/plan-*.md`, gitignored) and are never committed or referenced from tracked files.
- Never run `git stash pop` on a stash you did not create in this session.

## Fixtures and re-capturing

```sh
node scripts/spike/capture.mjs --out _dumps/<name> -- -p "<prompt>" ...     # dump-only proxy + hooks; raw dumps are gitignored
node scripts/spike/summarize.mjs _dumps/<name>                              # structure only, never full prompts
REFLEX_REDACT_EXTRA="<email>,<username>" node scripts/spike/redact-fixtures.mjs _dumps/<name> --label <name>
npm run gen:versions
```
`redact-fixtures.mjs` masks identifiers everywhere, keeps detection markers, and fails if any original identifier or secret shape remains. Raw dumps contain prompts and account identifiers: never commit them.
