// The router's main-chat pin rules, driven directly (no processes): the B1 -> B2 sequence from route-mode
// acceptance session B. B1 is a fresh conversation routed opus -> sonnet; on B2 the conversation holds a ~64k-token
// cache on Sonnet. A guard refusal must keep Sonnet, not fall back to the requested Opus.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { BackendError, type DecisionBackend } from "../../src/backend/types.js";
import { loadConfig, type Config } from "../../src/config.js";
import { DecisionLog, type DecisionRecord } from "../../src/log/decision-log.js";
import type { Decision } from "../../src/types.js";
import { Breaker } from "../../src/worker/breaker.js";
import { Router, type RouterDeps } from "../../src/worker/router.js";
import { loadFixtures, type Fixture } from "../support/fixtures.js";
import { waitFor } from "../support/http.js";

type Json = Record<string, unknown>;
type Answer = Record<string, number> | "timeout" | "hang";
const fixtures = loadFixtures();

/** An interactive fixture as an Opus request in session `sid`, optionally with a prefix on the user's text. */
function opusRequest(name: string, sid: string, prefix = "", model = "claude-opus-5"): Fixture {
  const f = fixtures.find((x) => x.file === `interactive.${name}.request.json`)!;
  const b = JSON.parse(f.body.toString()) as Json;
  b["model"] = model;
  const md = b["metadata"] as { user_id: string };
  md.user_id = JSON.stringify({ ...(JSON.parse(md.user_id) as Json), session_id: sid });
  if (prefix) {
    const last = [...(b["messages"] as { role: string; content: { type: string; text?: string }[] }[])].reverse().find((m) => m.role === "user")!;
    const block = [...last.content].reverse().find((c) => c.type === "text" && !c.text?.startsWith("<system-reminder>"))!;
    block.text = prefix + block.text!;
  }
  return { ...f, headers: { ...f.headers, "x-claude-code-session-id": sid }, body: Buffer.from(JSON.stringify(b)) };
}

