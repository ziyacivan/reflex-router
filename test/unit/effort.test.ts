// REFLEX_EFFORT: the level rule, the wire edits (add, re-insert by history hash, top-level) and the store, then the
// router end to end on an Opus 5.5 conversation (docs/wire-format.md §5.8).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { DecisionBackend } from "../../src/backend/types.js";
import { loadConfig } from "../../src/config.js";
import { DecisionLog, type DecisionRecord } from "../../src/log/decision-log.js";
import { effortPlan } from "../../src/policy.js";
import type { Decision } from "../../src/types.js";
import { Breaker } from "../../src/worker/breaker.js";
import { EffortStore } from "../../src/worker/effort-store.js";
import { Router } from "../../src/worker/router.js";
import { effortVia, messageEffort, withEffort, withTopEffort, type EffortMark } from "../../src/wire/effort.js";
import { loadFixtures } from "../support/fixtures.js";
import { waitFor } from "../support/http.js";
import { completeJsonl } from "../support/jsonl.js";

type Json = Record<string, unknown>;
type Msg = { role: string; content: unknown; output_config?: { effort: string } };
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-effort-"));
const msgs = (b: Buffer): Msg[] => (JSON.parse(b.toString()) as { messages: Msg[] }).messages;
const top = (b: Buffer): unknown => (JSON.parse(b.toString()) as { output_config?: { effort?: string } }).output_config?.effort;
const model = (b: Buffer): unknown => (JSON.parse(b.toString()) as { model?: string }).model;
const shape = (b: Buffer): string => msgs(b).map((m) => m.role[0]! + (m.output_config ? `:${m.output_config.effort}` : "")).join(" ");

describe("effortPlan: reasoning_demand read as a level", () => {
  it("one level per step of the 0..4 scale, absolute, clamped to the client's level unless up", () => {
    assert.deepEqual(effortPlan(0.2, "high", false), { pick: "low", target: "low", reasons: ["effort_down"] });
    assert.deepEqual(effortPlan(1.6, "high", false), { pick: "high", target: "high", reasons: ["effort_same"] });
    assert.deepEqual(effortPlan(3.9, "medium", false), { pick: "max", target: "medium", reasons: ["effort_up_disabled"] });
    assert.deepEqual(effortPlan(3.9, "medium", true), { pick: "max", target: "max", reasons: ["effort_up"] });
    assert.deepEqual(effortPlan(-3, "low", true), { pick: "low", target: "low", reasons: ["effort_same"] });
    assert.deepEqual(effortPlan(2, null, true), { pick: "high", target: null, reasons: ["effort_requested_unknown"] });
    assert.equal(effortPlan(undefined, "high", true), null);
  });
});

