# Changelog

0.5.3 is the first version published to npm (`reflex-router`); earlier ones were GitHub release tarballs only.

## Unreleased

_Nothing yet._

## 0.5.8 — 2026-09-25

### Fixed

- **Under Claude Code's sandbox every outcome hook failed with "HTTP 403", and only a session's first prompt was
  routed.** With `sandbox.enabled` in the session's settings, Claude Code answers each http hook to `127.0.0.1` with
  `HTTP 403 from http://127.0.0.1:<port>/__reflex/hook` — the door never saw the request. That cost more than outcome
  capture: since 2.1.278 a typed prompt is a plain string, and a plain string counts as a new turn only when the
  UserPromptSubmit hook delivered it, so every prompt after the first was forwarded to the requested model unjudged
  (`side` / `plain_string_no_typed_match` in `decisions.jsonl`). Measured on 2.1.281 (`docs/observations.md`,
  2026-09-24): http hooks go through the sandbox's network allowlist (`allowedHttpHookUrls` does not change it); command
  hooks do not. Under the sandbox reflex now injects command hooks that run `reflex hook-relay`, which relays each event
  to the door; the second prompt of a sandboxed session is judged and routed like the first.

### Added

- **`REFLEX_HOOKS=auto|http|command|off`** (default `auto`): how the outcome hooks reach the door. `auto` uses `http`
  hooks, except when the session's settings turn the sandbox on (user, project, local project, the `--settings` value
  and managed settings, in Claude Code's precedence), where it uses `command` hooks and says so in `worker.log`. `off`
  injects none, which leaves routing to a session's first prompt; outcome capture, escalation and the delegation hint
  need them too.
- **`reflex hook-relay <url>`**: the command hook itself. Reads one hook event on stdin, posts it to the loopback `url`,
  prints the door's answer when it is a JSON object and nothing otherwise, and always exits 0.

## 0.5.7 — 2026-09-25

### Fixed

- A subagent's progress summaries rewrote its whole history into a second cache. With `REFLEX_EFFORT` they went out
  without the effort level reflex had put into the subagent's first request, so the prefix changed at message 1; for a
  subagent routed to another model they went to the requested model. Every side call now carries its conversation's
  effort messages, and a routed subagent's summaries follow its pin. One live run each (Opus 5.5, 2.1.282): before, the
  summaries read only the 16.6k fixed prefix and wrote the subagent's history again (17.9k); after, they read 31–34k
  and wrote 88.
- A subagent the Agent tool call gave a `model` explicitly is no longer routed (or given another effort level): the
  choice was made on purpose. Recorded as `plan.reasons: ["model_explicit"]`. Models set in an agent definition's
  frontmatter are not seen and are still routed.
- Task notifications and subagent hand-backs are turns the chat answers, and a tool result carrying harness text is
  the loop's next step; they now follow the conversation's pin instead of going to the requested model. Live, with the
  main chat on Sonnet, they went to Sonnet and read its cache (~45k read, ~400 written each).
- A subagent asking for another tier than the main chat (its agent definition or a built-in agent chose the model) is
  no longer routed either.
- A subagent resumed after a background task lost the effort level reflex had set: Claude Code rebuilds its history
  (its cache misses there with or without reflex), so reflex's mark no longer matched. The level is now set again on
  that request (`messages.effort_kept`) and kept for the rest of the loop.
- Several subagents starting at once no longer queue for the decision backend: the client kept 4 connections, and
  with 8 subagents and 800 ms answers the last 4 ran out of the deadline and were not routed (fake backend). In the
  owner's log, 28% of subagent decisions timed out when 4 or more started within 1.5 s, 0% when one started alone.

### Changed

- `docs/reference.md`: resuming a conversation in a new process rewrites its cache whether or not reflex changed its
  effort (measured the same both ways), so continuing without reflex costs nothing extra.

### Added

- `scripts/spike/fake-anthropic.mjs` (a loopback Messages API for running the real `claude` without tokens) and
  `scripts/spike/claims-probe.mts` (the scenarios of the 2026-09-25 verification, fake upstream and fake Jev) and
  `scripts/spike/dump-proxy.mjs` (request bodies as reflex sent them, behind reflex).

## 0.5.6 — 2026-09-25

### Fixed

- MCP tool search was off in every reflex session: Claude Code disables it behind a non-first-party
  `ANTHROPIC_BASE_URL`, so every MCP tool schema went out on every request. reflex now starts `claude` with
  `ENABLE_TOOL_SEARCH=true` unless you set it yourself. `/context` at session start on one machine: 66.9k tokens behind
  0.5.5, 32.4k now (32.5k without reflex). `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` still keeps it off, with a warning.
- With tool search on, routing kept working: the step after a ToolSearch (`Tool loaded.` beside `tool_reference`
  results) is a tool-loop continuation, not a side call, so a pinned loop stays on its model; and a request routed to
  Haiku or Sonnet no longer carries `tool_addition` blocks those models reject (400, then a fallback): each becomes its
  tool without `defer_loading`.

### Added

- Claude Code 2.1.282 fixtures with tool search on; 2.1.282 is a tested version.

## 0.5.5 — 2026-09-24

### Fixed

- Subagent lines never appeared while the main chat sat waiting on background agents: Claude Code re-runs the status
  line only on main-chat events. reflex's status line now also refreshes every 2 seconds (`refreshInterval`).
- The status line now lists every running subagent, not only the ones reflex changed.

## 0.5.4 — 2026-09-24

### Added

- The status line shows the session's estimated cost: `Est. Cost: $1.80`, every recorded request (side calls too) at
  list prices for the model sent. It reflects effort changes directly, which `Est. Saved` (model switches only) does not.

### Fixed

