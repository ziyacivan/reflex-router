// Retargeting a Claude Code request to another model: make it look like the request Claude Code itself sends for
// that model family (docs/wire-format.md §5). This is the only code that changes a request body; it runs only when
// route mode deliberately applies a plan. Pure: bytes in, bytes out (or a reason why not), plus the list of fields
// it changed so every routed record can say exactly what was rewritten.
import type { Tier } from "../config.js";
import { MAX_OUTPUT_TOKENS } from "../tiers.js";

/** How a model family takes reasoning settings, as observed in native Claude Code requests. */
type ThinkingStyle = "adaptive" | "budget";
const STYLE: Readonly<Record<Tier, ThinkingStyle>> = { haiku: "budget", sonnet: "adaptive", opus: "adaptive", fable: "adaptive" };
/** Families that accept `role:"system"` messages and `output_config.effort` (both rejected by Haiku 4.5: M1 experiment). */
const ACCEPTS_SYSTEM_MESSAGES: Readonly<Record<Tier, boolean>> = { haiku: false, sonnet: true, opus: true, fable: true };
const ACCEPTS_EFFORT: Readonly<Record<Tier, boolean>> = { haiku: false, sonnet: true, opus: true, fable: true };
/**
 * Families that take a per-message `output_config` on a `role:"system"` message (per-turn effort; Fable 5.1 requests
 * carry one; so do Opus 5.5 requests on 2.1.280). Sonnet 5 rejects its effort: "messages.1.output_config: Extra inputs
 * are not permitted" (2.1.278 experiment.route-fable-to-sonnet), and on 2026-09-23 "output_config.effort requires a
 * model that supports per-turn effort; this model does not" (2.1.280 experiment.route-opus55-down). Haiku never sees
 * it: its system messages are folded into user messages.
 */
const ACCEPTS_MESSAGE_OUTPUT_CONFIG: Readonly<Record<Tier, boolean>> = { haiku: false, sonnet: false, opus: true, fable: true };
/**
 * Families that take MCP tool search's `tool_addition` blocks (2.1.282, beta mid-conversation-tool-changes). Opus 5.5
 * and Fable 5.1 get them from Claude Code natively (captures toolsearch-2.1.282, toolsearch-fable-native: 200). Sonnet 5
 * rejects them: "tool_addition/tool_removal is not supported on this model" (route opus->sonnet, 2026-09-25); Haiku 4.5
 * takes no role:"system" message, which is the only place they may stand. Native Haiku requests carry tool search
 * without them (capture toolsearch-haiku-native).
 */
const ACCEPTS_TOOL_CHANGES: Readonly<Record<Tier, boolean>> = { haiku: false, sonnet: false, opus: true, fable: true };

/** Native Haiku 4.5 requests from Claude Code use this budget (with max_tokens 32000). */
export const HAIKU_THINKING_BUDGET = 31999;
/** The API's minimum thinking budget. */
const MIN_THINKING_BUDGET = 1024;

/**
 * Source -> target pairs whose rewrite the API accepted in real sessions (docs/wire-format.md §5.1-5.6,
 * test/fixtures/claude-code/2.1.277/experiment.*, 2.1.278/experiment.route-haiku-*). Route mode only rewrites these;
 * anything else is logged as `rewrite_unverified` and forwarded unchanged.
 */
const VERIFIED_RETARGETS: ReadonlySet<string> = new Set(["sonnet>haiku", "opus>sonnet", "opus>haiku", "haiku>sonnet", "haiku>opus", "sonnet>opus",
  "fable>haiku", "fable>sonnet", "fable>opus", "haiku>fable", "sonnet>fable", "opus>fable"]);
/**
 * Models no retarget has been verified for yet, on either side: a pair whose source or target model matches one is
 * unverified whatever its tiers are. A new model in a verified family is not the model that was verified.
 */
const UNVERIFIED_MODELS: readonly string[] = ["claude-opus-5-5", "claude-sonnet-5-5"];
/**
 * Pairs with such a model verified since, written with the model id in place of its tier (docs/wire-format.md §5.7 and
 * §5.12, test/fixtures/experiments/2.1.280/experiment.route-*opus55*, 2.1.284/experiment.route-*sonnet55*): first
 * request, subagent pin, a continuation holding source-signed thinking, and un-pin with target-signed thinking back to
 * the source. A `sonnet` row is Sonnet 5 (a REFLEX_MODEL_SONNET setting); Sonnet 5.5 has rows of its own.
 */
