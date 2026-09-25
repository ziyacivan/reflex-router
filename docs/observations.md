# Observations

Measured results from running reflex on real sessions (shadow and route mode). Each entry states its conditions and sample size. These are observations, not general claims: one session is not a benchmark.

## 2026-09-19 — first dogfood session

**Setup.** One interactive Claude Code 2.1.277 session (Opus 5 requested on every decided turn), reflex at commit `0e2f76a` (the M2 build), shadow mode, Jev `jev-latest`, run from Turkey. Jev client at that time used global `fetch` (no persistent connection; see Latency).

**Classification.** 61 records: 12 `new` (11 main chat, 1 subagent), 24 `continuation`, 25 `side` (`no_tools` 13, `suggestion` 8, `agent_summary` 1, `compaction` 1, `cross_session` 1, `notification` 1). Zero `unclassified`, zero shape degrades, zero backend errors. `/compact` was classified as `side`/`compaction`.

**Reasoning, not length.** One main-chat turn was a hard question that ended with "answer in one sentence", i.e. it asked for a very short reply. Jev picked `opus` for it with `reasoning_demand` 3.24 (of 0–4). The tier question tells the backend to judge the reasoning a task demands and not the length of the message or reply (`src/policy.ts`), so this is our own first confirmation, on one prompt, of the "reasoning not length" behaviour previously reported for jev-router. The planned labelled comparison (length-framed vs reasoning-framed instructions) is still needed before this is more than one data point.

**Confidence.** 5 of 12 decisions stopped at `low_confidence` (choice confidence below the provisional 0.70 floor), including the only subagent turn (`sonnet`, confidence 0.32). Confidence is a spread statistic over the whole distribution, not the top probability, so a clear top option can still come with low confidence. Thresholds are unchanged; this is input for Phase 2 calibration.

**Decision rule (follow-up, same data).** All five low-confidence decisions were torn between `sonnet` and `haiku` while giving `opus` 0–0.09 (e.g. the subagent turn: sonnet 0.55 / haiku 0.45 / opus 0.00, confidence 0.32). With every request asking for Opus, the argmax-plus-confidence rule kept all five on Opus, the one tier the backend was most sure was not needed. The tier question is ordered, so the default rule is now `mass`: the cheapest tier leaving at most `REFLEX_MASS_EPS` (0.10) probability on the tiers above it. On these twelve vectors it picks `sonnet` for all five low-confidence turns (three were argmax `sonnet`; two were argmax `haiku` at 0.73 and 0.62 and move up to `sonnet` because sonnet held 0.27 and 0.29) and leaves the confident picks unchanged (haiku 1.0 ×2, haiku 0.95, opus 0.76). The vectors are unit tests (`test/unit/policy.test.ts`). `argmax` remains selectable, and every record now logs both picks so later sessions can compare them.

**Latency.** Jev decision latency p50 823 ms, p95 1136 ms (n = 12), measured with a fresh TCP+TLS connection per decision (global `fetch` drops idle connections after about 4 s). Shadow mode keeps this off the critical path. The client now holds a keep-alive connection and records `decision.connection` (`new`/`reused`) so the effect can be measured on the next session.

## 2026-09-19 — route-mode acceptance, sessions A and B: the cache cost model

**Setup.** Interactive Claude Code 2.1.277 sessions, Opus 5 requested, reflex in `route` mode (M3 build), from Turkey. Figures are the `usage` of individual responses in `decisions.jsonl`.

**Observation.** Claude Code's harness side calls (prompt suggestions, other `side` requests) are never rewritten, so they go to the **requested** model, and they carry the same conversation history with the same cache breakpoints. They keep the requested model's prompt cache warm even while the conversation itself is routed elsewhere. Session B:

| Time | Request | Sent to | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| B1 | new turn, routed down (guard: fresh) | Sonnet | 0 | 63,689 |
| B1 | continuation (pinned) | Sonnet | 63,689 | 7,557 |
| B1 | side call (`unclassified`) | Opus | 61,062 | 10,175 |
| B1 | side call (`suggestion`) | Opus | 71,237 | 1,815 |
| B2 | new turn, back on Opus (pre-fix behaviour) | Opus | 73,052 | 52 |

**Cost model that follows.** Moving a conversation **down** costs one cache write of the whole context on the target (B1: 63,689 tokens on Sonnet). Moving it back **up** to the requested model is close to free: its cache is already warm from the side calls (B2: 52 tokens written). The guard's penalty formula (write on the target minus read on the current holder) is the right shape for downward moves; upward moves are not guarded at all. Staying down costs the harness nothing extra, but every side call still bills the requested model, so part of a routed session's spend is on the requested model by construction.

**Consequence for reporting.** Savings estimates must not attribute side-call usage to the routed model: the report shows side-call token usage on the requested model as its own line.

**Follow-up (session B rerun): "one tier up" can cost more than "back to requested".** B1 was routed to Haiku (override), B2 moved up to Sonnet on Jev's pick (`return_up`), B3 went to Opus (override). B2 on Sonnet: 61,130 cache read (the shared system and tool prefix was already cached there) and **13,385 cache write** (the conversation itself). B3 on Opus: 74,398 cache read and 5,924 cache write, because side calls had kept Opus's copy of the whole conversation warm. So moving up one tier from a cheaper pin can pay a larger cache write than returning to the requested model, whose cache the harness maintains anyway; whether it is still cheaper overall depends on per-token prices and the turn's length. Not acted on; the report should show cache writes by move type (down, up one tier, back to requested) so Phase 2 can decide.

## 2026-09-19 — outcome signals, reconstructed for the earlier sessions

Outcome capture did not exist during shadow-1 and the route acceptance sessions. `scripts/spike/replay-transcripts.mjs` rebuilds the hook events those sessions would have produced from Claude Code's own local transcripts (main chat only; subagent transcripts are separate files and were not replayed) and runs them through the product tracker together with the logged decisions. Six of the seven logged sessions had a transcript.

| | shadow-1 | route (5 sessions) |
| --- | --- | --- |
| user prompts / logged main `new` turns / joined | 14 / 11 / 11 | 25 / 19 / 19 |
| `harness_injected` | 0 | 0 |
| correction score > 0 | 1 turn (score 1.0, rule `en:thats_wrong`) | 0 |
| `test_failure_after_edit` | 0 | 0 |
| reverted edits | 0 | 0 |

Every logged main-chat `new` turn joined to a user prompt; the one miss in a first pass came from the replay skipping a user-typed slash command, which does fire `UserPromptSubmit` (fixed in the replay). Test runs occurred (9 across the sessions) but none failed, and 4 turns contained edits, none undone. These sessions were short and mostly exploratory, so the absence of signals says little; the acceptance session is designed to trigger each one.

## 2026-09-19 — outcome capture acceptance (M4)

**Setup.** Interactive Claude Code 2.1.277 sessions with reflex in route mode and outcome hooks injected; the user made an edit, ran a failing test, corrected the assistant and had an edit reverted.

**Result.** Session 2 recorded `test_failure_after_edit` (runner `node-test`, exit code 1, one edit before it) on the turn that made the edit, and a subagent-scope outcome joined to that subagent's own decision record. `harness_injected` stayed at 0. The correction and the revert were recorded; one attribution issue is noted below.

**Finding: `UserPromptSubmit` fires for harness-injected messages too.** Two outcome windows in session 2 (turn seq 5 and 6) had no decision. Their prompts, identified afterwards from Claude Code's transcript because the worker had exited, were a message from another Claude session (transcript origin `peer`) and a background task notification (origin `task_notification`). The wire classified the same moments as `side` / `cross_session` and `side` / `notification`. Such windows now carry `no_decision: {reason: "no_wire_turn", nearest_wire: "side:cross_session"}` (the main-chat wire classification closest to the window's start). Prompts starting with `/` open no window at all. The same injected messages used to close the user's previous turn, so their text was read as that turn's correction; since `d4699c7` an injected prompt (recognised by `injectedPromptKind` in `src/wire`) keeps the user's window open, is counted in `counts.injected_prompts`, and is never scored. Session 2's records predate that fix.

**Attribution note (acceptance).** The `en:undo` match (0.8) landed on turn 3, the turn before the prompt that asked for the undo, while the revert that prompt triggered targeted turn 1. Recorded for Phase 2.

## 2026-09-19 — Jev latency with a kept-alive connection (archived sessions, read with `reflex report`)

**Setup.** The route-mode sessions archived after the keep-alive client and start-up warm-up landed (`route-1`, `route-3`, `m4-acceptance`; three sessions), Claude Code 2.1.277, Opus 5 requested, run from Turkey, Jev `jev-latest`. Numbers are the "6. Latency" section of `reflex report` over each file (nearest-rank percentiles; `m4-acceptance.jsonl` and the live `decisions.jsonl` are the same records and are counted once).

