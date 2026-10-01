import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, type Config, type Tier } from "../../src/config.js";
import { buildQuestions, judge, massPick, offeredTiers, plan, type PlanInput } from "../../src/policy.js";
import { estimateTokens, fitsContext, tierOfModel } from "../../src/tiers.js";
import type { Decision, Judgement } from "../../src/types.js";

const cfg = (env: NodeJS.ProcessEnv = {}): Config => {
  const r = loadConfig(env);
  assert.ok(r.ok, r.ok ? "" : r.errors.join());
  return r.config;
};
/** A judgement read with the `argmax` rule (the confidence floor applies). */
const j = (tier: Tier, confidence: number, reasoning?: number): Judgement => ({
  tier: { value: tier, confidence, probabilities: { [tier]: confidence } },
  rule: "argmax",
  readings: { mass: { value: tier, aboveMass: 0 }, argmax: { value: tier, confidence } },
  vetoes: reasoning === undefined ? {} : { reasoning_demand: reasoning },
});
const sub = (model: string): PlanInput => ({ kind: "subagent", requestedModel: model });

describe("tierOfModel", () => {
  it("maps model ids by family and returns null for unknown ones", () => {
    assert.equal(tierOfModel("claude-haiku-4-5-20251001"), "haiku");
    assert.equal(tierOfModel("claude-sonnet-5"), "sonnet");
    assert.equal(tierOfModel("claude-opus-5[1m]"), "opus");
    assert.equal(tierOfModel("claude-fable-5-1"), "fable");
    assert.equal(tierOfModel("gpt-5"), null);
    assert.equal(tierOfModel(null), null);
  });
});

describe("questions", () => {
  it("offer haiku/sonnet/opus, and fable only when explicitly allowed", () => {
    const q = buildQuestions(cfg());
    assert.equal(q["tier"]?.type, "choice");
    assert.deepEqual(Object.keys((q["tier"] as { criteria: object }).criteria), ["haiku", "sonnet", "opus"]);
    assert.deepEqual(offeredTiers(cfg({ REFLEX_ALLOW_FABLE: "1" })), ["haiku", "sonnet", "opus", "fable"]);
    const rd = q["reasoning_demand"];
    assert.ok(rd?.type === "score" && rd.criteria.length === 5);
  });

  it("tell the backend to judge reasoning, not length", () => {
    const text = JSON.stringify(buildQuestions(cfg())["tier"]);
    assert.match(text, /reasoning the task demands/);
    assert.match(text, /length of the message.*NOT the measure/);
  });
});

describe("judge", () => {
  const decision = (answers: Decision["answers"]): Decision => ({ answers, latencyMs: 1, backendModel: "m", tokensIn: 1, connection: null });
  const tierA = { type: "choice" as const, choice: "haiku", confidence: 0.8, probabilities: { haiku: 0.8, sonnet: 0.2 } };
  const rdA = { type: "score" as const, score: 0.7, confidence: 0.5, probabilities: {} };

  it("merges the tier pick and the reasoning_demand veto", () => {
    const r = judge(decision({ tier: tierA, reasoning_demand: rdA }), cfg());
    assert.ok(r.ok);
    assert.equal(r.judgement.tier.value, "sonnet", "mass: 0.2 on sonnet is above eps, so haiku is not safe");
    assert.deepEqual(r.judgement.readings, { mass: { value: "sonnet", aboveMass: 0 }, argmax: { value: "haiku", confidence: 0.8 } });
    assert.equal(r.judgement.vetoes["reasoning_demand"], 0.7);
    const a = judge(decision({ tier: tierA, reasoning_demand: rdA }), cfg({ REFLEX_DECISION_RULE: "argmax" }));
    assert.ok(a.ok);
    assert.equal(a.judgement.tier.value, "haiku");
  });

  it("a missing or mistyped answer, or a tier that was not offered, is an error (the caller fails open)", () => {
    assert.equal(judge(decision({ tier: tierA }), cfg()).ok, false);
    assert.equal(judge(decision({ tier: rdA, reasoning_demand: rdA }), cfg()).ok, false);
    assert.equal(judge(decision({ tier: { ...tierA, choice: "fable" }, reasoning_demand: rdA }), cfg()).ok, false);
  });
});

