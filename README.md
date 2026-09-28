# reflex-router

**Model routers ask "which model?" reflex also asks what happened next — and writes it down so the routing can eventually be judged against something.**

`reflex` runs the real [Claude Code](https://docs.claude.com/en/docs/claude-code) behind a loopback proxy and does three things with it:

1. **Decide.** At the start of each piece of work, a fast decision model ([TypeSafe Jev](https://docs.typesafe.ai), or [Laya](https://github.com/NandhaKishorM/laya) running on your own machine) judges how much *reasoning* the task demands, not how long the message is.
2. **Route** (opt-in). When it is safe, and does not throw away the conversation's prompt cache for nothing, send the work to a cheaper model. Otherwise leave it exactly as it was.
3. **Observe.** For every decision, record whether it looked wrong afterwards (the next prompt reads like a correction, a test failed after an edit, an edit was undone) and read the result back with `reflex report`.

What this alpha does **not** do, so you don't have to find out: reasoning effort (`REFLEX_EFFORT`, off by default) is new and its effect on quality is unmeasured; **no threshold in it is calibrated**, because calibrating one needs far more data than one person's log holds; and **no cost saving has been measured** — the dollar figures below are list-price estimates over recorded token counts, not bills. See [What reflex found](#what-reflex-found), [Status](#status) and [Contributing data](#contributing-data).

## How it works

```
   you ──► claude ──► reflex (127.0.0.1) ─────────────────► api.anthropic.com
          (unchanged)  front door + worker                   your credentials,
                            │                                forwarded untouched
                            │  start of work only:
                            │  redacted task text, capped
                            ▼
                       TypeSafe Jev
                       (decision backend)
```

`claude` is started with its base URL pointed at reflex. A small front door owns the loopback port for the whole session and hands each request to a supervised worker; if the worker fails, the door forwards the request straight to the API. Claude Code's own hooks post to the same loopback door for outcome capture.

**Decide → route → observe:**

- **Decide.** Only a positively identified start of work is sent to Jev: a prompt you typed in the main chat, or a subagent's first request. Tool-loop steps and Claude Code's own side calls (suggestions, summaries, notifications) never are. One backend call asks two questions: the least capable tier that will still do the task well (Haiku, Sonnet or Opus), and how much reasoning it demands.
- **Route.** In `shadow` mode (the default) every request is forwarded byte for byte and reflex only records what it *would* have done. In `route` mode a request can be rewritten for a cheaper model, but only for retargets verified against the API: every pair among Haiku, Sonnet, Opus and Fable (upgrades need `REFLEX_UPGRADES`, Fable needs `REFLEX_ALLOW_FABLE`). A **subagent** is decided at its first request and pinned to that model for its whole tool loop. The **main chat** is only switched behind a cost guard, because switching model discards the conversation's prompt cache (measured in [`docs/observations.md`](docs/observations.md), below). If the API rejects a rewritten request, reflex re-sends your original bytes.
- **Observe.** Each decided turn gets an outcome window. Reflex records a correction score with the matched rule ids (not a verdict), a failing test run after an edit in the turn, and edits undone within three turns. Prompt text, commands, paths and code from the hooks stay in memory; the log gets hashes, counts and rule ids.

**Ground rules** (enforced by tests): fail open, so any error, timeout or surprise ends in forwarding your request unchanged; byte-identical passthrough unless a rewrite was deliberately applied; your Anthropic credentials are never read, stored or logged; loopback only; your `~/.claude/settings.json` is never edited (reflex passes one temporary `--settings` file and deletes it on exit); zero runtime dependencies (TypeScript, Node 20+).

## Quick start

```sh
npm install -g reflex-router
```

That puts `reflex` on your PATH (Node.js 20+; alpha, see [Status](#status)). The same package is attached to each
[GitHub release](https://github.com/ziyacivan/reflex-router/releases) as a tarball.

Or from a checkout, if you would rather read it first:

```sh
git clone https://github.com/ziyacivan/reflex-router && cd reflex-router
npm ci && npm run build && npm link
```

Give it a Jev key, either in the environment or in a file that survives new shells:

```sh
export TYPESAFE_API_KEY=apikey_...
# or
mkdir -p ~/.reflex && (umask 077; echo 'TYPESAFE_API_KEY=apikey_...' > ~/.reflex/env)
reflex doctor        # what it would do, and where each setting came from
```

**Or keep decisions on your machine** with [Laya](https://github.com/NandhaKishorM/laya): no key, reflex starts and stops a loopback `laya-serve` for each session, offline. Install once, then set the backend:

```sh
uv tool install "laya[serve]"
export REFLEX_BACKEND=laya
reflex doctor
```

Uncalibrated, Laya keeps Opus for everything; reflex ships a calibration head fitted to reproduce Jev's decisions, with a safety margin towards Opus. It is conservative and less accurate than Jev: on 190 real prompts it moved 24 turns off Opus (Jev moved about half of them), and 1.6% of its plans were cheaper than Jev's ([measurement](docs/observations.md#2026-09-23--the-shipped-laya-head-tested-on-190-real-prompts-15-cheaper-than-jev-refit-with-a-safety-margin), [details](docs/reference.md#laya-decisions-on-this-machine)).

`~/.reflex/env` holds `KEY=value` lines for `REFLEX_*` settings and the key. It is merged **under** your environment (the environment wins), and a file that holds the key but is readable by group or others is refused: reflex warns, ignores the file, and runs plain `claude`. `reflex doctor` says why.

**Start in shadow mode, and look before you route:**

1. `reflex` (everything you type after it goes to `claude` untouched). The default mode is `shadow`: nothing about your session changes, and `~/.reflex/decisions.jsonl` fills up.
2. Work as usual for a few sessions, then `reflex report` (`--since 2h`, `--usd`). Read section 3, "shadow vs actual": what reflex *would* have routed where.
3. When you are happy with that, opt in: `REFLEX_MODE=route reflex`. To route only subagent work and leave the main chat alone, add `REFLEX_MAIN_CHAT=never`. The status line then shows the model reflex actually sent and the session's estimated cost, e.g. `Reflex: ⇣ Sonnet 5 (asked Opus 5.5) · Est. Cost: $1.80` (a list-price estimate over recorded token counts). It shows no saving: pricing the routed model's tokens at the requested model assumes both write the same amount, which they do not, so the saving is measured only where `REFLEX_AB` held turns back (`reflex report --usd`, section 8). When the main chat's prompt cache is known it adds how long it has left and what the next turn pays more once it lapses (`Cache: 42m left (lapse Est. +$0.61)`: the whole context written again instead of read, list prices; yellow in the last five minutes), and for three turns after the main chat's context shrank, by how much (`Context: compacted 183k→41k`). On a subscription it shows the account's quota as Anthropic reports it (`Quota: 5h 31%, 7d 48%`), and when the recent pace would reach 100% before the window resets, roughly when (`5h 62% (limit in ~40m)`). It also shows one line below for each running subagent, changed or not (Claude Code's own model display keeps showing the one it asked for); `REFLEX_STATUSLINE=0` turns it off, and a status line of your own is never replaced.
4. `REFLEX_MODE=off reflex` is literally plain `claude`, with no proxy at all.

Here is what the report looks like. This is real output (`reflex report` on the archived first dogfood session, sections 3 and 6), with its conditions in [`docs/observations.md`](docs/observations.md#2026-09-19--reflex-report-over-the-shadow-dogfood-session-excerpt): one shadow session, 12 decisions, nothing was routed, and "% tokens" is the token share of each cell's own request, **not a saving**.

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

The full report has sixteen sections (0–15): a workflow profile of where your tokens went; decisions by kind and tier; `mass` vs `argmax`; shadow vs actual; guard refusals; fallbacks and breaker; latency (Jev by new vs reused connection, the decision wait and the upstream's first byte); outcome rates for routed vs unchanged turns, with sample sizes and an explicit "insufficient data" line below 20 windows; cost at list prices; side-call usage on its own line; cache writes by move type; unclassified side-call fingerprints; a side-call routing estimate; escalations; effort (what `REFLEX_EFFORT` decided and applied, with outcomes by arm); and the quota exchange rate (tokens, and with `--usd` list-price dollars, per 1% of the 5-hour and weekly quota, by week and by model; the quota is account-wide, so usage outside reflex lowers these figures). `reflex report --json` prints the same sections as one JSON object, keyed by section number, for scripting against. Settings, route-mode details and safety nets: [`docs/reference.md`](docs/reference.md).

## How it compares

Capabilities only. This table has no speed or savings figures, ours or theirs, and it does not claim reflex is better on any number. It compares reflex-router with two existing Claude Code routers as we read them in [`docs/prior-art.md`](docs/prior-art.md) (their READMEs and code at the commits named there); both projects move, so check theirs: [jev-router](https://github.com/gargpratyush/jev-router/blob/0d39e5b/README.md) (`0d39e5b`) and [jcm-router](https://github.com/adarshmishra07/jcm-router/blob/083df7f/README.md) (`083df7f`).

| Capability | reflex-router (alpha) | jev-router | jcm-router |
| --- | --- | --- | --- |
| Outcome capture (correction, failing test after an edit, reverted edit, per decision) | Yes. Record-only by default; `REFLEX_ESCALATE` can raise a later turn's tier, off unless you set it | Not in what we read; cost only ([§5](docs/prior-art.md#5-what-reflex-router-does-differently)) | Not in what we read; cost only ([§5](docs/prior-art.md#5-what-reflex-router-does-differently)) |
| Quality-aware reporting | `reflex report`: outcome signals for routed vs unchanged turns with sample sizes, next to a stated cost estimate | Status line showing scores (display only, [§3](docs/prior-art.md#3-jev-router)) | Dashboard of cost, cache health and Jev latency; offline eval of decisions on hand-labelled prompts ([§2](docs/prior-art.md#2-jcm-router)) |
| Shadow mode | Default mode; report compares would-route with actual | No | `dry_run` |
| Pluggable / local decision backend | `DecisionBackend` interface: TypeSafe Jev, or Laya started by reflex on loopback | Jev only | Jev only |
| Per-agent pins | Pin per conversation, and per subagent id; state is session-scoped | State per session + first message, reused through the tool loop; no explicit subagent signal | Reuses the most recent routed turn's decision; subagents detected from the system prompt; turn key is prompt-based ([§2](docs/prior-art.md#2-jcm-router)) |
| Cost guard | Yes: refuses a main-chat switch whose lost prompt cache would cost more than a limit (list prices) | No cost model; a fixed context-size rule | Yes: cache-aware, with a maximum switch cost |
| Privacy controls | Allow-listed state sent to the backend, character budgets and secret redaction before anything leaves the machine, log files `0600` in a `0700` directory and size-rotated, a redacted 300-character prompt preview (off by default, switchable) | README says only the prompt is sent; the code also sends model, context size and available models ([§3](docs/prior-art.md#3-jev-router)) | Journal keeps a 300-character prompt preview by default (switchable) and is not rotated ([§2](docs/prior-art.md#2-jcm-router)) |

What they have that reflex does not: jcm-router has a live dashboard; jev-router has a custom model picker. reflex's report is plain text. Ideas we took from both (retry with the original request when a rewrite is rejected, byte-identical forwarding, pinning through a tool loop) are credited in [`THIRD_PARTY.md`](THIRD_PARTY.md); no code was copied.

## What leaves your machine

Full detail: [`docs/privacy.md`](docs/privacy.md).

- **To the decision backend (TypeSafe Jev):** only for the start of work. The request is `{state, model, questions}`; `state` has exactly four fields: your prompt (or a subagent's delegation prompt), and for the main chat the tail of the assistant's previous message, plus the requested tier and whether it is a subagent. Text is truncated first (by default 4,000 characters of your prompt, head and tail, and 1,000 of the assistant's reply; both settings), then redacted: API keys and tokens, `.env`-style `NAME=value` lines, private keys, and home-directory prefixes. Redaction is best effort, not a guarantee. No system prompt, tool list, tool results, file contents, session or device ids, headers or Anthropic credentials. Your TypeSafe key goes only in the `Authorization` header to TypeSafe. At start-up the worker also sends one bare `HEAD /` to open the connection early; it carries no key and no data.
- **To Anthropic:** your request with your own headers. In `shadow` mode it is byte for byte. In `route` mode a routed request has its model id and dependent fields rewritten (the changed fields are listed in its record), and no text is added, removed or edited. The one exception is opt-in: with `REFLEX_DELEGATE=1`, Claude Code itself adds reflex's fixed delegation hint (below) to each prompt you type. No `REFLEX_*` or `TYPESAFE_*` value ever reaches Anthropic.
- **On disk (`~/.reflex/`):** one JSON record per classified request, session ids hashed, plus, **off by default**, a redacted preview of at most 300 characters of each decided prompt so decisions can be reviewed; `REFLEX_LOG_PROMPTS=1` turns it on. Redaction does not remove project-relative paths or your own words from the preview. Outcome records hold hashes, counts, rule ids and test-runner kinds, never prompt text, commands, paths or code.

## Delegation hint (opt-in experiment)

Per-turn routing can only reach work that starts a turn or a subagent. In long single-turn sessions most tokens sit in the main chat's tool loop, which stays on the model the turn started on, so `reflex report` starts with a workflow profile: where your tokens went (new turns, tool-loop continuations, subagents, side calls) and at most how much of them routing could have touched.

`REFLEX_DELEGATE=1` (off by default; `shadow` or `route` mode) is an experiment in moving work into subagents, where routing applies. On every prompt you type (not on slash commands, Claude Code's own injected messages or subagent hand-backs), reflex's `UserPromptSubmit` hook answers with a fixed three-line hint, as hook context, asking Claude to hand exploration, multi-file reading, searches and test runs to subagents and keep the main conversation for synthesis and edits. The text is in [`src/delegate/hint.ts`](src/delegate/hint.ts); its version id is logged on every decision record of the session. If the worker is down or anything fails, the hook gets no answer and the prompt goes on without the hint.

**Risk: delegation can raise your total spend.** A subagent starts with its own context and re-reads files and state the main conversation may already hold, and Claude Code's side calls continue as before. More delegation is only a win if the cheaper tiers it enables outweigh that. The workflow profile and the cost section show total tokens and dollars per user turn with and without the hint, with the number of sessions on each side, so you can see whether it paid on your work; we have no measurement of that yet.

## Overrides, ceilings and known limits

- **Overrides.** Start a prompt with `reflex:haiku`, `reflex:sonnet` or `reflex:opus` to choose the model for that turn and the subagents it spawns. `!`, `/`, `@` and `#` are not used because Claude Code consumes them (`!` is bash mode). An override skips the backend, the confidence rule and the main-chat cost guard: it is your explicit choice, so it can pay the cache penalty the guard would have refused. The token stays in your prompt; reflex never edits prompt text.
- **Haiku context ceiling.** Work is not routed to Haiku when the request's estimated context exceeds 150,000 tokens (a fixed setting in `src/tiers.ts` chosen to leave room in Haiku's window, not a measurement); it goes to the next tier up, or stays as it was.
- **`opus[1m]` sessions.** Haiku does not accept the long-context beta, so the `context-1m-*` beta is removed from the request when it is retargeted to Haiku; the rest of the header is kept. Without that the API answered 400, and reflex's fallback then re-sent the original request ([`docs/acceptance-phase1.md`](docs/acceptance-phase1.md), item 6).
- **MCP tool search stays on.** Claude Code turns tool search off when `ANTHROPIC_BASE_URL` is not first-party, because many proxies drop `tool_reference` blocks; every MCP tool schema is then sent on every request. reflex forwards them (tests pin the `anthropic-beta` header, `defer_loading`, `tool_addition` and `tool_reference` blocks on real Claude Code 2.1.282 requests), so it starts `claude` with `ENABLE_TOOL_SEARCH=true`. On one machine (four MCP servers) `/context` at the start of a session read 32.5k tokens without reflex, 66.9k behind reflex 0.5.5 and 32.4k with this setting ([`docs/wire-format.md`](docs/wire-format.md) §5.10). A value you set yourself, in the environment or in Claude Code's settings `env`, is left alone: `ENABLE_TOOL_SEARCH=false` turns it off. With `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` set, tool search stays off and reflex says so at start. When a request is routed to Haiku or Sonnet, which reject the `tool_addition` blocks Opus and Fable requests carry, reflex turns each one into its tool without `defer_loading`.
- **Side calls keep billing the requested model.** Claude Code's own side calls are never decided and, moved only when the conversation answers them as its own: a subagent's progress summaries, task notifications, subagent hand-backs and tool results carrying harness text follow the conversation's pin (they replay its history, so they read the cache it wrote). Everything else stays on the model you asked for, so part of a routed session's usage does too, by construction. In route session B ([`docs/observations.md`](docs/observations.md)) they also kept that model's prompt cache warm while the conversation itself ran elsewhere.
- **Only verified retargets are applied.** Every pair among Haiku, Sonnet, Opus and Fable has been verified against the API ([`docs/wire-format.md`](docs/wire-format.md) §5). Upgrades need `REFLEX_UPGRADES=on` or `confident` (off by default) or a `reflex:<tier>` override; Fable needs `REFLEX_ALLOW_FABLE=1`.
- **The wire format is not a public contract.** reflex checks the request's shape at runtime and fixtures exist only for Claude Code 2.1.277, 2.1.278, 2.1.280 and 2.1.282; a different version warns, a different major version runs `route` as `shadow`. A failed shape check turns the session back into `shadow`.
- **Restarts lose pins.** If the worker crashes it is restarted, but pins and open outcome windows live in its memory: a routed tool loop then continues on the requested model. A response that is already streaming when the worker dies fails (Claude Code retries it), and killing the reflex launcher itself ends the session's connection.
- **Route mode adds a wait.** A new turn waits for the backend decision, bounded by `REFLEX_JEV_DEADLINE_MS` (a setting), after which the request goes out unchanged. Every decision record splits the wait from the upstream's first byte.
- **Outcome capture is a record, not a verdict.** Correction scores are heuristics, and the rules are English and Turkish only — which means the signal is weakest, for everyone else, exactly where escalation would use it.
- **Escalation is a mechanism, not a tuned feature.** `REFLEX_ESCALATE` is off by default and has a `shadow` mode for a reason: no threshold in it has been calibrated, because the data to calibrate it does not exist yet ([Status](#status)).
- **Not verified on Windows or against a published package**; the [Phase 1 acceptance record](docs/acceptance-phase1.md) lists what was and was not exercised in real sessions.

## What we have measured

Each line is in [`docs/observations.md`](docs/observations.md) with its conditions. These are single sessions on one machine, not benchmarks.

- **Jev decision latency, fresh connection:** p50 823 ms, p95 1,136 ms (n = 12). One interactive shadow session, Claude Code 2.1.277 with Opus 5 requested, run from Turkey, Jev `jev-latest`, a new TCP+TLS connection per decision.
- **Jev decision latency, reused connection:** p50 382 ms, p95 408 ms (n = 11 decisions in three archived route sessions). Different days and prompts from the line above, so this is not a controlled comparison ([entry](docs/observations.md#2026-09-19--jev-latency-with-a-kept-alive-connection-archived-sessions-read-with-reflex-report)).
- **Classification, first dogfood session:** 61 requests, 12 of them starts of work, none unclassified, none degraded, no backend errors; `/compact` was classified as a side call.
- **Reasoning, not length.** One prompt in that session asked for a one-sentence answer to a hard question, and Jev picked Opus for it (reasoning demand 3.24 of 0–4). A 30-prompt labelled comparison of length-framed and reasoning-framed instructions is in `test/live/` (synthetic prompts, labels are the author's judgment, so at best indicative); its result is not recorded in `docs/observations.md` yet, so we do not state one.
- **Prompt cache cost of switching (route sessions A and B, Opus 5 requested).** Moving a conversation down wrote its whole context once on the target (63,689 tokens on Sonnet in one case). Moving up one tier from a cheaper pin wrote more (13,385 tokens) than returning to the requested model (5,924 tokens). This is why the guard exists and why `reflex report` shows cache writes by move type.

### What reflex found

Findings from the first week's dogfooding, each with the session(s) it came from. These are the same [`docs/observations.md`](docs/observations.md) entries in prose form — read there for the full numbers and caveats.

- **Two Claude Code toggles cost more than routing saves, and neither is a routing problem.** One day of real route-mode work (615+ decisions, 7 sessions, ~108M tokens, list prices) found Session recap and Prompt suggestions — two optional, user-facing Claude Code features — billing **$11.82** between them, against routing's own estimated saving of $3.33 on that log and side-call routing's best case of $3.39 (both list-price estimates over recorded tokens, not bills). Both switch off in `/config`. *Condition:* the `notification` side kind merges Claude Code's AFK recap with background task notifications, so the $5.60 recap figure is an upper bound until the log is rewritten by a build that records `side_marker` (from v0.2.3-alpha), which this one was not; one day, one machine, mostly one codebase.

- **The workflow profile's verdict, on the sessions it's seen so far: routing had nothing to reach.** Two sessions of real company-codebase work (not this repo) logged 2 user turns and 43 pinned tool-loop continuations, zero subagents. Both turns were already judged `opus`, and a tool loop stays on the tier its turn started on — so per-turn routing could touch 0% of those tokens by construction. This is the reasoning behind the delegation hint (`REFLEX_DELEGATE=1`) and the workflow-profile section `reflex report` now leads with. *Condition:* two sessions, one external codebase — this describes that work, not work in general; the hint's own payoff is still unmeasured.

- **One `ultracode` fan-out cost $3.02 for a single prompt, and a polling cap couldn't hold it.** A read-only review of `src/wire/` and `src/outcome/`, run against the real API under a $1.50 spend cap, hit $3.02 before being killed mid-workflow — worker traffic alone was 65.8% of tokens and 74.7% of the dollars. Between two 18-second cap-check polls, spend went from $0.44 to $2.55: parallel workers write their context to the cache all at once, faster than sampling can catch. *Condition:* one session, one prompt, killed early — this is a lower bound on what the run would have cost, and a first data point for the warning above that delegation "can raise total spend," not a general figure for `ultracode` cost.

- **The first calibration read: both arms finally big enough, and they still say nothing.** On 1,525 decisions across 16 sessions, section 7's two main arms passed the n≥20 floor for the first time — routed 26 windows, unchanged 27. Correction rate 1/23 = **4.3%** [0.8, 21.0] routed against 0/21 = **0.0%** [0.0, 15.5] unchanged (Wilson 95%); restricted to the turns where the two decision rules disagree — the only turns the rule choice can affect — 0/9 and 0/1. Across the whole log there is **one** organic correction in 44 scored windows and **one** revert. The intervals overlap over almost their whole range: this cannot distinguish the rules, and one window moves the routed rate by 4.3 points. *What would:* about **73 scored windows per arm** for a ±5-point interval, about **430 per arm** to detect 5% vs 10% at 80% power — and since disagreements are 43% of decided turns, ~430 per arm means on the order of **2,000 decided main turns**. That is hundreds of sessions. *Condition:* one machine, one person, largely one codebase, and **the arms are not randomised** — a turn is routed because the backend judged it easy, so the two arms differ in the difficulty of their work before any outcome is measured. No rate there is a causal estimate. `REFLEX_AB` exists to fix exactly that ([Contributing data](#contributing-data)).

- **The delegation hint, measured on one day instead of across days.** The all-time hint table compares 8 sessions with the hint against 8 without and reports $2.64 per user turn without and $4.04 with — but those sessions span different days, builds and work, so it is **confounded**, and the report now says so. Over one day, one build and one codebase (5 sessions, 29 user turns): subagent share **22.0%** with the hint against **11.7%** without, and $0.39 per user turn against $0.61 — both in the direction the hint intends, and the opposite of the confounded table. *Condition:* **2 sessions against 3**, not randomised (the hint was on or off because of what was being worked on). A direction, not a result.

These are single-session or single-day figures, same as the rest of this section: not benchmarks. Every number here is a list-price estimate over recorded token counts unless it says otherwise, and none of them is a bill.

## Benchmarks

There are no benchmark or measured savings figures, on purpose. The closest thing is the maintainer's own route-mode log, read with the same command you can run:

```sh
reflex report --usd
```

Over three days of it (2026-09-22 to 09-24, 27 sessions, 2,209 requests, ~384M tokens), routing moved 96 requests down from Opus 5.5 to Sonnet 5 or Haiku 4.5, an estimated **$3.76** less, and 38 requests up to Opus, an estimated **$3.73** more: net about **$0.03**. The best single session was an estimated $2.07 less, all of it in subagents. 73% of the tokens were main-chat tool-loop continuations, so routing could touch at most 26% of them, and the cost guard refused 18 main-chat switches whose lost cache would not have paid back (median penalty $1.09). *Condition:* one machine, one person; some upward moves came from sessions that requested Sonnet or Haiku with `REFLEX_UPGRADES` on; all dollar figures are list-price estimates over recorded token counts, not bills ([entry](docs/observations.md#2026-09-24--three-days-of-route-mode-down-and-up-moves-nearly-cancel)).

The command prices the same measured token counts at the model sent and at the model requested, at list prices, and says what it does not model (tokenizer differences, what the requested model's cache would have held, cache TTL, discounts, subscription limits). Treat any figure about savings, ours or anyone's, as an estimate until it is measured against a bill.

## Contributing data

**reflex has no telemetry.** It makes exactly two kinds of network connection: to Anthropic, because that is your
Claude Code session, and to the decision backend, to ask one question per start of work: TypeSafe Jev, or with
`REFLEX_BACKEND=laya` a `laya-serve` on `127.0.0.1` that reflex starts offline. There is no third. Nothing about your
usage is sent anywhere, ever, and there is no setting that turns such a thing on.

Which is also the problem. Every threshold in reflex is tuned on **one person's log**, and the section above says what
that is worth: one organic correction in 44 scored windows, and telling the two decision rules apart would need
roughly **430 disagreement windows per arm** — on the order of 2,000 decided main turns, hundreds of sessions. That is
not reachable from one machine. It is very reachable from thirty.

So if you want to help, you send the data yourself:

```sh
reflex share            # writes ~/.reflex/reflex-share-<date>.jsonl and prints exactly what is in it
head -3 ~/.reflex/reflex-share-*.jsonl
```

`reflex share` is an **allow-list**, not a redactor: a field reaches the file only because it is named in
[`src/report/share.ts`](src/report/share.ts), so a field added to the log in future is absent from a shared file until
someone adds it deliberately. It writes a file and makes **no network connection of any kind**.

| In the file | Not in the file |
| --- | --- |
| Hashed session and conversation ids; reflex's own record ids (random UUIDs) | Any prompt, reply, code, command or file path — hashed or not, those fields are simply not copied |
| Timestamps, tiers, model names, which tier was picked and sent, and the reason codes | Your Anthropic credentials or TypeSafe key (reflex never records them anywhere) |
| The backend's answer: probabilities, confidence, rule, latency, version | Your machine name, user name, working directory or any environment variable |
| Token counts, HTTP status codes, timings | Prompt previews, error text, side-call fingerprints |
| Outcome counts (edits, bash runs, test runs), correction **rule ids** and scores, test-runner kinds | |

Read the file before you send it. If anything in it looks like something you would not want public, **do not send
it** — open an issue saying what you saw instead. That is a bug in `reflex share`, and it is worth more than the data.

Attach it to a [calibration data issue](.github/ISSUE_TEMPLATE/calibration-data.md), with your Claude Code version, OS,
the model you request and roughly what the work was.

**The most useful thing you can do** is run with `REFLEX_AB=0.2` for a while. It holds a random 20% of routable turns
on the model you asked for, as a control arm, and tags both arms. It is the only setting that produces data supporting
a *causal* read: every other comparison in the report is between turns the backend judged easy and turns it did not,
which differ in difficulty before any outcome is measured. It costs you the cheaper tier on one turn in five.

## Status

**Alpha.** Published on npm as `reflex-router` from 0.5.3; each version is also a tarball on [GitHub releases](https://github.com/ziyacivan/reflex-router/releases) (see [Quick start](#quick-start)).
It works and it is covered by tests, but almost nothing in it is calibrated, and the honest summary is below rather
than in a footnote.

- **Routing is measured on one user.** Every figure in this README and in [`docs/observations.md`](docs/observations.md)
  comes from one person's machine, largely one codebase, over about a week. Nothing here is a benchmark, and no cost
  saving has been measured — the dollar figures are list-price estimates over recorded token counts.
- **No threshold is calibrated, and per-rule calibration needs community data.** The `mass`/`argmax` choice, the
  reasoning-demand vetoes, the confidence floor and the escalation threshold are all chosen values, not fitted ones.
  Telling the two decision rules apart would need roughly **430 disagreement windows per arm** (~2,000 decided main
  turns); the whole log to date has 12. See [Contributing data](#contributing-data).
- **Escalation is a mechanism, not a tuned feature.** `REFLEX_ESCALATE` is **off by default** and has a `shadow` mode
  (`REFLEX_ESCALATE=shadow` records what it would have done and changes nothing) precisely because nobody has
  evidence about when it should fire. It can only ever raise a tier, never above the one your client asked for, so its
  worst case is a session on the model you already chose. Its correction rules are English and Turkish only.
- **`REFLEX_EFFORT` is new and its quality effect is unmeasured.** Off by default. It changes a turn's effort level
  (`low`…`max`) the way Claude Code's own `/effort` does, on Opus 5.5, Opus 5, Fable 5.1 and Sonnet 5; the API accepted
  every level and the thinking it caused moved with the level (single measured runs, [wire format §5.8](docs/wire-format.md#58-changing-effort-mid-conversation-same-model-2181)).
  Whether lower levels keep quality is not known yet: `REFLEX_EFFORT_AB` and report section 14 exist to measure it, and
  with `REFLEX_ESCALATE=1` a turn after a correction, failing test or revert runs at your own level again. By default it
  only changes **subagents** (each in its first request, which leaves nothing behind if you later continue without
  reflex); `REFLEX_EFFORT_MIDTURN=1` also changes the main chat turn by turn, which adds messages that only reflex
  re-sends ([reference](docs/reference.md#configuration)). The status line shows a changed level.
- **Fable is off by default.** Opus 5.5 ↔ Fable retargets are verified against the API ([wire format §5](docs/wire-format.md)),
  but Fable is only in the tier set with `REFLEX_ALLOW_FABLE=1`; without it a Fable retarget is recorded and left alone.
- **Tested on Claude Code 2.1.277, 2.1.278, 2.1.280 and 2.1.282, macOS only.** Not verified on Windows or Linux beyond CI
  (Ubuntu + macOS, Node 20/22/24). Fixtures exist only for those four Claude Code versions (2.1.280 and 2.1.282: one
  `claude -p` capture each with a subagent; 2.1.282 with MCP tool search on). **`REFLEX_BACKEND=laya` has never been run on Windows**: the process guard that stops
  `laya-serve` with reflex, and starting a `.cmd` shim, are untested there.
- **The wire format is not a public contract**, and it has already broken once: 2.1.278 changed how typed prompts are
  encoded and a whole session was silently not routed. reflex checks each request's shape at runtime, warns on a
  different minor version and runs `route` as `shadow` on a different major one. It also carries a **drift check**: if
  a session has seen at least 3 prompts you typed but the classifier has found at most 1 start of work, the worker
  warns and the decision record carries `drift`, counted in report section 1. The drift check is an alarm only — it
  never changes a classification or degrades the session, because the classifier's own fail-safe already forwards an
  unrecognised request unchanged. It exists so the next wire-format change is visible on day one instead of a session
  later.
- **What has not been exercised** in real sessions is listed in [`docs/acceptance-phase1.md`](docs/acceptance-phase1.md).

```sh
npm ci
npm test             # typecheck + lint + offline tests (a guard fails any non-loopback connection)
npm run test:live    # needs a real TYPESAFE_API_KEY; skipped without one
npm run build
```

Notes on what Claude Code sends, with redacted captures: [`docs/wire-format.md`](docs/wire-format.md). Prior art: [`docs/prior-art.md`](docs/prior-art.md). Changes: [`CHANGELOG.md`](CHANGELOG.md).

MIT. See [`LICENSE`](LICENSE) and [`THIRD_PARTY.md`](THIRD_PARTY.md).