- A finished subagent stayed on the status line for the rest of the session; its line now goes at `SubagentStop`.

## 0.5.3 — 2026-09-24

### Fixed

- A conversation reflex moved to another model came back on that model when resumed (`--continue`, `--resume`, with
  or without reflex): Claude Code resumes on the model named in the transcript's last answer, over your own setting.
  When reflex changes a request's model it now asks for an uncompressed answer and writes the model you asked for back
  into its `message_start`; every other byte is relayed unchanged (wire-format §5.9).

### Changed

- Published to npm: `npm install -g reflex-router`.

## 0.5.2 — 2026-09-24

### Changed

- New status line format: `Reflex: Opus 5.5 · Effort: ⇣ low (asked high) · Est. Saved: $0.42 · Total Saved: $3.10`,
  and below it one line per subagent reflex changed, titled as Claude Code shows it: `↳ List docs directory files:
  ⇣ Haiku 4.5 (asked Opus 5.5) · Effort: ⇣ low (asked high)`. It replaces `subagents → Haiku 4.5 ×2` and `subagent
  effort ⇣ low ×2` on the first line. The title comes from a new `PreToolUse` hook limited to the Agent tool (answered
  `204`), is joined to the subagent by its task text, and stays in the worker's memory; it is never logged.

## 0.5.1 — 2026-09-24

### Changed

- **`REFLEX_EFFORT` alone now changes subagents only; the main chat needs `REFLEX_EFFORT_MIDTURN=1`.** In 0.5.0 the
  default changed a main chat's first turn, and without MIDTURN no later turn could change it again, so the first
  prompt's level held for the whole chat. A subagent is one task stated in its first request, so its level fits all of
  it. A Sonnet main chat is no longer changed at all (its level is a top-level value, fixed for the chat); the 0.5.0
  "Sonnet at a model switch" case is gone with it.

### Added

- The status line shows a level `REFLEX_EFFORT` applied that differs from yours: `effort ⇣ low (asked high)` for the
  main chat, `subagent effort ⇣ low ×2` for subagents.

## 0.5.0 — 2026-09-24

### Added

- **`REFLEX_EFFORT=1`: the effort level, `low` to `max`, set per turn without changing the model** (route mode, off by
  default). The level is read from the reasoning-demand score the tier question already gets, and applied the way
  Claude Code's own `/effort` does it: Opus 5.5 (per-turn effort and top-level value), Opus 5 and Fable 5.1 (per-turn
  effort only), Sonnet 5 (top-level value, only where its cache is rewritten anyway); Haiku takes none. By default it
  changes a conversation's first request (main chat and every subagent), in place, which costs no cache and leaves
  nothing behind if the conversation is later continued without reflex. Every change is re-applied from
  `~/.reflex/effort.jsonl` (hashes and levels only) on later requests, whatever the mode or setting. All of it measured
  against the API on Claude Code 2.1.281 (`docs/wire-format.md` §5.8); whether lower levels keep quality is not.
- `REFLEX_EFFORT_UP=1`: allow levels above your client's. `REFLEX_EFFORT_MIDTURN=1`: also change a main chat's later
  turns, by adding an effort message (on accounts created on or after 2026-08-31, continuing such a conversation
  without reflex costs one refused request and its earlier thinking blocks; Claude Code retries by itself).
  `REFLEX_EFFORT_AB`: a random control arm at your level, for a causal read of quality.
- With `REFLEX_ESCALATE=1`, a correction, failing test or revert after a lowered-effort turn keeps the next turns at
  your level.
- `reflex report` section 14: effort decisions, applied levels, carried changes, outcomes by arm.

### Fixed

- `REFLEX_BACKEND=laya` could hang waiting for a `laya-serve` that was missing: the ready poll now wakes when the guard
  exits.

## 0.4.4 — 2026-09-23

### Added

- **The status line shows an estimated saving**, for the session and in total: `est. saved $0.42 (total $3.10)`. It is
  the same figure as `reflex report --usd` section 8's "routed only" difference (token counts priced at the requested
  model minus at the model sent, list prices; negative when routing cost more), so it is an estimate with that
  section's caveats, not a bill. The total is read from `~/.reflex/decisions.jsonl` when the session starts.

## 0.4.3 — 2026-09-23

### Added

- **A status line showing the model reflex actually sent.** Claude Code's own display shows the model it asked for,
  so a routed turn was only visible in a one-off chat notice. `reflex statusline` (injected as Claude Code's
  `statusLine` unless you have your own; `REFLEX_STATUSLINE=0` turns it off) shows e.g. `⇣ Sonnet 5 (asked Opus 5.5)
  · subagents → Haiku 4.5 ×2`. It asks the session's own loopback front door (`GET /__reflex/status`, model ids only,
  in memory) and prints an empty line on any failure.

## 0.4.2 — 2026-09-23

### Changed

- **Opus 5.5 ↔ Haiku, Sonnet and Fable are applied in route mode** (Fable still needs `REFLEX_ALLOW_FABLE=1`).
  Capped runs under the user's own settings (`opus[1m]`, no `--model`) covered subagent pins, continuations holding
  Opus 5.5-, Haiku-, Sonnet- or Fable-signed thinking, and un-pin in both directions (`docs/wire-format.md` §5.7). One
  interactive run (the `cli` shape: redacted thinking, 1-hour cache, long-context beta) was accepted too. Whether
  routed turns are as good is **not measured yet**: `REFLEX_AB` plus report section 7 is how to find out.
- **The main-chat cost guard also allows a switch that pays for itself.** `REFLEX_SWITCH_BREAKEVEN_REQUESTS` (default
  10): a switch over `REFLEX_MAX_SWITCH_PENALTY_USD` is allowed when that many requests on the cheaper model would
  recover the lost cache at the conversation's own measured averages. Replayed on the maintainer's five real Opus 5.5
  refusals, it still refuses all five (33–111 requests to break even; `docs/observations.md`).