describe("plan (decision table)", () => {
  const c = cfg();
  const cases: [string, PlanInput, Judgement, Config, Tier | null, string[], boolean][] = [
    ["confident, low-demand downgrade to haiku", sub("claude-sonnet-5"), j("haiku", 0.9, 0.5), c, "haiku", ["downgrade"], false],
    ["downgrade blocked by low confidence", sub("claude-sonnet-5"), j("haiku", 0.69, 0.2), c, null, ["low_confidence"], false],
    ["exactly at the confidence floor is allowed", sub("claude-sonnet-5"), j("haiku", 0.7, 0.2), c, "haiku", ["downgrade"], false],
    ["haiku vetoed by reasoning_demand > 1.0", sub("claude-sonnet-5"), j("haiku", 0.95, 1.4), c, null, ["veto_reasoning_demand"], false],
    ["missing reasoning_demand vetoes a downgrade", sub("claude-sonnet-5"), j("haiku", 0.95), c, null, ["veto_reasoning_demand"], false],
    ["opus -> sonnet allowed at demand 2.5", sub("claude-opus-5"), j("sonnet", 0.8, 2.5), c, "sonnet", ["downgrade"], false],
    ["opus -> sonnet vetoed above 2.5", sub("claude-opus-5"), j("sonnet", 0.8, 2.6), c, null, ["veto_reasoning_demand"], false],
    ["same tier: nothing to do", sub("claude-sonnet-5"), j("sonnet", 0.99, 2), c, null, ["same_tier"], false],
    ["upgrade disabled by default, logged as would_upgrade", sub("claude-haiku-4-5-20251001"), j("opus", 0.99, 4), c, null, ["upgrade_disabled"], true],
    ["upgrade on", sub("claude-haiku-4-5-20251001"), j("opus", 0.5, 4), cfg({ REFLEX_UPGRADES: "on" }), "opus", ["upgrade"], true],
    ["upgrade confident needs confidence", sub("claude-haiku-4-5-20251001"), j("opus", 0.5, 4), cfg({ REFLEX_UPGRADES: "confident" }), null, ["upgrade_low_confidence"], true],
    ["clamp steps UP to the next enabled tier", sub("claude-opus-5"), j("haiku", 0.9, 0.2), cfg({ REFLEX_TIERS: "sonnet,opus" }), "sonnet", ["downgrade", "clamped_up"], false],
    ["no enabled tier between chosen and requested: no change (never steps down)", sub("claude-sonnet-5"), j("haiku", 0.9, 0.2), cfg({ REFLEX_TIERS: "opus" }), null, ["no_enabled_tier"], false],
    ["unknown requested model: never routed", sub("some-other-model"), j("haiku", 0.9, 0.2), c, null, ["requested_tier_unknown"], false],
    ["main chat with REFLEX_MAIN_CHAT=never", { kind: "main", requestedModel: "claude-sonnet-5" }, j("haiku", 0.9, 0.2), cfg({ REFLEX_MAIN_CHAT: "never" }), null, ["main_chat_disabled"], false],
    ["main chat (guarded): the policy plans; the router applies the cost guard", { kind: "main", requestedModel: "claude-sonnet-5" }, j("haiku", 0.9, 0.2), c, "haiku", ["downgrade"], false],
    ["fable as an upgrade target is not enabled unless allowed", sub("claude-opus-5"), j("fable", 0.99, 4), cfg({ REFLEX_UPGRADES: "on" }), null, ["no_enabled_tier"], true],
    ["fable allowed", sub("claude-opus-5"), j("fable", 0.99, 4), cfg({ REFLEX_UPGRADES: "on", REFLEX_ALLOW_FABLE: "1" }), "fable", ["upgrade"], true],
  ];
  for (const [name, input, judgement, config, target, reasons, wouldUpgrade] of cases) {
    it(name, () => {
      const p = plan(input, judgement, config);
      assert.equal(p.target?.tier ?? null, target);
      assert.deepEqual(p.reasons, reasons);
      assert.equal(p.wouldUpgrade, wouldUpgrade);
    });
  }
});

