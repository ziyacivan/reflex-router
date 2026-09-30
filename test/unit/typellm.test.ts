import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { FEATURE_QUESTIONS } from "../../src/backend/laya-calibration.js";
import { fromTypeLLMAnswer, toTypeLLMQuestion, TypeLLMBackend } from "../../src/backend/typellm.js";
import { BackendError } from "../../src/backend/types.js";
import { loadConfig } from "../../src/config.js";
import { buildQuestions } from "../../src/policy.js";
import type { DecisionState, Question } from "../../src/types.js";
import { startFakeTypeLLM, type FakeTypeLLM } from "../support/fake-typellm.js";

const cfgR = loadConfig({});
assert.ok(cfgR.ok);
const questions = buildQuestions(cfgR.config);
const state: DecisionState = { task: "rename foo to bar in a.ts", context: { requesting_tier: "sonnet", is_subagent: true } };
const signal = new AbortController().signal;

const rejectsWith = async (p: Promise<unknown>, kind: string, status?: number): Promise<BackendError> => {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof BackendError, String(e));
    assert.equal(e.kind, kind);
    if (status !== undefined) assert.equal(e.status, status);
    return e;
  }
  assert.fail("expected a rejection");
};

describe("TypeLLM question translation", () => {
  it("is the text that was measured against Jev (docs/observations.md, 2026-09-30): pinned", () => {
    const choice: Question = {
      type: "choice",
      instructions: { question: "Which tier?", focus: "Judge reasoning." },
      criteria: { haiku: { what: "Mechanical.", not_for: "Diagnosis.", examples: ["list files", "rename"] }, opus: { what: "Hard." } },
    };
    assert.deepEqual(toTypeLLMQuestion(choice), {
      type: "string",
      enum: ["haiku", "opus"],
      instructions: "Which tier? Judge reasoning.\nOptions:\n- haiku: Mechanical. Not for: Diagnosis. Examples: list files; rename.\n- opus: Hard.",
      return_probabilities: true,
    });
    const score: Question = { type: "score", instructions: { question: "How much?" }, criteria: [{ what: "Little." }, { what: "Lots." }] };
    assert.deepEqual(toTypeLLMQuestion(score), { type: "string", enum: ["0", "1"], instructions: "How much?\nLevels:\n- 0: Little.\n- 1: Lots.", return_probabilities: true });
    assert.deepEqual(toTypeLLMQuestion({ type: "noul", instructions: "Is it mechanical?" }), { type: "boolean", instructions: "Is it mechanical?", return_probabilities: true });
  });

  it("translates every question the product and the Laya head ask", () => {
    for (const [id, q] of Object.entries({ ...questions, ...FEATURE_QUESTIONS })) {
      const t = toTypeLLMQuestion(q);
      assert.equal(t["return_probabilities"], true, id);
      assert.ok(typeof t["instructions"] === "string" && t["instructions"].length > 10, id);
    }
  });

  it("maps answers back: the choice and its probabilities, the score as the expected level, P(true)", () => {
    const tier = fromTypeLLMAnswer("tier", questions["tier"]!, { value: "sonnet", probabilities: { haiku: 0.1, sonnet: 0.8, opus: 0.1 } });
    assert.equal(tier.type, "choice");
    assert.ok(tier.type === "choice" && tier.choice === "sonnet" && tier.confidence > 0 && tier.confidence < 1);
    const rd = fromTypeLLMAnswer("reasoning_demand", questions["reasoning_demand"]!, { value: "0", probabilities: { "0": 0.77, "1": 0.23 } });
    assert.ok(rd.type === "score");
    assert.ok(Math.abs(rd.score - 0.23) < 1e-9, "a level missing from the reply counts as 0");
    assert.deepEqual(fromTypeLLMAnswer("f", { type: "noul", instructions: "x" }, { value: false, probabilities: { true: 0.2, false: 0.8 } }), { type: "noul", p: 0.2 });
  });

  it("rejects anything odd, so the caller fails open", () => {
    const t = questions["tier"]!;
    const bad: unknown[] = [
      undefined,
      { value: "sonnet" },
      { value: "gpt", probabilities: { haiku: 0.1, sonnet: 0.8, opus: 0.1 } },
      { value: "sonnet", probabilities: { haiku: 0.1, sonnet: 0.8, gpt: 0.1 } },
      { value: "sonnet", probabilities: { haiku: 0.1, sonnet: 0.5, opus: 0.1 } },
      { value: "sonnet", probabilities: { haiku: -0.1, sonnet: 1.1, opus: 0 } },
    ];
    for (const a of bad) assert.throws(() => fromTypeLLMAnswer("tier", t, a), (e: unknown) => e instanceof BackendError && e.kind === "invalid_response", JSON.stringify(a));
  });
});