const VERIFIED_MODEL_RETARGETS: ReadonlySet<string> = new Set([
  "claude-opus-5-5>haiku", "claude-opus-5-5>sonnet", "haiku>claude-opus-5-5", "sonnet>claude-opus-5-5",
  "claude-opus-5-5>fable", "fable>claude-opus-5-5",
  "claude-opus-5-5>claude-sonnet-5-5", "claude-sonnet-5-5>claude-opus-5-5", "claude-sonnet-5-5>haiku", "haiku>claude-sonnet-5-5",
]);
const unverifiedKey = (m: string | null): string | undefined => UNVERIFIED_MODELS.find((u) => m !== null && m.toLowerCase().includes(u));
export const isVerifiedRetarget = (from: Tier, to: Tier, fromModel: string | null, toModel: string): boolean => {
  if (!VERIFIED_RETARGETS.has(`${from}>${to}`)) return false;
  const f = unverifiedKey(fromModel);
  const t = unverifiedKey(toModel);
  return (f === undefined && t === undefined) || VERIFIED_MODEL_RETARGETS.has(`${f ?? from}>${t ?? to}`);
};

/**
 * `anthropic-beta` values a target model rejects, removed from the header when a request is retargeted to it (the
 * rest of the header is kept as is). Each row names the evidence.
 */
export const STRIP_BETAS: readonly { readonly to: Tier; readonly prefix: string; readonly evidence: string }[] = [
  {
    to: "haiku",
    prefix: "context-1m-",
    evidence:
      "route acceptance session B1 (opus[1m] -> Haiku): 400 \"The long context beta is not yet available for this subscription.\"; " +
      "interactive-opus1m.main-new-turn fixture; experiment.interactive-opus1m-first-turn-to-haiku",
  },
];

/** The `anthropic-beta` header for a request retargeted to `to`, and the values removed from it. Pure. */
export function retargetBetas(header: string | undefined, to: Tier): { readonly value: string | undefined; readonly stripped: readonly string[] } {
  if (header === undefined) return { value: undefined, stripped: [] };
  const rules = STRIP_BETAS.filter((r) => r.to === to);
  const parts = header.split(",").map((x) => x.trim()).filter(Boolean);
  const stripped = parts.filter((b) => rules.some((r) => b.startsWith(r.prefix)));
  if (stripped.length === 0) return { value: header, stripped: [] };
  return { value: parts.filter((b) => !stripped.includes(b)).join(","), stripped };
}

/**
 * Target models that 400 on a shape no rewrite can keep the meaning of, matched by substring of the model id. A request
 * carrying one is not rewritten: it goes to the model it asked for (API docs, 2026-09: Opus 5.5, Sonnet 5.5 and Fable 5.x
 * reject `thinking: {type: "disabled"}` at every effort level (Sonnet 5.5's lowest setting is `between_tools`); Opus 5.5,
 * Sonnet 5.5 and Fable 5.1 reject `tool_choice` `any`/`tool`, "tool_choice: type \"tool\" and \"any\" are not
 * supported for this model."). Claude Code sends thinking disabled only
 * on side calls so far (fixtures interactive.title-generation, ultracode.main-side-no-tools), which are not routed.
 */
const REJECTS_DISABLED_THINKING: readonly string[] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5"];
const REJECTS_FORCED_TOOL_CHOICE: readonly string[] = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"];
const matches = (list: readonly string[], model: string): boolean => list.some((m) => model.toLowerCase().includes(m));

export interface RewriteOptions {
  readonly from: Tier;
  readonly to: Tier;
  readonly model: string;
  /** Drop `thinking`/`redacted_thinking` blocks generated by another model from the history. */
  readonly dropHistoryThinking?: boolean;
}

export type RewriteResult =
  | { readonly ok: true; readonly body: Buffer; readonly fields: readonly string[] }
  | { readonly ok: false; readonly reason: "not_json" | "no_messages" | "thinking_budget_too_small" | "system_block_unfoldable" | "thinking_disabled_rejected" | "forced_tool_choice_rejected" };

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const blocksOf = (content: unknown): unknown[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : []);