// The twelve decisions of the first shadow dogfood session (docs/observations.md), probability vectors as
// Jev returned them. Requested tier: opus for all.
const SHADOW1: { probs: Record<string, number>; confidence: number; rd: number; argmax: Tier; mass: Tier; lowConfidence: boolean }[] = [
  { probs: { haiku: 1, sonnet: 0, opus: 0 }, confidence: 0.99, rd: 0.16, argmax: "haiku", mass: "haiku", lowConfidence: false },
  { probs: { sonnet: 0.9, opus: 0.01, haiku: 0.09 }, confidence: 0.85, rd: 1.16, argmax: "sonnet", mass: "sonnet", lowConfidence: false },
  { probs: { haiku: 0.93, sonnet: 0.07, opus: 0 }, confidence: 0.9, rd: 0.5, argmax: "haiku", mass: "haiku", lowConfidence: false },
  { probs: { sonnet: 0.55, opus: 0, haiku: 0.45 }, confidence: 0.32, rd: 1.04, argmax: "sonnet", mass: "sonnet", lowConfidence: true }, // the subagent turn
  { probs: { sonnet: 0.05, opus: 0, haiku: 0.95 }, confidence: 0.93, rd: 0.85, argmax: "haiku", mass: "haiku", lowConfidence: false },
  { probs: { opus: 0, haiku: 0.73, sonnet: 0.27 }, confidence: 0.59, rd: 1.01, argmax: "haiku", mass: "sonnet", lowConfidence: true },
  { probs: { opus: 0.01, sonnet: 0.5, haiku: 0.49 }, confidence: 0.25, rd: 0.83, argmax: "sonnet", mass: "sonnet", lowConfidence: true },
  { probs: { haiku: 1, opus: 0, sonnet: 0 }, confidence: 1, rd: 0.01, argmax: "haiku", mass: "haiku", lowConfidence: false },
  { probs: { haiku: 0, sonnet: 0.24, opus: 0.76 }, confidence: 0.63, rd: 3.24, argmax: "opus", mass: "opus", lowConfidence: false },
  { probs: { opus: 0.09, haiku: 0.62, sonnet: 0.29 }, confidence: 0.42, rd: 1.35, argmax: "haiku", mass: "sonnet", lowConfidence: true },
  { probs: { haiku: 0.36, sonnet: 0.62, opus: 0.02 }, confidence: 0.43, rd: 1.05, argmax: "sonnet", mass: "sonnet", lowConfidence: true },
  { probs: { haiku: 0.92, opus: 0, sonnet: 0.08 }, confidence: 0.87, rd: 0.75, argmax: "haiku", mass: "haiku", lowConfidence: false },
];

