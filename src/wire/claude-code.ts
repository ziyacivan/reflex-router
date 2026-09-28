// The ONLY module that reads Claude Code request bodies. parseRequest() turns raw bytes into a RequestView: who sent
// it (main chat / subagent), what kind of turn it is, and the text a decision would be based on. It never throws and
// never mutates or re-serialises the body. Evidence for every rule: docs/wire-format.md and the fixture manifest.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  BETA_EXTENDED_CACHE_TTL, BETA_MID_CONVERSATION_SYSTEM, BILLING_ENTRYPOINT, HANDBACK_PROMPT_PREFIX, HEADER_AGENT_ID, HEADER_SESSION_ID, LOCAL_COMMAND_BLOCK,
  INJECTED_PROMPT_MARKERS, MARKER_AGENT_PROMPT, MARKER_BILLING, MARKER_SUBAGENT, PASTED_CONTENT_TAG, QUEUED_MESSAGE_MARKER, QUEUED_MESSAGE_TRAILER, SIDE_MARKERS, SYSTEM_REMINDER, TOOL_LOADED_TEXT, USER_AGENT_VERSION, type SideKind,
} from "./markers.js";
import { matchesTypedPrompt } from "./typed-prompt.js";

export type RequestKind = "main" | "subagent" | "unknown";
/** Which signal classified a subagent. Header first; the system-prompt markers are the fallback. */
export type KindSignal = "header" | "marker:cc_is_subagent" | "marker:agent_prompt" | "none";
/**
 * new          a positively identified start of work: a user-typed main-chat prompt, or a subagent's first request
 * continuation a tool-loop step (the last message carries tool results, and at most harness reminders or a message the
 *              user typed mid-loop — an interjection, which stays on the turn's pin and is never decided again)
 * side         everything else: harness side calls, notifications, anything not positively identified. Never decided.
 */
export type Turn = "new" | "continuation" | "side";

export interface Signals {
  /** x-claude-code-agent-id present. */
  readonly header: boolean;
  /** cc_is_subagent=true in the system prompt. */
  readonly s1: boolean;
  /** "You are an agent for Claude Code" in the system prompt (optional marker). */
  readonly s2: boolean;
  /** x-anthropic-billing-header: in the system prompt (Claude Code client). */
  readonly s3: boolean;
}

/** Raw structural facts, used by the shape assertions. No content. */
export interface ShapeFacts {
  readonly headerSessionId: string | null;
  readonly metadataSessionId: string | null;
  readonly systemMessages: number;
  readonly nonSystemMessages: number;
  readonly lastNonSystemRole: string | null;
  readonly betaMidConversationSystem: boolean;
  readonly betaExtendedCacheTtl: boolean;
  /** TTL of the request's last cache breakpoint (the one that caches the whole prefix); null: none, or a TTL not known here. */
  readonly cacheTtl: CacheTtl | null;
  readonly maxTokens: number | null;
}

export type CacheTtl = "5m" | "1h";

export interface RequestView {
  readonly sessionId: string | null;
  readonly agentId: string | null;
  readonly kind: RequestKind;
  readonly signal: KindSignal;
  readonly signals: Signals;
  readonly turn: Turn;
  readonly sideKind: SideKind | null;
  /** Which harness marker named this side call, when one did; null when the kind came from shape alone. */
  readonly sideMarker: string | null;
  /** `sideKind: "unclassified"` only: which shape test produced the residual, so the bucket can be read apart. */
  readonly unclassifiedReason: UnclassifiedReason | null;
  /** `continuation` only: the tool results arrived with a message the user typed mid-loop. */
  readonly interjection: boolean;
  /**
   * `new` turns only (null otherwise): how the prompt's own message carried its content. The two known Claude Code
   * versions disagree — 2.1.277 sent every typed prompt as an array of blocks, 2.1.278 sends plain strings too — and
   * once a turn is recognised the two leave identical records, so this is the only way to tell them apart in a log.
   */
  readonly promptEncoding: PromptEncoding | null;
  readonly entrypoint: string | null;
  /** claude-cli/<version> from the user-agent, the version of the client that actually talks to us. */
  readonly clientVersion: string | null;
  readonly requestedModel: string | null;
  readonly requestedEffort: string | null;
  readonly toolCount: number;
  /** Stable per conversation: main chat = session + first message text; subagent = session + agent id. */
  readonly convKey: string | null;
  /** The user's (or, for a subagent, the delegating agent's) own text for a `new` turn; null otherwise. */
  readonly task: string | null;
  /** Text of the assistant message right before a main-chat `new` turn; null otherwise. */
  readonly previousAssistantText: string | null;
  readonly facts: ShapeFacts;
}

