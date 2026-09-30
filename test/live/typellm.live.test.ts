// Live tests against the real TypeLLM endpoint. Run with `npm run test:live`; they skip themselves without a
// TYPELLM_API_KEY. Cost: 2 decision calls (about 1,500 input tokens at TypeLLM's list price, well under a cent).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FEATURE_QUESTIONS, layaFeatures } from "../../src/backend/laya-calibration.js";
import { TypeLLMBackend } from "../../src/backend/typellm.js";
import { loadConfig, type Config } from "../../src/config.js";
import { buildQuestions, judge, offeredTiers, QUESTIONS } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";

const key = process.env["TYPELLM_API_KEY"]?.trim();
const skip = key ? false : "TYPELLM_API_KEY is not set";
const DEADLINE_MS = 10_000; // generous: these tests check shape, the product's own deadline is REFLEX_TYPELLM_DEADLINE_MS

const loaded = loadConfig({ REFLEX_ALLOW_FABLE: "" });
assert.ok(loaded.ok);
const cfg: Config = loaded.config;
const backend = (): TypeLLMBackend => new TypeLLMBackend({ baseUrl: process.env["REFLEX_TYPELLM_BASE_URL"]?.trim() || cfg.typellmBaseUrl, apiKey: key ?? "", deadlineMs: DEADLINE_MS });
const stateOf = (task: string) => buildState({ kind: "main", task, previousAssistantText: null, requestedModel: cfg.models.opus }, cfg).state;
const signal = (): { signal: AbortSignal } => ({ signal: new AbortController().signal });

describe("live TypeLLM", { skip }, () => {
  it("response shape round trip: the product's own questions come back valid and readable by the policy", async () => {
    const b = backend();
    try {
      const d = await b.decide(stateOf("Rename the variable tmp to buffer in utils.ts."), buildQuestions(cfg), signal());
      assert.deepEqual(Object.keys(d.answers).sort(), Object.keys(QUESTIONS).sort());
      const j = judge(d, cfg);
      assert.ok(j.ok, j.ok ? "" : j.error);
      assert.ok(offeredTiers(cfg).includes(j.judgement.tier.value));
      const demand = j.judgement.vetoes["reasoning_demand"];
      assert.ok(demand !== undefined && demand >= 0 && demand <= 4, `reasoning_demand in 0..4, got ${String(demand)}`);
      assert.ok(d.latencyMs > 0 && d.backendModel.length > 0 && (d.tokensIn ?? 0) > 0);
      console.log(`# typellm: ${d.backendModel}, ${d.latencyMs} ms, tier ${j.judgement.tier.value}, demand ${demand.toFixed(2)}`);
    } finally {
      b.close();
    }
  });

  it("the Laya head's feature questions come back too (yes/no as P(true))", async () => {
    const b = backend();
    try {
      const state = stateOf("Find why the payment webhook is processed twice under load.");
      const d = await b.decide(state, { ...buildQuestions(cfg), ...FEATURE_QUESTIONS }, signal());
      assert.ok(layaFeatures(d.answers, state) !== null);
    } finally {
      b.close();
    }
  });
});
