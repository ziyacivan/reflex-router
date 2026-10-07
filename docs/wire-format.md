# Claude Code wire format — observed facts

Everything here was **observed**, not inferred from documentation or prior art. Source: captures of Claude Code **2.1.277** on macOS, non-interactive (`claude -p`, `cc_entrypoint=sdk-cli`) and interactive (TUI, `cc_entrypoint=cli`), through `scripts/spike/capture.mjs` (a dump-only passthrough proxy). Redacted fixtures: `test/fixtures/claude-code/2.1.277/` (see its `manifest.json`). Raw dumps are gitignored under `_dumps/`.

This format is **not a public contract**. When Claude Code updates, re-run the capture (`docs/wire-format.md` §8) and diff.

## 1. What was captured

| Run | Setup | Requests | Cost |
| --- | --- | --- | --- |
| 1 | `--model sonnet`; main chat spawns one `general-purpose` subagent (Glob), then a failing Bash (`exit 1`), an Edit, a passing Bash; `--settings` with http hooks; a project-level command hook in `.claude/settings.json` | 9 | $0.32 |
| 2 | `--model haiku`; two `--settings` flags (ours + a user command hook) | 2 | $0.09 |
| 3 | `--model haiku`; local stdio MCP server declaring a JSON Schema **draft-04** tool | 2 | $0.07 |
| interactive | TUI session (`cc_entrypoint=cli`, Sonnet 5): a prompt that spawns a **background** Explore subagent, further prompts, `/compact`, a message from another session, a system notification | 30 + HEAD | not recorded |

Not captured (gaps, also listed in the manifest): forks, several concurrent subagents, custom `.claude/agents/*.md` subagents, an `Agent` call with an explicit `model`, `/resume`, Linux/Windows. To capture an interactive session yourself: `node scripts/spike/capture.mjs` (starts `claude` with the proxy and hooks), use it, then `node scripts/spike/redact-fixtures.mjs _dumps/<dir> --label <name>`.

## 2. Requests

- `POST /v1/messages?beta=true`, `stream: true`. Also once per process: **`HEAD /api/hello`** (not `HEAD /`); upstream answers 200. The two prior-art repos describe `HEAD /`.
- Body keys: `model, messages, system, tools, metadata, max_tokens, thinking, context_management, output_config, stream`.
- `metadata.user_id` is a **JSON string** `{"device_id":…,"account_uuid":…,"session_id":…}`. The device and account ids are personal identifiers → never log or send them.
- `system` is an array of 3 text blocks. Block 0 is the billing line: `x-anthropic-billing-header: cc_version=2.1.277.<3hex>; cc_entrypoint=sdk-cli;` (+ ` cc_is_subagent=true;` for subagents). The 3-hex suffix of `cc_version` differs between main and subagent requests of the same session. Block 1: `You are a Claude agent, built on Anthropic's Claude Agent SDK.`
- `messages`: the first user message holds `<system-reminder>` text blocks followed by the real prompt text. Sonnet requests carry `role:"system"` messages (mid-conversation-system beta), but **where** differs by entrypoint: with `sdk-cli` one trails the list and more accumulate as the tool loop grows (1, 1, 2, 2, 3, 4, 5, 6 over the run-1 requests); with `cli` they sit **mid-list** (index 1 in the main chat, 1 and 4 in the subagent, 3 after `/compact`) and do not accumulate. The native Haiku request had none (§5). Any "last message" logic must skip `role:"system"` messages wherever they are, and a rewrite that folds them must handle mid-list positions.
- Interactive-only differences: `thinking: {"type":"adaptive"}` **without** `display`; an extra `redact-thinking-2026-02-12` beta; 55 tools on the main chat and 34 on the Explore subagent (vs 45/43 with `sdk-cli`); the client sends `accept-encoding: gzip, deflate, br, zstd`.
- `thinking: {"type":"adaptive","display":"omitted"}`, `output_config: {"effort":"medium"}`, `max_tokens: 64000`, `context_management: {"edits":[{"type":"clear_thinking_20251015","keep":"all"}]}` on Sonnet 5.
- 3–4 `cache_control` markers per request.
- Tools: 43–45 per request; the set differs between main (45) and subagent (43: no `ScheduleWakeup`, `Workflow`).

