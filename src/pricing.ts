// List prices used by the main-chat cost guard and (later) cost estimates in reports.
//
// CHECK AGAINST https://platform.claude.com/docs/en/about-claude/pricing BEFORE EVERY RELEASE and update LAST_VERIFIED.
// Not modelled: the 1.1x inference_geo "us" multiplier, batch and fast-mode pricing, negotiated discounts, and
// subscription plans (whose limits are not priced per token at all).
import type { Tier } from "./config.js";

export const LAST_VERIFIED = "2026-09-28";

export interface TierPrice {
  /** $ per million base input tokens. */
  readonly input: number;
  /** $ per million output tokens. */
  readonly output: number;
  /** Cache read ("hits and refreshes") as a multiple of base input. */
  readonly cacheReadMult: number;
}

/** Claude Haiku 4.5, Sonnet 5, Opus 5.5, Fable 5.1 (the tier defaults in config.ts). */
export const PRICES: Readonly<Record<Tier, TierPrice>> = {
  haiku: { input: 1, output: 5, cacheReadMult: 0.1 },
  sonnet: { input: 2, output: 10, cacheReadMult: 0.1 },
  opus: { input: 4, output: 20, cacheReadMult: 0.05 },
  fable: { input: 10, output: 50, cacheReadMult: 0.025 },
};

/** Models priced differently from their tier's default above, matched by substring of the model id; first match wins. */
const MODEL_PRICES: readonly (readonly [string, TierPrice])[] = [
  ["claude-opus-5-5", PRICES.opus],
  ["claude-opus-", { input: 5, output: 25, cacheReadMult: 0.1 }], // Opus 5, 4.8, 4.7, 4.6, 4.5
  ["claude-fable-5-1", PRICES.fable],
  ["claude-fable-5", { input: 10, output: 50, cacheReadMult: 0.1 }], // Fable 5: cache reads $1, not 5.1's $0.25
];

/** Price of `model` (a model id of `tier`), or the tier default when the model is unknown or has no row of its own. */
export function priceOf(tier: Tier, model?: string | null): TierPrice {
  const m = model?.toLowerCase();
  return (m !== undefined && MODEL_PRICES.find(([k]) => m.includes(k))?.[1]) || PRICES[tier];
}

/** Cache write multiples of base input, by time-to-live. */
export const CACHE_WRITE_MULT = { "5m": 1.25, "1h": 2 } as const;
export type CacheTtl = keyof typeof CACHE_WRITE_MULT;

const perToken = (usdPerMTok: number): number => usdPerMTok / 1_000_000;

/** $ to write `tokens` into the cache of `tier`. */
export const cacheWriteUsd = (tier: Tier, tokens: number, ttl: CacheTtl): number => tokens * perToken(priceOf(tier).input) * CACHE_WRITE_MULT[ttl];

/** $ to read `tokens` from the cache of `tier`. */
export const cacheReadUsd = (tier: Tier, tokens: number): number => tokens * perToken(priceOf(tier).input) * priceOf(tier).cacheReadMult;

/** $ per million tokens to read from the cache of `tier` (the rate `cacheReadUsd` charges, not a $ amount). */
export const cacheReadRate = (tier: Tier, model?: string | null): number => priceOf(tier, model).input * priceOf(tier, model).cacheReadMult;

/** $ per million tokens to write into the cache of `tier` at `ttl` (the rate `cacheWriteUsd` charges, not a $ amount). */
export const cacheWriteRate = (tier: Tier, ttl: CacheTtl): number => priceOf(tier).input * CACHE_WRITE_MULT[ttl];

/** $ more the next request pays when a cached prefix of `tokens` on `model` has lapsed: written again instead of read. */
export const cacheLapseUsd = (tier: Tier, model: string | null, tokens: number, ttl: CacheTtl): number => {
  const p = priceOf(tier, model);
  return (tokens * p.input * (CACHE_WRITE_MULT[ttl] - p.cacheReadMult)) / 1_000_000;
};

/** Token counts of one response, as `usage` in the decision log. */
export interface UsageTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}

/** $ list-price estimate of one response's usage on `model` of `tier` (used by `reflex report`; an estimate, see the caveats at the top of this file). */
export const usageCostUsd = (tier: Tier, u: UsageTokens, ttl: CacheTtl, model?: string | null): number => {
  const p = priceOf(tier, model);
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * p.cacheReadMult + u.cacheCreate * p.input * CACHE_WRITE_MULT[ttl]) / 1_000_000;
};