export type ParseResult = { readonly ok: true; readonly view: RequestView } | { readonly ok: false; readonly reason: "not_json" | "not_object" };

/**
 * Side calls that replay their conversation and whose answer belongs to it, so they go where the conversation's pin
 * sends it (never decided): a subagent's progress summary, a tool-loop step carrying harness text, and a task
 * notification or subagent hand-back (`cross_session`) the chat answers as a turn of its own (Claude Code transcripts,
 * 2026-09-25: 92 of 99 and 45 of 46 answered in the main chat).
 */
export const followsPin = (v: Pick<RequestView, "sideKind" | "sideMarker">): boolean =>
  v.sideKind === "agent_summary" || v.sideKind === "tool_result_text" || v.sideKind === "cross_session" || v.sideMarker === "task_notification";

/** `POST /v1/messages` (any query string). Everything else, including count_tokens, is never classified. */
export function isMessagesRequest(method: string, url: string): boolean {
  return method === "POST" && url.split("?")[0] === "/v1/messages";
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const header = (h: IncomingHttpHeaders, name: string): string | null => {
  const v = h[name];
  return typeof v === "string" ? v : Array.isArray(v) ? (v[0] ?? null) : null;
};

interface Block {
  readonly type: string;
  readonly text: string | null;
}
/** Content as blocks; a plain-string content becomes one text block. */
const blocksOf = (m: Json): Block[] => {
  const c = m["content"];
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  return c.filter(isObj).map((b) => ({ type: str(b["type"]) ?? "unknown", text: str(b["text"]) }));
};
/** The harness sends each reminder as its own text block starting with the tag; inline ones are stripped too. */
const isReminderOnly = (t: string): boolean => t.trimStart().startsWith("<system-reminder>") || t.replace(SYSTEM_REMINDER, "").trim() === "";
/** True when a tool_result in the message holds a `tool_reference` block (what ToolSearch returns). */
const hasToolReferenceResult = (m: Json): boolean =>
  Array.isArray(m["content"]) && m["content"].some((b) => isObj(b) && b["type"] === "tool_result" && Array.isArray(b["content"]) && b["content"].some((c) => isObj(c) && c["type"] === "tool_reference"));
/** The user's own words: reminder blocks dropped, inline reminders and local-command wrappers removed, pasted-content tags unwrapped. */
const ownText = (blocks: readonly Block[]): string =>
  blocks
    .filter((b) => b.type === "text" && b.text !== null && !isReminderOnly(b.text))
    .map((b) => (b.text ?? "").replace(SYSTEM_REMINDER, "").replace(LOCAL_COMMAND_BLOCK, "").replace(PASTED_CONTENT_TAG, "").trim())
    .filter(Boolean)
    .join("\n\n");

/**
 * The user's own words inside Claude Code's "queued command" reminder, or null when this text is not one. A prompt
 * typed during a running tool loop is delivered in that wrapper, inside the tool-loop request, so `ownText` drops it
 * with every other reminder and the turn reads as an ordinary continuation. Pulling the text back out is what lets the
 * interjection test see it (and, through the tracker, lets it score as a correction of the turn it interrupted).
 *
 * Deliberately narrow: only the text between the marker line and the trailer is returned, so the harness's own
 * explanation never reaches the match. Returning it is not enough to promote anything - the caller still has to match
 * it against a prompt the hook stream says the user typed.
 */
export function queuedMessageText(text: string): string | null {
  const at = text.indexOf(QUEUED_MESSAGE_MARKER);
  if (at === -1) return null;
  const rest = text.slice(at + QUEUED_MESSAGE_MARKER.length);
  const end = rest.indexOf(QUEUED_MESSAGE_TRAILER);
  const inner = (end === -1 ? rest : rest.slice(0, end)).replace("</system-reminder>", "");
  const own = inner.replace(PASTED_CONTENT_TAG, "").trim();
  return own === "" ? null : own;
}

/** Every queued-command message in this message's blocks, newest-first order preserved. */
const queuedMessages = (blocks: readonly Block[]): string[] =>
  blocks.filter((b) => b.type === "text" && b.text !== null).map((b) => queuedMessageText(b.text ?? "")).filter((t): t is string => t !== null);

/** How a message carried its `content`: a plain string, an array of blocks, or neither. */
export type PromptEncoding = "string" | "blocks" | "other";
const contentEncoding = (m: Json | undefined): PromptEncoding =>
  m === undefined ? "other" : typeof m["content"] === "string" ? "string" : Array.isArray(m["content"]) ? "blocks" : "other";

const systemText = (body: Json): string => {
  const s = body["system"];
  if (typeof s === "string") return s;
  if (Array.isArray(s)) return s.filter(isObj).map((b) => str(b["text"]) ?? "").join("\n");
  return "";
};

const metadataSessionId = (body: Json): string | null => {
  const md = body["metadata"];
  const raw = isObj(md) ? str(md["user_id"]) : null;
  if (raw === null) return null;
  try {
    const o: unknown = JSON.parse(raw);
    return isObj(o) ? str(o["session_id"]) : null;
  } catch {
    return null;
  }
};

const sha = (s: string): string => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * Which shape test sent a request to the `unclassified` residual. `unclassified` is not one thing: it is everything not
 * positively identified, and section 11 has to tell an unknown harness shape from a typed prompt whose hook was missed.
 * - not_user_message          no last non-system message, or it is not role `user`
 * - plain_string_no_typed_match  content is a plain string and no UserPromptSubmit prompt matches it (see classifyTurn)
 * - non_text_block            a block that is not text (image, document): not handled yet
 * - no_own_text               nothing left after reminders and harness wrappers are stripped
 * - subagent_mid_run          a subagent text message that is not its first request, so not a new task
 * - no_typed_prompt           a main-chat user message in a session whose hooks are arriving, with no typed prompt
 *                             behind it (see classifyTurn)
 */
export type UnclassifiedReason =
  | "not_user_message" | "plain_string_no_typed_match" | "non_text_block" | "no_own_text" | "subagent_mid_run" | "no_typed_prompt";

interface TurnResult {
  readonly turn: Turn;
  readonly sideKind: SideKind | null;
  /** Which SIDE_MARKERS entry matched, when one did: two features can share a side kind (src/wire/markers.ts). */
  readonly sideMarker: string | null;
  /** Only ever set alongside `sideKind: "unclassified"`: which shape test produced the residual. */
  readonly unclassifiedReason: UnclassifiedReason | null;
  readonly task: string | null;
  /** A continuation whose tool results arrived with a message the user typed mid-loop. Never true off a continuation. */
  readonly interjection: boolean;
}
const side = (k: SideKind, marker: string | null = null): TurnResult => ({ turn: "side", sideKind: k, sideMarker: marker, unclassifiedReason: null, task: null, interjection: false });
const unclassified = (reason: UnclassifiedReason): TurnResult => ({ turn: "side", sideKind: "unclassified", sideMarker: null, unclassifiedReason: reason, task: null, interjection: false });
const continuation = (interjection: boolean): TurnResult => ({ turn: "continuation", sideKind: null, sideMarker: null, unclassifiedReason: null, task: null, interjection });

/**
 * Pure. Anything not positively identified as a user turn or a tool-loop step is `side`.
 * `typed`: prompts UserPromptSubmit delivered in this session (memory only), or null when none has arrived.
 */
function classifyTurn(nonSystem: readonly Json[], toolCount: number, kind: RequestKind, typed: readonly string[] | null, newestTyped: string | null): TurnResult {
  if (toolCount === 0) return side("no_tools");
  const last = nonSystem.at(-1);
  if (!last || last["role"] !== "user") return unclassified("not_user_message");
  const blocks = blocksOf(last);
  const texts = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "");
  for (const m of SIDE_MARKERS) if (texts.some((t) => t.includes(m.text))) return side(m.kind, m.id);

  if (blocks.some((b) => b.type === "tool_result")) {
    // A message the user typed mid-loop arrives inside a `<system-reminder>` (src/wire/markers.ts), so it is invisible
    // to every rule below: `isReminderOnly` is true for it and `ownText` strips it. Checked FIRST, and only promoted
    // when the text matches the newest typed prompt no wire turn has claimed - the same positive evidence a
    // plain-string `new` turn needs. Without the hook stream (tests, spikes) it stays an ordinary continuation, which
    // is the fail-safe direction.
    for (const q of queuedMessages(blocks)) {
      if (matchesTypedPrompt(q, newestTyped === null ? null : [newestTyped])) return continuation(true);
    }
    // A tool-loop step carries tool results and at most harness text: reminders, or "Tool loaded." beside a ToolSearch
    // result of tool_reference blocks.
    const loaded = hasToolReferenceResult(last);
    const onlyResults = blocks.every((b) => b.type === "tool_result" || (b.type === "text" && (isReminderOnly(b.text ?? "") || (loaded && b.text?.trim() === TOOL_LOADED_TEXT))));
    if (onlyResults) return continuation(false);
    // Tool results plus text. Two different things wear this shape, and they must not share a label:
    //  - the user typed into a running tool loop. Still their own turn, still the same pin, no new decision.
    //  - the harness put its own text alongside the results (observed: a large tool_result payload with a trailing
    //    instruction, main chat and subagent alike). That is a side call.
    return matchesTypedPrompt(ownText(blocks), typed) ? continuation(true) : side("tool_result_text");
  }
  // Content shape is NOT evidence of who wrote the message, and the two known versions disagree (docs/wire-format.md
  // §4.3): 2.1.277 sent every user-typed prompt as an array of blocks and only harness side calls as plain strings;
  // 2.1.278 sends typed prompts as plain strings too. Treating a plain string as a side call cost a whole session of
  // routing when 2.1.278 landed, so the shape alone no longer decides. The hook stream is the only positive evidence
  // of the user's own words, and it is what rules a plain string in; without it (no hooks yet, tests, spikes) the
  // request stays `side`, which is the fail-safe direction: a missed turn forwards unchanged.
  // Matched against the NEWEST unclaimed typed prompt alone, never the whole list. A plain string is also the shape a
  // prompt takes once it sits in a later request's history (proven: identical text, 2026-09-19 capture), so a side call
  // that replays the conversation up to some earlier user message wears exactly this shape. Such a call can only carry
  // an OLDER prompt, so restricting the match to the newest unclaimed one keeps it `side` while still recognising the
  // turn the user just typed. Once a main `new` turn is recognised the prompt is claimed, so a repeat cannot match it.
  if (typeof last["content"] === "string" && !matchesTypedPrompt(ownText(blocks), newestTyped === null ? null : [newestTyped])) return unclassified("plain_string_no_typed_match");
  if (blocks.some((b) => b.type !== "text")) return unclassified("non_text_block"); // images etc.: not handled yet
  const task = ownText(blocks);
  if (task === "") return unclassified("no_own_text");
  // A subagent's work starts with its first request; a later text message inside its run is not a new task.
  if (kind === "subagent" && nonSystem.length !== 1) return unclassified("subagent_mid_run");
  // Once hooks are arriving in a session (`typed` non-null), every prompt the user types reaches us through
  // UserPromptSubmit before its request. A main-chat message with no newest unclaimed typed prompt behind it was written
  // by the harness, whatever its encoding: 2.1.280 sent four such calls within 50 s (session 999c1b7f, 11k-38k input,
  // no cache), which were decided and routed as new turns. They are kept `side` with a fingerprint so their shape can
  // be named. Without hooks nothing changes: the structural rule above still stands alone.
  if (kind === "main" && typed !== null && !matchesTypedPrompt(task, newestTyped === null ? null : [newestTyped])) return unclassified("no_typed_prompt");
  return { turn: "new", sideKind: null, sideMarker: null, unclassifiedReason: null, task, interjection: false };
}

