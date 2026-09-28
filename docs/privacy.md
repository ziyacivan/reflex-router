# Privacy: what reflex sends and stores

## Sent to the decision backend (TypeSafe Jev, or Laya on this machine)

With `REFLEX_BACKEND=laya` the same request goes to a `laya-serve` that reflex started on `127.0.0.1` for this session, with a per-session key and `HF_HUB_OFFLINE=1`; it does not leave the machine, and no TypeSafe key is used ([reference](reference.md#laya-decisions-on-this-machine)). Everything below about content and limits applies unchanged. With `REFLEX_COMPARE=laya` the same state goes to Jev and to that local `laya-serve`; the decision record gains only numbers from Laya (a feature vector), never text.

Only for a request positively identified as the start of work (a user-typed main-chat prompt, or a subagent's first request; see `docs/wire-format.md` §4). Tool-loop steps, harness side calls and anything unclassified are never sent.

The request body is `{ state, model, questions }`. `questions` is fixed text from `src/policy.ts`. `state` has exactly these keys (asserted by `test/unit/privacy.test.ts` and `test/integration/shadow.test.ts`):

| Key | Content | Limit |
| --- | --- | --- |
| `task` | the user's prompt (or the subagent's delegation prompt), with harness reminders and local-command wrappers removed | `REFLEX_MAX_USER_CHARS` (default 4000), head + tail |
| `previous_assistant_reply` | main chat only: text of the assistant message just before the prompt | `REFLEX_MAX_ASSISTANT_CHARS` (default 1000), tail |
| `context.requesting_tier` | `haiku` / `sonnet` / `opus` / `fable` / `unknown`, derived from the requested model id | — |
| `context.is_subagent` | boolean | — |

When the worker starts in shadow or route mode it also sends one bare `HEAD /` to the TypeSafe host to open the connection early; it carries no key and no data.

Nothing else: no system prompt, tool list, file contents from tool results, session/agent/device/account ids, headers, paths as separate fields, or Anthropic credentials. The TypeSafe key travels only in the `Authorization` header to the TypeSafe endpoint.

Text is truncated first, then redacted (`src/privacy/redact.ts`): TypeSafe, Anthropic and other `sk-` keys, AWS access keys, GitHub/Slack/Google tokens, JWTs, PEM private keys, `Authorization`/`Bearer` values, the value of every `.env`-style `NAME=value` line, and home-directory prefixes (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>` become `~`). This is best effort, not a guarantee; entropy-based detection is deliberately not attempted because false positives would corrupt the task text.

## Stored locally

`~/.reflex/` (`REFLEX_HOME`): directory `0700`, files `0600`, rotated at 10 MB × 5.

`effort.jsonl` (only once `REFLEX_EFFORT=1` has changed a level) holds one line per level reflex put into a conversation: a SHA-256 of the conversation history up to that point, the level, whether it changed an existing message or added one (`op`), and a timestamp. No text.

`decisions.jsonl` holds one record per classified `POST /v1/messages` request: classification, signals, mode, the backend's answers and the would-be plan, upstream status, token usage, error categories, and the subscription quota the response reported (per window, the used share and its reset time: numbers only; the rest of the response headers, which identify the account, are never kept, and `reflex share` leaves the quota out). Session ids are stored hashed (SHA-256, truncated); conversation keys are hashes. For decided requests it also stores `prompt_preview`: the redacted task, whitespace-collapsed, capped at 300 characters by a constant in the logger. The preview is **off by default** (revisited 2026-09-20; it was on through the pre-release versions); `REFLEX_LOG_PROMPTS=1` turns it on so decisions can be reviewed. When on, redaction removes secrets and home-directory prefixes, not project-relative paths or the user's own words. Apart from the preview, the log holds no user text: the only other free-text field is `forwarded.fallback_error`, the upstream's own (redacted) error message for a rejected rewrite.

A side call the classifier could not name (`turn: side`, `side_kind: unclassified`) also gets `side_fingerprint` (`src/wire/fingerprint.ts`), so it can be sent back and given a side kind: message count and roles in order, tool count, whether tool results or `role: "system"` messages occur, the last message's block types and text length, `max_tokens`, the thinking type, the effort, the stream flag and the `anthropic-beta` list. No tool names and no system-prompt text. The one piece of text is the opening of the last message (at most 80 characters, only its first line up to the first colon, redacted), and only when it looks like harness text and matches none of the user-text heuristics; otherwise `head` is null and `head_omitted` names the heuristic. Those heuristics drop the text when the session has delivered no `UserPromptSubmit` yet, when it overlaps a prompt typed in the session (compared in memory against the hook payloads, which are never written), when it carries pasted-content or local-command wrappers or an image or document, and when its opening starts with anything but `<tag`, `[` or an ASCII capital letter, contains non-ASCII characters, speaks in the first person, or names a path, file, URL or e-mail address. `reflex report --fingerprints` prints them, grouped, as JSON lines.

Never stored: request or response bodies, credentials, backend error bodies.

## Hook events (outcome capture)

In `shadow` and `route` mode reflex registers Claude Code `http` hooks (`UserPromptSubmit`, `PreToolUse` for the Agent tool only, `PostToolUse` and `PostToolUseFailure` for Edit/Write/MultiEdit/NotebookEdit/Bash only, `SubagentStart`, `SubagentStop`, `Stop`) in its per-invocation `--settings` file. They go to the loopback front door, which answers `204` at once (after a main-chat model change, the next main-chat hook carries a `systemMessage` naming the two models, shown to you only; with `REFLEX_DELEGATE=1`, a typed prompt's `UserPromptSubmit` is answered with the fixed hint instead; see "Sent to Anthropic"). Their payloads contain prompts, commands, file paths and edited text; these stay in the worker's memory for a few turns (to compare the next prompt and to detect reverted edits, using hashes of the edited text) and are never written or sent anywhere. A subagent's title (the Agent call's `description`) is kept in memory for the status line only. What is written to `decisions.jsonl` (`record: "outcome"`, `"outcome_update"`, `"harness_injected"`): hashed session, prompt and agent ids, hashed file paths, counts, the matched correction rule ids and their score, test-runner kinds (e.g. `npm-test`) with exit codes, and revert kinds. No prompt text, commands, paths or code.

## Configuration file and reports

`~/.reflex/env` (in `REFLEX_HOME`) may hold `TYPESAFE_API_KEY` and `REFLEX_*` settings. It is read by the launcher only, its values are never logged, warnings about it name lines and variables but never values, `reflex doctor` shows the key as `(set, not shown)`, and the key is removed from the environment `claude` gets like any other `TYPESAFE_*` variable. A file that holds the key and is readable by group or others is refused whole (permissions are not checked on Windows). Only `REFLEX_*` and `TYPESAFE_API_KEY` are read from it: it is never a way to give reflex, or forward, Anthropic credentials.

With `REFLEX_DELEGATE=1`, each delivered delegation hint adds a `record: "delegate_hint"` holding only the hashed session, the time and the hint version; every decision record carries `delegate_hint` (the version, or null).

`reflex report` reads `decisions.jsonl` (and rotations, or the files you name), makes no network request and writes nothing. It prints counts, tiers, latencies, rule ids and, for rejected rewrites, the upstream's error text as logged (redacted, at most 100 characters shown); it does not print `prompt_preview`.

## Sent to Anthropic

The client's request with its own headers. The one header reflex changes is `accept-encoding`, narrowed to the codings it can decode (`gzip`, `br`, `deflate`). In `shadow` mode the body is sent byte for byte. In `route` mode a routed request's body is rewritten for the target model (model id, reasoning settings, `role:"system"` messages folded into user messages; `src/wire/rewrite.ts`) and the changed fields are listed in its decision record. No text is added, removed or edited; system-message text is only moved into the adjacent user message. No `REFLEX_*` or `TYPESAFE_*` value ever reaches the upstream.

One opt-in exception adds text, and it is Claude Code that adds it: with `REFLEX_DELEGATE=1` reflex answers the `UserPromptSubmit` hook of each prompt you type with the fixed delegation hint in `src/delegate/hint.ts` (about three lines, no data from your session), which Claude Code includes as context for that turn. reflex does not edit the request body to do this.
