import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { JevBackend, JEV_MODEL } from "../../src/backend/jev.js";
import { BackendError } from "../../src/backend/types.js";
import { loadConfig } from "../../src/config.js";
import { buildQuestions } from "../../src/policy.js";
import type { DecisionState } from "../../src/types.js";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";

const cfgR = loadConfig({});
assert.ok(cfgR.ok);
const cfg = cfgR.config;
const questions = buildQuestions(cfg);
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

describe("JevBackend", () => {
  let jev: FakeJev;
  let backend: JevBackend;
  before(async () => {
    jev = await startFakeJev();
    backend = new JevBackend({ baseUrl: jev.url + "/", apiKey: "apikey_unit", deadlineMs: 300 });
  });
  after(async () => {
    backend.close();
    await jev.close();
  });
  beforeEach(() => {
    jev.calls.length = 0;
    jev.set({ kind: "answer", tier: "haiku", confidence: 0.84, reasoning: 0.4 });
  });

  it("POSTs {state, model, questions} to /v1/systemone with the key only in the Authorization header", async () => {
    const d = await backend.decide(state, questions, { signal });
    const call = jev.calls[0];
    assert.ok(call);
    assert.equal(call.headers.authorization, "Bearer apikey_unit");
    assert.deepEqual(Object.keys(call.body).sort(), ["model", "questions", "state"]);
    assert.equal(call.body.model, JEV_MODEL);
    assert.equal(JEV_MODEL, "jev-1.13.0", "a pinned version, never the moving jev-latest alias");
    assert.deepEqual(call.body.state, state);
    assert.equal(call.raw.includes("apikey_unit"), false, "the key is never in the body");
    assert.equal(d.backendModel, "jev-test");
    assert.equal(d.tokensIn, 321);
    const tier = d.answers["tier"];
    assert.ok(tier?.type === "choice");
    assert.equal(tier.choice, "haiku");
    assert.equal(tier.confidence, 0.84);
    const rd = d.answers["reasoning_demand"];
    assert.ok(rd?.type === "score");
    assert.equal(rd.score, 0.4);
  });

  for (const status of [401, 422, 429, 500, 529]) {
    it(`HTTP ${status} is an http error carrying only the status, never the body`, async () => {
      jev.set({ kind: "status", status });
      const e = await rejectsWith(backend.decide(state, questions, { signal }), "http", status);
      assert.doesNotMatch(e.message, /shouldnotleak|apikey/);
    });
  }

  it("a hang ends at the deadline with a timeout, and is not retried", async () => {
    jev.set({ kind: "hang" });
    const t0 = Date.now();
    await rejectsWith(backend.decide(state, questions, { signal }), "timeout");
    assert.ok(Date.now() - t0 < 1500);
    assert.equal(jev.calls.length, 1, "zero retries");
  });

  it("a slow answer inside the deadline is fine", async () => {
    jev.set({ kind: "answer", tier: "opus", delayMs: 50 });
    const d = await backend.decide(state, questions, { signal });
    assert.ok(d.latencyMs >= 40);
  });

  it("decisions started together are all answered within the deadline: none waits behind another's socket", async () => {
    jev.set({ kind: "answer", tier: "haiku", delayMs: 180 });
    const all = await Promise.allSettled(Array.from({ length: 8 }, () => backend.decide(state, questions, { signal })));
    assert.deepEqual(all.map((r) => r.status), Array(8).fill("fulfilled"), "a queued second wave would end at ~360 ms, past the 300 ms deadline");
  });

  it("junk is invalid_response", async () => {
    jev.set({ kind: "junk" });
    await rejectsWith(backend.decide(state, questions, { signal }), "invalid_response");
  });

  it("the caller's abort signal is honoured", async () => {
    jev.set({ kind: "hang" });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    await rejectsWith(backend.decide(state, questions, { signal: ac.signal }), "aborted");
  });

  const good = { type: "choice", choice: "haiku", confidence: 0.8, probabilities: { haiku: 0.8, sonnet: 0.15, opus: 0.05 } };
  const score = { type: "score", score: 1, confidence: 0.5, probabilities: { "0": 0, "1": 1, "2": 0, "3": 0, "4": 0 } };
  const invalid: [string, unknown][] = [
    ["answers missing", { model: "m" }],
    ["a question unanswered", { answers: { tier: good } }],
    ["choice outside the options (fable not offered)", { answers: { tier: { ...good, choice: "fable" }, reasoning_demand: score } }],
    ["probabilities that do not sum to 1", { answers: { tier: { ...good, probabilities: { haiku: 0.8, sonnet: 0.8, opus: 0 } }, reasoning_demand: score } }],
    ["probability for an unknown option", { answers: { tier: { ...good, probabilities: { haiku: 0.5, gpt: 0.5 } }, reasoning_demand: score } }],
    ["confidence above 1", { answers: { tier: { ...good, confidence: 1.2 }, reasoning_demand: score } }],
    ["score beyond the last level", { answers: { tier: good, reasoning_demand: { ...score, score: 7 } } }],
    ["wrong answer type", { answers: { tier: score, reasoning_demand: score } }],
    ["NaN confidence", { answers: { tier: { ...good, confidence: "NaN" }, reasoning_demand: score } }],
  ];
  for (const [what, body] of invalid) {
    it(`rejects a malformed answer: ${what}`, async () => {
      jev.set({ kind: "raw", body });
      await rejectsWith(backend.decide(state, questions, { signal }), "invalid_response");
    });
  }

  it("reuses one keep-alive connection across decisions, and says so", async () => {
    const a = await backend.decide(state, questions, { signal });
    const b = await backend.decide(state, questions, { signal });
    assert.equal(b.connection, "reused");
    assert.ok(a.connection === "new" || a.connection === "reused");
    assert.equal(jev.calls[0]?.remotePort, jev.calls[1]?.remotePort, "same TCP connection");
  });

  it("keeps the connection across a pause longer than fetch's ~4 s idle window", async () => {
    await backend.decide(state, questions, { signal });
    await new Promise((r) => setTimeout(r, 4500));
    const d = await backend.decide(state, questions, { signal });
    assert.equal(d.connection, "reused");
    assert.equal(jev.calls[0]?.remotePort, jev.calls[1]?.remotePort);
  });

  it("a connection the server closed while idle is replaced transparently, within the deadline", async () => {
    await backend.decide(state, questions, { signal });
    jev.dropIdle();
    await new Promise((r) => setTimeout(r, 20));
    const d = await backend.decide(state, questions, { signal });
    assert.equal(d.connection, "new");
    assert.equal(jev.calls.length, 2, "the stale socket never delivered a request");
  });

  it("a reused connection that dies before any answer gets exactly one fresh attempt", async () => {
    await backend.decide(state, questions, { signal });
    jev.set({ kind: "reset_once", then: { kind: "answer", tier: "sonnet" } });
    const d = await backend.decide(state, questions, { signal });
    assert.equal(d.connection, "new");
    assert.equal(jev.calls.length, 3, "first call, the reset request, the fresh retry");
  });

  it("a fresh connection that dies is a network error, not retried", async () => {
    const fresh = new JevBackend({ baseUrl: jev.url, apiKey: "apikey_unit", deadlineMs: 500 });
    jev.set({ kind: "reset_once", then: { kind: "answer", tier: "sonnet" } });
    await rejectsWith(fresh.decide(state, questions, { signal }), "network");
    assert.equal(jev.calls.length, 1);
    fresh.close();
  });

  it("warm() opens the connection with a bare HEAD (no key, no body); the first decision then reuses it", async () => {
    const fresh = new JevBackend({ baseUrl: jev.url, apiKey: "apikey_unit", deadlineMs: 500 });
    const before = jev.other.length;
    await fresh.warm();
    const w = jev.other[before];
    assert.ok(w);
    assert.equal(w.method, "HEAD");
    assert.equal(w.headers.authorization, undefined, "no key on the warm-up");
    const d = await fresh.decide(state, questions, { signal });
    assert.equal(d.connection, "reused");
    assert.equal(jev.calls.at(-1)?.remotePort, w.remotePort);
    fresh.close();
  });

  it("warm() never throws, even when the endpoint is down", async () => {
    await new JevBackend({ baseUrl: "http://127.0.0.1:9", apiKey: "apikey_unit", deadlineMs: 500 }).warm(200);
  });

  it("an unreachable endpoint is a network error", async () => {
    const dead = new JevBackend({ baseUrl: "http://127.0.0.1:9", apiKey: "apikey_unit", deadlineMs: 500 });
    await rejectsWith(dead.decide(state, questions, { signal }), "network");
  });

  it("as laya: no key means no Authorization header, and the checkpoint name goes in `model`", async () => {
    const laya = new JevBackend({ id: "laya", baseUrl: jev.url, model: "english", deadlineMs: 500 });
    assert.equal(laya.id, "laya");
    await laya.decide(state, questions, { signal });
    const call = jev.calls.at(-1);
    assert.equal(call?.headers.authorization, undefined);
    assert.equal(call?.body.model, "english");
    laya.close();
  });

  it("accepts an answer shaped like laya-serve's (agent.py: 4-decimal rounding, extra fields)", async () => {
    // What Laya 0.3.5's agent.predict() returns for these two questions, plus the `routing` block of its Router.
    jev.set({
      kind: "raw",
      body: {
        model: "convaiinnovations/laya",
        answers: {
          tier: { type: "choice", choice: "sonnet", probabilities: { haiku: 0.2113, sonnet: 0.5021, opus: 0.2866 }, confidence: 0.3127 },
          reasoning_demand: { type: "score", score: 1.8342, probabilities: { "0": 0.1, "1": 0.2501, "2": 0.3333, "3": 0.2166, "4": 0.1 }, confidence: 0.1402 },
        },
        usage: { input_tokens: 187, output_tokens: 0 },
        routing: { model: "english", repo: "convaiinnovations/laya", reason: "latin script" },
      },
    });
    const d = await backend.decide(state, questions, { signal });
    assert.equal(d.backendModel, "convaiinnovations/laya");
    assert.equal(d.tokensIn, 187);
    assert.equal(d.answers["tier"]?.type === "choice" && d.answers["tier"].choice, "sonnet");
  });
});