/** The assistant text right before the last message (thinking and tool_use blocks excluded). */
function previousAssistant(nonSystem: readonly Json[]): string | null {
  const prev = nonSystem.at(-2);
  if (!prev || prev["role"] !== "assistant") return null;
  const t = blocksOf(prev)
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  return t === "" ? null : t;
}

/**
 * For a hook `UserPromptSubmit.prompt`: the side kind when Claude Code injected the message itself (another
 * session's message, a task notification, ...), null for a prompt the user typed. Prefix match, after whitespace and
 * a leading <system-reminder> tag, so a typed prompt that merely quotes a marker is not affected.
 */
export function injectedPromptKind(prompt: string): SideKind | null {
  const head = prompt.trimStart().replace(/^<system-reminder>\s*/, "");
  return INJECTED_PROMPT_MARKERS.find((m) => head.startsWith(m.text))?.kind ?? null;
}

/**
 * For a hook `UserPromptSubmit.prompt`: true when the prompt is a subagent's report handed back into the main chat.
 * Claude Code delivers it through `UserPromptSubmit` like a typed prompt, but it is model output, not the user
 * reacting to the previous reply, so it must not close the user's turn or be scored as a correction.
 */
export function isHandbackPrompt(prompt: string): boolean {
  return prompt.trimStart().replace(/^<system-reminder>\s*/, "").startsWith(HANDBACK_PROMPT_PREFIX.text);
}

