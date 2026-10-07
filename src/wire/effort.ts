// Effort on the wire (docs/wire-format.md §5.8). Claude Code's own /effort appends an effort-only system message after
// the new user message and sets the top-level effort too. The message is what changes the level (on Opus 5.5 the
// top-level value alone does nothing while the index-1 system message carries the client's effort), and it keeps the
// cache; a top-level change keeps it on Opus 5.5 only (Opus 5, Fable 5.1 and Sonnet 5.5 rewrite the messages cache). reflex adds
// the same message. Claude Code never sends back what reflex added, so every later request of the conversation must
// carry the added messages again, at the same place, or the history the model saw is edited (on Opus 5.5 and Fable
// the later thinking blocks are then bound to a different conversation): `withEffort` re-inserts them by the hash of
// the history before them. Sonnet 5 takes no per-message effort and loses its whole cache on a top-level change, so
// there the level is only set where the cache is being written anyway. Pure.
import crypto from "node:crypto";
import { tierOfModel } from "../tiers.js";
import type { Effort } from "../types.js";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
export const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

/**
 * Models whose requests take an added effort message, and whether the top-level value follows it (2.1.281,
 * experiment.effort-switch / effort-apply / effort-verify): Opus 5.5 keeps its cache either way and gets both, as
 * Claude Code sends them; Opus 5, Fable 5.1, Sonnet 5.5 and Haiku 5.5 get the message only, which keeps the cache and changes
 * the level.
 */
const MESSAGE_EFFORT: readonly { readonly match: RegExp; readonly top: boolean }[] = [
  { match: /claude-opus-5-5/, top: true },
  { match: /claude-opus-5(?!-\d)/, top: false },
  { match: /claude-fable-5-1/, top: false },
  // 2.1.284, experiment.effort-verify-sonnet55: the message changes the level with the cache kept; the top-level value
  // alone does not change it, and changing it rewrites the messages cache (docs/wire-format.md §5.12).
  { match: /claude-sonnet-5-5/, top: false },
  // 2.1.293, experiment.effort-verify-haiku55 (n = 4 runs of one puzzle): the message with the top-level value unchanged
  // keeps the cache (0 written, 25,136 read) and changes the level (output tokens, mean: 3,153 at `low`, 3,610 at the
  // client's `medium`, 8,896 at `max`); the top-level value alone does not (`max`: 3,242). Same as Sonnet 5.5.
  { match: /claude-haiku-5-5/, top: false },
];
export const messageEffort = (model: string | null): { readonly top: boolean } | null => (model === null ? null : (MESSAGE_EFFORT.find((m) => m.match.test(model.toLowerCase())) ?? null));

/**
 * How reflex may change the level of a request to `model` this turn: by message (Opus 5.5, Opus 5, Fable 5.1, Sonnet 5.5, Haiku 5.5:
 * any request), by the top-level value (Sonnet 5, only when its cache is being written anyway: `cacheFresh`), or not at all
 * (Haiku 4.5 takes no effort).
 */
export function effortVia(model: string | null, cacheFresh: boolean): "message" | "top-level" | null {
  if (messageEffort(model)) return "message";
  if (cacheFresh && tierOfModel(model) === "sonnet") return "top-level";
  return null;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Claude Code's own effort-only message shape. */
const effortMessage = (effort: Effort): Json => ({ role: "system", content: [], output_config: { effort } });
const effortOf = (m: unknown): unknown => (isObj(m) && m["role"] === "system" && isObj(m["output_config"]) ? m["output_config"]["effort"] : undefined);

/**
 * A message as the API renders it, not as Claude Code happens to serialise it this time: `cache_control` moves
 * between requests, and the same content is sent as a string on one request and as one text block on the next.
 */
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "cache_control").map(([k, x]) => [k, canon(x)])) : v;
const messageKey = (m: Json): string => JSON.stringify(canon(typeof m["content"] === "string" ? { ...m, content: [{ type: "text", text: m["content"] }] } : m));
/** Hash of the history up to and including `m`, chained from the hash of the history before it. */
const chain = (prev: string, m: Json): string => crypto.createHash("sha256").update(prev).update("\n").update(messageKey(m)).digest("hex");

/**
 * One level reflex put into a conversation, by the hash of the history up to the message it belongs to: `insert` = an
 * effort-only message after that message; `set` = that message is a system message already carrying an effort and
 * its level was changed. Claude Code does `set` itself when the level changes before a turn's system message is sent;
 * appending a second effort message after one that has its own cost ~11k tokens of cache on the next request
 * (2.1.281 smoke run, docs/wire-format.md §5.8), `set` costs none.
 */
export interface EffortMark {
  readonly effort: Effort;
  readonly op: "insert" | "set";
}

export interface EffortEdit {
  /** The request to send; the input buffer itself when nothing changed. */
  readonly body: Buffer;
  readonly fields: readonly string[];
  /** The level this request put in: stored (by the caller) once the upstream accepts the request. */
  readonly added: ({ readonly anchor: string } & EffortMark) | null;
  /** `add` needed an `insert` and `allowInsert` was false, so the level was left as it was. */
  readonly insertRefused?: boolean;
}