**Result.** All 11 decisions in those sessions reused the connection (`decision.connection: "reused"`): p50 382 ms, p95 408 ms (n = 11; by file: 6, 4 and 1 decisions). For comparison, the first dogfood session above used a fresh connection for each of its 12 decisions: p50 823 ms, p95 1,136 ms.

**Limits.** Different days, sessions, prompts and modes (shadow vs route), so this is not a controlled comparison of new vs reused connections; no decision in these sessions used a new connection, so there is no within-session contrast. Turns the cost guard refused before asking Jev are not decisions and are not in the sample. n = 11 says little about the tail. The live latency test (`npm run test:live`) is meant to measure new vs reused in one run; it has not been run yet (no key was available when it was written).

## 2026-09-19 — `reflex report` over the shadow dogfood session (excerpt)

**Setup.** `reflex report ~/.reflex/archive/shadow-1.jsonl` (v0.1.0 code) over the 61 records of the first dogfood session above: the M2 build, shadow mode, Opus 5 requested, Claude Code 2.1.277, run from Turkey, Jev `jev-latest`, a fresh connection per decision, and at that time the `argmax` rule with the 0.70 confidence floor (the `mass` rule came later). Sections 3 and 6, verbatim:

```
3. Shadow vs actual
  new turns that reached the backend (n=12); tokens = input + output + cache read + cache write of that turn's own request
    requested  would route to  turns  % turns  % tokens  actually sent there
    opus                haiku      5    41.7%     42.7%                    0
    opus               sonnet      1     8.3%      7.7%                    0
    opus                 opus      6    50.0%     49.6%                    6

  routed records (rewritten and accepted; includes pinned continuations): 0

6. Latency
  Jev decision latency (nearest-rank percentiles):
                            n     p50       p95
    all                    12  823 ms  1,136 ms
    connection not logged  12  823 ms  1,136 ms
```

**Reading.** Nothing was routed: shadow mode records what the plan would have done. "Would route to" is what the recorded plan said at the time, under that build's rule. "% tokens" is the share of the tokens of each cell's own request, not a saving: it says nothing about what the routed model would have cost or produced. One session, 12 decisions.

## 2026-09-19 — first real-work dogfood: where the tokens go (Phase 2 starting point)

**Setup.** Two Claude Code sessions on a company codebase (real work, not this repository), reflex v0.1.2 in shadow mode, Opus requested. Figures as reported by the maintainer from `reflex report` on that machine; the log itself stays there.

**Result.** 50 requests, 8.9M tokens. 2 user turns, 43 pinned tool-loop continuations, zero subagents. Both turns were judged `opus` (reasoning demand ≈ 2.95 of 0–4, confidence ≈ 0.9), so per-turn routing could have touched 0% of those tokens: a tool loop stays on the tier its turn started on. Two `unclassified` side calls consumed 452k tokens ($0.34 at list prices, about 3.5% of the sessions' usage). Outcome capture produced one window, so calibration has no data yet.

**Consequence.** Routing only pays where work starts a turn or a subagent. Phase 2a therefore adds (1) a workflow profile as the first section of `reflex report`, whose last line states at most how much of a log's tokens routing could have touched and how much of that is in subagents; (2) structural fingerprints for unclassified side calls, so they can be given a side kind; (3) an opt-in hint (`REFLEX_DELEGATE=1`) that asks Claude to delegate exploration to subagents, measured by the profile against total spend. Calibration (Phase 2b) waits for outcome data. A synthetic log of the same shape is a golden test (`test/fixtures/report/workflow-single-turn-long-loop.txt`). Two sessions, one codebase: this describes that work, not work in general.

## 2026-09-19 — the delegation hint reaches the request (REFLEX_DELEGATE=1)

**Setup.** `reflex -p "<one-line question>"` with `REFLEX_MODE=shadow REFLEX_DELEGATE=1`, the maintainer's own Claude Code settings (model setting `opus[1m]`, sent as `claude-opus-5` with the `context-1m-2025-08-07` beta; entrypoint `sdk-cli`; Claude Code 2.1.278; no `--model` or other override), reflex at the Phase 2a build. The Anthropic upstream was a local stand-in that recorded request bodies (never headers other than `anthropic-beta` and `user-agent`) and returned a canned reply, and the Jev URL pointed at a closed local port with a dummy key, so the run cost nothing and nothing left the machine. Betas seen: `claude-code-20250219, oauth-2025-04-20, context-1m-2025-08-07, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, mid-conversation-tool-changes-2026-07-01, advisor-tool-2026-03-01, effort-2025-11-24, fallback-credit-2026-06-01, extended-cache-ttl-2025-04-11`.

**Result.** The hook was answered with the hint, a `delegate_hint` record was written, and the one model request carried the hint text verbatim at the end of its trailing `role:"system"` message, prefixed `UserPromptSubmit hook additional context:` (details: `docs/wire-format.md` §7). The decision record carried `delegate_hint: "delegate-1"`, its task sent to the backend was the 114-character prompt alone (the hint is not in it, nor in the preview), and the Jev failure was recorded as `backend:network` with the request forwarded unchanged.

**Not run.** The same command against the real API: the request was about 98 KB (68 KB of tool schemas), roughly 28–31k tokens, all marked for a 1-hour cache write (2× input, $10/M on Opus 5 at list price), so a cold run would cost about $0.28–0.31, at or over the $0.30 cap set for it. Whether the model follows the hint, and whether that pays, is what the week in route mode is for.

## 2026-09-19 — Dynamic Workflow (`ultracode`) on 2.1.278: what a fan-out costs, and why a polling cap cannot hold one

**Setup.** One interactive Claude Code 2.1.278 session on this repository, the maintainer's own settings (`opus[1m]`,
effort `medium`, no `--model` or other override), driven through a pty by `scripts/spike/pty-run.py` into the dump-only
capture proxy (`scripts/spike/capture.mjs`), permission mode `plan` (read-only), real Anthropic upstream. One prompt
containing the `ultracode` keyword, asking for a read-only review of `src/wire/` and `src/outcome/`. A first attempt
stalled on a permission prompt for the `Workflow` tool and was killed after $0.3735; the second attempt is the one
measured here. **The run was killed at the spend cap, mid-workflow**, so every figure below is a lower bound.

**Cost.** 22 requests with usage, 1,504,782 tokens, **$2.6491** at list prices (Opus 5, 1-hour cache writes), plus
$0.3735 for the abandoned first attempt: **$3.02 for one prompt**. Split by scope:

| scope | requests | tokens | $ | % tokens | % $ |
| --- | --- | --- | --- | --- | --- |
| main chat | 7 | 515,248 | 0.6707 | 34.2% | 25.3% |
| workflow workers | 15 | 989,534 | 1.9784 | 65.8% | 74.7% |

Four workers ran. Each worker's **first** request pays a cache write of its own context (58,976 tokens for the first;
~9,530 each for the next three, which reused the shared prefix), and every worker step after that pays a further
2,000–10,500 tokens of cache write. Worker traffic was **two thirds of the tokens and three quarters of the dollars**
in a run that never finished.

**A polling kill-switch cannot hold a cap against a parallel fan-out.** The run was guarded by a monitor that
re-priced the captured SSE usage every 18 seconds and killed the session above the cap. Between two consecutive polls
the session went from **4 requests / $0.44 to 21 requests / $2.55** — about **$2.10 committed inside one 18-second
sampling gap** — because the workers start together and each writes its context to the cache at once. By the time the
check fired the money was already spent; killing the process cannot recall requests that have been billed. The agreed
cap was $1.50 and the actual spend was $3.02, an overrun of $1.52.

The conclusion is structural, not a tuning problem: **a cap enforced by sampling is always one poll interval behind a
fan-out that can commit its whole budget in parallel.** A cap has to be enforced where the requests pass, before they
are forwarded. `capture.mjs` now does that (it refuses to forward once a running total crosses `--cap-usd`). The
product proxy does not yet, and a per-session spend guard for workflow fan-outs is an open plan item — Claude Code's
own 25-agent / 1.5M-token warning is disabled by the `ultracode` session setting, so a user who turns it on has no
ceiling from either side.

**This is the first measurement behind the README's warning that the delegation hint "can raise total spend."** The
hint asks for delegation one turn at a time; `ultracode` delegates by default and, on this one prompt, put 65.8% of the
tokens into workers. One session, one prompt, killed early: it bounds nothing, but it is a data point with a price tag.

**Wire findings** (fixtures `test/fixtures/claude-code/2.1.278/ultracode.*`, details in `docs/wire-format.md` §7.1):
workflow workers are ordinary subagents on the wire (header **and** `cc_is_subagent=true`), classified correctly with
no code change; they request the **session's own model** (`claude-opus-5`, effort `medium`), so the third-party claim
that workers use a stock model did not reproduce; hook `agent_type` is the new value `workflow-subagent`;
`SubagentStart` fired for each worker, `SubagentStop` was not observed **because the session was killed**; zero
requests were `unclassified`.