/**
 * For a target that does not take `tool_addition` blocks (ACCEPTS_TOOL_CHANGES): each one announces a deferred tool as
 * visible from then on, so it becomes its tool without `defer_loading` (the same visible set) and the block goes. A
 * system message left with no content goes too (its only other observed key, a per-turn effort, is one neither such
 * target takes). A `tool_removal` has no such equivalent and was never observed, so it, like any block type not listed
 * here, makes the request unrewritable: it is then sent unchanged, never with a block the target may reject.
 */
function liftToolAdditions(messages: Json[]): { messages: Json[]; added: Set<string>; lifted: number } | null {
  const added = new Set<string>();
  let lifted = 0;
  const out: Json[] = [];
  for (const m of messages) {
    if (m["role"] !== "system" || !Array.isArray(m["content"])) {
      out.push(m);
      continue;
    }
    const kept: unknown[] = [];
    let mark: unknown;
    for (const c of m["content"] as unknown[]) {
      if (isObj(c) && c["type"] === "tool_addition" && isObj(c["tool"]) && typeof c["tool"]["name"] === "string") {
        added.add(c["tool"]["name"]);
        lifted++;
        if (c["cache_control"] !== undefined) mark = c["cache_control"];
      } else if (isObj(c) && c["type"] === "text") kept.push(c);
      else return null;
    }
    // A cache breakpoint on a lifted block moves to the last block that stays (in this message, else the one before),
    // so the conversation prefix is still written to the cache.
    const prev = out.at(-1)?.["content"];
    const host: unknown[] = kept.length > 0 ? kept : Array.isArray(prev) ? prev : [];
    const tail = host.at(-1);
    if (mark !== undefined && isObj(tail) && tail["cache_control"] === undefined) host[host.length - 1] = { ...tail, cache_control: mark };
    if (kept.length > 0) out.push({ ...m, content: kept });
  }
  return { messages: out, added, lifted };
}

/**
 * Folds every role:"system" message into the closest earlier user message (appended, so tool_result blocks stay
 * first), or into the next user message when none precedes it. Deterministic, so a pinned tool loop folds the same
 * history the same way on every request and the rewritten prefix stays cacheable.
 */
function foldSystemMessages(messages: Json[]): { messages: Json[]; folded: number } {
  const out: Json[] = [];
  let pending: unknown[] = [];
  let folded = 0;
  for (const m of messages) {
    if (m["role"] === "system") {
      folded++;
      const target = [...out].reverse().find((x) => x["role"] === "user");
      if (target) target["content"] = [...blocksOf(target["content"]), ...blocksOf(m["content"])];
      else pending.push(...blocksOf(m["content"]));
      continue;
    }
    const copy: Json = { ...m };
    if (pending.length > 0 && copy["role"] === "user") {
      copy["content"] = [...pending, ...blocksOf(copy["content"])];
      pending = [];
    }
    out.push(copy);
  }
  return { messages: out, folded };
}

