// Every string reflex relies on to recognise Claude Code traffic, in one place. None of this is a public contract:
// each entry names the fixture (test/fixtures/claude-code/<version>/) where it was observed, and the contract tests
// fail when a fixture stops matching.

/** Request headers. */
export const HEADER_SESSION_ID = "x-claude-code-session-id"; // every request; == metadata.user_id.session_id == hook session_id
export const HEADER_AGENT_ID = "x-claude-code-agent-id"; // subagent requests only; == hook agent_id (sonnet-agent-run.subagent-*, interactive.subagent-*)
export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-"; // prefix; 1-hour cache writes (main chat, not subagents, not compaction)

/** `user-agent: claude-cli/2.1.277 (external, cli)`. The HEAD /api/hello probe carries `Bun/…` instead. */
export const USER_AGENT_VERSION = /^claude-cli\/(\d+\.\d+\.\d+)/;

/**
 * `agent_type` values seen on subagent hook events. Informational only: nothing branches on this, because a Dynamic
 * Workflow worker is already a subagent by both the header and S1 (2.1.278 capture, `ultracode.hooks.jsonl`).
 * Recorded so a future value is recognised as new rather than silently assumed to be `general-purpose`.
 */
export const KNOWN_AGENT_TYPES = ["general-purpose", "workflow-subagent"] as const;

/** System-prompt markers. S1 is set by the harness for every subagent; S2 is the built-in general-purpose agent's
 * prompt and is OPTIONAL (absent on the interactive Explore subagent): never required, logged when seen. */
export const MARKER_BILLING = "x-anthropic-billing-header:"; // S3: the client is Claude Code
export const MARKER_SUBAGENT = "cc_is_subagent=true"; // S1
export const MARKER_AGENT_PROMPT = "You are an agent for Claude Code"; // S2 (optional)
export const BILLING_ENTRYPOINT = /cc_entrypoint=([^;\s]+)/;

/** Wrappers the harness puts around text that is not the user's own prompt. Stripped before judging a turn. */
export const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** Claude Code wraps pasted text as `<pasted_content id="…">…</pasted_content id="…">`; the tags go, the text stays. */
export const PASTED_CONTENT_TAG = /<\/?pasted_content(?:\s+id="[^"]*")?\s*>/g;
/**
 * Claude Code's wrapper for a prompt the user typed WHILE a tool loop was running (a "queued command"). It arrives
 * inside a `<system-reminder>` in the next request of the running turn, alongside the tool results, instead of as a
 * turn of its own — so every reminder-stripping rule drops it and the user's words vanish from the wire.
 *
 * Evidence: session 805b3287 (2026-09-19T21:28:07.672Z), Claude Code 2.1.278. The transcript records the attachment as
 * `{type: "queued_command", origin: {kind: "human"}, humanTurn: true}` and renders it as, verbatim:
 *
 *   <system-reminder>
 *   The user sent a new message while you were working:
 *   <pasted_content id="805b">
 *   Run the test suite and the link check.
 *   </pasted_content id="805b">
 *
 *   This is how Claude Code surfaces messages the user sends mid-turn - within the running turn, often alongside the
 *   next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.
 *   </system-reminder>
 *
 * The opening line is the marker; the trailer ends the user's text. Both are matched leniently (the trailer's dash is
 * an em dash in the observed text and is not relied on).
 */
export const QUEUED_MESSAGE_MARKER = "The user sent a new message while you were working:";
export const QUEUED_MESSAGE_TRAILER = "This is how Claude Code surfaces messages the user sends mid-turn";

/**
 * MCP tool search (2.1.282, toolsearch.main-continuation-tool-loaded): the tool-loop step after a ToolSearch that loaded
 * tools carries this harness text beside the tool_result of `tool_reference` blocks. Only recognised next to such a
 * result, so a user who types exactly these words anywhere else is unaffected.
 */
export const TOOL_LOADED_TEXT = "Tool loaded.";
export const LOCAL_COMMAND_BLOCK = /<(local-command-caveat|local-command-stdout|local-command-stderr|command-name|command-message|command-args)>[\s\S]*?<\/\1>/g;

/**
 * `tool_result_text` is the one kind with no marker: it is recognised by shape alone (last user message carries tool
 * results AND text that is neither a harness reminder nor a prompt the user typed). See classifyTurn.
 */
export type SideKind = "no_tools" | "suggestion" | "agent_summary" | "compaction" | "cross_session" | "notification" | "tool_result_text" | "unclassified";

/** The side kinds recognised by a text marker in the last message. */
export type MarkedSideKind = Exclude<SideKind, "no_tools" | "tool_result_text" | "unclassified">;

/**
 * Harness-generated requests that carry the full tool list and look like turns. Matched ONLY against the last
 * non-system message (these texts stay in the history and reappear in later requests).
 */
export const SIDE_MARKERS: readonly { readonly id: string; readonly kind: MarkedSideKind; readonly text: string; readonly evidence: string }[] = [
  { id: "suggestion", kind: "suggestion", text: "[SUGGESTION MODE:", evidence: "interactive.main-suggestion" },
  { id: "agent_summary", kind: "agent_summary", text: "Describe your most recent action", evidence: "interactive.subagent-summary" },
  { id: "compaction", kind: "compaction", text: "CRITICAL: Respond with TEXT ONLY", evidence: "interactive.main-compaction" },
  { id: "cross_session", kind: "cross_session", text: "Another Claude session sent a message:", evidence: "interactive.main-cross-session" },
  // Two different features share the `notification` kind; only the recap has a user-facing switch, so they are told
  // apart by marker id, not by kind.
  { id: "task_notification", kind: "notification", text: "[SYSTEM NOTIFICATION - NOT USER INPUT]", evidence: "interactive.main-notification" },
  // Claude Code's AFK "session recap": the user stepped away, the harness asks for a <=40-word catch-up. Arrives as a
  // plain-string content, so it reaches the marker scan through blocksOf. NOT CAPTURED: no fixture has this body. The
  // text is the redacted 80-code-point fingerprint head of two such calls in the maintainer's 2.1.278 route-mode log
  // of 2026-09-19 (side_fingerprint.head, both `messages` 78 and 242, last content a 253-character string); the
  // marker is the part of that head before the template fills in. See 2.1.278 manifest `gaps`.
  { id: "session_recap", kind: "notification", text: "The user stepped away and is coming back.", evidence: "2.1.278 route-mode log 2026-09-19 (fingerprint head); uncaptured, see 2.1.278 manifest gaps" },
];

/**
 * A subagent's report handed back into the main chat arrives as a UserPromptSubmit prompt too. Used only to keep the
 * delegation hint off it (isTypedPrompt); outcome capture does not use it yet.
 */
export const HANDBACK_PROMPT_PREFIX = { text: "<agent-message ", evidence: "interactive.hooks.jsonl: UserPromptSubmit prompt `<agent-message from=\"AGENT-1\">` [Subagent hand-back]" } as const;

/**
 * Texts that start a `UserPromptSubmit.prompt` Claude Code injected itself (hooks fire for these too): the wire's side
 * markers, plus the hook-side form of a background task notification.
 */
export const INJECTED_PROMPT_MARKERS: readonly { readonly id: string; readonly kind: MarkedSideKind; readonly text: string; readonly evidence: string }[] = [
  ...SIDE_MARKERS,
  { id: "task_notification", kind: "notification", text: "<task-notification>", evidence: "M4 acceptance session 2, seq 6: hook prompt; transcript origin task_notification; wire side/notification" },
];
