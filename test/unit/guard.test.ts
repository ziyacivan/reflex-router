import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guard, type GuardInput } from "../../src/guard.js";
import { parseOverride } from "../../src/overrides.js";
import { cacheReadUsd, cacheWriteUsd, LAST_VERIFIED, priceOf, PRICES, usageCostUsd, type UsageTokens } from "../../src/pricing.js";
import { isVerifiedRetarget } from "../../src/wire/rewrite.js";

// The guard tests below were written for Haiku 4.5 prices ($1 / $5); Haiku 5.5 (the default) has its own tests.
const H45 = "claude-haiku-4-5-20251001";
const base: GuardInput = { cacheTier: "sonnet", to: "haiku", toModel: H45, ctxTokens: 40_000, ttl: "1h", fresh: false, maxPenaltyUsd: 0.01, perRequest: null, breakevenRequests: 10 };

describe("pricing", () => {
  it("matches the pricing page as verified (per MTok) and carries the verification date", () => {
    assert.deepEqual(PRICES.haiku, { input: 0.1, output: 0.5, cacheReadMult: 0.1, long: { input: 0.5, output: 2.5 } }, "the Haiku tier default is Haiku 5.5");
    assert.deepEqual(PRICES.sonnet, { input: 2, output: 10, cacheReadMult: 0.05 }, "Sonnet 5.5: cache hits at 0.05x (pricing page 2026-10-08)");
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
    assert.deepEqual(priceOf("sonnet", "claude-sonnet-5"), { input: 2, output: 10, cacheReadMult: 0.1 }, "Sonnet 5 reads its cache at 0.1x");
    assert.deepEqual(priceOf("sonnet", "claude-sonnet-5-5[1m]"), PRICES.sonnet, "Sonnet 5.5 is the Sonnet tier default");
    assert.deepEqual(priceOf("fable", "claude-fable-5-1"), PRICES.fable);
    assert.deepEqual(priceOf("fable", "claude-fable-5"), { input: 10, output: 50, cacheReadMult: 0.1 }, "Fable 5 reads its cache at 0.1x");
  });
  it("Haiku 5.5 is priced by prompt length: up to 100,000 tokens, then the higher rates; Haiku 4.5 keeps $1 / $5", () => {
    const h55 = "claude-haiku-5-5";
    assert.deepEqual(priceOf("haiku", h55), { input: 0.1, output: 0.5, cacheReadMult: 0.1, long: { input: 0.5, output: 2.5 } });
    assert.deepEqual(priceOf("haiku", "claude-haiku-4-5-20251001"), { input: 1, output: 5, cacheReadMult: 0.1 });
    assert.deepEqual(priceOf("haiku", null), PRICES.haiku, "no model: the tier default, Haiku 5.5");
    const u = (input: number, cacheRead: number, cacheCreate: number, output: number): UsageTokens => ({ input, output, cacheRead, cacheCreate });
    const close = (a: number, b: number, why = ""): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b} ${why}`);
    // Pricing page: input $0.10, output $0.50, 1h write $0.20, cache read $0.01 per MTok up to 100,000 prompt tokens.
    close(usageCostUsd("haiku", u(0, 40_000, 10_000, 1_000), "1h", h55), (40_000 * 0.01 + 10_000 * 0.2 + 1_000 * 0.5) / 1e6);
    close(usageCostUsd("haiku", u(0, 90_000, 10_000, 0), "1h", h55), (90_000 * 0.01 + 10_000 * 0.2) / 1e6, "exactly 100,000 is still the lower price");
    // Over 100,000: input $0.50, output $2.50, 1h write $1, cache read $0.05 per MTok.
    close(usageCostUsd("haiku", u(0, 120_000, 30_000, 1_000), "1h", h55), (120_000 * 0.05 + 30_000 * 1 + 1_000 * 2.5) / 1e6);
    close(usageCostUsd("haiku", u(0, 120_000, 30_000, 1_000), "1h", "claude-haiku-4-5-20251001"), (120_000 * 0.1 + 30_000 * 2 + 1_000 * 5) / 1e6, "Haiku 4.5 has one price");
    close(cacheWriteUsd("haiku", 50_000, "5m"), (50_000 * 0.125) / 1e6);
    close(cacheWriteUsd("haiku", 50_000, "1h", H45), (50_000 * 2) / 1e6, "an explicit model beats the tier default");
    close(cacheWriteUsd("haiku", 200_000, "1h"), (200_000 * 1) / 1e6, "over 100,000 tokens: $1 per MTok");
  });
  it("cache write is 1.25x (5m) / 2x (1h) of input, read 0.1x (0.025x on Fable)", () => {
    assert.equal(cacheWriteUsd("haiku", 1_000_000, "5m", "claude-haiku-4-5-20251001"), 1.25);
    assert.equal(cacheWriteUsd("sonnet", 1_000_000, "1h"), 4);
    assert.ok(Math.abs(cacheReadUsd("sonnet", 1_000_000) - 0.1) < 1e-12, "Sonnet 5.5: 0.05x");
    assert.ok(Math.abs(cacheReadUsd("sonnet", 1_000_000, "claude-sonnet-5") - 0.2) < 1e-12, "Sonnet 5: 0.1x");
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
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 2 * 1 - 40_000 * 2 * 0.05) / 1e6) < 1e-12);
  });
  it("a small context passes; the limit is a ceiling", () => {
    assert.equal(guard({ ...base, ctxTokens: 5_000 }).allowed, true);
    const exact = (5_000 * 2 - 5_000 * 0.1) / 1e6;
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact + 1e-12 }).reason, "within_limit");
    assert.equal(guard({ ...base, ctxTokens: 5_000, maxPenaltyUsd: exact - 1e-9 }).reason, "over_limit");
  });
  it("break-even: allowed when N requests at the conversation's own averages recover the penalty", () => {
    // Opus 5.5 -> Sonnet at 100k (1h): penalty = 100k * (4 - 0.2) = $0.38; reads cost the same on both.
    const g: GuardInput = { ...base, cacheTier: "opus", to: "sonnet", toModel: null, ctxTokens: 100_000, perRequest: { write: 5_000, output: 1_500 } };
    const saving = (5_000 * (8 - 4) + 1_500 * (20 - 10) + 100_000 * (0.2 - 0.1)) / 1e6; // $0.045 per request: Sonnet 5.5 also reads its cache at $0.10, Opus 5.5 at $0.20
    const r = guard({ ...g, breakevenRequests: 8 });
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - 0.38) < 1e-9);
    assert.ok(Math.abs((r.savingUsd ?? 0) - saving) < 1e-12);
    assert.deepEqual([guard({ ...g, breakevenRequests: 8 }).allowed, guard({ ...g, breakevenRequests: 8 }).reason], [false, "over_limit"]); // 8 x $0.045 < $0.38
    assert.deepEqual([guard({ ...g, breakevenRequests: 9 }).allowed, guard({ ...g, breakevenRequests: 9 }).reason], [true, "breakeven"]);
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
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - (40_000 * 1.25 - 40_000 * 0.1) / 1e6) < 1e-12);
  });
});

describe("guard with Haiku 5.5 (the default Haiku model)", () => {
  const H55 = "claude-haiku-5-5";
  it("a 40k context moves from Sonnet's cache to Haiku 5.5 inside the $0.01 limit: the penalty is $0.004", () => {
    const r = guard({ ...base, toModel: H55 });
    assert.equal(r.allowed, true);
    assert.equal(r.reason, "within_limit");
    // write(Haiku 5.5, 40k, 1h) = 40k * $0.10 * 2 = $0.008; read(Sonnet 5.5, 40k) = 40k * $2 * 0.05 = $0.004
    assert.ok(Math.abs((r.penaltyUsd ?? 1) - 0.004) < 1e-12);
  });
  it("the same move to Haiku 4.5 is over the limit, so the model decides, not the tier", () => {
    assert.equal(guard({ ...base, toModel: H45 }).reason, "over_limit");
  });
  it("past 100,000 tokens the higher Haiku 5.5 rates apply to the write", () => {
    const r = guard({ ...base, toModel: H55, ctxTokens: 150_000, maxPenaltyUsd: 10 });
    // write = 150k * $0.50 * 2 = $0.15; read(Sonnet 5.5) = 150k * $2 * 0.05 = $0.015
    assert.ok(Math.abs((r.penaltyUsd ?? 0) - 0.135) < 1e-9);
  });
  it("the cache holder's model prices the read: a Haiku 4.5 cache is more expensive to leave than a Haiku 5.5 one", () => {
    const a = guard({ ...base, cacheTier: "haiku", cacheModel: H55, to: "sonnet", toModel: "claude-sonnet-5-5", ctxTokens: 40_000, maxPenaltyUsd: 10 });
    const b = guard({ ...base, cacheTier: "haiku", cacheModel: H45, to: "sonnet", toModel: "claude-sonnet-5-5", ctxTokens: 40_000, maxPenaltyUsd: 10 });
    assert.ok((a.penaltyUsd ?? 0) > (b.penaltyUsd ?? 0));
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

describe("verified retargets: Haiku 5.5", () => {
  const H = "claude-haiku-5-5";
  it("Haiku 5.5 to and from Sonnet 5.5, Opus 5.5, Fable 5.1, Sonnet 5 and Opus 5 is verified", () => {
    for (const [t, m] of [["sonnet", "claude-sonnet-5-5"], ["opus", "claude-opus-5-5"], ["opus", "claude-opus-5-5[1m]"], ["fable", "claude-fable-5-1"]] as const) {
      assert.equal(isVerifiedRetarget("haiku", t, H, m), true, `${H} > ${m}`);
      assert.equal(isVerifiedRetarget(t, "haiku", m, H), true, `${m} > ${H}`);
    }
    for (const [t, m] of [["sonnet", "claude-sonnet-5"], ["opus", "claude-opus-5"]] as const) {
      assert.equal(isVerifiedRetarget("haiku", t, H, m), true, `${H} > ${m}`);
      assert.equal(isVerifiedRetarget(t, "haiku", m, H), true, `${m} > ${H}`);
    }
    assert.equal(isVerifiedRetarget("haiku", "haiku", H, "claude-haiku-4-5-20251001"), false, "same tier: never a retarget");
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

  it("Sonnet 5.5 to and from Haiku, Opus 5.5, Opus 5 and Fable is verified", () => {
    for (const s55 of ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]) {
      for (const [t, m] of [["haiku", M.haiku], ["opus", "claude-opus-5-5"], ["opus", "claude-opus-5-5[1m]"], ["fable", M.fable]] as const) {
        assert.equal(isVerifiedRetarget("sonnet", t, s55, m), true, `${s55} > ${m}`);
        assert.equal(isVerifiedRetarget(t, "sonnet", m, s55), true, `${m} > ${s55}`);
      }
      assert.equal(isVerifiedRetarget("sonnet", "opus", s55, M.opus), true);
      assert.equal(isVerifiedRetarget("opus", "sonnet", M.opus, s55), true);
      assert.equal(isVerifiedRetarget("sonnet", "sonnet", M.sonnet, s55), false, "same tier: never a retarget");
    }
  });
});