export function retarget(body: Buffer, opts: RewriteOptions): RewriteResult {
  let b: Json;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isObj(parsed)) return { ok: false, reason: "not_json" };
    b = parsed;
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (!Array.isArray(b["messages"])) return { ok: false, reason: "no_messages" };
  const th0 = b["thinking"];
  if (isObj(th0) && th0["type"] === "disabled" && matches(REJECTS_DISABLED_THINKING, opts.model)) return { ok: false, reason: "thinking_disabled_rejected" };
  const tc = b["tool_choice"];
  if (isObj(tc) && (tc["type"] === "any" || tc["type"] === "tool") && matches(REJECTS_FORCED_TOOL_CHOICE, opts.model)) return { ok: false, reason: "forced_tool_choice_rejected" };
  const fields: string[] = [];

  b["model"] = opts.model;
  fields.push("model");

  if (typeof b["max_tokens"] === "number" && b["max_tokens"] > MAX_OUTPUT_TOKENS[opts.to]) {
    b["max_tokens"] = MAX_OUTPUT_TOKENS[opts.to];
    fields.push("max_tokens");
  }

  const oc = b["output_config"];
  if (!ACCEPTS_EFFORT[opts.to] && isObj(oc) && "effort" in oc) {
    const rest = Object.fromEntries(Object.entries(oc).filter(([k]) => k !== "effort"));
    if (Object.keys(rest).length > 0) b["output_config"] = rest;
    else delete b["output_config"];
    fields.push("output_config.effort");
  }

  const th = b["thinking"];
  if (isObj(th)) {
    const display = th["display"];
    if (STYLE[opts.to] === "budget" && th["type"] === "adaptive") {
      const max = typeof b["max_tokens"] === "number" ? b["max_tokens"] : HAIKU_THINKING_BUDGET + 1;
      const budget = Math.min(HAIKU_THINKING_BUDGET, max - 1);
      if (budget < MIN_THINKING_BUDGET) return { ok: false, reason: "thinking_budget_too_small" };
      b["thinking"] = { type: "enabled", budget_tokens: budget, ...(display !== undefined ? { display } : {}) };
      fields.push("thinking");
    } else if (STYLE[opts.to] === "adaptive" && th["type"] === "enabled") {
      b["thinking"] = { type: "adaptive", ...(display !== undefined ? { display } : {}) };
      fields.push("thinking");
    }
  }

  let messages = (b["messages"] as unknown[]).filter(isObj);
  if (!ACCEPTS_TOOL_CHANGES[opts.to] && messages.some((m) => m["role"] === "system")) {
    const lifted = liftToolAdditions(messages);
    if (lifted === null) return { ok: false, reason: "system_block_unfoldable" };
    messages = lifted.messages;
    if (lifted.lifted > 0) fields.push(`messages.tool_addition_lifted:${lifted.lifted}`);
    if (lifted.added.size > 0 && Array.isArray(b["tools"])) {
      let undeferred = 0;
      b["tools"] = (b["tools"] as unknown[]).map((t) => {
        if (!isObj(t) || t["defer_loading"] !== true || typeof t["name"] !== "string" || !lifted.added.has(t["name"])) return t;
        undeferred++;
        const { defer_loading: _, ...rest } = t;
        return rest;
      });
      if (undeferred > 0) fields.push(`tools.undeferred:${undeferred}`);
    }
  }
  if (!ACCEPTS_SYSTEM_MESSAGES[opts.to] && messages.some((m) => m["role"] === "system")) {
    const r = foldSystemMessages(messages);
    messages = r.messages;
    fields.push(`messages.system_folded:${r.folded}`);
  }
  if (!ACCEPTS_MESSAGE_OUTPUT_CONFIG[opts.to] && messages.some((m) => m["role"] === "system" && isObj(m["output_config"]) && "effort" in m["output_config"])) {
    // Only the per-turn effort goes (the key the target rejects); any other key stays, and the object goes only when
    // effort was all it held (every observed request so far).
    let dropped = 0;
    let stripped = 0;
    messages = messages.map((m) => {
      const moc = m["output_config"];
      if (m["role"] !== "system" || !isObj(moc) || !("effort" in moc)) return m;
      const rest = Object.fromEntries(Object.entries(moc).filter(([k]) => k !== "effort"));
      const { output_config: _, ...without } = m;
      if (Object.keys(rest).length === 0) {
        dropped++;
        return without;
      }
      stripped++;
      return { ...without, output_config: rest };
    });
    if (dropped > 0) fields.push(`messages.output_config_dropped:${dropped}`);
    if (stripped > 0) fields.push(`messages.output_config.effort:${stripped}`);
  }
  if (opts.dropHistoryThinking) {
    let dropped = 0;
    messages = messages.map((m) => {
      if (m["role"] !== "assistant" || !Array.isArray(m["content"])) return m;
      const kept = (m["content"] as unknown[]).filter((c) => !(isObj(c) && (c["type"] === "thinking" || c["type"] === "redacted_thinking")));
      dropped += (m["content"] as unknown[]).length - kept.length;
      return kept.length === (m["content"] as unknown[]).length ? m : { ...m, content: kept };
    });
    if (dropped > 0) fields.push(`messages.thinking_dropped:${dropped}`);
  }
  b["messages"] = messages;

  return { ok: true, body: Buffer.from(JSON.stringify(b)), fields };
}