### Headers
Beyond standard ones: **`x-claude-code-session-id`** (on every request; equals `metadata.user_id.session_id` and the hooks' `session_id`), **`x-claude-code-agent-id`** (on subagent requests **only**; equals the hooks' `agent_id`, 17 chars, constant across that subagent's requests), `x-app: cli`, `user-agent: claude-cli/2.1.277 (external, sdk-cli)`, `x-stainless-*`, `anthropic-beta` (comma list), `anthropic-dangerous-direct-browser-access`.

`anthropic-beta` on Sonnet main: `claude-code-20250219, oauth-2025-04-20, interleaved-thinking-2025-05-14, thinking-token-count-2026-05-13, context-management-2025-06-27, prompt-caching-scope-2026-01-05, mid-conversation-system-2026-04-07, advisor-tool-2026-03-01, effort-2025-11-24, extended-cache-ttl-2025-04-11`. Subagent requests **lack `extended-cache-ttl-2025-04-11`** → main chat writes 1-hour cache entries, subagents 5-minute ones (matters for the cost guard).

## 3. Main vs subagent

| Signal | Main | Subagent |
| --- | --- | --- |
| `x-claude-code-agent-id` header | absent | present, == hook `agent_id` |
| `cc_is_subagent=true` in billing line | absent | present |
| `You are an agent for Claude Code` in system | absent | present on the `general-purpose` agent (sdk-cli); **absent** on the interactive Explore agent. Optional: never required, logged when seen |
| `x-anthropic-billing-header:` in system | present | present |
| subagent's first user text | — | **exactly equals** the parent's `Agent` tool `tool_input.prompt` |
| model | requested model | inherited (`Agent` input had no `model`; got `claude-sonnet-5`) |

The header and `cc_is_subagent=true` co-occurred on every subagent request (both entrypoints) and on no main-chat request. The agent-prompt marker is agent-type specific. A **background** subagent's requests interleave with main-chat requests, and its `SubagentStop` hook can arrive during a later user turn.

**Detection priority (our rule).** The header `x-claude-code-agent-id` is the **primary** signal (cheapest, no body parsing, and the exact join key to hooks). The two system-prompt markers are the **fallback** for when the header is absent. Every decision logs which signal fired (`signal: "header" | "marker:cc_is_subagent" | "marker:agent_prompt" | "none"`) and the raw presence of all three (`signals: {header, s1, s2}`), so a signal that starts disappearing shows up in the data before it causes damage. Header and markers disagreeing is itself a shape violation (§10).

## 4. Turns

Only **positively identified** work is ever decided on. `src/wire/claude-code.ts` classifies the last non-system message:

| Turn | Rule |
| --- | --- |
| `new` | `user` role whose text, after dropping reminder blocks and `<local-command-…>`/`<command-…>` wrappers, is non-empty, and no side marker (below). Content may be an **array** of text blocks or, since 2.1.278, a **plain string** — a plain string is `new` only when the hook stream vouches for it (§4.3). A subagent is `new` only on its first request |
| `continuation` | `user` role with `tool_result` blocks and nothing else except reminder blocks, **or** a message the user typed mid-loop (an *interjection*, §4.2). Failed Bash arrives as `tool_result` with **`is_error: true`, content `"Exit code 1"`** |
| `side` | everything else, tagged with a `side_kind` |

In 2.1.277 every user-typed prompt observed (both entrypoints) and every subagent start arrived as an array of blocks, and every plain-string content was a harness side call. **This stopped being true in 2.1.278** — see §4.3.

### 4.1 Harness side calls (interactive)

These carry the full tool list and the same `messages[0]` as the real conversation, so they look like turns and share its conversation key. They are matched **only against the last message**, because the injected text stays in the history.

| `side_kind` | Last message | Fixture |
| --- | --- | --- |
| `suggestion` | plain string `[SUGGESTION MODE: …` | `interactive.main-suggestion` |
| `agent_summary` | plain string `Describe your most recent action…`, sent under the subagent's agent id | `interactive.subagent-summary` |
| `compaction` | `tool_result` + text `CRITICAL: Respond with TEXT ONLY…`; **lacks the `extended-cache-ttl` beta** | `interactive.main-compaction` |
| `cross_session` | text `Another Claude session sent a message:` (no `UserPromptSubmit` hook) | `interactive.main-cross-session` |
| `notification` | reminder-only, `[SYSTEM NOTIFICATION - NOT USER INPUT]` (no `UserPromptSubmit`) | `interactive.main-notification` |
| `notification` | plain string `The user stepped away and is coming back. Recap in under 40 words…` — Claude Code's AFK session recap | **uncaptured**, see §4.2 |
| `no_tools` | no or empty `tools`: title generation (`output_config.format` JSON schema), `max_tokens: 64` side calls, the `max_tokens: 1` quota probe (no system prompt at all) | `interactive.title-generation`, `…side-no-tools`, `…quota-probe` |
| `tool_result_text` | `tool_result` blocks **plus** text that is neither a reminder nor a prompt the user typed. Recognised by shape, not by a marker | **uncaptured**, see §4.2 |
| `unclassified` | anything else not positively identified | — |

Consequences: main-chat model turns are **not** 1:1 with `UserPromptSubmit`; `SubagentStop` also fires for agent ids that never had a `SubagentStart` and never appear as an `x-claude-code-agent-id` header (likely the suggestion forks).

### 4.2 Tool results carrying text: a side call or the user interjecting

A last `user` message with `tool_result` blocks **and** a non-reminder text block is ambiguous on the wire. Two different
things produce it, and they must not share a label:

- **The user typed into a running tool loop.** Still their own turn: the pin is held, no new decision is taken, and the
  turn is `continuation` with `interjection: true` (logged only when true).
- **The harness put its own text beside the results.** A side call: `side` / `tool_result_text`.

They are told apart by the prompts `UserPromptSubmit` delivered for the session, which the worker holds in memory only
(`src/worker/recent-prompts.ts`); the test is the shared matcher in `src/wire/typed-prompt.ts`, used by the classifier
and by the fingerprint's `typed_prompt` head omission so the two can never disagree about the same sentence. With no
hook stream (no prompt seen yet, hooks not installed) an interjection is never claimed and the request stays
`tool_result_text` — the fail-open direction, since neither outcome routes anything.

One harness text is recognised by shape instead: `Tool loaded.` beside a `tool_result` whose content holds
`tool_reference` blocks is the tool-loop step after a ToolSearch (2.1.282, §5.10), so it is a `continuation`. Before
this rule, with tool search on, that step went out as `side` / `tool_result_text`: to the requested model, off the pin
(two real sessions, 2026-09-25).

### 4.3 Content shape does not identify the writer (2.1.277 -> 2.1.278)

**Proven, from a capture (`_dumps/plain-string`, 2.1.278.85b, 2026-09-19).** A typed prompt is sent as an **array** of
text blocks while it is the newest message, and the **identical text** appears as a **plain string** once it sits in a
later request's history. Request 007's last user message is an array whose text is 119 code points,
`sha256[..10] = 907dbed69a`; request 008 carries the same 119 code points as a plain-string user message in its history,
same hash. So a plain string is, at minimum, the *history* encoding of a prompt — and content shape alone cannot say
who wrote a message or when.

**Proven, from the maintainer's route-mode log (session `399c485e`, 2.1.278, 2026-09-19).** Eleven typed
`UserPromptSubmit` hooks produced **one** main `new` turn. For each of the ten outcome windows that took no decision,
every wire request in the window was enumerated: each contains **exactly one** `main` / `side:unclassified` request and
**zero** `main` / `new`. That request is the **first** in its window and arrives **0.0-0.1 s** after the window opens —
i.e. at the moment the user pressed enter. Its fingerprint says `last.content: "string"`, `text_chars` 77-254, with
`messages` growing 13 -> 22 -> 29 -> 38 -> 57 -> 62 -> 107 -> 140 -> 177 -> 215 across the session. Window `seq=11`
contains that request and **nothing else**. The betas in force: `afk-mode-2026-01-31`, `advisor-tool-2026-03-01`,
`dangerous-tool-use-2026-09-03`, `effort-2025-11-24`, `fallback-credit-2026-06-01`,
`mid-conversation-tool-changes-2026-07-01`, `extended-cache-ttl-2025-04-11`, `context-1m-2025-08-07`.

**Proven: the plain-string form is not universal in 2.1.278, and the betas are not what decides it.** The capture above
ran the same minor version and sent all four of its typed prompts as arrays; the current classifier labels all four
`new`. Its main requests carry **exactly the same 16 betas** as the regression session — `advisor-tool`, `afk-mode`,
`dangerous-tool-use`, `effort`, `fallback-credit`, `mid-conversation-tool-changes`, `extended-cache-ttl` included;
set-identical, no difference in either direction. (An earlier revision of this section claimed a beta difference. It was
read off request 002, the `tools: 0` quota probe, which carries a shorter list than the session's real requests.)

**The strongest surviving lead: reflex's own delegation hint.** With `REFLEX_DELEGATE=1` reflex answers a user-typed
`UserPromptSubmit` with `hookSpecificOutput.additionalContext`; `scripts/spike/capture.mjs` answers every hook `204`
and never injects anything. Across the maintainer's logs, plain-string `unclassified` residuals appear **only** in
sessions where the hint was being injected — 20 of them across four such sessions, and **zero** in any session without
it. (Two plain-string residuals in a no-hint session are the AFK session recap, a genuine harness side call, not a
missed prompt.) This is a correlation with one known exception: a short hint-enabled session of four turns produced no
residuals at all, so injection alone is not sufficient — conversation length, or something that accumulates with it,
is likely also involved. **Not established.** It does mean the capture proxy cannot reproduce the shape on its own.

**Inferred, not proven.** That those ten plain-string requests carried the *newest* prompt rather than an older one.
The timing (first in window, +0.0 s) and the monotonically growing message counts make a history-replaying side call
very hard to credit, but no body was captured — that log stores fingerprints, not bodies — so this is inference from
structure, not a byte comparison. What makes the encoding switch between array and plain string for the newest message
is **unknown**; the differing beta sets are the leading candidate and nothing here establishes it.

**What it cost.** The old rule read a plain string as proof of a side call. Every prompt after the session's first then
classified `side` / `unclassified`: no decision was taken, the pin never moved, and every request still forwarded
correctly, so nothing failed loudly. The prior session, on 2.1.277, had 5 `new` turns and no `unclassified` side calls.
It took reading `nearest_wire` by hand a day later to notice.

**The rule now.** A plain-string last message is a `new` turn only when it matches the **newest** typed prompt whose
hook has arrived and which no wire turn has claimed yet (`src/worker/recent-prompts.ts`, memory only; the match is
`src/wire/typed-prompt.ts`). Matching the whole prompt list would be unsafe given the proven history encoding: a side
call replaying the conversation up to an earlier user message wears exactly this shape and its text is a real prompt
the user really typed. Such a call can only carry an *older* prompt, so the newest-unclaimed test refuses it. A main
`new` turn claims the prompt, so a repeat of the same request cannot be promoted twice. With no hook stream the request
stays `side` — the fail-safe direction, since an unrecognised request forwards unchanged. Side markers are still
matched first, so a named harness side call keeps its own kind whatever shape it wears.

Each `unclassified` records **which** test produced it (`unclassified_reason`, on the decision record and in the
fingerprint), so `plain_string_no_typed_match` can be told from an unknown harness shape in report section 11.

**Drift alarm.** `src/wire/drift.ts` cross-checks the two views: when a session has seen at least 3 typed
`UserPromptSubmit` prompts but the classifier has found at most 1 main `new` turn, the worker logs a warning and the
decision record carries `drift`, counted in report section 1. It changes nothing — not routing, not classification, not
the session's degraded state — it only makes the next format change visible on day one. Had it existed, session
`399c485e` would have raised it on its third prompt. Since 0.3.8 it also flags, once per session and value, a requested
model or a `max_tokens` value that no fixture request holds (`unseen_requested_model`, `unseen_max_tokens`; the lists
are generated beside the tested versions by `npm run gen:versions`), and every upstream rejection of a rewritten request
(`rewrite_rejected`). A record can carry several reasons, comma-separated.

**A main new turn needs a typed prompt once hooks arrive (2.1.280).** Session `999c1b7f` got four array-encoded
main-chat requests within 50 s with no `UserPromptSubmit` behind any of them (11k–38k input, no cache), and they were
decided as user turns. Since 0.3.8, once any `UserPromptSubmit` has reached the worker for a session, a main-chat
message that is not the newest unclaimed typed prompt is `side` / `unclassified` with `unclassified_reason:
no_typed_prompt`, whatever its encoding, and gets a fingerprint. Without a hook stream the structural rule stands
alone. **No body of these calls was captured**, so their shape and side kind are still unnamed.

**Fixture.** `2.1.278/ultracode.main-new-turn-plain-string.request.json` is **derived**, not captured: the real
`ultracode#004` request with its last user message re-encoded as a plain string. The capture of 2026-09-19 did **not**
reproduce the plain-string-as-newest-message shape, so no real body of one exists yet. Its manifest `expect` is the
no-hook classification; `test/unit/wire-plain-string.test.ts` asserts both directions, the history-replay refusal and
the claim, and replays the 13-turn session. **Reproducing this under the regression's beta set, and replacing the
derived fixture with real bytes, is still open.**

**Evidence, and its limits.** Both kinds and the interjection come from the maintainer's 2.1.278 route-mode log of
2026-09-19, where all eight `unclassified` side calls fell into these shapes: 2 AFK recaps (plain-string content, 253
characters, `messages` 78 and 242), 2 `tool_result_text` (9,417 characters of text beside the results, one main chat and
one subagent), 2 interjections (362 and 412 characters, at message 218 and 234, head dropped as `typed_prompt`), and 2
older records written before `side_fingerprint` existed, whose shape is unrecoverable. **No body was captured for any of
them** — that log stores fingerprints, not bodies — so no fixture asserts these three cases; they are covered by
synthetic unit cases in `test/unit/wire.test.ts` and listed in the 2.1.278 manifest's `gaps`. The recap marker text is
the redacted 80-code-point fingerprint head of those two calls. A future capture should pair the request with its
`hooks.jsonl`, because an interjection cannot be recognised from a request alone.

## 5. Native Haiku request shape (Claude Code choosing Haiku itself)

| Field | Sonnet 5 (main) | Haiku 4.5 (main, native) |
| --- | --- | --- |
| `model` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| `thinking` | `{type:"adaptive", display:"omitted"}` | `{type:"enabled", budget_tokens:31999, display:"omitted"}` |
| `output_config` | `{effort:"medium"}` | **absent** |
| `max_tokens` | 64000 | 32000 |
| `context_management` | clear_thinking edit | **same** clear_thinking edit (kept) |
| trailing `role:"system"` message | yes | **no** |
| betas | as above | minus `effort-2025-11-24`, minus `mid-conversation-system-2026-04-07` |

This contradicts the prior-art recipe ("delete `thinking`, delete `context_management`"). What the API actually requires was then measured (§5.1).

### 5.1 Retargeting a Sonnet request to Haiku: what the API accepts (experiment)

`scripts/spike/rewrite-experiment.mjs` re-sent one real Sonnet 5 request (first turn of a fresh `claude -p` conversation) as 11 variants of a 6-step rewrite, using the live request's own auth headers held in memory only. Result file: `test/fixtures/claude-code/2.1.277/experiment.sonnet-to-haiku-retarget.results.json`.

| Rewrite step | Needed? | Evidence |
| --- | --- | --- |
| `model` → `claude-haiku-4-5-20251001` | yes | — |
| remove `output_config.effort` | **yes** | kept → 400 `This model does not support the effort parameter.` |
| `thinking` `adaptive` → `{type:"enabled", budget_tokens:31999}` | **yes** | kept → 400 `adaptive thinking is not supported on this model` |
| fold `role:"system"` messages into the adjacent user message | **yes** | kept → 400 `role 'system' is not supported on this model` |
| cap `max_tokens` at 32000 | **no** | accepted with 64000 |
| remove `effort-*` and `mid-conversation-system-*` betas | **no** | accepted with them present |
| `context_management` | keep as is | native Haiku keeps it; never removed |

The minimal working rewrite is therefore three field edits plus the model swap; the extra steps in a native Haiku request are not required, and fewer edits mean less risk. The API reports one validation error at a time, so necessity was established by leave-one-out, not from the messages alone.

**Unverified, and it only matters for side calls.** `retarget` removes `output_config.effort`, and when `effort` was the
object's **only** key it deletes `output_config` entirely rather than sending `{}`. Neither branch of that choice has
been tested against the API: no experiment sent an empty `output_config`, and no experiment retargeted a request whose
`output_config` carries `format` (the JSON-schema shape a `no_tools` title-generation call uses, §4.1). So two things
are open — whether the API accepts `output_config: {}`, and whether a target model accepts `output_config.format`
without `effort`. This is reached only if side-call routing is implemented; ordinary turns carry `effort` alongside
nothing else, so today the object is simply dropped. Not worth a paid run on its own.

**Scope.** One request, first turn, no assistant history. **Not tested:** switching the model in the middle of a conversation (Sonnet-generated `thinking` blocks with signatures already in `messages`), requests with earlier `tool_use`/`tool_result` turns, Opus/Fable targets, the `context-1m` beta, and subagent (5-minute cache) requests. A mid-conversation switch is the likeliest place for a rejection, which is one more reason the main chat is only switched behind a cost guard and every rewrite keeps the retry-with-original safety net.

### 5.2 Routing a whole session Sonnet → Haiku (experiment, M3)

`scripts/spike/route-experiment.mjs` ran one real `claude -p` session (Sonnet 5, tools limited to Bash and Agent) through a proxy that routed it the way route mode does, using the product rewrite `src/wire/rewrite.ts`, and probed each shape on the way. Results: `test/fixtures/claude-code/2.1.277/experiment.route-sonnet-to-haiku.results.json`. Estimated cost $0.07.

| Case | Result |
| --- | --- |
| subagent's first request → Haiku | 200 |
| subagent continuation, pinned (Haiku history; system messages mid-list and trailing, folded) | 200 |
| main continuation with a **signed Sonnet thinking block** in the history, kept as is | 200 |
| same, history thinking dropped | 200 |
| same, `thinking` without `display` (interactive shape) | 200 |
| same, plus the `redact-thinking-2026-02-12` beta (interactive header) | 200 |
| later main continuation, pinned (Haiku turns in history) | 200 |
| **un-pin**: the original bytes to Sonnet, with Sonnet- and Haiku-made thinking blocks in the history | 200 |

So route mode keeps history thinking blocks (fewer edits), and both the retry-with-original safety net and releasing a pin send requests the API accepts. "Accepted" means HTTP 200 and a normal stream; it does not show whether a model uses or ignores thinking blocks signed by another model. **Not tested:** Opus or Fable as source or target, Haiku → Sonnet/Opus (upgrades), `context-1m`, an interactive session end to end (the `cli` shapes were emulated on an `sdk-cli` request), histories near the context limit. (Opus was covered next, §5.3.)

### 5.3 Routing a whole session from Opus 5 (experiment, M3)

The same script with `--from opus` ran one real Opus 5 session with two subagents: subagent #1 and the main chat were routed to Haiku, subagent #2 to Sonnet, and each shape was probed against both targets. Results: `test/fixtures/claude-code/2.1.277/experiment.route-opus-to-sonnet-haiku.results.json`. Estimated cost $0.17. The Opus request sent `effort: "medium"` and adaptive thinking with `display: "omitted"`.

| Case | Opus → Haiku | Opus → Sonnet |
| --- | --- | --- |
| subagent's first request | 200 (×3) | 200 (×3) |
| subagent continuation, pinned | 200 (system messages mid-list + trailing folded) | 200 |
| main continuation with a **signed Opus thinking block** in the history (kept / dropped / no `display` / + redact-thinking beta) | 200 ×4 | 200 ×4 |
| later main continuations, pinned (target-made turns in history) | 200 ×3 | — |
| history made by Opus and Haiku, sent to Sonnet (pin changed mid-loop) | — | 200 |
| **un-pin**: original bytes back to Opus with Opus- and Haiku-made thinking | 200 | |

Opus → Sonnet needs only the model swap (both families take adaptive thinking, `effort` and system messages); Opus → Haiku needs the same three edits as Sonnet → Haiku. **Not tested:** Opus → Sonnet with `effort` other than `medium` (`high`, `xhigh`, `max`), an interactive Opus session end to end, `context-1m`, Fable, upgrades. The Opus main request in this `-p` run had no `extended-cache-ttl` beta; the cost guard reads the TTL from each request.

### 5.4 Interactive Opus first turn → Haiku (probe, M3 acceptance follow-up)

Route-mode acceptance session A saw one Opus → Haiku main-chat first turn rejected with 400 (the fallback worked; the error text was not recorded then). Hypothesis: the interactive main chat's 1-hour cache TTL. `scripts/spike/first-turn-probe.mjs` started an **interactive** Opus session in a pseudo-terminal (`scripts/spike/pty-run.py`), intercepted its first main-chat request and probed Haiku with the product rewrite; the real turn was not sent. That request had `max_tokens` 64000, adaptive thinking without `display`, `effort: "medium"`, `cache_control` TTL `1h`, the `extended-cache-ttl-2025-04-11` beta, 55 tools and 14 betas. **Result: 200 with the unchanged rewrite** (`experiment.interactive-opus-first-turn-to-haiku.results.json`, est. $0.10). The 1-hour TTL is therefore not the cause.

**Resolved: the long-context beta.** The rejected requests came from the model setting `opus[1m]`, which sends `model: "claude-opus-5"` **plus the `context-1m-2025-08-07` beta**; the reproductions above had used `--model opus`, without it. With the fallback error now recorded, acceptance session B1 reported `invalid_request_error: The long context beta is not yet available for this subscription.` A second interactive probe with `opus[1m]` (fixture `interactive-opus1m.main-new-turn`, results `experiment.interactive-opus1m-first-turn-to-haiku.results.json`, est. $0.03) confirmed it: the body rewrite with the headers untouched → **400 with that message**; the product rewrite, which also removes that beta from `anthropic-beta` when the target is Haiku → **200**. Sonnet and Opus accept the beta and keep it. Which beta values are removed per target lives in one table, `STRIP_BETAS` in `src/wire/rewrite.ts`, each row naming its evidence; a routed record lists every removed value in `forwarded.fields` (`anthropic-beta:-<value>`), and the retry-with-original re-sends the original headers. Note: Haiku 4.5's context window is 200k tokens, so a Haiku-pinned conversation that grows past it will be rejected and fall back to the requested model (see §5.6: a "prompt is too long" rejection no longer disables the tier).

### 5.5 Upgrades: Haiku 4.5 → Sonnet / Opus, Sonnet → Opus (experiment, 2.1.278)

`scripts/spike/route-experiment.mjs --from haiku --to sonnet,opus` ran five real `claude -p` sessions under the user's own settings (model setting `haiku`, no `--model`, entrypoint `sdk-cli`); each results file records those settings. Three are kept as results (`test/fixtures/claude-code/2.1.278/experiment.route-haiku-*.results.json`); the other two were attempts at run 3 in which Sonnet produced no thinking block, so their un-pin probe did not test what it was for. Estimated cost of these five runs about $2.56, at list prices over the recorded usage. Run 1 was capped at $0.50 and overshot to $1.05: the cap is checked before a probe, not against the probe's own cost, and one Opus probe wrote 58k tokens to the 1-hour cache.

| Case | Haiku → Sonnet | Haiku → Opus |
| --- | --- | --- |
| main chat's first request (no history) | 200 | 200 |
| subagent's first request | 200 (×4) | 200 (×3) |
| subagent continuation, pinned | 200 (×2) | 200 |
| main continuation with a **signed Haiku thinking block** in the history (kept / dropped / no `display` / + redact-thinking beta) | 200 ×4 (2 runs) | 200 ×4 |
| later main continuations, pinned | 200 | 200 |
| history made by Haiku and Opus, sent to Sonnet (pin changed mid-loop) | 200 | — |
| **un-pin**: original bytes back to Haiku with a **Sonnet-signed** / **Opus-signed** thinking block in the history | 200 | 200 |

The rewrite is the model swap plus `thinking` `enabled` (budget) → `adaptive`; the Haiku request carries no `effort` and no `role:"system"` messages, and `max_tokens` 32000 is accepted as is. The un-pin row is the one that matters for fail-open: after an upgrade the client's own bytes hold thinking blocks signed by the stronger model, and the retry-with-original sends exactly those to Haiku. The subagent un-pin probes held no thinking blocks, so the Sonnet-signed case rests on run 3's main chat and the Opus-signed case on run 2's.

**Interactive, and `context-1m`** (`experiment.route-haiku-up-interactive.results.json`, est. $2.42). The same script with `--interactive` runs the TUI in a pseudo-terminal (`pty-run.py`; `cc_entrypoint=cli`, 1-hour cache TTL, the `redact-thinking-2026-02-12` beta, `thinking` without `display`). Every probe was accepted: the first request to Sonnet and to Opus, each also with `context-1m-2025-08-07` added to `anthropic-beta`; a subagent's first request to both and its pinned continuation to Sonnet; the main continuation holding a Haiku thinking block to both targets in all four variants; un-pin to Haiku and cross-target to Opus with three thinking blocks (Haiku- and Sonnet-made) in the history. So the long-context beta needs no `STRIP_BETAS` row for Sonnet or Opus. A `haiku` model setting never sends it; the probe covers a request that does.

**Sonnet → Opus** (`experiment.route-sonnet-to-opus-subagent.results.json`, est. $0.61 over two runs, one kept). The model setting is `haiku` and `--model` is not used, so the Sonnet source was a native Sonnet **subagent** (the main chat set the Agent tool's `model` parameter). Its first request (no history), its second request (a signed Sonnet thinking block, `role:"system"` messages mid-list and trailing, `effort: "medium"`, the `effort-*` and `mid-conversation-system-*` betas), the pinned Opus continuations and un-pin back to Sonnet with Opus-made thinking were all accepted, with only `model` changed. A Sonnet **main chat** was not run; its request carries the same fields as that subagent request plus the interactive ones covered above. Efforts other than `medium` are untested, as for Opus → Sonnet (§5.3).

### 5.6 Fable 5.1, efforts other than `medium`, a Sonnet main chat, and the Haiku context ceiling (experiment, 2.1.278)

Eight more sessions with `scripts/spike/route-experiment.mjs` (flags `--probe-efforts`, `--probe-ceiling`; probes now carry the product's header rewrite too). Estimated cost about $18.6 in total at list prices, plus one unpriced single-turn Fable capture (`scripts/spike/capture.mjs`, gitignored) to read the Fable request's structure. **Six of the eight used `--model` and some `--effort`**, a deliberate exception to the no-override rule approved by the user: a Sonnet, Opus or Fable source cannot be produced from the model setting `haiku` otherwise. Each results file records its flags.

| Pair | First request | + effort low…max | Subagent | Main continuation (4 variants) | Un-pin to source | File |
| --- | --- | --- | --- | --- | --- | --- |
| Sonnet main (effort xhigh) → Opus | 200 | 200 ×5 | 200 | 200 ×4 | 200 | `route-sonnet-main-to-opus-efforts` |
| Opus (effort max) → Sonnet | 200 | 200 ×5 | 200 | 200 ×4 | 200 | `route-opus-max-to-sonnet-efforts` |
| Haiku → Fable | 200 | 200 ×5 | 200 | 200 ×4 | 200 | `route-haiku-to-fable-and-ceiling` |
| Sonnet → Fable | 200 | — | 200 | 200 ×4 | 200 | `route-sonnet-to-fable` |
| Opus → Fable | 200 | — | 200 | 200 ×4 | 200 | `route-opus-to-fable` |
| Fable → Haiku | 200 | — | 200 ×2 | 200 ×4 | 200 | `route-fable-down` |
| Fable → Opus | 200 | 200 ×5 | 200 ×2 | 200 ×4 | — | `route-fable-down` |
| Fable → Sonnet, rewrite as it was | **400** | **400 ×5** | **400** | **400 ×4** | — | `route-fable-down` |
| Fable → Sonnet, fixed | 200 | 200 ×5 | 200 | 200 ×4 | 200 | `route-fable-to-sonnet` |

**Fable → Sonnet needed a fix.** A Fable 5.1 request carries a per-turn effort on its `role:"system"` message (`{"role":"system","content":[…],"output_config":{"effort":"high"}}`, the same value as the top-level one) and the `per-turn-control-2026-07-01` beta. Sonnet 5 rejects the message field: with the beta, `output_config.effort requires a model that supports per-turn effort; this model does not`; with the beta removed, `messages.1.output_config: Extra inputs are not permitted`. `retarget` now drops `output_config` from system messages when the target is Sonnet (`messages.output_config_dropped:<n>`); the beta itself is harmless once the body is fixed (a "betas untouched" probe was accepted), so no `STRIP_BETAS` row. Opus and Fable keep the field; Haiku folds system messages into user messages, which already drops it.

**The Haiku context ceiling is not safe for dense content.** Route mode estimates tokens as body bytes ÷ 2.5 and routes to Haiku only up to 150k estimated tokens (`CONTEXT_CEILING`, `src/tiers.ts`). The first request was padded with synthetic filler to exactly that estimate and sent to Haiku:

| Filler | Bytes per token (measured) | Real tokens at an estimated 150k | Haiku (200k window) |
| --- | --- | --- | --- |
| English prose | 4.43 / 4.59 | 81k–84k | 200 |
| code | 3.05 / 3.11 | 119k–122k | 200 |
| this repository's `package-lock.json` | 2.69 | 139k | 200 |
| digits and punctuation | ~1.4 | 244k / 265k | **400** `prompt is too long` |

So a request made mostly of numeric or symbol-heavy text (data files, minified output) can be estimated under the ceiling and still exceed Haiku's window. Fail-open holds: the rejection triggers the retry with the original bytes. The cost is one rejected request. It used to also disable the Haiku tier for the session for 30 minutes, as for any rejected rewrite; a rejection whose message is `prompt is too long` (`isPromptTooLong`, `src/wire/anthropic.ts`) now only moves that loop back to the requested model. The retry's measured context is then recorded for the conversation, so its next turns are kept off Haiku by the ceiling check (`max(measured, estimated)`), not by the estimate alone. The estimate itself is unchanged: dividing by ~1.4 instead of 2.5 would keep prose conversations off Haiku from about 50k real tokens.

**Not tested:** histories near the 1M window of Sonnet, Opus or Fable, and Fable → Haiku with a thinking budget too small for `max_tokens` (retarget refuses that case itself: `thinking_budget_too_small`).

### 5.7 Opus 5.5 as the source (experiment, 2.1.280, capped at $0.50)

One `-p` session under the user's own settings, **no override**: model setting `opus[1m]`, effort `medium`, requested
model `claude-opus-5-5`, entrypoint `sdk-cli`, betas include `context-1m-2025-08-07` and `per-turn-control-2026-07-01`.
Flags `--to haiku,sonnet --main sonnet --lean --probe-message-oc --cap-usd 0.50`. Estimated cost **$0.52**: the cap
reserved 4 bytes/token for each request, the Opus 5.5 first request (35k tokens, all a 1-hour cache write, $0.29) needed
more, and the proxies now reserve at 2.5 bytes/token (`estimateTokens`). Results:
`test/fixtures/experiments/2.1.280/experiment.route-opus55-down.results.json`.

| Probe | Status | Rewritten fields |
| --- | --- | --- |
| first request → Haiku | 200 | `model`, `max_tokens` (128000 → 64000), `output_config.effort`, `thinking`, `messages.system_folded:1`, `anthropic-beta:-context-1m-…` |
| first request → Haiku, betas untouched | **400** `The long context beta is not yet available for this subscription.` | — |
| first request → Sonnet | 200 | `model`, `messages.output_config_dropped:1` |
| first request → Sonnet, system message's `output_config` kept | **400** `output_config.effort requires a model that supports per-turn effort; this model does not` | `model` |
| subagent first request → Haiku | 200 | as the first request |
| subagent → Sonnet, main and subagent continuations, un-pin | not run: refused by the cap | |

**What this settles.** An Opus 5.5 request asks for `max_tokens` 128000, which Haiku 4.5 rejects (`max_tokens: 128000 >
64000`, seen in the maintainer's route-mode log of 2026-09-22); `retarget` now lowers it to the target's
`MAX_OUTPUT_TOKENS` (`src/tiers.ts`). Like Fable 5.1, Opus 5.5 puts a per-turn `output_config` on its trailing system
message; Sonnet rejects its `effort`, so that key must go, and `retarget` removes only that key (the object goes when
effort was all it held, as in every request seen).

**What it does not.** No continuation with Opus 5.5 thinking in the history, no pinned loop and no un-pin were sent, so
every pair with `claude-opus-5-5` on either side stayed `rewrite_unverified` (`UNVERIFIED_MODELS`,
`src/wire/rewrite.ts`) until the follow-up below.

**Continuations (follow-up run, same settings, same day).** `--to haiku,sonnet --main sonnet --lean --no-main-new
--cap-usd 2.50`, one session with two subagents. Results:
`test/fixtures/experiments/2.1.280/experiment.route-opus55-continuations.results.json`, est. $0.94; three further
attempts (est. $0.59 together, not kept) tried to make Sonnet think before a tool call and did not.

| Probe | Haiku | Sonnet |
| --- | --- | --- |
| subagent first request (×2) | 200 ×2 | 200 ×2 |
| subagent pinned continuation | 200 | 200 |
| subagent un-pin to Opus 5.5 with target-made turns | 200 (one **Haiku-signed** thinking block) | 200 (no thinking block) |
| main continuation with an **Opus 5.5 thinking block** in the history | 200 | 200 |
| later main continuation, pinned | — | 200 |
| main un-pin to Opus 5.5 after Sonnet turns | — | 200 (the one thinking block is Opus 5.5's own) |
| history made by Opus 5.5 and Sonnet, sent to Haiku | 200 | — |

So **Opus 5.5 → Haiku is verified** (first request, subagent pin, a continuation holding Opus 5.5 thinking, un-pin
with Haiku-signed thinking). Sonnet produced no thinking block in any routed turn of these runs, so the Sonnet-signed
case was taken up by the next run.

**Upgrades into Opus 5.5, and Sonnet-signed thinking sent to it** (same settings, `--from sonnet|haiku --to opus
--delay-pin --no-main-new`, cap $1.50 each; est. $0.55 and $0.48). The Opus 5.5 main chat started a native Sonnet or
Haiku subagent through the Agent tool (its `model` parameter); `--delay-pin` let that subagent's first request through
unchanged, so its second request held the subagent model's own signed thinking. Results:
`experiment.route-sonnet-to-opus55-subagent.results.json`, `experiment.route-haiku-to-opus55-subagent.results.json`.

| Probe | Sonnet → Opus 5.5 | Haiku → Opus 5.5 |
| --- | --- | --- |
| subagent first request (no history) | 200 | 200 |
| second request, **source-signed thinking** in the history | 200 | 200 |
| pinned Opus 5.5 continuation (source- and Opus 5.5-signed thinking) | 200 | 200 |
| un-pin to the source with Opus 5.5-made thinking | 200 | 200 |

Only `model` changes for Sonnet → Opus 5.5 (`thinking` too for Haiku: budget → adaptive). The Sonnet row closes
the gap above: Opus 5.5 accepts a Sonnet-signed thinking block. The request the retry-with-original sends after an
Opus 5.5 → Sonnet pin (Opus 5.5's own bytes holding Sonnet-made turns) was not sent literally. Its parts were: Opus 5.5
accepting its own request shape, and accepting Sonnet-signed thinking. **Verified and applied:** Opus 5.5 ↔ Haiku and
Opus 5.5 ↔ Sonnet (`VERIFIED_MODEL_RETARGETS`, `src/wire/rewrite.ts`).

**Opus 5.5 ↔ Fable** (same settings; est. $1.71 + $0.53 + $0.34, caps $4.00 / $3.00 / $1.50). Opus 5.5 → Fable:
`--from opus --to fable --main fable --lean --no-main-new`. Fable → Opus 5.5: `--from fable --to opus --delay-pin
--no-main-new`, with a native Fable subagent (the Agent tool's `model: "fable"`). Results:
`experiment.route-opus55-to-fable.results.json`, `experiment.route-fable-to-opus55-subagent.results.json`,
`experiment.route-fable-to-opus55-subagent-thinking.results.json`.

| Probe | Opus 5.5 → Fable | Fable → Opus 5.5 |
| --- | --- | --- |
| subagent first request | 200 | 200 (×2, no history) |
| subagent pinned continuation | 200 | 200 |
| subagent un-pin to the source | 200 (no thinking block) | 200 (two **Opus 5.5-signed** thinking blocks) |
| main continuation with an **Opus 5.5 thinking block**, then pinned | 200, 200 | — |
| main un-pin to Opus 5.5 after Fable turns | 200 (the one thinking block is Opus 5.5's own) | — |
| second request holding a **Fable-signed** thinking block | — | 200 (probe and routed) |

Only `model` changes in either direction: both models take adaptive thinking, `effort` and a system message's
`output_config`, and `max_tokens` 128000. Fable produced no thinking block in any turn of the first two runs, so a
third run put a puzzle before the subagent's first tool call. Fable then thought, and Opus 5.5 accepted that
Fable-signed block. As for Sonnet above, the un-pin after an Opus 5.5 → Fable pin was not sent literally with
Fable-signed thinking in it: Opus 5.5 accepting its own request shape and accepting Fable-signed thinking were
verified separately. **Verified and applied** (Fable still needs `REFLEX_ALLOW_FABLE=1`). 

**Interactive Opus 5.5** (`experiment.route-opus55-interactive.results.json`, est. $1.39, cap $3.00). Every run above was
`-p` (`sdk-cli`), while real Opus 5.5 use is interactive: 814 of 823 Opus 5.5 records in the maintainer's log have
entrypoint `cli`. `--interactive 180 --to haiku,sonnet --main haiku --lean --no-main-new` ran the TUI in a
pseudo-terminal under the user's settings (`opus[1m]`, no `--model`), in this repository's folder: a new folder's trust
dialog now defaults to "No, exit". The request carried `cc_entrypoint=cli`, `redact-thinking-2026-02-12`,
`extended-cache-ttl-2025-04-11`, `context-1m-2025-08-07`, and `thinking` without `display`. All 200: the main
continuation holding Opus 5.5 thinking → Haiku and → Sonnet, subagent first requests → both (×2), pinned Haiku and
Sonnet loops (main and subagent), un-pin to Opus 5.5 with Haiku-made thinking (main, 2 blocks; subagent) and with
Sonnet-made turns (subagent), and a history made by Opus 5.5 and Haiku → Sonnet. The very first Opus 5.5 request got
a 429 from the API (not the cap) and Claude Code retried it.

**A Fable main chat → Opus 5.5** (`experiment.route-fable-main-to-opus55.results.json`, est. $1.15, cap $4.00). This
is a deliberate exception to the no-override rule, approved by the user as in §5.6: `--model fable` with the model setting
`opus[1m]`, since a Fable main chat cannot be produced otherwise. Flags `--from fable --to opus --main opus --lean`;
the prompt puts a puzzle before the first tool call so Fable thinks (525 thinking tokens). The first request to Opus 5.5,
the main continuation holding a **Fable-signed** thinking block, the pinned Opus 5.5 continuation, and un-pin to Fable
with Fable- and Opus 5.5-signed thinking in the history: all 200. Only `model` changes.

Route mode applies exactly the verified pairs: **every pair among Haiku, Sonnet, Opus 5 and Fable** (§5.1–5.6), every pair between Opus 5.5 and Haiku, Sonnet or Fable (§5.7), and every pair between Sonnet 5.5 and Haiku, Opus 5.5 or Fable (§5.12). Fable still needs `REFLEX_ALLOW_FABLE=1`, upgrades still need `REFLEX_UPGRADES=on` (or `confident`). Everything else is logged as `rewrite_unverified` and forwarded unchanged.

Model ids observed: `claude-sonnet-5`, `claude-haiku-4-5-20251001`.

### 5.8 Changing effort mid-conversation, same model (2.1.281)

**What Claude Code sends for `/effort`** (interactive, $0, against a local stand-in upstream; model setting `opus[1m]`,
requested model `claude-opus-5-5`). The first request carries the session's effort twice, as before: top-level
`output_config.effort` and on the `role:"system"` message at index 1. After `/effort low` the next request appends
`{"role":"system","content":[],"output_config":{"effort":"low"}}` directly after the new user message **and** sets the
top-level effort to `low`. Earlier effort messages stay in the history: after four changes it held
`high` (index 1), `low`, `max`, `medium`, each after the user message it was set before. The betas do not change
(`per-turn-control-2026-07-01`, `effort-2025-11-24`). `/effort` also writes the level into the user's
`~/.claude/settings.json` (`modelSettings.<model>.effortLevel`); a capture that types it must restore that file.

**What the API does with it** (`test/fixtures/experiments/2.1.281/experiment.effort-switch.results.json`, est. $0.94,
cap $2.00). One `-p` session under the user's own settings, no override (`opus[1m]`, effort `high`, entrypoint
`sdk-cli`), `route-experiment.mjs --from opus --to sonnet --probe-effort-switch`. The main chat stays on Opus 5.5;
the live requests do what reflex would do (append an effort message at the first continuation → `low`, at the third →
`max`, and re-insert every earlier one on later requests); probes at the first and second continuation. Cache counts
are tokens of a ~49k-token request:

| Request | Status | Cache read | Cache write |
| --- | --- | --- | --- |
| Opus 5.5, `high` → each of `low` `medium` `high` `xhigh` `max` (message + top-level) | 200 ×5 | 48,371–49,317 (all) | ≤ 946 (the new tail) |
| Opus 5.5, top-level effort only | 200 | 49,317 | 0 |
| Opus 5.5, effort message only | 200 | 49,317 | 0 |
| live: effort messages re-inserted on the next three requests (one more added at the third) | 200 ×3 | 49,726–49,930 | 0–728 |
| next request with the effort message **forgotten** (a history edit) | 200 | 49,317 (up to the removed message) | 409 |
| Sonnet 5, same request at the same effort (after a write) | 200 | 48,438 | 946 |
| Sonnet 5, same request, top-level effort `high` → `low` | 200 | **0** | **49,384** |

**What it settles.** On Opus 5.5 effort is not part of the cache key: any level, in either direction, keeps the cache,
with or without the message. Claude Code sends both, so reflex should too. Re-inserting
the effort messages keeps the prefix byte-identical; forgetting one is accepted (no preserved-thinking 400 on this
account) but loses the cache from the removed message on, which grows with every later turn. On **Sonnet 5 an effort
change rewrites the whole cache**, like a model switch (Sonnet takes no per-message effort, §5.6), so there it only
pays where the cache is being written anyway: a first request, or together with a model switch. Haiku takes no effort.
**Does the level take effect?** (`experiment.effort-apply.results.json`, est. $0.60 plus $0.23 for a first attempt
whose puzzle the model knew by heart, ~150 output tokens at every level.) Same setup, `--probe-effort-apply`: at the
first continuation a fixed synthetic puzzle (a recurrence mod 1009, answer 1006) is appended to the last user message
and each variant is answered in full, twice, `max_tokens` 16000. Output tokens (thinking included), client effort `high`:

| Variant | Output tokens (two runs) | Answer |
| --- | --- | --- |
| unchanged (`high`) | 1,844 / 1,900 | correct ×2 |
| top-level only → `low` | 1,827 / 1,616 | correct ×2 |
| top-level only → `max` | 2,060 / 1,707 | correct ×2 |
| effort message + top-level → `low` | 1,092 / 1,051 | correct ×2 |
| effort message + top-level → `max` | 4,704 / 5,487 | correct ×2 |

**The top-level value alone does nothing** while the system message at index 1 carries the client's effort; the
appended effort message is what changes the level (about −43% at `low`, +170% at `max` here). So a mid-conversation
change on Opus 5.5 needs the message, and with it the re-insertion on every later request. Anything that changes the
level therefore makes the history the model saw differ from Claude Code's transcript; if the effort messages are ever
left out (state lost, or the conversation continued without reflex), that is a history edit: accepted on this account,
unverified on accounts that the preserved-thinking check enforces (created on or after 2026-08-31).

**Opus 5, Fable 5.1 and Sonnet, and the preserved-thinking check** (`experiment.effort-verify-{1,2,3}` and
`experiment.effort-verify-set`, est. $5.7 in all; the first run's puzzle probes were malformed (a user message after
Claude Code's trailing system text message is a 400: "role 'system' must precede an 'assistant' message or end the
array") and are superseded by the second and third). Same `-p` setup, `--probe-effort-verify`; Opus 5 is the Opus 5.5
request with the model swapped, Fable the product's retarget, Sonnet likewise; the puzzle goes onto the last user
message. Single runs, all answers correct:

| Model | How | Cache on the change | Output tokens `low` / client (`high`) / `max` |
| --- | --- | --- | --- |
| Opus 5 | message only | kept (48,570 read); with the top-level value too: 13,628 rewritten | 1,556 / 2,354 / 2,676 |
| Fable 5.1 | message only | kept (48,570 read); with the top-level value too: 13,628 rewritten | 2,215 / 2,563 / 5,908 |
| Sonnet 5 | top-level | the whole prompt rewritten each time | 1,980 / 5,626 / 10,524 |

The check (`thinking.block_binding.prefix_mismatch_behavior`, beta `thinking-binding-controls-2026-08-01`, which opts
any account in), on Opus 5.5 with a thinking block produced after the change:

| Change | Sent as reflex sends it (`"error"`) | Left out (continued without reflex), `"error"` | Left out, `"drop_block"` |
| --- | --- | --- | --- |
| effort-only message **inserted** after the user message | 200 | **400** "Invalid `signature` in `thinking` block. The block is bound to a different conversation." | 200, `thinking_dropped` / `prefix_binding_mismatch` |
| level **set** on the turn's own effort-bearing system message | 200 | 200, nothing dropped | 200, nothing dropped |

An inserted message sitting after Claude Code's trailing system text message (first verify run) was left out without
a mismatch; treated as bound anyway. So an inserted message becomes part of what later thinking blocks are bound to;
a changed level on an existing message does not (it is still part of the cache key: left out, it costs one rewrite).
Without the controls this older account was not refused in any case.

**What Claude Code does with that 400** ($0, a local stand-in upstream answering the second main request with the
exact error): it resent the request with the thinking block removed from the history and carried on, no user
action. So on an enforced account a conversation continued without reflex after an insert loses its earlier thinking
blocks and one request, not the session.

**Where the level goes** (smoke runs through the built `reflex`, `REFLEX_TIERS=opus`, then `-p --continue` in a new
reflex process). A first request ends in Claude Code's system message carrying its own effort. Appending a second
effort message after it cost the next request ~11k tokens of cache and so did the resumed turn (read 33,310 / written
12,152, and 32,959 / 12,644, against 44,113 / 1,000 and 45,576 / 30 without `REFLEX_EFFORT`); changing that message's
level in place gave exactly the numbers of the run without `REFLEX_EFFORT` at every request. Claude Code does the
same itself when the level changes before a turn's system message is sent (the capture above).

`REFLEX_EFFORT=1` applies this (`src/wire/effort.ts`): a subagent's level goes into its first request's own
effort-bearing system message (`set`); the main chat changes only with `REFLEX_EFFORT_MIDTURN=1`, its first turn by
`set` and later turns as an appended effort-only message (`insert`), since a first-turn level alone would hold for the
whole chat. Opus 5.5 also gets the top-level value; Opus 5 and Fable do not; Sonnet gets the top-level value on a
subagent's first request only (a Sonnet main chat keeps its level). Every mark is re-applied from `~/.reflex/effort.jsonl` by the hash of Claude Code's own history up to it; the
hash ignores `cache_control` and treats a string and one text block alike (on the 2.1.281 capture the same messages
came back in both forms, and every re-application landed at its place).

**Fable and interactive sessions** (`experiment.effort-verify-set-fable`, est. $0.70: the live main chat retargeted
to Fable 5.1 with its first request's level `set`, Fable-signed thinking in the history). With the check on
(`"error"`), the level re-applied was accepted with the cache kept (49,072 read), and left out it was accepted too with
nothing dropped (a cache rewrite only), as on Opus 5.5. An interactive smoke run through the built `reflex`
(`REFLEX_EFFORT=1 REFLEX_EFFORT_MIDTURN=1`, entrypoint `cli`): the first turn `set` to `low`, its tool-loop requests
re-applied it (cache read 76,617 and 77,563), the second turn `insert`ed `medium` (read 77,972, written 37); all 200.

### 5.9 A resumed conversation requests the transcript's model (2.1.281, $0)

Claude Code writes the **response's** `message.model` into the transcript, and `--continue`/`--resume` (both `-p` and
interactive) request the model of the transcript's last turn, over the user's own `model` setting (`opus[1m]` here).
Measured against a loopback stand-in for the API that answers every request naming a model other than the one asked
for: the first turn asked for `claude-opus-5-5`, the resumed one for `claude-haiku-4-5-20251001` (tool list 43 → 47);
with the model echoed back unchanged the resumed turn asked for `claude-opus-5-5` again. Claude Code's own cost
figures (`modelUsage`, `total_cost_usd`) are keyed by the requested model either way. Interactive `--continue` does
not see sessions started with `-p`.

So a routed turn would carry on as the user's choice once the conversation is resumed, through reflex or without it.
When reflex retargets a request's model it asks the upstream for `accept-encoding: identity` and writes the client's
model back into `message_start` (`ModelRestorer`, src/wire/anthropic.ts), only for a `200` `text/event-stream` answer
with no `content-encoding` and no `content-length`; every other byte is relayed unchanged. End to end through the built
`reflex` (fake upstream and Jev, `reflex:haiku`): the turn went out as Haiku, and `claude -p --continue` without
reflex then asked for `claude-opus-5-5`.

### 5.10 MCP tool search behind reflex (2.1.282)

Claude Code turns MCP tool search off when `ANTHROPIC_BASE_URL` is not a first-party host ("[ToolSearch:optimistic]
disabled: ANTHROPIC_BASE_URL=… is not a first-party Anthropic host. Set ENABLE_TOOL_SEARCH=true (or auto / auto:N) if
your proxy forwards tool_reference blocks", in the 2.1.282 binary), so every reflex session up to 0.5.5 sent every MCP
tool schema, and every deferrable built-in, on every request. reflex now starts `claude` with `ENABLE_TOOL_SEARCH=true`
unless the user set it (src/launcher/launch.ts `proxyEnv`). The same binary turns it off for
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` whatever `ENABLE_TOOL_SEARCH` says; reflex warns at start. Per-model gating is
Claude Code's own: its default unsupported list is `claude-3-5-haiku`, `claude-3-haiku` (a remote flag may replace it).

What a request carries with tool search on (captures toolsearch-2.1.282, toolsearch-haiku-native,
toolsearch-fable-native; fixtures `2.1.282/toolsearch.*`):

- `anthropic-beta` gains `advanced-tool-use-2025-11-20` (first party; the binary names `tool-search-tool-2025-10-19`
  for gateway providers). Opus 5.5 and Fable 5.1 requests also carry `mid-conversation-tool-changes-2026-07-01`.
- `tools` holds `ToolSearch`, a `DeferredToolPlaceholder` with `defer_loading: true`, and deferred tools with
  `defer_loading: true`. A tool ToolSearch loads is appended to `tools` (still `defer_loading: true`).
- ToolSearch's result is a `tool_result` of `{type:"tool_reference", tool_name}` blocks, followed in the same message by
  one text block `Tool loaded.` per result (§4.2).
- On Opus 5.5 and Fable 5.1, a server's tools that become visible are announced in a `role:"system"` message with
  `{type:"tool_addition", tool:{type:"tool_reference", name}}` blocks, the last one carrying a cache breakpoint. A
  trailing system message `The following deferred tools are now available via ToolSearch…` also appears.
- Native Haiku 4.5 requests (Claude Code's own `model:"haiku"` subagent) carry `defer_loading` and `tool_reference`
  and answer 200, but no system message and no `tool_addition`.

What the API accepts when reflex retargets such a request (real sessions, 2026-09-25, `reflex:<tier>` override,
user's own settings `model: opus[1m]`, sdk-cli; results in `2.1.282/experiment.toolsearch-route.results.json`):

| Target | `role:"system"` | `tool_addition` | Evidence |
| --- | --- | --- | --- |
| Haiku 4.5 | no | no | 400 `messages.0.content: 'tool_addition'/'tool_removal' blocks are only permitted within role: "system" messages` (folded into a user message) |
| Sonnet 5 | yes | no | 400 `tool_addition/tool_removal is not supported on this model` |
| Opus 5.5 | yes | yes | Claude Code's own requests, 200 |
| Fable 5.1 | yes | yes | Claude Code's own requests (`model:"fable"` subagent), 200 |

So for Haiku and Sonnet reflex lifts each `tool_addition` out of the system messages and drops `defer_loading` from the
tool it names (the same visible set; native Haiku likewise sees loaded tools as entries in `tools`), moves a cache
breakpoint on a lifted block to the last block that stays, and drops a system message left empty
(`messages.tool_addition_lifted:N`, `tools.undeferred:N` in `forwarded.fields`). A `tool_removal`, never observed, or
any other non-text block in a system message leaves the request unrewritten. With the final code, 3 Sonnet sessions
and 1 Haiku session had blocks lifted and 1 more Haiku session had none to lift: every request routed, no fallback,
including `Tool loaded.` steps and `tool_reference` results (one session of each captured through a dump proxy behind
reflex: every rewritten request answered 200). Three Haiku sessions on intermediate code (lift for Haiku only) were
also accepted throughout. Lifting changes `tools` when
a server connects mid-session, which costs the target model one cache write from `tools` on, as appending a loaded
tool does natively.

**Claude Code 2.1.287 and later: `tool_addition` carries the definition.** From 2.1.287 every request (Sonnet 5.5,
`sdk-cli`) also sends the betas `mid-conversation-tool-changes-2026-07-01` and `inline-tools-2026-09-15`, and the
`tool_addition` blocks in the system message no longer name a deferred tool in `tools`: they hold the tool itself,
`{type:"tool_addition", tool:{type:"tool_definition", definition:{name, description, input_schema}}}` (fixtures
`2.1.287` to `2.1.292`, `print-agent.subagent-new-turn`, three MCP tools; the main chat's first request has no such
blocks). 2.1.286 and earlier send `tool:{type:"tool_reference", name}`. The lift reads both: a definition is appended to
`tools` as a plain tool in the order announced, unless that name is already listed (`tools.defined:N` in
`forwarded.fields`); a `tool_definition` with no name, or a request without `tools`, is left unrewritten. Before this
change such a request was unrewritable (`system_block_unfoldable`), so a subagent that announced MCP tools was never
routed; nothing failed, it ran on the model the client asked for. One `claude -p` session with a general-purpose
subagent (2.1.292, model setting `sonnet`, entrypoint `sdk-cli`, est. $0.17 at list prices):
the main chat's first request retargeted to Haiku, the subagent's first request retargeted with the lift
(`messages.tool_addition_lifted:3`, `tools.defined:3`, `messages.system_folded:1`), its pinned continuation, and the
same request sent back to Sonnet with Haiku-made turns in history: all 200, the new betas kept on the Haiku request
(`test/fixtures/experiments/2.1.292/experiment.route-sonnet55-to-haiku-subagent-inline-tools.results.json`). Not
measured: Haiku with a definition that the main chat announces, a `tool_removal`, Opus 5.5 or Fable 5.1 receiving
`tool_definition` blocks from a rewritten Sonnet request (they keep the blocks as sent), and cache behaviour after a
mid-session connect.

Context at start, interactive, same machine and settings (Claude Code's `/context`, before any prompt):

| Session | Total | MCP tools |
| --- | --- | --- |
| `claude`, no proxy | 32.5k | 641 tokens, deferred |
| reflex 0.5.5 | 66.9k | 23 tools, 9k tokens, loaded up front (built-in tools 43.2k) |
| reflex with `ENABLE_TOOL_SEARCH=true` | 32.4k | 12 tools, 726 tokens, "loaded on-demand" (built-in tools 16.9k) |
| same, with `ENABLE_TOOL_SEARCH=false` (environment, or `--settings` `env`) | 66.9k | 23 tools, 9k tokens |

First request of `claude -p "Reply with the single word ok." --output-format json` on Opus 5.5 (single runs; MCP
servers connect in the background, so it varies with timing): 28,376 input tokens without reflex, 44,456 behind reflex
0.5.5, 28,167 with the change. Runs that route mode sent to Haiku are excluded (another tokenizer).

### 5.11 Shapes Opus 5.5, Sonnet 5.5 and Fable 5.x reject (API documentation, not measured here)

Per Anthropic's API documentation (2026-09): Opus 5.5, Sonnet 5.5 and Fable 5.x return 400 on `thinking: {"type": "disabled"}` at
every effort level, and Opus 5.5, Sonnet 5.5 and Fable 5.1 on `tool_choice` `{"type": "any"}` / `{"type": "tool"}` ("tool_choice:
type \"tool\" and \"any\" are not supported for this model."). Neither has a rewrite that keeps its meaning (turning
thinking on, or dropping the forced tool), so a request carrying one is not retargeted to those models
(`src/wire/rewrite.ts`, `REJECTS_DISABLED_THINKING` / `REJECTS_FORCED_TOOL_CHOICE`) and goes to the model it asked for,
recorded as `rewrite_failed`. In the captures, Claude Code sends thinking disabled only on side calls (title generation,
`no_tools`), which reflex does not route, and never sends `tool_choice`.

### 5.12 Sonnet 5.5 (experiment, 2.1.284)

Est. $3.55 for the first twelve runs (cap $15), $1.17 for the Opus 5 pairs and $0.22 for the refusal runs through reflex.

Claude Code 2.1.284 resolves the `sonnet` alias to `claude-sonnet-5-5` (its baked-in model table: capabilities
`per_turn_effort`, `mid_conv_system`, `rejects_disabled_thinking`, `refusal_fallback`, `org_locked_thinking`, no
`mid_conv_tool_change`; default effort `medium`; `max_tokens` 128000). Every run below kept the user's own settings
(`opus[1m]`, effort `medium`, no `--model`) and reached Sonnet 5.5 either as a retarget target (`route-experiment.mjs
--model sonnet=claude-sonnet-5-5`) or as a native subagent the Opus 5.5 main chat started with the Agent tool's
`model: "sonnet"` / `"haiku"` / `"fable"` (`--delay-pin`). Results: `test/fixtures/experiments/2.1.284/`.

| Pair | First request | Pinned loop | Source-signed thinking in the history | Un-pin to the source |
| --- | --- | --- | --- | --- |
| Opus 5.5 → Sonnet 5.5 (`-p`, `route-opus55-to-sonnet55`, `-main`) | 200 | 200 (main and subagent) | 200 (Opus 5.5 block) | 200 |
| Opus 5.5 → Sonnet 5.5 (interactive, `cli`, `-interactive`) | 200 | 200 | 200 | 200; a history made by Opus 5.5 and Sonnet 5.5 → Haiku: 200 |
| Sonnet 5.5 → Haiku / Opus 5.5 / Fable 5.1 (`route-sonnet55-subagents`) | 200 ×3 | 200 ×3 | 200 ×3 (Sonnet 5.5 block) | 200 ×3 (Haiku- and Opus 5.5-signed blocks) |
| Haiku → Sonnet 5.5, Fable 5.1 → Sonnet 5.5 (`route-{haiku,fable}-to-sonnet55-subagent`) | 200, 200 | 200, 200 | 200, 200 (Haiku-, Fable-signed) | 200, 200 (Sonnet 5.5-signed) |
| Opus 5 → Sonnet 5.5 (`route-opus5-to-sonnet55`, `-main`) | 200 | 200 (main and subagent) | 200 (Opus 5 block) | 200; → Haiku: 200 |
| Sonnet 5.5 → Opus 5 (`route-sonnet55-to-opus5-subagent`, `-thinking`) | 200 | 200 | 200 (Sonnet 5.5 block) | 200 |

Only `model` changes towards Sonnet 5.5, plus the usual `tool_addition` lift (Sonnet 5.5 has no `mid_conv_tool_change`;
the lifted requests were accepted). Unlike Sonnet 5, Sonnet 5.5 **accepts a system message's per-turn `output_config`**
(first request with it kept: 200), so `retarget` keeps it for that model (`MESSAGE_OUTPUT_CONFIG_MODELS`). The Opus 5
rows had no `opus` alias to start from (it names Opus 5.5 on 2.1.284): `route-experiment.mjs --source-model
claude-opus-5` sent every Opus 5.5 request of the live session as `claude-opus-5`, a request shape Opus 5 accepts
(§5.8), so the session itself ran on Opus 5.

**Effort** (`effort-verify-sonnet55`, the Opus 5.5 first request retargeted to Sonnet 5.5; a fixed puzzle, answer 1006,
correct in every run). An appended effort message keeps the cache (18,481 read, 0 written) and changes the level:
output tokens 1,321 at `low`, 1,569 at the client's `medium`, 6,510 at `max`. The top-level value alone does not
(`max`: 1,190), and changing it with the message rewrote the messages cache (11,770 read, 6,711 written). So Sonnet
5.5 is handled like Opus 5 and Fable 5.1: the message, not the top-level value (`src/wire/effort.ts`).

**Preserved thinking** (`effort-verify-set-sonnet55`: the live chat retargeted to Sonnet 5.5, the first request's level
`set` to `low`, a Sonnet 5.5-signed thinking block after it). With `prefix_mismatch_behavior: "error"`, the level
re-applied was accepted with the cache kept (20,833 read); left out, it was accepted with a rewrite from the change on.
The positive control, a tool result before that thinking block edited, was **also accepted with nothing dropped**: this
account does not run the history-editing check on Sonnet 5.5 even with the controls beta, so these runs cannot show
what an enforced account does. reflex uses `set` there, as on Opus 5.5 where `set` was shown not to bind.

**Refusals.** Two runs whose prompt asked the model to work a puzzle out "carefully in your head" before a tool call
got `stop_reason: "refusal"`, category `reasoning_extraction`, from Sonnet 5.5
(`effort-verify-set-sonnet55-refusal`). Claude Code then resent the turn as a new request to `claude-opus-5-5`
(the requested model), which refused too, and exited 1; later requests carried `fallback-credit-2026-06-01`.

**What Claude Code sends after a refusal, and what the pin did with it** (the built reflex, a loopback Jev fixing
`sonnet`, `scripts/spike/token-compare/run.mts` with the puzzle prompt, behind `scripts/spike/dump-proxy.mjs`). The
refused response carries `stop_details` `{type: "refusal", category, explanation, fallback_credit_token,
fallback_has_prefill_claim}`. Claude Code then resends the same request to the model it asked for, with one text block
added to the last user message ("Your response above was stopped by a safety classifier — this is not a tool or API
error. …") and `fallback-credit-2026-06-01` in `anthropic-beta`; reflex classifies it as side `tool_result_text`. In 3
of 4 runs Sonnet 5.5 refused, and the pin sent that resend to Sonnet 5.5 again: refused again, `claude -p` exited 1.
Claude Code's own recovery was defeated. **Fixed:** the usage parser also reads the stop reason
(`src/wire/anthropic.ts`); when a request reflex moved to another model ends in `refusal`, the conversation's pin is
released while the stream is still passing (`src/worker/router.ts`), so the resend and the rest of the loop go to the
model the client asked for, which is every other fail-open path's outcome too. The record gets `refusal: {category,
pin_released}`. With that in place the sonnet tier default is `claude-sonnet-5-5`, Claude Code's own `sonnet`.

## 6. Responses

Plain SSE, `\n\n`-separated (no `\r\n` seen), events `message_start, content_block_start, ping, content_block_delta, content_block_stop, message_delta, message_stop`. The capture proxy drops `accept-encoding`, so compression was **not** observed. The interactive client offers `zstd`, which `node:zlib` cannot decode before Node 22.15, so reflex narrows `accept-encoding` toward the upstream to the client's own offer restricted to `gzip, br, deflate` (absent stays absent). A response in any other coding is relayed untouched and logged as `usage_unknown_reason: "encoding:<name>"`. `message_start.message.usage` has `input_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{…}, output_tokens, service_tier, inference_geo`; final usage is in `message_delta.usage` (adds `output_tokens_details`, `iterations[]`).

## 7. Hooks (delivered via `type:"http"` hooks injected with `--settings`)

- Delivery works; 204 empty-body responses are accepted silently.
- `session_id` == wire session id (**verified**). `prompt_id` present on every event; `UserPromptSubmit` carries `prompt`.
- Inside a subagent every tool event carries `agent_id` + `agent_type` (`"general-purpose"`).
- `SubagentStart`: `{session_id, transcript_path, cwd, prompt_id, agent_id, agent_type}` — **no `tool_use_id`, no prompt**. `SubagentStop` adds `permission_mode, effort, stop_hook_active, agent_transcript_path, last_assistant_message, background_tasks, session_crons` — **no `outcome` field**.
- **A failing Bash fires `PostToolUseFailure` only** (`error: "Exit code 1"`, `is_interrupt: false`); a passing one fires `PostToolUse` with `tool_response = {stdout, stderr, interrupted, isImage, noOutputExpected}`.
- Edit: `tool_input = {file_path, old_string, new_string, replace_all}`; `tool_response` includes `filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll`.
- Join keys: hook `agent_id` == request `x-claude-code-agent-id` → **exact attribution**, no FIFO needed.
- **`UserPromptSubmit` answered with `hookSpecificOutput.additionalContext`** (2.1.278, `-p`, entrypoint `sdk-cli`, observed 2026-09-19 against a local stand-in upstream; not kept as a fixture): the text does **not** go into the user message. The request is `[user: three reminder blocks + the typed prompt, system: the environment block]` and the hook text is appended at the end of that trailing `role:"system"` message (the `mid-conversation-system-*` beta), after a blank line, prefixed `UserPromptSubmit hook additional context: `. The classifier ignores `role:"system"` messages when it extracts the task, so the hint never reaches the decision backend or the prompt preview; a retarget that folds system messages carries it into the user message.

### `--settings` semantics
- Hooks from **different sources merge**: project `.claude/settings.json` command hooks and `--settings` http hooks both fired for the same events (5 tool events each, including the subagent's Glob).
- **Multiple `--settings` flags do not merge — the last wins wholesale.** With two flags, our hooks (first flag) never fired; the second flag's hook did. `ANTHROPIC_BASE_URL` still took effect via the process environment. Consequence: a user-supplied `--settings` must be merged into ours (or ours skipped), never added alongside.

## 7.1 Dynamic Workflow workers (2.1.278, `ultracode` keyword)

One interactive capture, Claude Code 2.1.278, `opus[1m]` + effort `medium`, permission mode `plan`, killed mid-workflow
(fixtures `ultracode.*`, 27 `/v1/messages` requests, 4 workers). What it establishes:

- **A workflow worker is an ordinary subagent on the wire.** Every worker request carries `x-claude-code-agent-id`
  **and** `cc_is_subagent=true` (S1); `You are an agent for Claude Code` (S2) is absent, as it is for the interactive
  Explore subagent. `parseRequest` classifies all 18 worker requests as `kind: "subagent"`, `signal: "header"` with no
  code change — **workflow workers need no new detection**.
- **Hook `agent_type` is `workflow-subagent`** (new value; §7 previously recorded only `general-purpose`). It is carried
  through as an opaque string, so nothing branches on it — see `KNOWN_AGENT_TYPES` in `src/wire/markers.ts`.
- **`SubagentStart` fires for each worker** (4 events, each with `agent_id`), and tool events carry the worker's
  `agent_id`, so the exact-attribution join of §7 holds. **`SubagentStop` was not observed — but the session was killed
  mid-workflow at the spend cap, so this is not evidence that it does not fire.**
- **Workers request the session's own model.** All 27 requests, main and worker alike, asked for `claude-opus-5` with
  `effort: "medium"` — the user's setting. The third-party claim that workers use a stock model regardless of the
  user's choice did **not** reproduce; the requested-tier logic needs no worker-specific baseline. (One main-chat
  `side`/`no_tools` call asked for `effort: "high"` against a `medium` session setting; harness side calls choose their
  own effort.)
- **Where the `ultracode` opt-in lands.** The harness appends `The user included the keyword "ultracode", opting this
  turn into multi-agent orchestration — use the Workflow tool to fulfill the request.` to the **trailing `role:"system"`
  message**, immediately **before** its closing `Today's date is …` line, and auto-loads the `workflow-authoring` skill
  into the user message. A `UserPromptSubmit` hint (§7) is appended to the **same** message, after a blank line,
  **after** the date line — so the two coexist in one system message, opt-in first, hint last. Worker requests do
  **not** carry the opt-in line.
- **The keyword is inert under `-p`.** With `-p` the `Workflow` tool is still in `tools` and `workflow-authoring` still
  loads, but the opt-in line is **absent** (verified against a local stand-in upstream, $0). An `ultracode` capture must
  drive a real pty.
- **New top-level body key `safeguards`** (2.1.278): `[{type: "dangerous_tool_use", classifier_context: {...}}]`,
  carrying `permission_mode`, `platform`, `live_cwd`, `home_dir`, `rule_roots` and `trusted_directories` — i.e.
  absolute paths and the home directory. reflex never parses or logs request bodies, so this changes nothing at
  runtime, but `redact-fixtures.mjs` copied it verbatim and leaked the home directory into candidate fixtures; it now
  scrubs every top-level key it does not redact explicitly.

## 7.2 Status line (2.1.280, interactive, $0)

Observed against a local stand-in upstream in a pseudo-terminal: a `statusLine` (`{type: "command", command}`) given
through `--settings` is used, and the command sees the session's `ANTHROPIC_BASE_URL`. Its stdin is one JSON object:
`session_id` (**equal to the requests' `x-claude-code-session-id`**, verified), `transcript_path`, `cwd`,
`scratchpad_dir`, `effort.level`, `model.id` / `model.display_name` (the model Claude Code asked for, e.g.
`claude-opus-5-5[1m]` / `Opus 5.5 (1M context)`, whatever reflex sent), `workspace.*`, `version`, `output_style.name`,
`cost.*`, `context_window.*`, `exceeds_200k_tokens`, `fast_mode`, `thinking.enabled`. reflex reads `session_id` only
(`src/wire/statusline.ts`). A new folder's trust dialog now defaults to "No, exit", so an interactive capture must run in
a trusted folder or select "Yes".

## 7.3 Subscription quota headers (2.1.277–2.1.281, subscription login)

Every `/v1/messages` response to a subscription-authenticated session carries `anthropic-ratelimit-unified-*` headers
(33 raw responses in the local captures, all four families; the committed fixtures list the names with values redacted,
e.g. `2.1.280/manifest.json`). Per window (`5h`, `7d`): `-<window>-utilization`, a fraction with two decimals
(`0.31`, i.e. **1% steps**), `-<window>-reset` (epoch seconds; constant across a window's requests) and
`-<window>-status` (`allowed` seen). A third window, `7d_oi`, appeared only on `claude-fable-5-1` responses (3 of 4;
none of 29 Opus/Sonnet/Haiku ones). Also sent: `-status`, `-reset`, `-representative-claim` (`five_hour`),
`-fallback`, `-fallback-percentage`, `-overage-status`, `-overage-disabled-reason`. The share is the account's: it
moves with usage outside reflex. The same responses carry `anthropic-organization-id`, so reflex never keeps the header
map: `src/wire/ratelimit.ts` reads each window's utilisation, reset and status word, and the decision record keeps
only `quota: {<window>: {util, reset}}` (not shared by `reflex share`).

## 8. Things that did NOT reproduce

- **MCP draft-04 normalisation** (jev-router): verified only **in scope**. The fixture `haiku-mcp-draft4.main-new-turn.request.json` contains the construct (`$schema` draft-04, `minimum:0 + exclusiveMinimum:true`, `maximum:10 + exclusiveMaximum:false`), Claude Code sent it **unchanged** through a custom base URL, and the API returned **200** (one request, `claude-haiku-4-5-20251001`, `sdk-cli`). Not tested: Sonnet/Opus/Fable as the target, other draft-04 constructs (`id`, `definitions`, type arrays), the interactive entrypoint. So the compat rewrite is *not currently required*, which is weaker than *not needed*; if routing ever retargets a request to a model that rejects the schema, the 4xx retry-with-original path is the safety net. Recorded in `manifest.json` under `findings`.
- `HEAD /` (prior art) — actually `HEAD /api/hello`.

## 9. Re-capturing for a new Claude Code version

```
node scripts/spike/capture.mjs --out _dumps/<name> -- -p "<prompt>" --output-format json …
node scripts/spike/summarize.mjs _dumps/<name>
REFLEX_REDACT_EXTRA="<email>,<username>" node scripts/spike/redact-fixtures.mjs _dumps/<name> --label <name>
```
`redact-fixtures.mjs` masks identifiers everywhere they occur, elides long prompt text while preserving the detection markers (and asserts they survive), and fails if any original identifier or common secret shape remains. Fixtures land in `test/fixtures/claude-code/<version>/` with a `manifest.json`; the startup version check (plan §3.1) compares the running `claude --version` with those directories.

## 10. Expected shape (checked at runtime)

The startup version check is only a hint. The worker therefore verifies the shape itself on the first N (default 10, `REFLEX_SHAPE_CHECK_N`) `new`/`continuation` requests of a session; side calls are never checked (they legitimately differ). Any violation degrades the session to shadow and logs `degraded_reason: "shape:<check>"` with the signal booleans (never request content). All expectations below hold for every fixture (`test/unit/wire-contract.test.ts`), and each mutated fixture trips exactly its check (`test/unit/wire.test.ts`):

| Check | Expected |
| --- | --- |
| `session_id` | `x-claude-code-session-id` present, or `metadata.user_id` parses to JSON with `session_id`; when both exist they are equal |
| `client_identity` | system text contains `x-anthropic-billing-header:` |
| `subagent_signals` | header `x-claude-code-agent-id` present ⇔ `cc_is_subagent=true` present; the optional agent-prompt marker, when seen, only on a subagent |
| `system_messages_beta` | `role:"system"` messages present ⇒ the `mid-conversation-system-*` beta is present (one-way: side calls carry the beta without system messages) |
| `turn_structure` | at least one non-system message, and the last one has `role:"user"` |

Dropped after the interactive capture: "main-chat requests carry `extended-cache-ttl-*`" (the compaction request lacks it, which would have degraded normal sessions).

The version check is separate and only ever a hint: same major, different minor/patch → warn; different major → degrade to shadow; unparseable → warn. Passing assertions on an unknown minor version continue normally; failing assertions on a matching version still degrade.