/**
 * For a hook `UserPromptSubmit.prompt`: true only for a prompt the user typed as a turn of its own. False for messages
 * Claude Code injected (injectedPromptKind), a subagent's hand-back, slash commands (`/compact`, `/model`, skills: not
 * a turn of their own) and blank prompts.
 */
export function isTypedPrompt(prompt: string): boolean {
  const head = prompt.trimStart().replace(/^<system-reminder>\s*/, "");
  return head.trim() !== "" && !head.startsWith("/") && !isHandbackPrompt(prompt) && injectedPromptKind(prompt) === null;
}

/**
 * The `ttl` of the last `cache_control` in prefix order (tools, system, then message blocks): that breakpoint writes
 * the whole prefix, so it is when the conversation's cache lapses. Without a `ttl` the API default, 5m, applies. The
 * main chat marks every breakpoint `"ttl": "1h"`, subagents and compaction mark none (fixtures 2.1.277-2.1.282).
 */
export function lastBreakpointTtl(b: Json): CacheTtl | null {
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const blocks = [...list(b["tools"]), ...list(b["system"]), ...list(b["messages"]).flatMap((m) => (isObj(m) ? list(m["content"]) : []))];
  const last = blocks.filter((x) => isObj(x) && isObj(x["cache_control"])).at(-1) as Json | undefined;
  if (last === undefined) return null;
  const ttl = (last["cache_control"] as Json)["ttl"];
  return ttl === undefined || ttl === "5m" ? "5m" : ttl === "1h" ? "1h" : null;
}