function harness(onQuota?: RouterDeps["onQuota"]): { send(fx: Fixture, answer: Answer | null, cacheCreate?: number, resHeaders?: Record<string, string>): Promise<{ rec: DecisionRecord; sent: Json }>; calls(): number } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-router-"));
  const loaded = loadConfig({ REFLEX_MODE: "route", TYPESAFE_API_KEY: "apikey_x", REFLEX_HOME: home, REFLEX_JEV_DEADLINE_MS: "50" });
  assert.ok(loaded.ok);
  const config: Config = loaded.config;
  let answer: Answer | null = null;
  let calls = 0;
  const backend: DecisionBackend = {
    id: "jev",
    decide: (_s, questions) => {
      calls++;
      if (answer === "timeout") return Promise.reject(new BackendError("timeout", "t"));
      if (answer === "hang") return new Promise<Decision>(() => undefined); // never settles: the router's own bound fires
      const probs = answer ?? {};
      const choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]![0];
      const tierQ = questions["tier"]!;
      assert.equal(tierQ.type, "choice");
      const d: Decision = {
        answers: {
          tier: { type: "choice", choice, confidence: 0.5, probabilities: probs },
          reasoning_demand: { type: "score", score: 1, confidence: 0.5, probabilities: {} },
        },
        latencyMs: 1,
        backendModel: "jev-test",
        tokensIn: 1,
        connection: "reused",
      };
      return Promise.resolve(d);
    },
  };
  const log = new DecisionLog(home, false);
  const router = new Router({ config, effectiveMode: "route", degradedReason: null, claudeVersion: "2.1.277", backend, breaker: new Breaker(), log, logger: () => undefined, ...(onQuota ? { onQuota } : {}) });
  const records = (): DecisionRecord[] => (fs.existsSync(log.file) ? fs.readFileSync(log.file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as DecisionRecord) : []);
  return {
    calls: () => calls,
    async send(fx, a, cacheCreate = 60_000, resHeaders = {}) {
      answer = a;
      const before = records().length;
      const p = await router.prepare("POST", "/v1/messages?beta=true", fx.headers, fx.body);
      assert.ok(p.obs);
      p.obs.headers(200, { "content-type": "text/event-stream", ...resHeaders });
      p.obs.tap(Buffer.from(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":${cacheCreate},"cache_read_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":50}}\n\n`));
      p.obs.finish(true);
      const all = await waitFor(() => (records().length > before ? records() : null));
      return { rec: all[before]!, sent: JSON.parse(p.body.toString()) as Json };
    },
  };
}

const SONNETISH = { sonnet: 0.55, haiku: 0.45, opus: 0 }; // shadow-1's subagent vector: mass -> sonnet

describe("router: main-chat pin rules (session B)", () => {
  it("B1 fresh -> sonnet; its continuation stays on sonnet", async () => {
    const h = harness();
    const b1 = await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    assert.equal(b1.sent["model"], "claude-sonnet-5");
    assert.equal(b1.rec.guard?.reason, "fresh");
    const c = await h.send(opusRequest("main-continuation", "B"), null);
    assert.equal(c.rec.pin, "hit");
    assert.equal(c.sent["model"], "claude-sonnet-5");
  });

  it("B2, Jev still says sonnet: stays on sonnet (Jev is asked; no switch, so no guard penalty)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const calls = h.calls();
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B"), SONNETISH);
    assert.equal(h.calls(), calls + 1, "a pinned-below-requested conversation always asks");
    assert.equal(b2.sent["model"], "claude-sonnet-5");
    assert.deepEqual(b2.rec.plan?.reasons, ["downgrade", "stay_pinned"]);
    assert.equal(b2.rec.forwarded.model, "claude-sonnet-5");
  });

  it("B2, Jev says haiku: the switch is over the limit, so the conversation KEEPS sonnet (not opus)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH, 63_689);
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B"), { haiku: 0.99, sonnet: 0.01, opus: 0 });
    assert.equal(b2.rec.guard?.reason, "over_limit");
    assert.deepEqual(b2.rec.plan?.reasons, ["downgrade", "guard_blocked", "stay_pinned"]);
    assert.equal(b2.sent["model"], "claude-sonnet-5", "was claude-opus-5 before the fix");
    const c = await h.send(opusRequest("main-continuation", "B"), null);
    assert.equal(c.sent["model"], "claude-sonnet-5", "and its tool loop stays there too");
  });

  it("B2, Jev puts real mass on opus: moves back up to the requested model (never guarded)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const f = opusRequest("main-new-turn-plain", "B");
    const b2 = await h.send(f, { opus: 0.7, sonnet: 0.3, haiku: 0 });
    assert.equal(b2.sent["model"], "claude-opus-5");
    assert.ok(b2.rec.plan?.reasons.includes("return_up"));
    assert.equal(b2.rec.forwarded.rewritten, false, "the original bytes");
    const c = await h.send(opusRequest("main-continuation", "B"), null);
    assert.equal(c.sent["model"], "claude-opus-5");
  });

  it("B2 with an explicit reflex:opus override moves up without asking Jev", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const calls = h.calls();
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B", "reflex:opus "), SONNETISH);
    assert.equal(h.calls(), calls);
    assert.equal(b2.sent["model"], "claude-opus-5");
    assert.equal(b2.rec.override, "opus");
  });

  it("B2 when the backend fails: the conversation stays pinned (a pin is a prior decision, not an error path)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B"), "timeout");
    assert.equal(b2.rec.error, "backend:timeout");
    assert.deepEqual(b2.rec.plan?.reasons, ["stay_pinned_backend_error"]);
    assert.equal(b2.sent["model"], "claude-sonnet-5");
    const c = await h.send(opusRequest("main-continuation", "B"), null);
    assert.equal(c.sent["model"], "claude-sonnet-5", "its tool loop stays pinned too");
  });

  it("B2 when the decision never arrives (router bound): also stays pinned", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B"), "hang");
    assert.equal(b2.rec.error, "decision_late");
    assert.deepEqual(b2.rec.plan?.reasons, ["stay_pinned_backend_error"]);
    assert.equal(b2.sent["model"], "claude-sonnet-5");
  });

  it("B2 failure with reflex:opus: the override leaves the pin without asking the backend", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "B"), SONNETISH);
    const b2 = await h.send(opusRequest("main-new-turn-plain", "B", "reflex:opus "), "timeout");
    assert.equal(b2.sent["model"], "claude-opus-5");
  });

  it("a backend failure on a conversation still on the requested tier forwards unchanged, as before", async () => {
    const h = harness();
    const a1 = await h.send(opusRequest("main-new-turn", "F"), "timeout");
    assert.equal(a1.sent["model"], "claude-opus-5");
    assert.deepEqual(a1.rec.plan, null);
  });

  it("a Haiku-pinned tool loop that outgrows Haiku's 150k ceiling moves up to Sonnet for the rest of the loop", async () => {
    const h = harness();
    const b1 = await h.send(opusRequest("main-new-turn", "C"), { haiku: 1, sonnet: 0, opus: 0 }, 160_000); // response: 160k-token prompt
    assert.equal(b1.sent["model"], "claude-haiku-4-5-20251001");
    const c = await h.send(opusRequest("main-continuation", "C"), null);
    assert.equal(c.sent["model"], "claude-sonnet-5");
    assert.ok(c.rec.plan?.reasons.includes("context_ceiling"));
    const c2 = await h.send(opusRequest("main-continuation", "C"), null);
    assert.equal(c2.sent["model"], "claude-sonnet-5", "the pin itself moved");
  });

  it("an override to Haiku on an oversized conversation is raised too (the ceiling is a hard limit)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "D"), { opus: 1, sonnet: 0, haiku: 0 }, 160_000);
    const t2 = await h.send(opusRequest("main-new-turn-plain", "D", "reflex:haiku "), null);
    assert.equal(t2.rec.override, "haiku");
    assert.equal(t2.sent["model"], "claude-sonnet-5");
    assert.ok(t2.rec.plan?.reasons.includes("context_ceiling"));
  });

  it("a conversation still on the requested tier is refused before the backend, as before (session A)", async () => {
    const h = harness();
    await h.send(opusRequest("main-new-turn", "A"), { opus: 0.8, sonnet: 0.2, haiku: 0 }, 70_000);
    const calls = h.calls();
    const a2 = await h.send(opusRequest("main-new-turn-plain", "A"), SONNETISH);
    assert.equal(h.calls(), calls, "no Jev call");
    assert.equal(a2.rec.guard?.reason, "over_limit");
    assert.equal(a2.sent["model"], "claude-opus-5");
  });

  it("a /model switch drops the pin: the loop never stays on a tier decided for the old requested model", async () => {
    const h = harness();
    const b1 = await h.send(opusRequest("main-new-turn", "M"), SONNETISH);
    assert.equal(b1.sent["model"], "claude-sonnet-5");
    // The user switches to Haiku mid-loop: the Sonnet pin sits ABOVE the new requested tier.
    const c = await h.send(opusRequest("main-continuation", "M", "", "claude-haiku-4-5-20251001"), null);
    assert.equal(c.sent["model"], "claude-haiku-4-5-20251001");
    assert.equal(c.rec.pin, "miss");
    assert.equal(c.rec.forwarded.rewritten, false);
  });

  it("an Opus 5.5 main chat is routed to Sonnet (a verified pair) and its continuation follows the pin", async () => {
    const h = harness();
    const r = await h.send(opusRequest("main-new-turn", "U", "", "claude-opus-5-5"), SONNETISH);
    assert.equal(r.sent["model"], "claude-sonnet-5");
    assert.ok(!r.rec.plan?.reasons.includes("rewrite_unverified"));
    assert.equal(r.rec.forwarded.rewritten, true);
    const c = await h.send(opusRequest("main-continuation", "U", "", "claude-opus-5-5"), null);
    assert.equal(c.sent["model"], "claude-sonnet-5");
  });
});

describe("router: the subscription quota", () => {
  it("records each window's share and reset, hands them on as the headers arrive, and keeps no other header", async () => {
    const seen: unknown[] = [];
    const h = harness((q) => seen.push(q));
    const { rec } = await h.send(opusRequest("main-new-turn", "Q"), SONNETISH, 60_000, {
      "anthropic-ratelimit-unified-5h-utilization": "0.31",
      "anthropic-ratelimit-unified-5h-reset": "1790300400",
      "anthropic-ratelimit-unified-5h-status": "allowed_warning",
      "anthropic-ratelimit-unified-7d-utilization": "0.48",
      "anthropic-organization-id": "org-secret",
    });
    assert.deepEqual(rec.quota, { "5h": { util: 0.31, reset: 1790300400 }, "7d": { util: 0.48, reset: null } });
    assert.deepEqual(seen, [{ "5h": { util: 0.31, reset: 1790300400, status: "allowed_warning" }, "7d": { util: 0.48, reset: null, status: null } }]);
    assert.doesNotMatch(JSON.stringify(rec), /org-secret|allowed_warning/);
    const none = await h.send(opusRequest("main-continuation", "Q"), null);
    assert.ok(!("quota" in none.rec), "no quota headers: no field");
  });
});