describe("decision rule: mass vs argmax on the shadow-1 vectors", () => {
  const decisionFor = (v: (typeof SHADOW1)[number]): Decision => ({
    answers: {
      tier: { type: "choice", choice: v.argmax, confidence: v.confidence, probabilities: v.probs },
      reasoning_demand: { type: "score", score: v.rd, confidence: 0.5, probabilities: {} },
    },
    latencyMs: 1,
    backendModel: "m",
    tokensIn: 1,
    connection: null,
  });
  const opusReq: PlanInput = { kind: "subagent", requestedModel: "claude-opus-5" };

  it("the five low-confidence turns all pick sonnet under mass/0.10, and are downgraded from opus to sonnet", () => {
    const low = SHADOW1.filter((v) => v.lowConfidence);
    assert.equal(low.length, 5);
    for (const v of low) {
      const r = judge(decisionFor(v), cfg());
      assert.ok(r.ok);
      assert.equal(r.judgement.rule, "mass");
      assert.equal(r.judgement.tier.value, "sonnet", JSON.stringify(v.probs));
      const p = plan(opusReq, r.judgement, cfg());
      assert.equal(p.target?.tier, "sonnet");
      assert.deepEqual(p.reasons, ["downgrade"]);
    }
  });

  it("under argmax the same five stay on opus (low_confidence), as they did in shadow-1", () => {
    for (const v of SHADOW1.filter((x) => x.lowConfidence)) {
      const r = judge(decisionFor(v), cfg({ REFLEX_DECISION_RULE: "argmax" }));
      assert.ok(r.ok);
      assert.deepEqual(plan(opusReq, r.judgement, cfg({ REFLEX_DECISION_RULE: "argmax" })).reasons, ["low_confidence"]);
    }
  });

  it("the confident picks are unchanged: haiku 1.0 (x2), haiku 0.95, opus 0.76", () => {
    const confident = SHADOW1.filter((v) => (v.argmax === "haiku" && ((v.probs["haiku"] ?? 0) >= 0.95)) || v.argmax === "opus");
    assert.equal(confident.length, 4);
    for (const v of confident) assert.equal(massPick(v.probs, ["haiku", "sonnet", "opus"], 0.1).value, v.argmax);
  });

  it("every one of the twelve: both readings are computed and match the expectations above", () => {
    for (const v of SHADOW1) {
      const r = judge(decisionFor(v), cfg());
      assert.ok(r.ok);
      assert.equal(r.judgement.readings.argmax.value, v.argmax);
      assert.equal(r.judgement.readings.mass.value, v.mass, JSON.stringify(v.probs));
    }
  });

  it("massPick: never undercuts a tier above eps, sums the mass of all higher tiers, respects the offered set", () => {
    assert.deepEqual(massPick({ haiku: 0.8, sonnet: 0.09, opus: 0.11 }, ["haiku", "sonnet", "opus"], 0.1), { value: "opus", aboveMass: 0 });
    assert.deepEqual(massPick({ haiku: 0.84, sonnet: 0.08, opus: 0.08 }, ["haiku", "sonnet", "opus"], 0.1).value, "sonnet", "0.08 + 0.08 above haiku is more than eps");
    assert.deepEqual(massPick({ haiku: 0.9, sonnet: 0.1, opus: 0 }, ["haiku", "sonnet", "opus"], 0.1), { value: "haiku", aboveMass: 0.1 }, "exactly eps is allowed");
    assert.equal(massPick({ haiku: 0.5, sonnet: 0.5 }, ["haiku", "sonnet", "opus"], 0).value, "sonnet", "eps 0: only tiers with zero mass above");
    assert.equal(massPick({ haiku: 0.5, sonnet: 0.3, opus: 0.1, fable: 0.1 }, ["haiku", "sonnet", "opus", "fable"], 0.1).value, "opus");
  });

  it("config: mass is the default; eps is bounded", () => {
    assert.equal(cfg().decisionRule, "mass");
    assert.equal(cfg().massEps, 0.1);
    assert.equal(cfg({ REFLEX_MASS_EPS: "0.05" }).massEps, 0.05);
    assert.equal(loadConfig({ REFLEX_MASS_EPS: "0.9" }).ok, false);
    assert.equal(loadConfig({ REFLEX_DECISION_RULE: "vote" }).ok, false);
  });
});

describe("per-tier context ceiling (Haiku: 150k estimated tokens)", () => {
  const opus = (ctx: number | null): PlanInput => ({ kind: "subagent", requestedModel: "claude-opus-5", contextTokens: ctx });
  it("over the ceiling, Haiku is not a candidate: the pick moves to the next tier up", () => {
    const p = plan(opus(160_000), j("haiku", 0.95, 0.2), cfg());
    assert.equal(p.target?.tier, "sonnet");
    assert.deepEqual(p.reasons, ["downgrade", "context_ceiling"]);
  });
  it("exactly at the ceiling, or unknown context, Haiku is still a candidate", () => {
    assert.equal(plan(opus(150_000), j("haiku", 0.95, 0.2), cfg()).target?.tier, "haiku");
    assert.equal(plan(opus(null), j("haiku", 0.95, 0.2), cfg()).target?.tier, "haiku");
  });
  it("no enabled tier between the ceiling-excluded pick and the requested one: no change", () => {
    const p = plan(opus(160_000), j("haiku", 0.95, 0.2), cfg({ REFLEX_TIERS: "haiku,opus" }));
    assert.equal(p.target, null);
    assert.deepEqual(p.reasons, ["context_ceiling", "no_enabled_tier"]);
  });
  it("tiers without a ceiling are unaffected by size", () => {
    assert.equal(plan(opus(900_000), j("sonnet", 0.9, 2), cfg()).target?.tier, "sonnet");
  });
  it("the byte-based estimate over-estimates the measured 2.67-2.80 bytes/token slightly", () => {
    assert.equal(estimateTokens(191_626), 76_651); // measured: 68,643 tokens
    assert.equal(fitsContext("haiku", 150_001), false);
    assert.equal(fitsContext("sonnet", 10_000_000), true);
  });
});

