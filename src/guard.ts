// Main-chat cost guard (pure). Switching a conversation's model throws away its prompt cache: the new model must
// write the whole context into its own cache, while staying would have read it cheaply. A downgrade is only worth it
// if that one-time penalty is small:
//
//   penalty = cacheWrite(to, ctx, ttl) - cacheRead(from, ctx)
//
// `from` is the tier that holds the cache (the model that last served this conversation), `ctx` the context size
// measured from that response. Unknown context => refuse. A conversation's first request has no cache anywhere, so
// there is nothing to lose. The guard only restricts moving AWAY from the cache holder towards a cheaper tier;
// returning to the requested tier is never blocked (quality first).
//
// A switch is allowed when the penalty is at most `maxPenaltyUsd`, or when it is recovered within `breakevenRequests`
// requests on the cheaper tier at this conversation's own measured averages:
//
//   saving/request = write * (writeRate(from) - writeRate(to)) + output * (out(from) - out(to)) + ctx * (readRate(from) - readRate(to))
//
// This counts neither the way back (a later return to `from` writes what it missed, at `from`'s rates) nor a
// change in how many requests or tokens the cheaper model uses; both are unmeasured.
import type { Tier } from "./config.js";
import { cacheReadRate, cacheReadUsd, cacheWriteRate, cacheWriteUsd, priceOf, type CacheTtl } from "./pricing.js";

export interface GuardInput {
  /** Tier whose cache holds this conversation (last served), or null when nothing was served yet. */
  readonly cacheTier: Tier | null;
  readonly to: Tier;
  /** The models behind `cacheTier` and `to`, when known: prices are per model (Haiku 4.5 and 5.5 differ tenfold). */
  readonly cacheModel?: string | null;
  readonly toModel?: string | null;
  /** input + cache_read + cache_create of the last response on this conversation; null when unknown. */
  readonly ctxTokens: number | null;
  /** The request's own cache TTL (main chat: 1h via the extended-cache-ttl beta). */
  readonly ttl: CacheTtl;
  /** No earlier assistant turn in the conversation: nothing is cached yet. */
  readonly fresh: boolean;
  readonly maxPenaltyUsd: number;
  /** This conversation's mean new tokens (input + cache write) and output tokens per response after its first; null before any. */
  readonly perRequest: { readonly write: number; readonly output: number } | null;
  /** Requests within which the penalty must be recovered; 0 turns the break-even rule off. */
  readonly breakevenRequests: number;
}

export type GuardReason = "fresh" | "no_switch" | "within_limit" | "breakeven" | "over_limit" | "ctx_unknown";

export interface GuardResult {
  readonly allowed: boolean;
  readonly reason: GuardReason;
  readonly ctx: number | null;
  readonly penaltyUsd: number | null;
  /** Estimated saving per request on the cheaper tier (null when not computed). */
  readonly savingUsd: number | null;
}

export function guard(g: GuardInput): GuardResult {
  if (g.cacheTier === g.to) return { allowed: true, reason: "no_switch", ctx: g.ctxTokens, penaltyUsd: 0, savingUsd: null };
  if (g.fresh) return { allowed: true, reason: "fresh", ctx: g.ctxTokens, penaltyUsd: null, savingUsd: null };
  if (g.ctxTokens === null || g.cacheTier === null) return { allowed: false, reason: "ctx_unknown", ctx: null, penaltyUsd: null, savingUsd: null };
  const from = g.cacheTier;
  const ctx = g.ctxTokens;
  const fm = g.cacheModel ?? null;
  const tm = g.toModel ?? null;
  const penaltyUsd = cacheWriteUsd(g.to, ctx, g.ttl, tm) - cacheReadUsd(from, ctx, fm);
  const savingUsd = g.perRequest === null ? null
    : (g.perRequest.write * (cacheWriteRate(from, g.ttl, fm) - cacheWriteRate(g.to, g.ttl, tm)) + g.perRequest.output * (priceOf(from, fm).output - priceOf(g.to, tm).output) + ctx * (cacheReadRate(from, fm) - cacheReadRate(g.to, tm))) / 1_000_000;
  const done = (allowed: boolean, reason: GuardReason): GuardResult => ({ allowed, reason, ctx, penaltyUsd, savingUsd });
  if (penaltyUsd <= g.maxPenaltyUsd) return done(true, "within_limit");
  if (g.breakevenRequests > 0 && savingUsd !== null && savingUsd > 0 && penaltyUsd <= g.breakevenRequests * savingUsd) return done(true, "breakeven");
  return done(false, "over_limit");
}