## 0.4.1 — 2026-09-23

### Fixed

- **The Laya calibration head of 0.4.0 routed too low on real prompts.** Tested on 190 prompts the maintainer had
  typed, 15% of its plans with `english` (the default) were cheaper than Jev's; the synthetic training tasks had put
  that at 3–4%. The refit `cal-20260923.2` adds real prompts to the training data and a margin towards Opus, tuned on
  real prompts: 1.6% cheaper than Jev (cross-validated), and none of the held-out author set cheaper than the label.
  It routes less: 24 of 190 real prompts moved off Opus.

### Added

- Claude Code 2.1.280 fixtures (`claude -p` with an Explore subagent); 2.1.280 is a tested version.
- `scripts/calibrate/harvest-history.ts` (your own typed prompts, numbers only written; the prompts go to Jev) and
  `fit.ts --max-under` / `--version`.

## 0.4.0 — 2026-09-23

Decisions can now stay on your machine: [Laya](https://github.com/NandhaKishorM/laya), run by reflex itself, as an
alternative to TypeSafe Jev. **Experimental**: measured less accurate than Jev (below). Try it in `shadow` mode first.

### Added

- **`REFLEX_BACKEND=laya`.** reflex starts `laya-serve` for each session on a free `127.0.0.1` port (Laya's own default
  is `0.0.0.0`), with a random per-session key, one preloaded checkpoint (`REFLEX_LAYA_MODEL`, default `english`) and
  `HF_HUB_OFFLINE=1`, and stops it when the session ends. It runs under a small guard process, so it exits with reflex
  even after `kill -9`. Its environment has no `REFLEX_*`, `TYPESAFE_*` or `ANTHROPIC_*` variable. No TypeSafe key is
  used. Install once with `uv tool install "laya[serve]"`; `reflex doctor` finds `laya-serve` and the weights. With no
  `laya-serve` on `PATH`, reflex runs plain `claude` and says so.
- **A calibration head for Laya** (`REFLEX_LAYA_CALIBRATION`, on by default). Uncalibrated, Laya keeps Opus for
  essentially every task. reflex asks it seven extra yes/no questions and maps all of its answers to Jev's scale with
  parameters fitted by distillation from Jev (`src/backend/laya-calibration.generated.ts`, `cal-20260923`). Each
  record's `backend_version` names the calibration. Measured (`docs/observations.md`): 17/30 on the held-out author set
  (uncalibrated 12, Jev 27). On 440 synthetic tasks, 3–4% of its plans were cheaper than Jev's; in 31 turns of two real
  sessions, 3 were. It is "Sonnet by default, Opus when it looks hard" and rarely picks Haiku.
- **`REFLEX_COMPARE=laya`** (with the Jev backend) also puts every decided state to a local Laya, off the request's
  path, and records only numbers (a feature vector) in a `compare` block. Jev alone decides. This is how calibration
  data is collected: `scripts/calibrate/harvest-corpus.ts` and `scripts/calibrate/fit.ts`.
- New settings: `REFLEX_LAYA_BIN`, `REFLEX_LAYA_MODEL`, `REFLEX_LAYA_DEADLINE_MS` (default 2500 ms: 9 questions, a
  measured long-task p95 of 1.5–2.2 s on an idle Apple M4), `REFLEX_LAYA_READY_TIMEOUT_MS`, `REFLEX_LAYA_CALIBRATION`,
  `REFLEX_COMPARE`.

### Changed

- **`REFLEX_BACKEND=local` is removed.** It was a placeholder that ran plain `claude`; it is now a configuration error
  (reflex warns and runs plain `claude`, as before).

### Fixed

- In route mode, the wait for a decision and the logged `decision_deadline_ms` always used `REFLEX_JEV_DEADLINE_MS`,
  whatever the backend.

### Known limits

- Laya is not Jev: see the measurements above. `english` reads at most 512 tokens, less than the default
  `REFLEX_MAX_USER_CHARS` budget holds. Laya's first decision of a session waits for its checkpoint to load (seconds):
  shadow mode waits off the request's path; in route mode that first turn usually goes out unchanged.
- The process guard is untested on Windows.

## 0.3.8 — 2026-09-23

### Fixed

- **Harness calls were decided as your turns.** On 2.1.280, four main-chat requests arrived within 50 s with no prompt
  typed behind them, and were decided and routed like user turns. Once hooks are arriving in a session, a main-chat
  request that is not the prompt you just typed is now a side call (`unclassified`, reason `no_typed_prompt`, with a
  fingerprint) and forwards unchanged. Sessions without hooks are classified as before.
- **Section 12 printed a break-even of 2500000000.0** when a warm cache read on the side tier costs as much as on the
  requested model (Sonnet 5 vs Opus 5.5). It now says there is no break-even.

### Added

- **Drift in section 1 covers more than turn counts.** It also flags a requested model or a `max_tokens` value that no
  captured fixture holds, and every rewrite the upstream rejected (`unseen_requested_model`, `unseen_max_tokens`,
  `rewrite_rejected`). An alarm only; routing is unchanged. Claude Code 2.1.280 is **not** added to the tested versions:
  no 2.1.280 capture is in the fixtures yet.

### Docs

- `docs/observations.md`: the 2.1.280 / Opus 5.5 log, section 8's −$0.95 by pair.

## 0.3.7 — 2026-09-23

A hotfix from a 15-hour route-mode log on Claude Code 2.1.280 with Opus 5.5, where routing cost more than it saved
(section 8: −$0.95).

### Fixed

- **A pin could hold a conversation above the model you asked for.** After a `/model` switch a pinned subagent kept
  its old target (15 Sonnet → Opus records after a switch from Haiku to Sonnet). A pin now belongs to the requested
  model it was decided under: when the request asks for a different tier, the pin is dropped, the request goes to the
  new requested model, and the next new turn decides afresh. Upgrades stay opt-in and off by default
  (`REFLEX_UPGRADES`); the Haiku → Opus records in that log were made with it set to `on`.
- **Opus 5.5 → Haiku was rejected** with `max_tokens: 128000 > 64000`. Each tier now carries its model's maximum output
  (Haiku 64000; Sonnet, Opus, Fable 128000; models overview, checked 2026-09-23) and a retarget lowers a larger
  `max_tokens` to it.
- **Opus 5.5 pairs were applied without being tested** (0.3.6), and Opus 5.5 → Sonnet removed the whole per-message
  `output_config`. A retarget now removes only the key the target rejects (the per-turn `effort`) and keeps any other.
  Every pair with `claude-opus-5-5` on either side is `rewrite_unverified` and forwarded unchanged until a real run
  covers it: one capped run under the user's own settings (`opus[1m]`, no `--model`) accepted Opus 5.5 → Haiku and
  → Sonnet on first requests, but its continuation probes were cut by the $0.50 cap (estimated spend $0.52; the
  experiment proxies now reserve at 2.5 bytes/token, not 4). `docs/wire-format.md` §5.7.

## 0.3.6 — 2026-09-22

### Added

- **Claude Opus 5.5 is the opus tier default** (`claude-opus-5-5`), so an upgrade to Opus lands on it;
  `REFLEX_MODEL_OPUS` / `ANTHROPIC_DEFAULT_OPUS_MODEL` still override it. A session that asks for Opus 5.5 was
  already classified as opus. The Opus 5.5 retargets have not been run against the real API yet; a rejection falls
  back to the original request.
- **Each Opus is priced at its own rate.** Opus 5.5 is $4 / $20 per MTok with cache reads at 0.05x (pricing page,
  checked 2026-09-22); Opus 5 and 4.x stay at $5 / $25 / 0.1x, and `reflex report` prices every record at the model
  it names, so logs recorded on Opus 5 keep their figures.

### Fixed

- **The model-change notice could be lost.** A change reflex made was dropped if you switched models with `/model`
  before a main-chat hook carried it. It now stays queued; several pending changes are shown one per line.

## 0.3.5 — 2026-09-22

### Added

- **Every retarget among Haiku, Sonnet, Opus and Fable is verified and applied.** New since 0.3.4: Fable 5.1 in both
  directions (Fable still needs `REFLEX_ALLOW_FABLE=1`), a Sonnet main chat to Opus, and Opus ↔ Sonnet at every
  effort from `low` to `max`. Eight real sessions; six used `--model`/`--effort`, an approved exception to the
  no-override rule, recorded in each results file. Table and cost: `docs/wire-format.md` §5.6.

### Fixed

- **Fable → Sonnet was rejected on every request.** A Fable 5.1 request puts a per-turn `output_config` on its
  `role:"system"` message, which Sonnet 5 does not accept. The rewrite now drops that field for Sonnet
  (`messages.output_config_dropped:<n>`).
- **A "prompt is too long" rejection no longer disables the tier.** The size estimate (bytes ÷ 2.5) can let dense text
  through that exceeds Haiku's window (measured: 244k–265k real tokens at an estimated 150k). The retry with the
  original bytes already kept the session working; it no longer also switches Haiku off for 30 minutes. The retry's
  measured context keeps that conversation's next turns off a tier it does not fit.

## 0.3.4 — 2026-09-22

### Added

- **Upgrades are applied: Haiku → Sonnet, Haiku → Opus, Sonnet → Opus.** With `REFLEX_UPGRADES=on` (or `confident`),
  or a `reflex:<tier>` override, route mode now rewrites a request to a stronger model than the one asked for, for
  these three pairs. They were verified in real sessions under the user's own settings (model setting `haiku`, no
  `--model`), including an interactive session, the `context-1m` beta on Sonnet and Opus, and the retry-with-original
  case: the client's own bytes, holding thinking blocks signed by the stronger model, sent back to the weaker one. Every
  probe was accepted. Table, cost and what is still untested: `docs/wire-format.md` §5.5; results in
  `test/fixtures/claude-code/2.1.278/experiment.route-*.results.json`. `REFLEX_UPGRADES` stays off by default.