describe("config for policy", () => {
  it("tier list is canonical, fable needs the explicit switch, unknown tiers are errors", () => {
    assert.deepEqual(cfg({ REFLEX_TIERS: "opus, haiku" }).tiers, ["haiku", "opus"]);
    const r = loadConfig({ REFLEX_TIERS: "fable,sonnet" });
    assert.ok(r.ok);
    assert.deepEqual(r.config.tiers, ["sonnet"]);
    assert.equal(r.warnings.length, 1);
    assert.equal(loadConfig({ REFLEX_TIERS: "gpt" }).ok, false);
  });

  it("model ids: REFLEX_MODEL_<TIER> > ANTHROPIC_DEFAULT_<TIER>_MODEL > built-in", () => {
    const c = cfg({ REFLEX_MODEL_HAIKU: "h1", ANTHROPIC_DEFAULT_HAIKU_MODEL: "h2", ANTHROPIC_DEFAULT_OPUS_MODEL: "o2" });
    assert.equal(c.models.haiku, "h1");
    assert.equal(c.models.opus, "o2");
    assert.equal(c.models.sonnet, "claude-sonnet-5-5");
  });

  it("numeric settings are bounded and named in errors", () => {
    const r = loadConfig({ REFLEX_JEV_DEADLINE_MS: "0" });
    assert.ok(!r.ok);
    assert.match(r.errors.join(), /REFLEX_JEV_DEADLINE_MS/);
    assert.equal(cfg({ REFLEX_SHAPE_CHECK_N: "3" }).shapeCheckN, 3);
  });

  it("REFLEX_LOG_PROMPTS is off by default and only on when explicitly truthy", () => {
    assert.equal(cfg({}).logPrompts, false);
    assert.equal(cfg({ REFLEX_LOG_PROMPTS: "0" }).logPrompts, false);
    assert.equal(cfg({ REFLEX_LOG_PROMPTS: "" }).logPrompts, false);
    assert.equal(cfg({ REFLEX_LOG_PROMPTS: "1" }).logPrompts, true);
    assert.equal(cfg({ REFLEX_LOG_PROMPTS: "true" }).logPrompts, true);
  });
});

describe("upgrades follow the backend's own answer, not the mass margin", () => {
  /** A `mass` judgement: the mass reading says `mass`, the backend's own answer says `argmax`. */
  const m = (mass: Tier, argmax: Tier, confidence: number, reasoning = 2): Judgement => ({
    tier: { value: mass, confidence, probabilities: { [mass]: 0.4, [argmax]: confidence } },
    rule: "mass",
    readings: { mass: { value: mass, aboveMass: 0 }, argmax: { value: argmax, confidence } },
    vetoes: { reasoning_demand: reasoning },
  });
  const on = cfg({ REFLEX_UPGRADES: "on" });
  const sonnet = sub("claude-sonnet-5-5");

  it("a tail of mass on opus with sonnet as the backend's own answer keeps the model and asks for effort", () => {
    const p = plan(sonnet, m("opus", "sonnet", 0.7), on);
    assert.equal(p.target, null);
    assert.deepEqual(p.reasons, ["upgrade_to_effort"]);
    assert.equal(p.wouldUpgrade, false);
  });

  it("the backend's own answer being opus still upgrades, under the mass rule", () => {
    const p = plan(sonnet, m("opus", "opus", 0.45), on);
    assert.equal(p.target?.tier, "opus");
    assert.deepEqual(p.reasons, ["upgrade"]);
    assert.equal(p.wouldUpgrade, true);
  });

  it("the upgrade target is the backend's answer, not the mass pick above it", () => {
    const p = plan(sub("claude-haiku-4-5-20251001"), m("opus", "sonnet", 0.8), on);
    assert.equal(p.target?.tier, "sonnet");
  });

  it("`confident` gates on the argmax confidence whatever the decision rule", () => {
    const confident = cfg({ REFLEX_UPGRADES: "confident" });
    assert.deepEqual(plan(sonnet, m("opus", "opus", 0.69), confident).reasons, ["upgrade_low_confidence"]);
    assert.equal(plan(sonnet, m("opus", "opus", 0.7), confident).target?.tier, "opus");
  });

  it("with upgrades off nothing changes: logged as would_upgrade, no effort conversion", () => {
    const p = plan(sonnet, m("opus", "sonnet", 0.7), cfg());
    assert.deepEqual(p.reasons, ["upgrade_disabled"]);
    assert.equal(p.wouldUpgrade, true);
  });

  it("downgrades are untouched by the argmax reading (the mass margin was measured for them)", () => {
    const p = plan(sub("claude-opus-5-5"), m("sonnet", "haiku", 0.3, 1), on);
    assert.equal(p.target?.tier, "sonnet");
  });
});