/**
 * `typedPrompts`: looks up the prompts UserPromptSubmit delivered for a session (the worker's memory), null when none
 * has arrived. Omitted by callers that have no hook stream (tests, spikes): an interjection is then never claimed and
 * such a request stays `side` / `tool_result_text`.
 */
export function parseRequest(
  headers: IncomingHttpHeaders,
  body: Buffer,
  typedPrompts?: (sessionId: string | null) => readonly string[] | null,
  /** The newest typed prompt no wire turn has claimed yet; the only one a plain-string message may be promoted by. */
  newestTypedPrompt?: (sessionId: string | null) => string | null,
): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!isObj(parsed)) return { ok: false, reason: "not_object" };
  const b = parsed;

  const sys = systemText(b);
  const agentId = header(headers, HEADER_AGENT_ID);
  const signals: Signals = { header: agentId !== null, s1: sys.includes(MARKER_SUBAGENT), s2: sys.includes(MARKER_AGENT_PROMPT), s3: sys.includes(MARKER_BILLING) };
  const signal: KindSignal = signals.header ? "header" : signals.s1 ? "marker:cc_is_subagent" : signals.s2 ? "marker:agent_prompt" : "none";
  const kind: RequestKind = signal !== "none" ? "subagent" : signals.s3 ? "main" : "unknown";

  const messages = Array.isArray(b["messages"]) ? b["messages"].filter(isObj) : [];
  const nonSystem = messages.filter((m) => m["role"] !== "system");
  const toolCount = Array.isArray(b["tools"]) ? b["tools"].length : 0;
  const betas = (header(headers, "anthropic-beta") ?? "").split(",").map((x) => x.trim());

  const headerSessionId = header(headers, HEADER_SESSION_ID);
  const mdSessionId = metadataSessionId(b);
  const sessionId = headerSessionId ?? mdSessionId;

  const t = classifyTurn(nonSystem, toolCount, kind, typedPrompts?.(sessionId) ?? null, newestTypedPrompt?.(sessionId) ?? null);
  // How the last non-system message carried its content. Only meaningful for a `new` turn, where it says which
  // encoding the prompt arrived in: 2.1.277 sent every typed prompt as an array of blocks, 2.1.278 sends plain
  // strings too, and the two are otherwise indistinguishable once a turn is recognised (docs/wire-format.md 4.3).
  // Recorded so that question can be answered from a log instead of inferred from the Claude Code version.
  const promptEncoding = t.turn === "new" ? contentEncoding(nonSystem.at(-1)) : null;

  let convKey: string | null = null;
  if (sessionId !== null && kind !== "unknown") {
    if (kind === "subagent" && agentId !== null) convKey = `${sha(sessionId)}:a:${sha(agentId)}`;
    else {
      const first = messages[0];
      const firstText = first ? blocksOf(first).map((x) => x.text ?? "").join("\n") : "";
      convKey = `${sha(sessionId)}:${kind === "main" ? "m" : "s"}:${sha(firstText)}`;
    }
  }

  const oc = b["output_config"];
  const ua = header(headers, "user-agent") ?? "";
  return {
    ok: true,
    view: {
      sessionId,
      agentId,
      kind,
      signal,
      signals,
      turn: t.turn,
      sideKind: t.sideKind,
      sideMarker: t.sideMarker,
      unclassifiedReason: t.unclassifiedReason,
      interjection: t.interjection,
      promptEncoding,
      entrypoint: BILLING_ENTRYPOINT.exec(sys)?.[1] ?? null,
      clientVersion: USER_AGENT_VERSION.exec(ua)?.[1] ?? null,
      requestedModel: str(b["model"]),
      requestedEffort: isObj(oc) ? str(oc["effort"]) : null,
      toolCount,
      convKey,
      task: t.task,
      previousAssistantText: t.turn === "new" && kind === "main" ? previousAssistant(nonSystem) : null,
      facts: {
        headerSessionId,
        metadataSessionId: mdSessionId,
        systemMessages: messages.length - nonSystem.length,
        nonSystemMessages: nonSystem.length,
        lastNonSystemRole: str(nonSystem.at(-1)?.["role"]),
        betaMidConversationSystem: betas.some((x) => x.startsWith(BETA_MID_CONVERSATION_SYSTEM)),
        betaExtendedCacheTtl: betas.some((x) => x.startsWith(BETA_EXTENDED_CACHE_TTL)),
        cacheTtl: lastBreakpointTtl(b),
        maxTokens: typeof b["max_tokens"] === "number" ? b["max_tokens"] : null,
      },
    },
  };
}