### Fixed

- **A Haiku main chat never asked the decision backend**, so `REFLEX_UPGRADES` could not apply to it: the main-chat
  pre-guard gave up with `no_enabled_tier` because no tier below Haiku exists. With upgrades on it now asks; a
  downgrade still meets the cost guard after the decision.

### Tests

- The model-change notice end to end through the front door, and a Haiku main-chat turn upgraded to Opus with the
  "upgraded" notice.

## 0.3.3 — 2026-09-22

### Added

- **Model-change notice in the chat.** When reflex moves the main chat to a different model (a downgrade, an upgrade,
  or back to the model you asked for), the next main-chat hook answer carries a `systemMessage` such as
  `reflex downgraded the model: claude-opus-4-7 → claude-haiku-4-5`. Claude Code shows it to you and does not send it
  to the model. It arrives with the next main-chat hook (an Edit/Write/Bash tool result or the end of the turn), not
  at the moment of the decision. Side calls, subagents and your own `/model` switch are not announced. Route mode only
  (shadow never changes the model). Covered by `test/unit/model-notice.test.ts`.

### Docs

- `CLAUDE.md`, `docs/reference.md`, `docs/privacy.md`: hook answers may now carry this notice besides the delegation
  hint.

## 0.3.2 — 2026-09-20

### Privacy