**Not possible: the 452k comparison.** The two 452k-token unclassified side calls from the company dogfood cannot be
compared against these. No archived log on this machine carries a `side_fingerprint` field at all — fingerprints landed
in v0.2.0-alpha, after every archived session — and the company log stays on that machine. The only two `unclassified`
side calls present locally are 38k and 71k tokens from this repository's own acceptance sessions.

## 2026-09-19 — side-call routing: priced, and parked (no-go)

**Setup.** `reflex report --usd` over `~/.reflex/decisions.jsonl` as of that evening: 615+ decisions, 7 sessions,
~108M tokens, one day of real route-mode work on Claude Code 2.1.278 with Opus 5 requested, from Turkey. Every figure
is that one log at list prices (`src/pricing.ts`, verified 2026-09-19). One day, one machine, mostly one codebase.

**The question.** Side calls are 17.7% of the log's tokens, $17.88 at the requested model, and none of them is routed.
That is several times routing's whole measured saving ($3.33, section 8), so it looked like the largest remaining
lever. Section 12 of `reflex report` now computes the answer from a log instead of arguing it.

**A cold model swap loses, 2–4×.** A side call is almost entirely a cache hit on a prefix the conversation already paid
to write: `notification` is **99.5% cache read** (8,953,099 read against 13,743 write), `suggestion` 98.2%. Sending the
same request to another model turns that hit into a miss, and no tier wins the resulting rate comparison — Opus cache
read is $0.50/Mtok, while the cheapest possible cold write (Haiku, 5-minute) is $1.25/Mtok. A target would need
`input < $0.40/M` to break even cold; none is close. Priced on the measured tokens, every call cold: `notification`
2.12× on Haiku and 4.24× on Sonnet, `suggestion` 1.88× and 3.77×.

**What pays is a warm target, and it needs the calls to cluster.** In the steady state Haiku reads at $0.10/Mtok
against Opus's $0.50 and outputs at $5/M against $25/M. One cold write must then be amortised over later warm calls:
**break-even is 5.0 warm calls per cold write at the 1-hour write rate and 3.1 at 5 minutes** (Haiku), 8.3 for Sonnet.
The calls do cluster — p50 gap 20 s between consecutive `notification` calls, 3–52 s depending on kind.

**But the cheap tier cannot hold them.** Haiku's context ceiling is 150,000 tokens (`src/tiers.ts`) and the side calls
are far larger: **32 of 32 `notification` calls over the ceiling (max 420,574 tokens), 33 of 41 `suggestion` (max
501,695), 0 of 25 `no_tools` (max 47,204)**. This is what decided the question, and it is not a cache argument at all.
Removing the unroutable calls also breaks up the warm clusters that made the rest pay.

| tier | ceiling | writes | routable | over ceiling | $ saved gross | $ saved net |
| --- | --- | --- | --- | --- | --- | --- |
| haiku | 150,000 | 5m | 36 | 65 | $1.69 | $0.4912 |
| haiku | 150,000 | 1h | 36 | 65 | $1.79 | $0.1986 |
| sonnet | none | 5m | 101 | — | $1.06 | $0.1853 |
| **sonnet** | none | **1h** | 101 | — | **$4.62** | **$3.39** |

"Net" carves out conversations ever pinned below the requested tier — the only ones that can lose the free warm cache
their side calls provide today (observations above: a return to the requested model cost 52 tokens *because* side calls
kept it warm). That exposure is small here: **3 of 29 conversations**, with the cost guard refusing 11 `over_limit`
moves against 3 it allowed.

**An 18× spread on a fact nobody has recorded.** Sonnet is worth $3.39 net at 1-hour cache writes and $0.19 at
5-minute — the whole case rests on which TTL is in force, and **no record in this log says**. The wire computed
`betaExtendedCacheTtl` and discarded it; it is logged as `cache_ttl_beta` only from v0.2.3-alpha, so section 12
currently states that it assumed the shorter window. Per kind on Sonnet at the TTL each record implies, `suggestion`
**costs $1.66** (2.8 warm per cold, under its 8.3 break-even) while `notification` **saves $1.72** (15.0 warm per cold).

**Decision: no-go on `REFLEX_ROUTE_SIDE`, parked.** The only candidate that survives is **`notification` → Sonnet**,
worth $1.72 of the $3.39, and only if `cache_ttl_beta` reads 1h after a day of logging. `suggestion` loses money on
Sonnet and barely reaches break-even on Haiku, where most of its calls do not fit. `no_tools` is 43.6% cache read on
this log and saves $1.30, but 96.3% and **costs $0.0029** on the archived logs — not a stable pilot.

**The larger number, which needs no routing at all.** Two of these side kinds are optional Claude Code features with
user-facing switches. Section 9 now prints what they cost and the switch that turns each off:

| feature | side kind | calls | tokens | $ at requested model | switch |
| --- | --- | --- | --- | --- | --- |
| Session recap | `notification` | 32 | 9,420,418 | **$5.60** | `/config` → Session recap (`awaySummaryEnabled`) |
| Prompt suggestions | `suggestion` | 46 | 10,668,174 | **$6.22** | `/config` → Prompt suggestions (`promptSuggestionEnabled`, env `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION`) |

**$11.82 in one day against routing's $3.33 and side-routing's best case of $3.39.** Switch names and defaults are from
the Claude Code docs (interactive-mode, settings-reference), read 2026-09-19; Session recap is documented on by default.

**Limits.** Both rows above are attributed by side kind, which merges Claude Code's AFK recap with background task
notifications under `notification`; only the recap has that switch, so the $5.60 is an **upper bound**. From
v0.2.3-alpha the matched marker is recorded (`side_marker`, `session_recap` vs `task_notification`) and the row becomes
exact — on a log written by that build, which this one is not. The estimate also prices recorded token counts, where
the router sizes requests from bytes, so a call near a ceiling could be classified differently in practice. And it is
one day of one person's work: `no_tools` alone swings from saving to costing between this log and the archives.

## 2026-09-20 — first calibration read: the arms are comparable in size and say nothing yet

**Setup.** `~/.reflex/decisions.jsonl` as of 2026-09-19T21:55Z: 1,677 records, 1,525 decisions (1,505 with usage),
16 sessions, one machine, mostly this repository, Claude Code 2.1.277 and 2.1.278, Opus 5 requested throughout,
reflex 0.2.0-alpha .. 0.2.5-alpha in route mode, Jev `jev-1.13.0`, from Turkey. Rates below are over every main-chat
outcome window that joined a decision; intervals are Wilson 95%.

**Both main arms passed `MIN_OUTCOME_N` for the first time** — routed 26 windows, unchanged 27 — which is what makes
section 7 print rates at all. It is also the whole of the good news.

| main arm | correction > 0 (of scored) | test failure after an edit (of windows with edits) | reverted edit (of windows with edits) |
| --- | --- | --- | --- |
| routed | 1/23 = **4.3%** [0.8, 21.0] | 0/3 = 0.0% [0.0, 56.2] | 0/3 = 0.0% [0.0, 56.2] |
| unchanged | 0/21 = **0.0%** [0.0, 15.5] | 0/10 = 0.0% [0.0, 27.8] | 1/10 = **10.0%** [1.8, 40.4] |

Restricted to the turns where the two decision rules disagreed — the only turns on which the rule choice can matter:

| main arm, mass != argmax | windows | correction > 0 | test failure | revert |
| --- | --- | --- | --- | --- |
| routed | 11 | 0/9 = 0.0% [0.0, 29.9] | 0/0 — | 0/0 — |
| unchanged | 1 | 0/1 [0.0, 79.3] | 0/0 — | 0/0 — |

**The data cannot distinguish the two rules, and it is not close.** Across the whole log there is **one** organic
correction in 44 scored main windows (2.3%) and **one** revert; every disagreement window scored zero. The routed and
unchanged intervals overlap over almost their entire range, and the disagreement arms have 9 and 1 scored windows
against a floor of 20. Reading "routed corrects more often" off 1 versus 0 would be reading noise: a single window
moves the routed rate by 4.3 points.

**What n would.** Holding the observed base rate (~5%), a Wilson interval of ±5 points needs **about 73 scored
windows per arm**; detecting a real difference between 5% and 10% at 80% power needs **about 430 per arm**. Those are
*disagreement* windows, and disagreements are 29 of the 68 decisions that logged both readings (43%), so ~430 per arm
means on the order of 2,000 decided main turns. At today's density — 29 typed main turns across five sessions — that
is hundreds of sessions. **The honest conclusion is that per-rule calibration is not reachable from one person's
dogfood log**, and that the tractable near-term target is the weaker one: 20 scored windows per disagreement arm, which
buys a printed rate and not a comparison.