describe("effort on the wire", () => {
  // Claude Code's shape: the new turn ends in the index-1 system message carrying the session's effort; on the next
  // request the same content comes back as a string, cache_control has moved, and the turn's reply follows.
  const first = { model: "claude-opus-5-5", output_config: { effort: "high" }, messages: [
    { role: "user", content: [{ type: "text", text: "do the thing", cache_control: { type: "ephemeral" } }] },
    { role: "system", content: [{ type: "text", text: "reminders" }], output_config: { effort: "high" } },
  ] };
  const next = { ...first, messages: [
    { role: "user", content: [{ type: "text", text: "do the thing" }] },
    { role: "system", content: "reminders", output_config: { effort: "high" } },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "now the other", cache_control: { type: "ephemeral" } }] },
  ] };
  const buf = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));

  const storeOf = (e: ReturnType<typeof withEffort>): Map<string, EffortMark> => new Map([[e!.added!.anchor, { effort: e!.added!.effort, op: e!.added!.op }]]);

  it("a turn ending in Claude Code's own effort-bearing system message: that message's level is changed (op set)", () => {
    const e = withEffort(buf(first), () => undefined, "low")!;
    assert.equal(shape(e.body), "u s:low");
    assert.deepEqual(msgs(e.body).at(-1), { role: "system", content: [{ type: "text", text: "reminders" }], output_config: { effort: "low" } });
    assert.equal(top(e.body), "low");
    assert.deepEqual(e.fields, ["messages.effort_set", "output_config.effort"]);
    assert.equal(e.added!.op, "set");
    assert.match(e.added!.anchor, /^[0-9a-f]{64}$/);
  });

  it("any other turn: Claude Code's effort-only message is appended (op insert)", () => {
    const e = withEffort(buf(next), () => undefined, "low")!;
    assert.equal(shape(e.body), "u s:high a u s:low");
    assert.deepEqual(msgs(e.body).at(-1), { role: "system", content: [], output_config: { effort: "low" } });
    assert.equal(e.added!.op, "insert");
    const trailing = { ...next, messages: [...next.messages, { role: "system", content: [{ type: "text", text: "reminder" }] }] };
    assert.equal(shape(withEffort(buf(trailing), () => undefined, "low")!.body), "u s:high a u s s:low", "after a system message with no effort of its own");
  });

  it("re-applies it on later requests at the same place, whatever cache_control and string/block form do", () => {
    const set = storeOf(withEffort(buf(first), () => undefined, "low"));
    const e = withEffort(buf(next), (h) => set.get(h), null)!;
    assert.equal(shape(e.body), "u s:low a u", "Claude Code sends its message back at its own level; reflex's is re-applied");
    assert.equal(top(e.body), "low");
    assert.deepEqual(e.fields, ["messages.effort_reinserted:1", "output_config.effort"]);
    assert.equal(e.added, null);
    const ins = storeOf(withEffort(buf(next), () => undefined, "max"));
    const later = { ...next, messages: [...next.messages, { role: "assistant", content: [{ type: "text", text: "ok" }] }, { role: "user", content: [{ type: "text", text: "go on" }] }] };
    assert.equal(shape(withEffort(buf(later), (h) => ins.get(h), null)!.body), "u s:high a u s:max a u");
  });

  it("a new level on a later turn goes at its end; the level already in effect is not put in twice", () => {
    const set = storeOf(withEffort(buf(first), () => undefined, "low"));
    assert.equal(shape(withEffort(buf(next), (h) => set.get(h), "max")!.body), "u s:low a u s:max");
    const same = withEffort(buf(next), (h) => set.get(h), "low")!;
    assert.equal(same.added, null);
    assert.equal(shape(same.body), "u s:low a u");
    // back to the client's own level: a message saying so, since the history still holds "low"
    assert.equal(shape(withEffort(buf(next), (h) => set.get(h), "high")!.body), "u s:low a u s:high");
  });

  it("without allowInsert a turn that would need an inserted message is left alone (set still works)", () => {
    const b = buf(next);
    const e = withEffort(b, () => undefined, "low", true, false)!;
    assert.equal(e.body, b);
    assert.equal(e.insertRefused, true);
    assert.equal(withEffort(buf(first), () => undefined, "low", true, false)!.added?.op, "set");
  });

  it("keepFirst: a history Claude Code rebuilt (no mark matches) gets the conversation's first level back, as a new set mark", () => {
    const set = storeOf(withEffort(buf(first), () => undefined, "low"));
    const rebuilt = { ...next, messages: [{ role: "user", content: [{ type: "text", text: "do the thing, rebuilt" }] }, ...next.messages.slice(1)] };
    assert.deepEqual(withEffort(buf(rebuilt), (h) => set.get(h), null)!.fields, [], "without keepFirst the level is lost");
    const e = withEffort(buf(rebuilt), (h) => set.get(h), null, true, false, "low")!;
    assert.equal(shape(e.body), "u s:low a u");
    assert.deepEqual(e.fields, ["messages.effort_kept", "output_config.effort"]);
    assert.equal(e.added!.op, "set");
    const again = new Map([[e.added!.anchor, { effort: "low" as const, op: "set" as const }]]);
    assert.deepEqual(withEffort(buf(rebuilt), (h) => again.get(h), null, true, false, "low")!.fields, ["messages.effort_reinserted:1", "output_config.effort"]);
    assert.deepEqual(withEffort(buf(next), (h) => set.get(h), null, true, false, "low")!.fields, ["messages.effort_reinserted:1", "output_config.effort"], "a matching mark wins");
  });

  it("nothing stored and nothing to add: the very same bytes (byte-identical passthrough)", () => {
    const b = buf(next);
    assert.equal(withEffort(b, () => undefined, null)!.body, b);
    assert.equal(withEffort(b, () => undefined, "high")!.body, b, "high is already in effect");
    assert.equal(withEffort(Buffer.from("not json"), () => undefined, "low"), null);
  });

  it("the client's own later /effort message is the level in effect", () => {
    const withOwn = { ...next, messages: [...next.messages, { role: "system", content: [], output_config: { effort: "max" } }] };
    assert.equal(withEffort(buf(withOwn), () => undefined, "max")!.added, null);
  });

  it("by message on Opus 5.5 (with the top-level value), Opus 5, Fable 5.1 and Sonnet 5.5 (message only); Sonnet 5 top-level; Haiku none", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-5", "claude-opus-5[1m]", "claude-fable-5-1"]) assert.equal(effortVia(m, false), "message", m);
    assert.equal(messageEffort("claude-opus-5-5")?.top, true);
    assert.equal(messageEffort("claude-opus-5")?.top, false, "a top-level change rewrites Opus 5's messages cache");
    assert.equal(messageEffort("claude-fable-5-1")?.top, false);
    assert.equal(effortVia("claude-sonnet-5", true), "top-level");
    assert.equal(effortVia("claude-sonnet-5", false), null, "a top-level change rewrites Sonnet's whole cache");
    assert.equal(effortVia("claude-haiku-4-5-20251001", true), null, "Haiku 4.5 takes no effort");
    assert.equal(effortVia("claude-haiku-5-5", false), "message", "Haiku 5.5: the message changes the level with the cache kept (2.1.293)");
    assert.equal(messageEffort("claude-haiku-5-5")?.top, false, "a top-level change rewrites its messages cache");
    for (const m of ["claude-sonnet-5-5", "claude-sonnet-5-5[1m]"]) {
      assert.equal(effortVia(m, false), "message", m);
      assert.equal(messageEffort(m)?.top, false, "a top-level change rewrites Sonnet 5.5's messages cache");
    }
    const noTop = withEffort(buf(next), () => undefined, "low", false)!;
    assert.equal(shape(noTop.body), "u s:high a u s:low");
    assert.equal(top(noTop.body), "high", "message only: the top-level value is left alone");
    assert.deepEqual(noTop.fields, ["messages.effort_added"]);
    const b = buf(first);
    assert.equal(top(withTopEffort(b, "max")!.body), "max");
    assert.equal(withTopEffort(b, "high")!.body, b);
  });
});

