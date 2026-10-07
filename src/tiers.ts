import { TIERS, type Tier } from "./config.js";

/** Cheapest first. */
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

/** Tier of a model id by family name (claude-sonnet-5-5, claude-haiku-4-5-20251001, claude-opus-5[1m], ...); null if unknown. */
export function tierOfModel(model: string | null): Tier | null {
  if (model === null) return null;
  const m = model.toLowerCase();
  return TIERS.find((t) => m.includes(t)) ?? null;
}

/**
 * Largest estimated context a tier is routed with; null = no ceiling below the requested model's own window.
 * Set for Haiku 4.5, whose window is 200k tokens (150k leaves room for the reply and for growth within a tool loop). Haiku
 * 5.5, the default since 2026-10-07, takes 1M (a 905,642-token request answered 200) and prices a prompt over 100,000
 * tokens at five times the input rate, but no measurement says how well it works that deep, so the ceiling stays.
 */
export const CONTEXT_CEILING: Readonly<Record<Tier, number | null>> = { haiku: 150_000, sonnet: null, opus: null, fable: null };

/**
 * Largest `max_tokens` each tier's model accepts (models overview, synchronous Messages API, checked 2026-09-23). A
 * retarget lowers a larger value to this: an Opus 5.5 request asks for 128000, which Haiku 4.5 rejects with
 * 400 "max_tokens: 128000 > 64000" (2.1.280 log, 2026-09-22).
 */
export const MAX_OUTPUT_TOKENS: Readonly<Record<Tier, number>> = { haiku: 128_000, sonnet: 128_000, opus: 128_000, fable: 128_000 };

/**
 * Haiku 5.5 (the Haiku default) takes 128K like the other current models (400 above it: "max_tokens: 200000 > 128000",
 * 2.1.293 probe); any other Haiku model takes the 64K of Haiku 4.5.
 */
export const maxOutputTokens = (t: Tier, model: string | null): number => {
  const m = model?.toLowerCase() ?? "";
  return t === "haiku" && m.includes("haiku") && !m.includes("claude-haiku-5-5") ? 64_000 : MAX_OUTPUT_TOKENS[t];
};

/**
 * Request bytes per input token, measured on the interactive 2.1.277 capture: 2.67-2.80 (JSON body, tools included).
 * 2.5 over-estimates the token count slightly on purpose, so a ceiling is hit early rather than late.
 */
export const BYTES_PER_TOKEN_ESTIMATE = 2.5;
export const estimateTokens = (bodyBytes: number): number => Math.ceil(bodyBytes / BYTES_PER_TOKEN_ESTIMATE);

/** True when a request of `ctx` estimated tokens may be sent to `t` (unknown context never excludes a tier). */
export function fitsContext(t: Tier, ctx: number | null): boolean {
  const ceiling = CONTEXT_CEILING[t];
  return ctx === null || ceiling === null || ctx <= ceiling;
}