- **`REFLEX_LOG_PROMPTS` is now off by default.** It was on through the pre-release versions so decisions could be
  reviewed while the routing rules were being written, with a stated promise to revisit that before a public release
  — this is that revisit. `REFLEX_LOG_PROMPTS=1` still adds the redacted, 300-character prompt preview to
  `decisions.jsonl`. `reflex doctor` now prints a `prompt preview:` line saying whether it is on or off. README,
  `docs/privacy.md`, `docs/reference.md` and `docs/acceptance-phase1.md` updated to match; both defaults are covered
  by tests (`test/unit/policy.test.ts`, `test/unit/env-file.test.ts`).

### Docs

- **`CLAUDE.md`:** never run `git stash pop` on a stash you did not create in this session.

## 0.3.1 — 2026-09-20

**The first version published to npm**, under the `alpha` dist-tag. Two wire/tracker bugs found by reading the
2026-09-19 log against Claude Code's own transcripts, the settings that make escalation safe to ship, and the
reporting and tooling needed for anyone but the author to contribute calibration data.

### Fixed

- **A message you type during a tool loop is no longer invisible.** Claude Code wraps a mid-loop prompt in a
  `<system-reminder>` and delivers it inside the running turn's next request, beside the tool results. Every
  reminder-stripping rule dropped it, so the step classified as an ordinary continuation and the words never reached
  the wire. Observed on session 805b3287 (docs/observations.md), where it left an outcome window closing
  `no_wire_turn`. That is not only a reporting gap: a correction typed mid-loop is exactly the signal escalation runs
  on, and in this shape it could never be scored against the turn it criticises. The wrapper is now recognised and the
  inner text matched against the newest unclaimed typed prompt — the same positive evidence a plain-string turn needs.
  No hook stream, no promotion.
- **`SubagentStart` no longer manufactures a main-chat window.** It carries the subagent's own prompt id, which the
  main chat never saw, so the tracker created a window for it that no wire turn could ever join: zero counts, open
  until `session_end`, closing `no_wire_turn`. Observed as 29d16aa2 seq 4, where the phantom and the subagent's own
  window share a `turn_seq` and an `openedAt` to the millisecond. A subagent now attaches to the turn that spawned it
  or to none, and its record says which in a new `parent_turn` field.

### Escalation

- **`REFLEX_ESCALATE_TARGET` (`requested` | `next`, default `requested`).** Escalation goes straight back to the
  requested tier. "One tier up" is the intuitive choice and the measurement says it is the expensive one: moving a
  Haiku pin to Sonnet paid 13,385 tokens of cache write where moving to the requested Opus paid 5,924, because Claude
  Code's own side calls keep the requested model's cache warm for free. `next` keeps the old behaviour.
- **`REFLEX_ESCALATE=shadow`** records `would_escalate` and changes nothing — no tier change, no `escalated:` reason.
  Section 13 lists shadow rows as shadow and counts only applied escalations. `REFLEX_ESCALATE` is now
  `off | on | shadow`; a value that is neither a mode nor a boolean spelling is a configuration error rather than a
  silent `off`.

### Measurement

- **`REFLEX_AB=<fraction>` (default 0): a randomised control arm.** Of the turns the backend would route below the
  requested tier, that fraction is held on the requested model at random and tagged `ab: "control"`; the rest are
  tagged `ab: "routed"`. Section 7 compares only the tagged turns and refuses the comparison until both arms pass
  `MIN_OUTCOME_N`. This is the only setting that produces data supporting a causal read: every other comparison in the
  report is between turns the backend judged easy and turns it did not, which differ in difficulty before any outcome
  is measured. Only a conversation currently on the requested tier is eligible; an escalated turn is never randomised.
- **`prompt_encoding` on every main new turn.** 2.1.277 sent typed prompts as blocks, 2.1.278 sends plain strings too,
  and once a turn is recognised the two left identical records — so the question "did the delegation hint change the
  encoding?" was unanswerable from a log and could only be inferred from the Claude Code version. Report section 1 now
  counts new turns by encoding, split by hint.

### Publishing

- **`reflex share`** writes a structural-only copy of the log and prints exactly what is in it. It is an allow-list,
  not a redactor: a field reaches the file only because `src/report/share.ts` names it, so a field added to the record
  later is absent until someone adds it deliberately. It writes a file and opens no socket — reflex has no telemetry
  and no upload path — and it says so in its own output. A `calibration-data` issue template says where to attach it
  and to report anything that looks wrong rather than sending it.