const withLevel = (m: Json, effort: Effort): Json => ({ ...m, output_config: { ...(m["output_config"] as Json), effort } });

/**
 * Re-applies every stored mark (by the hash of Claude Code's own history, before any change), then puts in `add` when
 * that differs from the level now in effect (the last effort-bearing message, else the top-level value): by changing
 * the last message when it is a system message with its own effort (`set`), else, only with `allowInsert`, by
 * appending an effort-only message (`insert`). With `setTop` the top-level value follows the level in effect, as
 * Claude Code does. Null for a body it cannot read.
 *
 * `keepFirst`: the level reflex set on the conversation's first effort-bearing system message. When no stored mark
 * matches that message any more (Claude Code rebuilt the history, e.g. resuming a subagent after a background task,
 * which already misses the cache from message 0), it is set again there and returned as a new `set` mark.
 *
 * Why `insert` is gated: the preserved-thinking check binds later thinking blocks to an inserted message, so a
 * conversation continued without it (without reflex) is refused once on accounts that check enforces, before Claude
 * Code strips the blocks and retries; a changed level on an existing message is not part of what the check binds
 * (experiment.effort-verify-set: forgotten, still accepted), so `set` leaves nothing behind but a cache miss.
 */
export function withEffort(body: Buffer, lookup: (anchor: string) => EffortMark | undefined, add: Effort | null, setTop = true, allowInsert = true, keepFirst: Effort | null = null): EffortEdit | null {
  let b: Json;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    if (!isObj(parsed) || !Array.isArray(parsed["messages"])) return null;
    b = parsed;
  } catch {
    return null;
  }
  const out: unknown[] = [];
  let h = "";
  let reinserted = 0;
  /** The last message is Claude Code's own and was left as sent: a system message with an effort can take `set`. */
  let lastUntouched = false;
  let firstLevelSeen = false;
  let kept: EffortEdit["added"] = null;
  for (const m of b["messages"] as unknown[]) {
    lastUntouched = false;
    if (!isObj(m)) {
      out.push(m);
      continue;
    }
    h = chain(h, m);
    const e = lookup(h);
    const first = !firstLevelSeen && effortOf(m) !== undefined;
    if (effortOf(m) !== undefined) firstLevelSeen = true;
    if (first && e === undefined && keepFirst !== null && effortOf(m) !== keepFirst) {
      out.push(withLevel(m, keepFirst));
      kept = { anchor: h, effort: keepFirst, op: "set" };
    } else if (e?.op === "set" && effortOf(m) !== undefined) {
      out.push(withLevel(m, e.effort));
      reinserted++;
    } else if (e !== undefined) {
      out.push(m, effortMessage(e.effort));
      reinserted++;
    } else {
      out.push(m);
      lastUntouched = true;
    }
  }
  const oc = isObj(b["output_config"]) ? b["output_config"] : {};
  const inMessages = [...out].reverse().map(effortOf).find((e) => e !== undefined);
  const current = inMessages ?? oc["effort"];
  let added: EffortEdit["added"] = kept;
  let insertRefused = false;
  if (add !== null && add !== current) {
    const last = out[out.length - 1];
    if (lastUntouched && isObj(last) && effortOf(last) !== undefined) {
      out[out.length - 1] = withLevel(last, add);
      added = { anchor: h, effort: add, op: "set" };
    } else if (allowInsert) {
      out.push(effortMessage(add));
      added = { anchor: h, effort: add, op: "insert" };
    } else insertRefused = true;
  }
  if (reinserted === 0 && added === null) return { body, fields: [], added: null, insertRefused };

  const fields: string[] = [];
  if (reinserted > 0) fields.push(`messages.effort_reinserted:${reinserted}`);
  if (kept) fields.push("messages.effort_kept");
  else if (added) fields.push(added.op === "set" ? "messages.effort_set" : "messages.effort_added");
  const effective = added?.effort ?? current;
  if (setTop && effective !== oc["effort"]) {
    b["output_config"] = { ...oc, effort: effective };
    fields.push("output_config.effort");
  }
  b["messages"] = out;
  return { body: Buffer.from(JSON.stringify(b)), fields, added, insertRefused };
}

/** Sets the top-level effort (Sonnet). The input buffer itself when it already holds `effort`; null when unreadable. */
export function withTopEffort(body: Buffer, effort: Effort): EffortEdit | null {
  try {
    const b: unknown = JSON.parse(body.toString("utf8"));
    if (!isObj(b)) return null;
    const oc = isObj(b["output_config"]) ? b["output_config"] : {};
    if (oc["effort"] === effort) return { body, fields: [], added: null };
    b["output_config"] = { ...oc, effort };
    return { body: Buffer.from(JSON.stringify(b)), fields: ["output_config.effort"], added: null };
  } catch {
    return null;
  }
}