describe("EffortStore", () => {
  it("keeps anchors across instances, skips bad lines, writes hashes and levels only", () => {
    const home = tmp();
    const a = "a".repeat(64);
    EffortStore.at(home, () => undefined).add(a, "low", "set");
    fs.appendFileSync(path.join(home, "effort.jsonl"), "torn{\n" + JSON.stringify({ anchor: "short", effort: "low" }) + "\n" + JSON.stringify({ anchor: "b".repeat(64), effort: "huge" }) + "\n");
    const again = EffortStore.at(home, () => undefined);
    assert.deepEqual(again.get(a), { effort: "low", op: "set" });
    assert.equal(again.get("b".repeat(64)), undefined);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, "effort.jsonl"), "utf8").split("\n")[0]!) as Json).sort(), ["anchor", "at", "effort", "op", "v"]);
    assert.equal(fs.statSync(path.join(home, "effort.jsonl")).mode & 0o777, 0o600);
  });
});

describe("router: REFLEX_EFFORT on an Opus 5.5 conversation", () => {
  const fx = loadFixtures();
  const get = (name: string): { headers: Json; body: Json } => {
    const f = fx.find((x) => x.version === "2.1.280" && x.file === `print-agent.${name}.request.json`)!;
    return { headers: f.headers, body: JSON.parse(f.body.toString()) as Json };
  };
  const newTurn = get("main-new-turn");
  // The fixtures elide long text differently per request, so the continuation is built on the new turn's own
  // messages: the history Claude Code would really send back.
  const contBody = { ...get("main-continuation").body, messages: [...(newTurn.body["messages"] as unknown[]), ...(get("main-continuation").body["messages"] as unknown[]).slice(2)] };

  function harness(env: Record<string, string>, demand: number, home = tmp(), tier: "opus" | "sonnet" = "opus") {
    let tierNow = tier;
    const loaded = loadConfig({ REFLEX_MODE: "route", TYPESAFE_API_KEY: "apikey_x", REFLEX_HOME: home, REFLEX_JEV_DEADLINE_MS: "200", ...env });
    assert.ok(loaded.ok);
    const backend: DecisionBackend = {
      id: "jev",
      decide: () =>
        Promise.resolve<Decision>({
          answers: {
            tier: { type: "choice", choice: tierNow, confidence: 0.9, probabilities: { haiku: 0, sonnet: tierNow === "sonnet" ? 1 : 0, opus: tierNow === "opus" ? 1 : 0 } },
            reasoning_demand: { type: "score", score: demand, confidence: 0.9, probabilities: {} },
          },
          latencyMs: 1,
          backendModel: "jev-test",
          tokensIn: 1,
          connection: "reused",
        }),
    };
    const log = new DecisionLog(home, false);
    const store = EffortStore.at(home, () => undefined);
    const router = new Router({ config: loaded.config, effectiveMode: "route", degradedReason: null, claudeVersion: "2.1.280", backend, breaker: new Breaker(), log, logger: () => undefined, effortStore: store });
    const records = (): DecisionRecord[] => completeJsonl<DecisionRecord>(log.file);
    return {
      home,
      router,
      setTier: (t: "opus" | "sonnet") => { tierNow = t; },
      async send(req: { headers: Json; body: Json }, status = 200) {
        const before = records().length;
        const p = await router.prepare("POST", "/v1/messages?beta=true", req.headers as never, Buffer.from(JSON.stringify(req.body)));
        assert.ok(p.obs);
        if (status !== 200) p.obs.fallback(status, "rejected");
        p.obs.headers(200, { "content-type": "text/event-stream" });
        p.obs.tap(Buffer.from(`event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":40000,"output_tokens":1}}}\n\n`));
        p.obs.finish(true);
        const all = await waitFor(() => (records().length > before ? records() : null));
        return { rec: all[before]!, sent: p.body, rewritten: p.rewritten };
      },
    };
  }

  it("MIDTURN: an easy main-chat turn runs at low: level set in place, recorded, and re-applied on the continuation", async () => {
    const h = harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1" }, 0);
    const a = await h.send(newTurn);
    assert.equal(a.rewritten, true);
    assert.equal(msgs(a.sent).length, 2, "the turn's own system message carries the new level");
    assert.equal(msgs(a.sent)[1]!.output_config?.effort, "low");
    assert.equal(top(a.sent), "low");
    assert.equal(model(a.sent), "claude-opus-5-5", "the model is left alone");
    assert.deepEqual(a.rec.effort, { pick: "low", target: "low", via: "message", reasons: ["effort_down"] });
    assert.deepEqual(a.rec.forwarded.fields, ["messages.effort_set", "output_config.effort"]);

    const c = await h.send({ headers: newTurn.headers, body: contBody });
    assert.equal(msgs(c.sent).length, (contBody.messages).length, "nothing added: the level is re-applied in place");
    assert.equal(msgs(c.sent)[1]!.output_config?.effort, "low");
    assert.ok(c.rec.forwarded.fields.includes("messages.effort_reinserted:1"));

    // a fresh worker (restart, or a resume through reflex) still re-applies it, even with the setting off now
    const fresh = harness({}, 0, h.home);
    const r = await fresh.send({ headers: newTurn.headers, body: contBody });
    assert.equal(msgs(r.sent)[1]!.output_config?.effort, "low");
  });

  it("above the client's level only with REFLEX_EFFORT_UP", async () => {
    const off = await harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1" }, 4).send(newTurn);
    assert.equal(off.rewritten, false, "medium is already in effect");
    assert.deepEqual(off.rec.effort?.reasons, ["effort_up_disabled"]);
    const on = await harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1", REFLEX_EFFORT_UP: "1" }, 4).send(newTurn);
    assert.equal(top(on.sent), "max");
  });

  it("with the setting off nothing changes and nothing is recorded", async () => {
    const a = await harness({}, 0).send(newTurn);
    assert.equal(a.rewritten, false);
    assert.equal(a.rec.effort, undefined);
  });

  it("a rejected effort change is not stored, disables no tier, and stops new levels for the session", async () => {
    const h = harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1" }, 0);
    const a = await h.send(newTurn, 400);
    assert.equal(a.rec.effort?.via, null);
    assert.equal(fs.existsSync(path.join(h.home, "effort.jsonl")), false, "the model never saw it");
    const c = await h.send({ headers: newTurn.headers, body: contBody });
    assert.equal(c.rewritten, false, "nothing to re-insert");
    const b = await h.send(newTurn);
    assert.equal(b.rewritten, false, "no new level after a rejection");
    assert.equal(b.rec.forwarded.model, "claude-opus-5-5");
  });

  const sub = get("subagent-new-turn");
  const subCont = { headers: sub.headers, body: { ...get("subagent-continuation").body, messages: [...(sub.body["messages"] as unknown[]), ...(get("subagent-continuation").body["messages"] as unknown[]).slice(2)] } };

  it("default: a subagent's level goes into its first request's own system message and stays for its loop", async () => {
    const h = harness({ REFLEX_EFFORT: "1" }, 0);
    const a = await h.send(sub);
    assert.deepEqual(a.rec.forwarded.fields, ["messages.effort_set", "output_config.effort"]);
    assert.equal(a.rec.effort?.via, "message");
    const c = await h.send(subCont);
    assert.equal(msgs(c.sent)[1]!.output_config?.effort, "low");
    assert.equal(msgs(c.sent).length, (subCont.body.messages).length, "nothing inserted");
  });

  it("default: the main chat is left alone, even its first turn (its level would hold for the whole chat)", async () => {
    const a = await harness({ REFLEX_EFFORT: "1" }, 0).send(newTurn);
    assert.equal(a.rewritten, false);
    assert.equal(a.rec.effort?.via, null);
    assert.ok(a.rec.effort?.reasons.includes("effort_midturn_off"));
  });

  it("a subagent routed to Sonnet 5: the top-level level on its first request, kept for its loop", async () => {
    const h = harness({ REFLEX_EFFORT: "1", REFLEX_MODEL_SONNET: "claude-sonnet-5" }, 0, tmp(), "sonnet");
    const a = await h.send(sub);
    assert.equal(model(a.sent), "claude-sonnet-5");
    assert.equal(top(a.sent), "low");
    assert.ok(msgs(a.sent).every((m) => m.output_config === undefined), "Sonnet takes no effort message");
    assert.equal(a.rec.effort?.via, "top-level");
    const c = await h.send(subCont);
    assert.equal(model(c.sent), "claude-sonnet-5");
    assert.equal(top(c.sent), "low");
  });

  it("a subagent routed to Sonnet 5.5: the level set in its first request's own system message, the top-level value untouched", async () => {
    const h = harness({ REFLEX_EFFORT: "1" }, 0, tmp(), "sonnet");
    const a = await h.send(sub);
    assert.equal(model(a.sent), "claude-sonnet-5-5");
    assert.equal(a.rec.effort?.via, "message");
    assert.equal(top(a.sent), (sub.body as { output_config?: { effort?: string } }).output_config?.effort, "a top-level change would rewrite Sonnet 5.5's messages cache");
    assert.equal(msgs(a.sent).filter((m) => m.output_config !== undefined).at(-1)?.output_config?.effort, "low");
    const c = await h.send(subCont);
    assert.equal(model(c.sent), "claude-sonnet-5-5");
    assert.equal(msgs(c.sent).filter((m) => m.output_config !== undefined).at(-1)?.output_config?.effort, "low", "re-applied on its loop");
  });

  const withModel = (req: { headers: Json; body: Json }, model: string) => ({ headers: req.headers, body: { ...req.body, model } });
  // A later user-typed turn of the same conversation: not the first request, so Sonnet's cache is not fresh.
  const laterTurn = { headers: newTurn.headers, body: { ...newTurn.body, messages: [...(newTurn.body["messages"] as unknown[]), { role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: [{ type: "text", text: "now rename the helper too" }] }] } };

  it("Opus 5: the level by message only, the top-level value untouched (it would rewrite the cache)", async () => {
    const a = await harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1" }, 0).send(withModel(laterTurn, "claude-opus-5"));
    assert.deepEqual(msgs(a.sent).at(-1), { role: "system", content: [], output_config: { effort: "low" } });
    assert.equal(top(a.sent), "medium");
    assert.deepEqual(a.rec.forwarded.fields, ["messages.effort_added"]);
  });

  it("a Sonnet 5 main chat keeps its level, even with MIDTURN (a first-turn level would hold for the whole chat)", async () => {
    const a = await harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1", REFLEX_MODEL_SONNET: "claude-sonnet-5" }, 0, tmp(), "sonnet").send(newTurn);
    assert.equal(model(a.sent), "claude-sonnet-5", "the tier routing itself is unchanged");
    assert.equal(top(a.sent), "medium");
    assert.equal(a.rec.effort?.via, null);
    assert.ok(a.rec.effort?.reasons.includes("effort_sonnet_main_chat"));
  });

  it("MIDTURN: a later main-chat turn is still decided for effort when the guard keeps the model (the tier move stays blocked)", async () => {
    const h = harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1" }, 0);
    await h.send(newTurn, 200);
    h.setTier("sonnet");
    const b = await h.send(laterTurn);
    assert.equal(model(b.sent), "claude-opus-5-5");
    assert.ok(b.rec.plan?.reasons.includes("guard_blocked"));
    assert.equal(b.rec.effort?.via, "message");
  });

  it("REFLEX_ESCALATE=1: after an outcome signal the next turn keeps the client's level", async () => {
    const h = harness({ REFLEX_EFFORT: "1", REFLEX_EFFORT_MIDTURN: "1", REFLEX_ESCALATE: "1" }, 0);
    const a = await h.send(newTurn);
    assert.equal(a.rec.effort?.target, "low");
    h.router.onEscalationSignal({ conv: a.rec.conv!, signal: "test_failure", score: null, decisionId: a.rec.id, turnSeq: 1 });
    const b = await h.send(laterTurn);
    assert.equal(b.rec.effort?.target, "medium");
    assert.ok(b.rec.effort?.reasons.includes("effort_escalated"));
    assert.equal(msgs(b.sent).at(-1)?.output_config?.effort, "medium", "back to the client's level, by message");
  });

  it("without MIDTURN a later main-chat turn keeps the client's level: nothing inserted, the reason recorded", async () => {
    // the first turn ran at the client's level (nothing stored), so this turn would need an inserted message
    // (REFLEX_UPGRADES=on makes the backend be asked on a later main-chat turn; without MIDTURN effort alone does not)
    const b = await harness({ REFLEX_EFFORT: "1", REFLEX_UPGRADES: "on" }, 0).send(laterTurn);
    assert.equal(b.rewritten, false);
    assert.equal(b.rec.effort?.via, null);
    assert.ok(b.rec.effort?.reasons.includes("effort_midturn_off"));
  });
});
