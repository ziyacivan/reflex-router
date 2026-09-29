import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guard, type GuardInput } from "../../src/guard.js";
import { parseOverride } from "../../src/overrides.js";
import { cacheReadUsd, cacheWriteUsd, LAST_VERIFIED, priceOf, PRICES } from "../../src/pricing.js";
import { isVerifiedRetarget } from "../../src/wire/rewrite.js";

const base: GuardInput = { cacheTier: "sonnet", to: "haiku", ctxTokens: 40_000, ttl: "1h", fresh: false, maxPenaltyUsd: 0.01, perRequest: null, breakevenRequests: 10 };

describe("pricing", () => {
  it("matches the pricing page as verified (per MTok) and carries the verification date", () => {
    assert.deepEqual(PRICES.haiku, { input: 1, output: 5, cacheReadMult: 0.1 });
    assert.deepEqual(PRICES.sonnet, { input: 2, output: 10, cacheReadMult: 0.1 });
    assert.deepEqual(PRICES.opus, { input: 4, output: 20, cacheReadMult: 0.05 });
    assert.deepEqual(PRICES.fable, { input: 10, output: 50, cacheReadMult: 0.025 });
    assert.match(LAST_VERIFIED, /^\d{4}-\d{2}-\d{2}$/);
  });
  it("prices an older Opus at its own rate, Opus 5.5 and unknown models at the tier default", () => {
    const opus5 = { input: 5, output: 25, cacheReadMult: 0.1 };
    assert.deepEqual(priceOf("opus", "claude-opus-5[1m]"), opus5);
    assert.deepEqual(priceOf("opus", "claude-opus-4-8"), opus5);
    assert.deepEqual(priceOf("opus", "claude-opus-5-5[1m]"), PRICES.opus);
    assert.deepEqual(priceOf("opus", null), PRICES.opus);
    assert.deepEqual(priceOf("sonnet", "claude-sonnet-5"), PRICES.sonnet);
    assert.deepEqual(priceOf("sonnet", "claude-sonnet-5-5[1m]"), PRICES.sonnet, "Sonnet 5.5 keeps Sonnet 5's price");
    assert.deepEqual(priceOf("fable", "claude-fable-5-1"), PRICES.fable);
    assert.deepEqual(priceOf("fable", "claude-fable-5"), { input: 10, output: 50, cacheReadMult: 0.1 }, "Fable 5 reads its cache at 0.1x");
  });
  it("cache write is 1.25x (5m) / 2x (1h) of input, read 0.1x (0.025x on Fable)", () => {
    assert.equal(cacheWriteUsd("haiku", 1_000_000, "5m"), 1.25);
    assert.equal(cacheWriteUsd("sonnet", 1_000_000, "1h"), 4);
    assert.ok(Math.abs(cacheReadUsd("sonnet", 1_000_000) - 0.2) < 1e-12);
    assert.ok(Math.abs(cacheReadUsd("fable", 1_000_000) - 0.25) < 1e-12);
  });
});

describe("guard", () => {
  it("a fresh conversation has nothing cached: allowed", () => {
    assert.deepEqual(guard({ ...base, fresh: true, ctxTokens: null, cacheTier: null }), { allowed: true, reason: "fresh", ctx: null, penaltyUsd: null, savingUsd: null });
  });
  it("staying on the tier that holds the cache costs nothing", () => {
    assert.equal(guard({ ...base, cacheTier: "haiku" }).reason, "no_switch");
  });
  it("unknown context refuses", () => {
    assert.deepEqual(guard({ ...base, ctxTokens: null }), { allowed: false, reason: "ctx_unknown", ctx: null, penaltyUsd: null, savingUsd: null });
  });
  it("penalty = write(to, ctx, ttl) - read(from, ctx); 40k context on the 1h main chat is over $0.01", () => {
    const r = guard(base);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, "over_limit");
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 2 * 1 - 40_000 * 0.1 * 2) / 1e6) < 1e-12);
  });
  it("a small context passes; the limit is a ceiling", () => {
    assert.equal(guard({ ...base, ctxTokens: 5_000 }).allowed, true);
    const exact = (5_000 * 2 - 5_000 * 0.2) / 1e6;
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact + 1e-12 }).reason, "within_limit");
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact - 1e-9 }).reason, "over_limit");
  });
  it("break-even: allowed when N requests at the conversation's own averages recover the penalty", () => {
    // Opus 5.5 -> Sonnet at 100k (1h): penalty = 100k * (4 - 0.2) = $0.38; reads cost the same on both.
    const g: GuardInput = { ...base, cacheTier: "opus", to: "sonnet", ctxTokens: 100_000, perRequest: { write: 5_000, output: 1_500 } };
    const saving = (5_000 * (8 - 4) + 1_500 * (20 - 10)) / 1e6; // $0.035 per request
    const r = guard(g);
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - 0.38) < 1e-9);
    assert.ok(Math.abs((r.savingUsd ?? 0) - saving) < 1e-12);
    assert.deepEqual([r.allowed, r.reason], [false, "over_limit"]); // 10 x $0.035 < $0.38
    assert.deepEqual([guard({ ...g, breakevenRequests: 11 }).allowed, guard({ ...g, breakevenRequests: 11 }).reason], [true, "breakeven"]);
    assert.equal(guard({ ...g, breakevenRequests: 0, perRequest: { write: 1e6, output: 1e6 } }).allowed, false); // 0 = off
    assert.equal(guard({ ...g, perRequest: null }).reason, "over_limit"); // no averages yet: only the $ limit
  });
  it("break-even counts the cheaper cache read on every request (Opus 5.5 -> Haiku)", () => {
    const r = guard({ ...base, cacheTier: "opus", to: "haiku", ctxTokens: 100_000, perRequest: { write: 0, output: 0 } });
    assert.ok(Math.abs((r.savingUsd ?? 0) - 100_000 * (0.2 - 0.1) / 1e6) < 1e-12);
    assert.equal(r.allowed, false); // $0.18 penalty vs 10 x $0.01
  });
  it("uses the 5-minute write multiplier when the request has no 1h TTL", () => {
    const r = guard({ ...base, ttl: "5m", maxPenaltyUsd: 1 });
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 1.25 - 40_000 * 0.2) / 1e6) < 1e-12);
  });
});