**Limits.** One machine, one person, largely one codebase. The arms are not randomised — a turn is routed because the
backend judged it easy, so "routed" and "unchanged" differ in the difficulty of their work before any outcome is
measured, and no rate here is a causal estimate. Windows are counted across five reflex versions and two Claude Code
versions; from 0.3.0-alpha every decision record carries `backend_version` and sections 2 and 7 split by it, so a
later read can refuse to mix them. Correction rules are English and Turkish only.

## 2026-09-20 — the delegation hint, measured on one day instead of across days

**Setup.** The five sessions run on 2026-09-19 evening under reflex 0.2.5-alpha (`00516692`, `0f0db1c4`, `29d16aa2`,
`33a26791`, `805b3287`): 186 decisions, 29 main-chat user turns, 38 outcome windows, Claude Code 2.1.278 throughout,
Opus 5 requested, route mode, same machine and codebase, same day. `reflex report --usd` over those records only.

**Why a same-day table at all.** The all-time hint table in section 0 compares 8 sessions with the hint against 8
without, but those sessions are spread over different days, different reflex builds and different work; it reports
`$2.64` per user turn without the hint and `$4.04` with it, which is a comparison of days as much as of the setting.
**Treat the all-time hint table as confounded.** Over one day, same build, same kind of work:

| hint | sessions | hints delivered | user turns | tokens | tokens per user turn | $ at sent | $ per user turn | subagent share | side-call share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off | 2 | — | 13 | 10,229,538 | 786,888 | $7.94 | $0.6104 | 11.7% | 5.5% |
| `delegate-1` | 3 | 17 | 16 | 7,359,589 | 459,974 | $6.28 | $0.3926 | 22.0% | 18.2% |

**Reading.** On this day the hint went with a higher subagent share (22.0% against 11.7%) and a lower cost per user
turn — the direction the hint is meant to produce, and the opposite of what the confounded all-time table shows. It is
**2 sessions against 3**, not a result: session-to-session variance in this log is larger than the gap, the sessions
were not assigned at random (the hint was on or off because of what was being worked on), and "user turns" counts
turns, not work done in them. It is recorded because it is the first comparison of the hint that holds the day, the
build and the codebase fixed, and because it points the other way from the all-time table.

## 2026-09-20 — the two windows without a wire turn, identified from Claude Code's transcripts

Of 31 main-chat outcome windows in those five sessions, 29 joined a decision and 2 closed `no_wire_turn`. Neither is a
slash command (those open no window). They are two different faults, both found by reading the sessions' own Claude
Code transcripts against the log:

**`29d16aa2`, turn seq 4 — not a prompt at all.** The window opened at 21:16:02.614Z with zero counts and
`correction: null`, and hung open until `session_end` 359 s later. The transcript has no user message at that instant:
the only event is the `Agent` tool's `tool_result`, carrying a `prompt_id` the tracker had never seen. `SubagentStart`
then reached `#turnFor`, which manufactures a main window for an unseen prompt id (`src/outcome/tracker.ts`, "an event
whose UserPromptSubmit we did not see"). The subagent's own window opened in the same millisecond **and was given the
same `turn_seq` (4)**, because `SubagentStart` passes `#turnFor(...).seq` — the two records are the two halves of one
call. So this is a **phantom window**: a tracker artefact, not a missed turn. It does not occur for every subagent
(`0f0db1c4` ran three with no phantom), only when the `SubagentStart` prompt id differs from the open main turn's.

**`805b3287`, turn seq 6 — a real prompt the wire could not see.** `nearest_wire` is `side:cross_session`, which is the
subagent hand-back that arrived 236 ms earlier and was correctly absorbed as an injected prompt (it shows as
`injected_prompts: 1` on the previous window). The prompt that actually opened the window is in the transcript as a
`queued_command` attachment at 21:28:07.672Z with `origin: {kind: "human"}` and `humanTurn: true`: **"Run the test
suite and the link check."** — typed by the user while the tool loop was still running, and correctly given the
delegation hint. It never became a main `new` turn because Claude Code delivered it *inside* the running loop, wrapped
as `<system-reminder> The user sent a new message while you were working: …`; `ownText()` strips reminders, so the
wire's interjection test (`matchesTypedPrompt`) saw nothing of the user's words and classified the step as an ordinary
`continuation`.

**Why the second one matters beyond reporting.** A message typed mid-loop in that wrapper is invisible to the wire, so
if it is a correction its score never reaches the turn it criticises — the signal escalation is built on is exactly the
signal this shape drops. `continuation:interjection` handles the unwrapped form; this wrapped form is not yet
recognised. Recorded, not fixed.

**Not answerable from this log: whether the hint changes the wire encoding.** No decision record carries the encoding
of a recognised `new` turn's prompt. `unclassified_reason: plain_string_no_typed_match` is written only for side calls
that failed the match, `side_fingerprint.last.content` only for unclassified side calls, and today's five sessions
produced zero unclassified side calls — so there is no residual to read either. A plain string that *is* promoted to a
`new` turn and an array of blocks leave byte-identical records. All 186 decisions are Claude Code 2.1.278, which
`docs/wire-format.md` §4.3 records as sending typed prompts as plain strings, so the expected answer is "all 29 were
plain strings" — but that is inference from the version, not a measurement, and it is the thing the question wanted
tested. The hint also cannot plausibly change it: it is appended to the trailing `role:"system"` message, not to the
user message (2026-09-19 delegation entry). **Measuring this needs a field that does not exist yet.**

## 2026-09-22 — 15 hours of route mode on 2.1.280 with Opus 5.5: routing cost more than it saved

**Setup.** The maintainer's own work, Claude Code 2.1.280, `~/.reflex/decisions.jsonl` from 2026-09-22 15:21 to
2026-09-23 07:17 UTC: 295 classified requests, 8 sessions, route mode throughout, `REFLEX_UPGRADES=on` in
`~/.reflex/env`. The builds were 0.3.3–0.3.6, so the opus tier default changed from `claude-opus-5` to
`claude-opus-5-5` mid-log. The requested model moved from Haiku to Sonnet to Opus 5.5 (`opus[1m]`) as the day went on.
Figures are list-price estimates over recorded token counts (`reflex report --usd`), not a benchmark.

**Section 8: −$0.95** on 55 routed main-chat and subagent requests ($3.38 at the requested model, $4.33 at the model
sent). By pair, same pricing:

| Requested → sent | Records | $ at requested | $ at sent | Difference |
| --- | --- | --- | --- | --- |
| Haiku 4.5 → Opus 5 (upgrade) | 5 | $0.17 | $0.84 | −$0.67 |
| Sonnet 5 → Opus 5 (upgrade) | 15 | $0.80 | $1.99 | −$1.20 |
| Opus 5.5 → Sonnet 5 | 35 | $2.41 | $1.50 | +$0.91 |

The loss is the upgrades. They were opt-in and turned on, but only 5 records were an upgrade decision: one subagent
(session `1a9d6360`) was decided Haiku → Opus at its first request. All 15 Sonnet → Opus records are that same
subagent's later continuations, still on the Haiku-era pin after the requested model became Sonnet, with no new decision
behind them. 0.3.7 drops a pin when the requested tier changes. The one saving pair was applied before any real
run had verified it.

**Section 5: one rejected rewrite**, Opus 5.5 → Haiku: `max_tokens: 128000 > 64000`. Opus 5.5 requests ask for 128000;
Haiku 4.5's maximum is 64000. The retry with the original bytes kept the session working and disabled Haiku for 30
minutes. 0.3.7 lowers `max_tokens` to the target tier's maximum.

**Harness calls decided as user turns (session `999c1b7f`).** Five main-chat `new` turns, all array-encoded (`blocks`):
one at 21:10:46 with a 75k-token cache write, then four at 21:14:12, 21:14:12, 21:14:31 and 21:15:02. Those four came
within 50 s, with 11,177–38,328 input tokens, no cache read or write, and no `UserPromptSubmit` behind any of them (4
`harness_injected` records). They were decided and two were routed to Sonnet. 0.3.8 keeps such a call `side` /
`unclassified` (`no_typed_prompt`) once hooks are arriving in the session, so the next log's section 11 can name its
shape.

**Nothing flagged it.** Section 1 read `drift: none` across a Claude Code version, a requested model and a `max_tokens`
value that no fixture held. 0.3.8 flags all three, and every rejected rewrite (`rewrite_rejected`).

**Section 12** printed a break-even of 2500000000.0 for Sonnet `notification` calls on the Opus 5.5 session: Sonnet 5
and Opus 5.5 both read the cache at $0.20/MTok, so a warm read saves nothing and there is no break-even. 0.3.8 prints
that instead.

**Follow-up run, 2026-09-23** (`docs/wire-format.md` §5.7): Opus 5.5 → Haiku (with the clamp) and → Sonnet were
accepted on first requests under the user's own settings. The $0.50 cap stopped the run before any continuation, so
every Opus 5.5 pair stays unapplied.

## 2026-09-23 — Laya vs Jev on the labelled reasoning set: Laya never routes down

**Setup.** `test/live/laya.live.test.ts` at commit `0eabb94`: the 30-prompt set of `test/live/reasoning-set.ts` (labels are the author's judgment, not ground truth; 12 haiku, 6 sonnet, 12 opus), the product's own state and questions, the default `mass` rule (`REFLEX_MASS_EPS` 0.10). Laya 0.3.7 (torch 2.14.0, CPU) started by the launcher exactly as in a session, once per checkpoint, on an Apple M4; Jev `jev-latest` over the network from Turkey. One run each, no repeats.

| Backend | exact | cheaper than label | dearer than label | picks haiku / sonnet / opus | AUC of P(opus), opus vs haiku labels | latency p50 / p95 |
| --- | --- | --- | --- | --- | --- | --- |
| Laya `english` | 12/30 | 0 | 18 | 0 / 0 / 30 | 0.68 | 175 / 334 ms |
| Laya `multilingual` | 12/30 | 0 | 18 | 0 / 2 / 28 | 0.76 | 88 / 310 ms |
| Laya `typed-decisions` | 12/30 | 0 | 18 | 0 / 0 / 30 | 0.95 | 216 / 712 ms |
| Jev | 27/30 | 2 | 1 | 13 / 5 / 12 | 1.00 | 321 / 400 ms |

**What it means.** Zero-shot, Laya picks Opus for essentially every prompt, so with Opus requested reflex would change nothing: no under-routing (safe), and no saving either. The 12 exact matches are just the 12 Opus labels. The reason is visible in the probabilities: `english` and `typed-decisions` keep P(opus) between 0.31 and 0.68 for every prompt, and the mass rule only moves below Opus when P(opus) ≤ 0.10. `multilingual` spreads its probabilities but puts 0.84–1.00 on Opus for half the haiku-labelled prompts. Jev's P(opus) is 0.00 on all 12 haiku-labelled prompts. This matches Laya's own README (base checkpoints "near chance on typed-decisions zero-shot", over-confident until temperatures are fitted); `laya-serve` also warns at start-up that the `english` checkpoint ships invalid temperatures.

**The one signal.** `typed-decisions` ranks the prompts well (AUC 0.95 for P(opus) between opus- and haiku-labelled prompts) inside a narrow band (0.31–0.50 haiku, 0.45–0.63 opus). A threshold picked on these 30 prompts would be fitted to the author's labels, so none is proposed here; making Laya route needs calibration or fine-tuning on reflex's own questions against more labelled data than one person's 30 prompts.

**Other measurements.** Ready (checkpoint loaded) in 2.0 s (`english`), 3.6 s (`multilingual`), 3.0 s (`typed-decisions`). Laya reported more than 512 input tokens for 16 of 30 prompts on `english` (max 1024) and for all 30 on the others (max 2048): the state plus the question text exceeds a 512-token context on long prompts, so `english` reads a truncated task. Latencies are local CPU vs network and not comparable as a claim about either backend in general.

## 2026-09-23 — Laya calibrated by distillation from Jev

**Why.** Zero-shot Laya never routes down (entry above). A calibration head (`src/backend/laya-calibration.ts`) maps Laya's answers to the product's two questions plus seven yes/no feature questions (`lf-1`) to Jev's tier distribution and reasoning score. It is a soft-target multinomial logistic regression plus a ridge regression, 14 inputs, fitted with `scripts/calibrate/fit.ts`, and shipped as parameters (`laya-calibration.generated.ts`, `cal-20260923`), so a Laya user never contacts Jev.

**Data (the teacher is Jev `jev-latest`; Laya 0.3.7 on CPU, Apple M4).**
- *Synthetic corpora:* 320 generated tasks (templated; cross-validation keeps tasks sharing their first three words in one fold) and 120 hand-written ones (40 over 800 characters: pasted logs, code, configs). Written by a model to cover stacks and difficulty; **not** real user prompts. Both went to Jev and to every Laya checkpoint; only numbers were kept (`harvest-corpus.ts`).
- *Real sessions:* two long `claude -p --continue` sessions behind reflex, in route mode with `REFLEX_COMPARE=laya` (`typed-decisions`). Session 1: 20 turns building a time-series database. Session 2: 17 turns building a CRDT editor backend. Settings: Claude Code 2.1.280, the user's own model setting (`claude-opus-5-5[1m]` on every turn), entrypoint `sdk-cli`, `--permission-mode acceptEdits` with a Bash allow-list, no `--model` override. **Cost: about $60.7 at the reported `total_cost_usd`, against a stated cap of $60** (the last turn crossed it). The results yielded 44 decisions with a comparison, 31 of them usable: 13 were lost to two bugs found on the way, both fixed (the comparison did not wait for `laya-serve` to load, and it used the product deadline). Jev asked for a downgrade 19 times, but none was applied: 18 were refused by the main-chat cost guard and 1 was `rewrite_unverified`, so both sessions ran entirely on Opus. These sessions ran behind a second, outer reflex (the one the experimenter's own Claude Code ran under), so its log holds every request twice; only the inner records have a `compare` block.
- *Not used:* the experimenter's own Claude Code history, which would have been the most realistic source, because sending it to Jev was not done.

**Cross-validated on the corpora** (440 tasks, plan = what the policy does with Opus requested, reasoning veto applied, `mass` eps 0.10):

| | agree with Jev | cheaper than Jev | Jev-opus turns kept on opus | Jev-haiku turns sent to haiku |
| --- | --- | --- | --- | --- |
| raw Laya (any checkpoint) | 13.6% | 0 | 60/60 | 0/129 |
| always Sonnet (reference) | 57.0% | 13.6% | 0/60 | 0/129 |
| `english` + head | 57.3% | 4.1% | 45/60 | 10/129 |
| `typed-decisions` + head (466 incl. sessions) | 53.9% | 3.4% | 60/74 | 1/135 |
| `multilingual` + head | 48.2% | 5.2% | 37/60 | 7/129 |

**Held out: the 30-prompt author-labelled set** (`test/live/laya.live.test.ts`; mass pick vs label): `english` 12 → 17 exact (4 cheaper than the label, all short-but-hard prompts, 9 dearer); `typed-decisions` 12 → 15 (2 cheaper); Jev 27 (2 cheaper). AUC of P(opus) between opus- and haiku-labelled prompts: `english` 0.68 → 0.97, `typed-decisions` 0.95 → 0.99.

**Held out: the real sessions** (head fitted on the corpora only, `typed-decisions`, n = 31, 29 main turns): Jev planned 8 haiku / 6 sonnet / 17 opus; the head planned 0 / 6 / 25 and agreed on 17 turns, **the same as raw Laya**. It moved 6 turns to Sonnet, 3 of which Jev had kept on Opus. So on real work it was no more accurate than Laya uncalibrated and ~10% of its plans were cheaper than Jev's; on the corpora that rate was 3–4%. The corpora are not the distribution of this kind of session (Jev said Opus for 14% of corpus tasks and 55% of session turns), and n = 31 is small.

**Things tried that did not help.** Squared or pairwise feature terms, and one extra Laya choice question (the kind of task, 10 options): within noise on agreement, a little more haiku at the price of more cheaper-than-Jev plans, and slower (`english` p95 1.9 s with the extra question).

**Latency, one calibrated decision (9 questions), idle M4, CPU.** `english` p50/p95 678/754 ms on short tasks and 1,474/1,478 ms on long ones; `typed-decisions` 864/946 and 1,763/2,223; `multilingual` 348/378 and 786/1,087. With the machine busy (inside the sessions) `typed-decisions` took p50 1,741 ms, p95 3,104 ms. `REFLEX_LAYA_DEADLINE_MS` now defaults to 2,500 ms.

**What it means.** The head turns Laya from "Opus for everything" into "Sonnet by default, Opus when it looks hard": it keeps most of what Jev keeps on Opus and almost never picks Haiku. It is not Jev: 3–4% of plans cheaper than Jev's on the corpora, about 10% (3/31) in the real sessions. Laya's own README says the real gain needs fine-tuning. The Jev-labelled data these tools now produce is exactly what that would need, and a shared-nothing way to grow it is `REFLEX_COMPARE=laya` in shadow mode.

## 2026-09-23 — the shipped Laya head, tested on 190 real prompts: 15% cheaper than Jev; refit with a safety margin

**Setup.** `scripts/calibrate/harvest-history.ts`, with the owner's consent: 190 prompts the owner typed in 41 past Claude Code transcripts (seven projects; agent-driven experiment directories excluded), each with its previous assistant reply and the model that answered it, put to Jev and to every Laya checkpoint. Only numbers were written. The same harvest measured one calibrated decision on these real prompts, machine idle: `english` p50/p95 1,491/1,585 ms, `multilingual` 772/977 ms, `typed-decisions` 2,265/2,923 ms. `typed-decisions` is above the 2,500 ms default deadline at p95.

**This distribution is not the corpora's.** Jev planned 3 Haiku, 93 Sonnet and 94 Opus for these prompts; for the corpora it was 129, 251 and 60.

**The head shipped in 0.4.0 (`cal-20260923`, fitted on corpora only) on these prompts** (plan with Opus requested):

| | agree with Jev | cheaper than Jev |
| --- | --- | --- |
| raw Laya | 94/190 | 0 |
| `english` + 0.4.0 head (the default) | 106/190 | **28 (14.7%)** |
| `typed-decisions` + 0.4.0 head | 104/190 | 10 (5.3%) |
| `multilingual` + 0.4.0 head | 103/190 | 63 (33%) |

The corpora had put the cheaper-than-Jev rate at 3–4%. On real prompts the default was four times worse. That is a quality risk in route mode: 15% of the turns Jev keeps on Opus went to Sonnet.

**Refit (`cal-20260923.2`).** Now fitted on corpora + history (+ the recorded sessions for `typed-decisions`). `fit.ts` also adds an **opus margin**, a constant added to the opus logit and folded into the head's bias. It picks the smallest margin whose cross-validated plans on *real* samples are cheaper than Jev's at most 3% of the time (`--max-under`). The margin is tuned on the same real samples it is scored on, so the rates below are somewhat optimistic.

| real prompts, cross-validated | margin | agree with Jev | cheaper than Jev | moved below Opus |
| --- | --- | --- | --- | --- |
| `english` | 0.75 | 110/190 | 3 (1.6%) | 24 |
| `typed-decisions` (221 incl. sessions) | 0.375 | 123/221 | 5 (2.3%) | 23 |
| `multilingual` | 0.5 | 102/190 | 5 (2.6%) | 19 |

**Held out, the 30-prompt author set.** `english` gets 15/30 exact with **0** cheaper than the label; the 0.4.0 head got 17/30 with 4, all short-but-hard. `typed-decisions` gets 15/30 with 1 cheaper; Jev gets 27/30 with 2.

**What it means.** With the margin, calibrated Laya is conservative. On the owner's real prompts it moves about one turn in eight off Opus, and it rarely moves one that Jev would keep. It saves less than Jev: Jev moves half of them. The synthetic corpora are useful for shape, but they cannot set the safety margin. Every refit has to be scored on real traffic.

## 2026-09-23 — why Opus 5.5 route mode barely routed: unverified pairs, and a guard that was right for the wrong reason

**The 19 downgrades that were never applied.** In the two `claude -p --continue` calibration sessions (entry above), all 18 guard refusals were `ctx_unknown`, not `over_limit`: each `-p --continue` turn starts a new reflex, so its worker has never seen a response on the conversation and does not know its context size. The 19th was a first turn: the guard allowed it (`fresh`), and `rewrite_unverified` stopped it. The maintainer's own interactive log (`~/.reflex/decisions.jsonl`, 2026-09-22/23, requested model `claude-opus-5-5`) has 15 guarded main-chat downgrades: 8 `fresh` first turns (allowed by the guard; stopped by `rewrite_unverified`, a disabled tier, or applied before Opus 5.5 was the default), 2 `ctx_unknown`, and 5 `over_limit` with penalties of $0.38–$1.85 at 100k–487k tokens of context, all toward Sonnet.

**The $0.01 limit.** Switching Opus 5.5 → Sonnet on the 1-hour-TTL main chat costs $3.80 per million context tokens, so $0.01 allows it only below about 2.6k tokens. Claude Code's system prompt alone is larger, so after the first turn no main-chat switch between any pair could pass. The fixed limit ignored what a switch saves. The guard now also allows a switch whose penalty is recovered within `REFLEX_SWITCH_BREAKEVEN_REQUESTS` (default 10) requests on the cheaper tier, at the conversation's own measured mean new and output tokens per request (`src/guard.ts`, `saving_usd` in the record).

**Replayed on the 5 refusals**, with each conversation's averages up to that point (list prices, recorded token counts): a request on Sonnet instead of Opus 5.5 saved an estimated $0.010–$0.018 (mean new tokens 1.3k–3.0k, output 480–950; cache reads cost the same on both). Recovering the penalty would take **33, 38, 39, 111 and 111 requests**. At about 13.5 main-chat requests per user turn in this log (930 continuations, 69 new turns), that is 2.5–8 user turns on Sonnet with no return to Opus. So with the default of 10 all five are still refused. On this log the guard refused the right switches; the fixed limit just happened to agree with the break-even result. The break-even rule counts neither the way back (a return to Opus writes at Opus rates whatever it missed) nor any difference in how many requests or tokens Sonnet uses. Both are unmeasured.

**What does route Opus 5.5 work.** Mid-conversation switches on a large context rarely pay off. What can pay off is a conversation's first turn, where nothing is cached yet, plus subagents. Those were blocked by `rewrite_unverified`. A follow-up run (`docs/wire-format.md` §5.7, est. $1.53 including three failed attempts, cap $2.50) verified Opus 5.5 → Haiku end to end, and route mode now applies it. A second follow-up (est. $1.03, cap $3.00) had the Opus 5.5 main chat start a native Sonnet or Haiku subagent. It showed that Opus 5.5 accepts Sonnet-signed thinking, and verified Sonnet/Haiku → Opus 5.5 as well. Opus 5.5 → Sonnet, the target of 14 of the 19 downgrades Jev asked for, is applied now too. A third follow-up (est. $2.58, cap $7.00) verified Opus 5.5 ↔ Fable. Fable thought only when a puzzle came before its first tool call. A Fable main chat → Opus 5.5 was also accepted end to end (est. $1.15, with a `--model fable` override approved by the user). None of this measures whether the routed turns were as good; that needs outcome data from real use.

## 2026-09-23 — Laya fine-tuned by distillation from Jev (pilot): faster and closer to Jev, but four times more cheaper-than-Jev plans

**Why.** The calibration head asks 9 questions (p95 1.6–2.9 s) and still routes conservatively. Laya's README says fine-tuning is where the value is. A fine-tune needs text, and the owner decided (2026-09-23) that only synthetic tasks may be kept and uploaded; the owner's prompts are used only for local evaluation, never for training.

**Setup.** 500 synthetic tasks written by a model (five domains; 348 main, 152 subagent; 95 over 800 characters; 114 with a previous reply), built into the product's decision state and labelled by Jev `jev-1.13.0` on the product's two questions (`scripts/calibrate/label-corpus.ts`); Jev's answer distributions are the soft targets. Jev's argmax: 164 haiku, 209 sonnet, 127 opus. Laya's own fine-tuning notebook (Apache-2.0), adapted to this data, base `laya-typed-decisions`, on Kaggle 2×T4 through the Kaggle API (private dataset and kernel): 382 training tasks (764 questions), 4 epochs, 5 min; one group in five held out. The checkpoint is asked only the product's two questions, with no head.

**Held out, synthetic (118 tasks, argmax vs Jev's argmax).** Base `typed-decisions` zero-shot: 20% agree, 0% cheaper, 80% dearer, demand MAE 1.00. Fine-tuned: 77% agree, 10% cheaper, 13% dearer, demand MAE 0.36.

**Real prompts** (`scripts/calibrate/eval-checkpoint.ts`, with the owner's consent: 279 prompts the owner typed in 80 transcripts, 277 answered by every backend; Jev planned 22 haiku, 124 sonnet, 131 opus; plan with Opus requested, laya 0.3.7 on CPU, Apple M4, machine idle):

| | agree with Jev | cheaper than Jev | dearer | picks h/s/o | opus recall | latency p50/p95 |
| --- | --- | --- | --- | --- | --- | --- |
| shipped `english` + `cal-20260923.2` | 155 (56%) | **7 (2.5%)** | 115 | 1 / 47 / 229 | 124/131 | 1,488 / 1,564 ms |
| fine-tuned pilot | 168 (61%) | **35 (12.6%)** | 74 | 10 / 104 / 163 | 97/131 | 442 / 612 ms |

Cross-entropy against Jev is the same (1.046 vs 1.046); demand MAE 0.72 → 0.67.

**What it means.** 382 synthetic tasks and five minutes of training give a checkpoint that is 3.4× faster (two questions instead of nine), agrees with Jev more and moves far more turns off Opus, but it moves a quarter of the turns Jev keeps on Opus as well: its cheaper-than-Jev rate is where the 0.4.0 head was before the safety margin (14.7%). As is, it must not ship. Two gaps are visible: the corpus has fewer hard tasks than real traffic (25% vs 47% opus by Jev), and there is no opus margin. Next: a larger corpus weighted towards real traffic's shape, and a margin tuned on one half of the transcripts and scored on the other.

## 2026-09-23 — Laya fine-tuned on 2,734 synthetic tasks: at the head's safety level it saves no more; only faster. Not shipped

**Setup.** As the pilot (entry above), with the corpus grown to 2,734 tasks after filtering: the pilot's 500, 1,249 model-written tasks kept, 1,000 written one by one by subagents without scripts (five of ten first-round batches were template-generated, 45–54% unique openings against 96–100%, and were discarded), 30% Turkish, half of the main tasks with a previous reply. Rows sharing any six-word sequence with the owner's typed prompts (10) and exact duplicates (5) were dropped. Jev's argmax: 884 haiku, 1,296 sonnet, 554 opus (20% opus; the owner's real prompts: 46%). Kaggle 2×T4, 2,185 training tasks, 4 epochs, about 40 min.

**Held out, synthetic (549 tasks).** 79% argmax agreement with Jev (pilot 77%), 9% cheaper, tier TV 0.20 (0.23), demand MAE 0.31 (0.36).

**Real prompts** (`eval-checkpoint.ts`, with the owner's consent: 285 typed prompts in 80 transcripts, 278 answered by every backend; Jev planned 23 haiku / 126 sonnet / 129 opus; plan with Opus requested):

| | agree | cheaper than Jev | picks h/s/o | opus recall | latency p50/p95 |
| --- | --- | --- | --- | --- | --- |
| shipped `english` + `cal-20260923.2` | 152 | **7 (2.5%)** | 1 / 47 / 230 | 122/129 | 1,471 / 1,566 ms |
| fine-tuned, no margin | 173 | 22 (7.9%) | 8 / 90 / 180 | 108/129 | 449 / 600 ms |
| fine-tuned + opus margin, tuned on the other half of the transcripts | 155 | **7 (2.5%)** | 8 / 38 / 232 | 123/129 | 449 / 600 ms |

The margins picked were 2 and 1.5 (large: its cheaper-than-Jev plans are confident ones).

**What it means.** Five times the data brought the cheaper-than-Jev rate from 12.6% to 7.9%, still too high. At the shipped head's safety level the fine-tuned checkpoint keeps as many turns on Opus as the head (232 vs 230): no saving gained. Its one gain is latency (3.3× at p95, two questions instead of nine), which item "cut Laya latency" can get far more cheaply than hosting an 800 MB custom checkpoint behind a `laya-serve` wrapper. The limit is the data: synthetic tasks do not carry real traffic's shape (20% vs 46% Opus by Jev), and the owner decided that their prompts are not training data. **Not shipped.** The tools stay (`label-corpus.ts`, `eval-checkpoint.ts`, `laya-serve-checkpoint.sh`) for a later attempt with better data.

## 2026-09-24 — effort can change mid-conversation on Opus 5.5 without losing the cache; on Sonnet it cannot

**Setup.** Claude Code's own `/effort` captured against a local stand-in ($0), then one `-p` Opus 5.5 session through
`route-experiment.mjs --probe-effort-switch` (est. $0.94, cap $2.00). Details and the table: `docs/wire-format.md` §5.8.

**Result.** On Opus 5.5, switching from `high` to any of the five levels kept the whole ~49k-token cache (read
48–49k, write under 1k), whether the switch went through the per-message effort, the top-level value, or both. The
effort messages re-inserted on later requests kept every request a full cache hit; a forgotten one was accepted but
lost the cache from that point. On Sonnet 5 the same switch read 0 and rewrote 49k tokens (est. $0.20 at list prices).

**What it means.** On Opus 5.5 an effort change mid-conversation costs nothing in cache, unlike a model switch
(33–111 requests to pay back, 2026-09-23). On Sonnet it costs as much as a model switch.

**Follow-up, same day: does the level take effect?** A non-memorisable puzzle answered in full at each variant, twice
(est. $0.60; a first attempt with a known-answer puzzle, $0.23, showed nothing). With Claude Code's effort still on the
system message at index 1, changing only the top-level value left thinking where it was (1,616–2,060 output tokens
against 1,844–1,900 unchanged); adding the effort message moved it (about 1,070 at `low`, about 5,100 at `max`). So on
Opus 5.5 the level can only be changed by adding to the history, and reflex must keep re-adding what it added.

## 2026-09-24 — effort: every model measured, and where a changed level is safe to leave behind

**Setup.** `route-experiment.mjs --probe-effort-verify` (four runs) and smoke runs through the built `reflex`, `-p` and
interactive, under the user's settings (`opus[1m]`, no `--model`). Est. $9.8 on top of the $1.77 of the first two runs.
Tables and wording: `docs/wire-format.md` §5.8.

**Result.** The effort message changes how much the model thinks on Opus 5 (1,556 / 2,354 / 2,676 output tokens at
`low` / client `high` / `max`) and Fable 5.1 (2,215 / 2,563 / 5,908) and keeps their cache, where a top-level change
rewrites ~13.6k tokens of it; Sonnet's top-level value moves it the most (1,980 / 5,626 / 10,524) and rewrites the
whole prompt each time. With Anthropic's edited-history check opted in, an **inserted** effort message that is later
left out gets the next request refused (Opus 5.5), while a level **set** on the turn's own system message and later
left out is accepted with nothing dropped (Opus 5.5 and Fable). Claude Code answers that refusal by removing the
thinking blocks and retrying on its own. Appending after Claude Code's effort-bearing system message cost ~11k tokens
of cache on the next request and on a resumed turn; setting it in place cost nothing (identical numbers to a run
without `REFLEX_EFFORT`).

**What it means.** `REFLEX_EFFORT=1` now only uses `set` (a conversation's first request, main or subagent) and
Sonnet's top-level value where the cache is rewritten anyway: nothing left behind if the conversation is later
continued without reflex. Later main-chat turns need an insert, so they wait for `REFLEX_EFFORT_MIDTURN=1`, whose cost
if the conversation is continued without reflex is one refused request and the earlier thinking blocks, on enforced
accounts only. Quality is still unmeasured: `REFLEX_EFFORT_AB` and report section 14 are there for it.

**Seen on the way, not about effort.** After route mode moved a `-p` main chat to Haiku, `claude -p --continue`
requested Haiku itself (`requested.model` `claude-haiku-4-5-20251001`, no effort): the resumed session took the model
of the transcript's last turn, so the user's own model choice did not come back. Measured and fixed afterwards: [wire format §5.9](wire-format.md#59-a-resumed-conversation-requests-the-transcripts-model-21281-0).


## 2026-09-24 — the outcome hooks under Claude Code's sandbox (2.1.281, Linux)

A project whose `.claude/settings.local.json` says `{"sandbox": {"enabled": true}}`: every prompt of an interactive
session launched through reflex showed `UserPromptSubmit hook error — HTTP 403 from http://127.0.0.1:46847/__reflex/hook`,
and `claude -p` sessions reported `Stop hook error`. Neither the front door nor the worker has a 403 path
(`src/launcher/front-door.ts` answers the hook with the worker's reply or a silent 204), so the request never reached
reflex. Same prompt, `claude -p "Reply with the single word: ok" --output-format stream-json --verbose` through the
launcher in route mode, one `--settings` override each:

| session | hook errors | result |
|---|---|---|
| `/tmp`, no sandbox in any settings | none | `ok`; opus-5-5 asked, haiku-4-5 sent |
| the sandboxed project, as is | `Stop hook error` | `ok` (this one prompt still routed) |
| + `{"sandbox":{"enabled":false}}` | none | `ok` |
| + `{"allowedHttpHookUrls":["http://127.0.0.1:*"]}` | `Stop hook error` | `ok` |
| + `{"sandbox":{"enabled":true,"network":{"allowedDomains":["127.0.0.1","localhost"]}}}` | none | `ok` |

So the sandbox's network allowlist decides. The network-config page's "never sends localhost through the proxy" is
stated for WebSocket connections; http hooks did go through the allowlist here. Allowing `127.0.0.1` fixes it, but it
opens every loopback service to every sandboxed command, which a user may not want.

**Correction, the same night: routing did depend on the hooks.** The first fix left the hooks out under the sandbox and
was verified with one `claude -p` prompt, which routed; the table's "routing unaffected" was read off that single prompt.
A real interactive session in the sandboxed project told a different story in `decisions.jsonl`: its first prompt was a
`new` turn and was judged, and every later prompt was `side` / `unclassified` / `plain_string_no_typed_match`,
forwarded to the requested model without a question to the backend. Since 2.1.278 a typed prompt is a plain string, and
a plain string counts as a new turn only when the UserPromptSubmit hook delivered that prompt
(`src/wire/claude-code.ts`, `classifyTurn`); a session's first request reaches reflex as blocks, which is why it alone
routed. So without the hooks only the first prompt of a session is routed.

A command hook gets through where the http hook does not: in a session with `{"sandbox":{"enabled":true}}` and both kinds
on `UserPromptSubmit`, a loopback listener received the command hook's POST (`fetch` from a `node` script, answered 204)
and nothing from the http hook: the command hook, a process Claude Code starts itself, was not held to the sandbox's
network allowlist. Hence
`REFLEX_HOOKS=auto`: `http` hooks normally, and under the sandbox `command` hooks running `reflex hook-relay <url>`, which
relays the event on stdin to the door and prints the door's answer (only a JSON object; anything else prints nothing,
since a UserPromptSubmit command hook's plain stdout would join the prompt's context).

Two prompts in one session (`claude -p --input-format stream-json`, two user messages), in the sandboxed project, route
mode, Jev:

| build | prompt 1 | prompt 2 | hook errors |
|---|---|---|---|
| hooks left out (the first fix) | `new`, Jev haiku 1.0, haiku sent | `side` / `plain_string_no_typed_match`, opus sent | none |
| hooks relayed by a command hook | `new`, Jev haiku 1.0, haiku sent | `new`, Jev haiku 1.0, haiku sent | none |

The relay costs one `node` start per hook event: `reflex statusline`, the same CLI path, took 39–46 ms here.


## 2026-09-24 — three days of route mode: down and up moves nearly cancel

**Setup.** `reflex report --usd` over the maintainer's `~/.reflex/decisions.jsonl` (2026-09-22T15:21Z to
2026-09-24T18:01Z): 27 sessions, 2,209 classified requests, ~384M tokens, `route` mode, Jev `jev-1.13.0`, mostly
Opus 5.5 requested. Section 8's "routed only" difference, split by direction and session with `savedUsd`.

**Result.** 96 requests moved down (Opus 5.5 → Sonnet 5: 89, → Haiku 4.5: 7), an estimated $3.76 less; 38 moved up
(Sonnet 5 / Haiku 4.5 → Opus 5 or Opus 5.5), an estimated $3.73 more; net $0.03. By session: +$2.07, +$1.03, +$0.66,
+$0.25 (downward, three of them subagent work) against −$1.87 and −$2.11 (upward, sessions that requested Sonnet or
Haiku with `REFLEX_UPGRADES` on, partly experiments). Tokens: main-chat tool-loop continuations 73.4%, subagents
12.9%, side calls 8.5%, main-chat new turns 5.2%, so routing could touch at most 26.3%. The guard refused 18 of 26
main-chat switches (16 `over_limit`, median penalty $1.09; 2 `ctx_unknown`). In the last 24 hours of the log nothing
was routed: Jev wanted Sonnet on 19 of 40 new turns and the guard refused the main-chat ones. Jev latency p50 414 ms
(381 ms on a reused connection, n = 165).

**What it means.** On this log the estimated saving from downward moves is real but small, and the upward moves spend
about the same amount; the status line's per-session figure can look large while the total stays near zero. None of
it says whether the routed turns were as good (section 7: routed arms n < 20). List-price estimates over recorded
token counts, not bills; one machine, one person.


## 2026-09-24 — stopping Laya work

**Decision.** Laya throughput did not meet expectations in daily use; closing all open Laya items (refit, latency,
512-token truncation, Windows support). No further Laya work planned. `REFLEX_BACKEND=laya` stays in the codebase as
a supported option (fitted for `cal-20260923.2`, `FEATURE_VERSION` unchanged) but gets no more tuning.


## 2026-09-24 — a second machine: five days of work use (shared log)

**Setup.** `reflex report --usd` over a `reflex share` log from the maintainer's work machine (2026-09-19T09:17Z to
2026-09-24T18:49Z): 26 sessions, 2,517 classified requests, ~631M tokens; route 1,641 / shadow 876 requests; Jev
`jev-1.13.0`; Claude Code 2.1.278+; mostly Opus 5.5 requested, some Fable 5.1. No `REFLEX_AB` in this log.

**Result.** 248 routed records (Opus 5.5 → Sonnet 5: 185, Opus 5 → Sonnet 5: 38, Sonnet 5 → Opus 5.5: 25): an
estimated $7.11 less on routed requests (75.2% of their requested-model price), 3.4% of all main + subagent spend
($206.79 → $199.68). Tokens: main-chat continuations 55.0%, subagents 27.3%, side calls 16.8%, new turns 0.8%; routing
could touch at most 15.1%, 69.2% of it in subagents (one session of 13 subagent runs held 294.6M tokens). Guard: 6 of
10 main-chat switches refused (`over_limit`, penalty p50 $0.62). Jev p50 629 ms, p95 1,027 ms (n = 41). Mass vs argmax
agreed on 48.8% of 41 turns. Outcome windows: routed main 1, subagent 2, all without signals; no comparison possible.
Side calls $45.25 at the requested model (Session recap $2.70, Prompt suggestions $3.67).

**What it means.** On a subagent-heavy work log the downward moves dominate and the estimated saving is positive, unlike
the three-day personal log above (net ~$0). It adds nothing to the quality question: without `REFLEX_AB` its routed
turns are not comparable with its unrouted ones, and combined with the personal log the randomised arms stay at routed
11 / control 22. List-price estimates over recorded token counts, not bills.

## 2026-09-25 — MCP tool search behind reflex: half the starting context, and two routing breaks it would have caused

**Conditions.** One machine, Claude Code 2.1.282, the owner's own settings (`model: opus[1m]`, four MCP servers, two of
them unauthenticated), route mode. Details and API errors verbatim: `docs/wire-format.md` §5.10,
`test/fixtures/claude-code/2.1.282/experiment.toolsearch-route.results.json`.

**Context.** Claude Code's `/context` at the start of an interactive session: 32.5k tokens without reflex, 66.9k behind
reflex 0.5.5 (MCP tools 9k and built-in tools 43.2k, all loaded up front), 32.4k with `ENABLE_TOOL_SEARCH=true`. The
first request of a `-p` one-liner on Opus 5.5: 28,376 / 44,456 / 28,167 input tokens (single runs). Every later request
of a session re-reads that prefix, so the difference is paid again per request, at the cache-read rate.

**What turning it on would have broken.** In the owner's `-p` sessions before the fix, the step after a ToolSearch was
logged as a side call (`tool_result_text`): a pinned loop would have sent that step to the requested model. And with
`reflex:haiku` / `reflex:sonnet` the first routed request was rejected (400) because of `tool_addition` blocks, so
reflex's fallback re-sent it on Opus and the conversation lost its pin. After the fix: 3 Sonnet and 2 Haiku sessions on
the final code, every request routed, no fallback.

**Not measured.** Whether a model sees the same tools as well when a lifted `tool_addition` becomes a non-deferred tool
(the visible set is the same; quality was not scored). Cost per session was not measured beyond the start-of-session
context. List-price estimate of the experiment: about $4.

## 2026-09-25 — nine anomaly claims checked: six fixes, two refuted

**Conditions.** Claims from another machine's logs, checked one by one with a prediction, a control, a repro and a
mutation: fake upstream and fake Jev for the wire (no tokens), the real `claude` 2.1.282 against a fake Messages API,
and a few live runs on the owner's settings (`opus[1m]`, `effortLevel: medium`). Full record with commands and outputs:
[`verification-2026-09-25.md`](verification-2026-09-25.md).

**Result.** Four claims confirmed and fixed in code. (1) Side calls lost `REFLEX_EFFORT`'s marks. Live, a subagent's
progress summaries read only the 16.6k fixed prefix and wrote its history again (17.9k); after the fix they read 31–34k
and wrote 88. (2) A routed subagent's summaries went to the requested model and built a second cache there: a 15k
write on Opus for a loop running on Sonnet; they now follow the pin. (3) A subagent whose Agent call named a model was
routed anyway. (4) Decisions queued behind 4 sockets: with 800 ms answers, 4 of 8 simultaneous subagents timed out
(fake Jev); in the owner's log 28% of subagent decisions timed out when 4 or more started together. Tool search behind
0.5.5 was confirmed and was already fixed in 0.5.6. `REFLEX_EFFORT_UP` going above `effortLevel` is the flag doing
its job (a decision is open). The resends on a rejected rewrite or a dead worker happen as documented. The startup 429
is Claude Code's quota probe, answered 429 without reflex too.

**Follow-ups.** Task notifications and subagent hand-backs are real main-chat turns (92 of 99 and 45 of 46 answered
there in the transcripts); they, and tool results carrying harness text, now follow the conversation's pin. With the
main chat on Sonnet, a notification read ~45k and wrote ~400. A subagent resumed after a background task is rebuilt by
Claude Code (cache miss with or without reflex); reflex now keeps its effort level there. Subagents asking for another
tier than the main chat are not routed. Resuming a conversation in a new process rewrote its cache in every
interactive pair, with or without reflex (12,831 vs 12,840 written), so continuing without reflex adds nothing. The
effort level may go above the user's own by the owner's decision. List-price estimate of all live runs: about $11.40
(~6.3M tokens).