describe("TypeLLMBackend", () => {
  let fake: FakeTypeLLM;
  let backend: TypeLLMBackend;
  before(async () => {
    fake = await startFakeTypeLLM();
    backend = new TypeLLMBackend({ baseUrl: fake.url + "/", apiKey: "tl-sk-unit", deadlineMs: 300 });
  });
  after(async () => {
    backend.close();
    await fake.close();
  });
  beforeEach(() => {
    fake.calls.length = 0;
    fake.set({ kind: "answer", tier: "haiku" });
  });

  it("POSTs /v1/generate with the bearer key, the model, the state as JSON context and translated questions", async () => {
    const d = await backend.decide(state, questions, { signal });
    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.headers.authorization, "Bearer tl-sk-unit");
    assert.equal(call.body.model, "typellm-latest");
    assert.deepEqual(JSON.parse(call.body.context as string), state);
    assert.deepEqual(Object.keys(call.body.questions), Object.keys(questions));
    assert.deepEqual(call.body.questions["tier"]!.enum, Object.keys((questions["tier"] as { criteria: object }).criteria));
    const tier = d.answers["tier"]!;
    assert.ok(tier.type === "choice" && tier.choice === "haiku");
    const rd = d.answers["reasoning_demand"]!;
    assert.ok(rd.type === "score" && Math.abs(rd.score - 1.25) < 1e-9);
    assert.equal(d.backendModel, "typellm-test");
    assert.equal(d.tokensIn, 654);
    assert.ok(d.latencyMs >= 0);
  });

  it("asks for the configured model", async () => {
    const b = new TypeLLMBackend({ baseUrl: fake.url, apiKey: "tl-sk-unit", deadlineMs: 300, model: "Qwen/Qwen3.8-27B" });
    await b.decide(state, questions, { signal });
    b.close();
    assert.equal(fake.calls[0]!.body.model, "Qwen/Qwen3.8-27B");
  });

  it("reuses the keep-alive connection across decisions", async () => {
    const a = await backend.decide(state, questions, { signal });
    const b = await backend.decide(state, questions, { signal });
    assert.equal(fake.calls[0]!.remotePort, fake.calls[1]!.remotePort);
    assert.equal(b.connection, "reused");
    assert.ok(a.connection === "new" || a.connection === "reused");
  });

  it("an HTTP error is an `http` BackendError with the status and never the body", async () => {
    for (const status of [401, 402, 429, 502, 503]) {
      fake.set({ kind: "status", status });
      const e = await rejectsWith(backend.decide(state, questions, { signal }), "http", status);
      assert.doesNotMatch(e.message, /tl-sk-/);
    }
  });

  it("junk, a missing result and a partial result are `invalid_response`", async () => {
    fake.set({ kind: "junk" });
    await rejectsWith(backend.decide(state, questions, { signal }), "invalid_response");
    fake.set({ kind: "raw", body: { model: "typellm-test" } });
    await rejectsWith(backend.decide(state, questions, { signal }), "invalid_response");
    fake.set({ kind: "raw", body: { result: { tier: { value: "haiku", probabilities: { haiku: 1 } } } } });
    await rejectsWith(backend.decide(state, questions, { signal }), "invalid_response");
  });

  it("the hard deadline fires as a `timeout`, and the caller's abort as `aborted`", async () => {
    fake.set({ kind: "hang" });
    await rejectsWith(backend.decide(state, questions, { signal }), "timeout");
    const ac = new AbortController();
    const p = backend.decide(state, questions, { signal: ac.signal });
    ac.abort();
    await rejectsWith(p, "aborted");
  });
});