- **README:** "Contributing data" (why one person's log cannot calibrate anything, and what `REFLEX_AB` is for) and a
  rewritten "Status" stating plainly that this is an alpha measured on one user, that nothing is calibrated, that
  escalation is an uncalibrated mechanism which is off by default, that Fable routes are unverified and disabled, and
  that only Claude Code 2.1.277/2.1.278 on macOS have been exercised. Several overclaims corrected: routing's $3.33 is
  an estimate over recorded tokens, not a measured saving; the tagline no longer implies reflex knows whether work was
  done right.
- **package.json:** `bugs`, `homepage`, `keywords`, `publishConfig.access: public`. The `files` list was re-checked
  against `npm pack`: 63 files, no tests, fixtures, sourcemaps or scripts. CI runs tests only and publishes nothing.

## 0.3.0-alpha — 2026-09-20

The first release in which an outcome signal can change a later request — opt-in, off by default, and bounded so that
its worst case is the model your client already asked for. The rest is the reporting needed to judge it.

- **Rule change: "outcome capture is record-only" is split in two.** The privacy half is unchanged and now stated on
  its own: outcome capture writes nothing but hashes, counts, rule ids and runner kinds, and prompt, path and code text
  never leaves the worker's memory. The other half was a staging decision — record before acting — and this release
  ends it with a narrow replacement: **an outcome signal may raise a tier and may do nothing else.** It may never lower
  a tier, never go above the tier the client asked for, never change prompt text, never change a hook answer, never
  reach the backend and never leave the machine. (`CLAUDE.md`)
- **`REFLEX_ESCALATE=1` (off by default): auto-escalation.** When a turn reflex routed *below* the requested tier
  closes its outcome window with a correction score at or above `REFLEX_ESCALATE_THRESHOLD` (default `1`), a failing
  test after an edit, or a reverted edit, that conversation's next `REFLEX_ESCALATE_WINDOW_TURNS` (default `3`) new
  turns are planned **one tier above** the backend's pick and never above the requested tier. It never touches pinned
  tool loops, subagents or side calls; it does not overrule the cost guard, only raises the floor the guard evaluates
  against; `reflex:<tier>` still wins; a second signal restarts the count rather than stacking; and the state is in
  memory, so a worker restart drops it. An escalated decision carries an `escalation` block naming the signal, the tier
  before and after, and the decision whose window produced it, plus a `plan.reasons` entry of `escalated:<signal>`.
  The lever is weaker than it sounds and is worth stating plainly: the turn that went wrong is already over and billed,
  so what escalation buys is that **the turn in which you say it went wrong is itself routed up**. (`src/worker/escalation.ts`)
- **Fix: an undo-family correction is attributed to the turn the revert undid.** `correctionSignal` scores the prompt
  that *closes* a turn, so "undo that" put its `en:undo` weight on whatever turn merely came before it — in the M4
  acceptance session that was turn 3 while the revert targeted turn 1. When a revert is detected with
  `offset_turns > 0`, the undo-family part of the score is now re-attributed with an `outcome_update` record carrying
  `signal: "correction_reattributed"` (the matched rule ids, the score, the offset and the turn it came off). The
  original `outcome` record is append-only and is left exactly as written. Nothing is re-attributed at offset 0.
- **`backend_version` on every decision record.** The version the decision backend reported for itself (Jev returns it
  as `model`, e.g. `jev-1.13.0`); null when no backend call happened. Report sections 2 and 7 group by it, so a
  calibration can refuse to add two backend versions' rates together. Older logs are read through the version already
  inside `decision.backendModel`, so history groups too.
- **`reflex report` section 13, escalations**: every escalated turn with its signal, the tier before and after, what
  was actually sent, and the outcome of that turn once its own window closes. It refuses to print a rate below
  `MIN_OUTCOME_N` and says in words that nothing in it establishes whether escalation helps.
- **`reflex doctor`** prints what escalation is set to do, in a sentence, and says when the mode makes it a no-op.
- Three measurements recorded in [`docs/observations.md`](docs/observations.md): the first calibration read (both main
  arms past n=20 for the first time, with Wilson intervals, and the finding that the data cannot distinguish the `mass`
  and `argmax` rules and roughly what n would); the delegation hint measured over one day and one build instead of
  across days, with the all-time table marked confounded; and the identification, from Claude Code's own transcripts,
  of the two outcome windows that had no wire turn — one a tracker artefact, one a real prompt typed mid-tool-loop
  that the wire cannot see because the harness wraps it in a `<system-reminder>`.

## 0.2.5-alpha — 2026-09-19

Tightens the 0.2.4-alpha classifier rule and corrects what that release claimed. Nothing routes differently on any observed session.

- **Correction to what 0.2.4-alpha claimed.** Its entry and `docs/wire-format.md` §4.3 said "2.1.278 sends typed prompts as plain strings". That is **not** established: a capture of the same 2.1.278 minor sends every typed prompt as an array of blocks, and the classifier labels all of them `new`. What is proven is narrower — a plain string is at minimum the *history* encoding of a prompt (identical text, verified by hash), and one 2.1.278 session turned 11 typed prompts into 1 `new` turn. §4.3 has been rewritten to separate the proven from the inferred.
- **The betas are not the trigger.** A first reading of the capture suggested the regression session held betas the healthy one lacked. That was read off the `tools: 0` quota probe, which carries a shorter list; the two sessions' real requests carry **set-identical** betas (16 each, no difference either way). The trigger is unknown. The strongest surviving lead is reflex's own delegation hint: plain-string residuals appear only in sessions where `REFLEX_DELEGATE=1` was injecting `additionalContext` into `UserPromptSubmit` (20 across four sessions, zero in any session without it), with one short hint-enabled session as a counterexample, so injection alone is not sufficient. Correlation only. It does mean `scripts/spike/capture.mjs`, which answers every hook `204`, cannot reproduce the shape by itself.
- **A plain-string prompt is promoted only by the newest unclaimed typed prompt.** A capture on 2026-09-19 proved that a prompt's identical text is re-encoded as a plain string once it sits in a later request's history, so matching against the whole prompt list could have promoted a side call that replays the conversation up to an earlier user message. Matching only the newest prompt no wire turn has claimed refuses that while still recognising the turn the user just typed. No observed session changes classification; this closes a path the 0.2.4-alpha rule left open.
- **`reflex doctor` names a `REFLEX_*`/`TYPESAFE_*` variable nothing reads.** Such a name is ignored by `loadConfig` and then stripped from the environment given to `claude`, so a typo — or a variable from a plan that was never built — vanishes without a word and looks exactly like a setting that had no effect. `REFLEX_DUMP=1` was set for a whole session on the strength of a stale note before anyone noticed nothing read it.
- `docs/prior-art.md` no longer claims reflex adopts `REFLEX_DUMP`: it never existed, and bodies are deliberately never written to disk by a live session. It points at the dump-only proxy `scripts/spike/capture.mjs` instead.

## 0.2.4-alpha — 2026-09-19

Fixes a silent routing regression introduced by **Claude Code 2.1.278**, not by a reflex release. Nothing about the routing rules changed; the classifier had stopped recognising typed prompts, so most turns were never decided at all.

- **Fix: a user-typed prompt delivered as a plain string is recognised again.** Up to 2.1.277 every typed prompt arrived as an array of text blocks and only harness side calls used a plain-string content, so the classifier treated a plain string as proof of a side call. 2.1.278 sends typed prompts as plain strings too (the reminders that rode beside them moved into `role:"system"` messages). Every prompt after the first then classified as `side` / `unclassified`: no decision was taken, the conversation's pin never moved, and nothing failed loudly because each request still forwarded unchanged. In the maintainer's 13-turn session the wire found **1** `new` turn where there were 11; the previous session, on 2.1.277, found 5 of 15 with no `unclassified` side calls. Content shape no longer decides: a plain string is the user's turn only when the session's `UserPromptSubmit` prompts match it (`src/wire/typed-prompt.ts`, held in memory only). With no hook stream the request stays `side`, which is the fail-safe direction. Side markers are still matched first, so a named harness side call keeps its own kind whatever shape it wears. (`docs/wire-format.md` §4.3)
- **`unclassified_reason`** on decision records and in the fingerprint: which shape test produced the residual. `unclassified` was one bucket for five different situations, so a typed prompt whose hook was missed (`plain_string_no_typed_match`) looked exactly like an unknown harness shape. Report section 11 now breaks the bucket down by reason. `FINGERPRINT_VERSION` is **3**.
- **A drift alarm, because this regression cost a whole session in silence.** When a session has seen at least 3 typed `UserPromptSubmit` prompts but the classifier has found at most 1 main `new` turn, the worker logs a warning and the decision record carries `drift`, counted in `reflex report` section 1. It is an alarm only: it does not gate routing, degrade the session or change any classification — the classifier's own fail-safe already handles correctness. It exists so the next wire-format change is visible on day one instead of a session later. (`src/wire/drift.ts`)
- **Fix: section 9's "optional Claude Code features" block always prints**, with a zero row per feature. It was skipped entirely when no side call in range carried a feature marker — which is precisely the case a marker regression produces, so the block disappeared exactly when it was most worth seeing. Zero is a measurement; absence is not.
- **Section 12 prices only the cache TTL the log actually recorded**, when every record in range agrees, instead of always showing both candidates. Both are still shown while `cache_ttl_beta` is absent or mixed, and the header now says which case it is. The candidates table's third column was labelled `writes` but held the TTL; it is now labelled `TTL`.
- **`reflex report --json`**: the same sections `reflex report` prints, as one JSON object (a header of counts/span plus a `sections` object keyed by section number — matching the text report's own numbering, not by title text — each value `{title, lines}`). Built from the same section functions the text report calls, so it cannot drift from the text output; mutually exclusive with `--fingerprints`. Schema stability covered by tests over the archived real logs and an empty log.
- CI: `actions/checkout` and `actions/setup-node` bumped to v7, `ubuntu-latest` pinned to `ubuntu-24.04` in the test matrix. No functional change.
- Fixture `2.1.278/ultracode.main-new-turn-plain-string.request.json`, **derived** (clearly marked as such in the manifest and `gaps`) from the real `ultracode#004` request by re-encoding its last user message as a plain string: no body of a real 2.1.278 plain-string prompt was captured, since the route-mode log stores fingerprints, not bodies. `test/unit/wire-plain-string.test.ts` asserts both directions and replays the 13-turn session.

## 0.2.3-alpha — 2026-09-19

Measurement only: nothing routes differently from 0.2.2-alpha. `REFLEX_ROUTE_SIDE` was designed, priced and **not built** — see `docs/observations.md`, "side-call routing: priced, and parked".

- **`reflex report` section 12, side-call routing estimate.** What sending the harness's own side calls to a cheaper shared tier would have cost on your log, with every cold cache write paid in full, priced for both candidate tiers at both cache-write TTLs, gross and net of the conversations that would lose a free warm cache. It reports warm-vs-cold amortisation against the break-even each tier needs, and flags calls too large for a tier's context window as unroutable rather than counting them as savings.
- **Section 9 names what the optional Claude Code features cost**, with the switch that turns each off: Session recap (`/config` → Session recap, `awaySummaryEnabled`) and Prompt suggestions (`/config` → Prompt suggestions, `promptSuggestionEnabled`). On one day of the maintainer's own work these were **$11.82 at list prices**, against a best-case side-routing saving of $3.39 and a measured routing saving of $3.33. No advice, just the numbers and the switch names.
- **`side_marker`** on decision records: which harness marker named a side call. Claude Code's AFK session recap and its background task notifications share the `notification` side kind but only the recap has a switch, so the feature table attributes by marker. Records from older builds carry none and are counted separately rather than attributed by kind.
- **`cache_ttl_beta`** on decision records: whether the request carried the `extended-cache-ttl` beta. The wire computed this and threw it away, so no log could say whether cache writes were 1-hour or 5-minute — a distinction worth **18×** in the side-routing estimate.
- `docs/wire-format.md` §5.1 records an unverified branch of the rewrite recipe (an empty `output_config`, and `output_config.format` without `effort`), reached only if side-call routing is ever implemented.

## 0.2.2-alpha — 2026-09-19

Phase 2b groundwork. Nothing routes differently yet except what is listed here; side-call routing itself is designed but not implemented (`REFLEX_ROUTE_SIDE` does not exist in this version).

- **Side calls Claude Code makes are now named instead of falling to `unclassified`.** The AFK session recap ("The user stepped away and is coming back…") is a `notification`; tool results carrying harness text are the new side kind `tool_result_text`, recognised by shape rather than by a marker.
- **A message typed into a running tool loop is no longer mistaken for a side call.** It is a `continuation` carrying `interjection: true`: the turn's pin is held and no new decision is taken. The classifier and the fingerprint now share one test for "is this text a prompt the user typed" (`src/wire/typed-prompt.ts`), so they cannot disagree about the same sentence; that also stops empty text matching any prompt, so `FINGERPRINT_VERSION` is **2**.
- **Fix: a correction typed mid-tool-loop is no longer lost.** Such a prompt opened an outcome window that joined no decision, so the correction in the *next* prompt was written with `decision_id: null`. The window now joins the pinned conversation's own decision (`attribution: "interjection"`). Because that decision then owns two windows, `reflex report` counts interjections in an arm of their own and never inside a per-arm rate, so the outcome `n` the calibration gate waits on stays honest.
- **`reflex doctor` fails loudly when `REFLEX_DELEGATE=1` cannot work.** `REFLEX_MODE=off` and any effective mode of `passthrough` run `claude` directly with no settings file, so reflex's `UserPromptSubmit` hook is never installed and the hint is silently lost. Doctor now prints a `hint injection:` line naming the reason and exits 1.
- **`REFLEX_WARM_INTERVAL_MS`** (default 60000, 0 disables): the worker pings the decision backend on an interval to hold its keep-alive connection open between turns, in shadow and route mode only. The first decision after an idle gap otherwise pays a fresh handshake (p50 823 ms new vs 382 ms reused; different sessions, not a controlled comparison). Whether it helps is measurable from the existing `connection` field; **not yet measured.**
- No fixture covers the recap, `tool_result_text` or an interjection: they were seen in a route-mode log, which stores fingerprints and not bodies. They are synthetic unit cases and are listed in the 2.1.278 manifest's `gaps` (`docs/wire-format.md` §4.2).

## 0.2.1-alpha — 2026-09-19

- Fix: a subagent's hand-back is no longer treated as a prompt the user typed. Claude Code delivers a subagent's report to the main chat through `UserPromptSubmit`, so outcome capture closed the user's turn on it, opened a window of its own, and scored the report's text as the user's correction of the previous reply. A hand-back (`isHandbackPrompt`, the marker already in `src/wire`) now takes the same path as a harness-injected message: the user's turn stays open, tool events after it join that turn, the text is never scored, and it is counted in `counts.injected_prompts`.
- Claude Code **2.1.278** added to the tested versions, with redacted fixtures for a Dynamic Workflow (`ultracode`) session. Workflow workers are ordinary subagents on the wire (`x-claude-code-agent-id` **and** `cc_is_subagent=true`) and are classified correctly with no change; they request the **session's own model**, so the requested-tier logic is unchanged. Hook `agent_type` has the new value `workflow-subagent`. Details and limits: `docs/wire-format.md` §7.1, `docs/observations.md`.
- Measured, in `docs/observations.md`: one `ultracode` prompt put **65.8% of its tokens and 74.7% of its dollars into workflow workers** (4 workers, 1.5M tokens, $2.65 at list prices, killed early). This is the first measurement behind the README's warning that delegation can raise total spend.

## 0.2.0-alpha — 2026-09-19

Phase 2a: measure where the tokens go before tuning anything (docs/observations.md, first real-work dogfood).

- `reflex report` section 0, **workflow profile**: user turns per session; the share of tokens in main-chat new turns, tool-loop continuations, subagents and side calls; a split by delegation hint version with total tokens, dollars at list prices and both per user turn; and the verdict "routing can touch at most X% of your tokens; Y% of that is in subagents". Golden tests over structural copies of the archived real logs (`scripts/report/strip-archive.mjs`) and a synthetic single-turn / long-loop log.
- **Fingerprints for unclassified side calls** (`side_fingerprint`, `src/wire/fingerprint.ts`): structure only (counts, roles, block types, `max_tokens`, thinking, effort, stream, betas) plus at most the 80-character opening of harness text when it matches no user-text heuristic, redacted. `reflex report` section 11 and `reflex report --fingerprints` (JSON lines to send back).
- **`REFLEX_DELEGATE=1`** (opt-in, off by default): the `UserPromptSubmit` hook answers user-typed prompts with a fixed three-line hint (`src/delegate/hint.ts`, `delegate-1`) asking Claude to delegate exploration, multi-file reading, searches and test runs to subagents. Never on slash commands, injected messages, subagent hand-backs or subagent events; any failure is "no hook output". Every decision record carries `delegate_hint`; delivered hints are `record: "delegate_hint"`. Section 8 compares sessions with and without the hint. It can raise total spend (README).
- `reflex doctor` shows whether the delegation hint is on.

## 0.1.3 — 2026-09-19

- Fix: a setting exported as an empty string was treated as set. An empty `ANTHROPIC_BASE_URL` made `reflex doctor` (and every launch) fail with "ANTHROPIC_BASE_URL must be an http(s) URL" instead of using the default upstream, and an empty `REFLEX_UPSTREAM_URL` hid a set `ANTHROPIC_BASE_URL`. Every setting `loadConfig` reads now goes through one helper that treats an empty or whitespace-only value as unset, so the next source or the default applies. `~/.reflex/env` already treated empty process values as unset.

## 0.1.2 — 2026-09-19

- Fix: `reflex report` skips an unterminated last line of `decisions.jsonl` and counts it as skipped.
- `package.json` gains the `repository` field, so the README's relative `docs/` links resolve on a package page.

## 0.1.1 — 2026-09-19

- README rewrite; reference material moved to `docs/reference.md`.
- Test helper reads only complete lines of `decisions.jsonl` (CI race).

## 0.1.0 — 2026-09-19

- First tagged version.