describe("overrides", () => {
  it("a leading reflex:<tier> token, case-insensitive; anything else is not an override", () => {
    assert.equal(parseOverride("reflex:opus fix the race"), "opus");
    assert.equal(parseOverride("  REFLEX:Haiku list files"), "haiku");
    assert.equal(parseOverride("reflex:sonnet"), "sonnet");
    assert.equal(parseOverride("reflex:haiku\nnext line"), "haiku");
    for (const t of ["fix reflex:opus", "reflex:opuses", "reflex:fable x", "reflex: opus", "!haiku x", "", null]) assert.equal(parseOverride(t), null, String(t));
  });
});

describe("verified retargets", () => {
  const M = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5", opus: "claude-opus-5", fable: "claude-fable-5-1" } as const;
  it("every pair among Haiku, Sonnet, Opus 5 and Fable was verified against the API", () => {
    for (const [f, t] of [["sonnet", "haiku"], ["opus", "sonnet"], ["opus", "haiku"], ["haiku", "sonnet"], ["haiku", "opus"], ["sonnet", "opus"], ["fable", "haiku"], ["fable", "sonnet"], ["fable", "opus"], ["haiku", "fable"], ["sonnet", "fable"], ["opus", "fable"]] as const) assert.equal(isVerifiedRetarget(f, t, M[f], M[t]), true);
    for (const [f, t] of [["haiku", "haiku"], ["opus", "opus"]] as const) assert.equal(isVerifiedRetarget(f, t, M[f], M[t]), false);
  });

  it("Opus 5.5 to and from Haiku, Sonnet and Fable is verified", () => {
    assert.equal(isVerifiedRetarget("opus", "haiku", "claude-opus-5-5[1m]", M.haiku), true);
    assert.equal(isVerifiedRetarget("opus", "sonnet", "claude-opus-5-5", M.sonnet), true);
    assert.equal(isVerifiedRetarget("sonnet", "opus", M.sonnet, "claude-opus-5-5"), true);
    assert.equal(isVerifiedRetarget("haiku", "opus", M.haiku, "claude-opus-5-5"), true);
    assert.equal(isVerifiedRetarget("opus", "fable", "claude-opus-5-5", M.fable), true);
    assert.equal(isVerifiedRetarget("fable", "opus", M.fable, "claude-opus-5-5"), true);
    assert.equal(isVerifiedRetarget("opus", "opus", "claude-opus-5-5", "claude-opus-5-5"), false);
  });

  it("Sonnet 5.5 to and from Haiku, Opus 5.5 and Fable is verified; to and from Opus 5 it is not", () => {
    for (const s55 of ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]) {
      for (const [t, m] of [["haiku", M.haiku], ["opus", "claude-opus-5-5"], ["opus", "claude-opus-5-5[1m]"], ["fable", M.fable]] as const) {
        assert.equal(isVerifiedRetarget("sonnet", t, s55, m), true, `${s55} > ${m}`);
        assert.equal(isVerifiedRetarget(t, "sonnet", m, s55), true, `${m} > ${s55}`);
      }
      assert.equal(isVerifiedRetarget("sonnet", "opus", s55, M.opus), false, "Opus 5 <-> Sonnet 5.5 was not run");
      assert.equal(isVerifiedRetarget("opus", "sonnet", M.opus, s55), false);
      assert.equal(isVerifiedRetarget("sonnet", "sonnet", M.sonnet, s55), false, "same tier: never a retarget");
    }
  });
});
