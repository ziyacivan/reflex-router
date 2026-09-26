import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanTitle, fetchStatus, formatStatus, shortModel } from "../../src/statusline.js";
import { parseStatusInput } from "../../src/wire/statusline.js";
import { SessionStatus } from "../../src/worker/session-status.js";
import { hasOwnStatusLine, mergeSettings } from "../../src/launcher/settings-inject.js";
import type { DecisionInfo } from "../../src/outcome/tracker.js";
import { hashId, type DecisionRecord } from "../../src/log/decision-log.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const plain = (s: string | null): string | null => (s === null ? null : s.replace(ANSI, ""));
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5-20251001";

describe("statusline", () => {
  it("short model names", () => {
    assert.equal(shortModel("claude-opus-5-5[1m]"), "Opus 5.5");
    assert.equal(shortModel(HAIKU), "Haiku 4.5");
    assert.equal(shortModel(SONNET), "Sonnet 5");
    assert.equal(shortModel("claude-fable-5-1"), "Fable 5.1");
    assert.equal(shortModel("some-gateway-model"), "some-gateway-model");
  });

  it("shows the model reflex sent when it differs from the one asked for, and every running subagent", () => {
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: SONNET }, subagents: [] })), "Reflex: ⇣ Sonnet 5 (asked Opus 5.5)");
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: SONNET, sent: OPUS }, subagents: [] })), "Reflex: ⇡ Opus 5.5 (asked Sonnet 5)");
    const sub = (sent: string, title: string | null) => ({ title, model: { requested: OPUS, sent }, effort: null });
    const subs = [sub(HAIKU, "List docs directory files"), sub(OPUS, "Unchanged"), sub(SONNET, null)];
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: OPUS }, subagents: subs })), "Reflex: Opus 5.5\n↳ List docs directory files: ⇣ Haiku 4.5 (asked Opus 5.5)\n↳ Unchanged: Opus 5.5\n↳ subagent 3: ⇣ Sonnet 5 (asked Opus 5.5)");
    assert.equal(plain(formatStatus({ worker: "up", main: null, subagents: [] })), "Reflex");
    assert.equal(plain(formatStatus({ worker: "down" })), "Reflex: passthrough");
    assert.equal(formatStatus(null), null);
  });

  it("reads only session_id and model.display_name from stdin; junk gives nulls", () => {
    assert.deepEqual(parseStatusInput('{"session_id":"s1","model":{"id":"claude-opus-5-5[1m]","display_name":"Opus 5.5 (1M context)"},"cost":{}}'), { sessionId: "s1", displayName: "Opus 5.5 (1M context)" });
    assert.deepEqual(parseStatusInput("not json"), { sessionId: null, displayName: null });
    assert.deepEqual(parseStatusInput("[1]"), { sessionId: null, displayName: null });
  });

  it("only asks a loopback base URL", async () => {
    assert.equal(await fetchStatus("https://api.anthropic.com", "s1"), null);
    assert.equal(await fetchStatus(undefined, "s1"), null);
    assert.equal(await fetchStatus("http://127.0.0.1:9", "s1", 200), null); // nothing listening
  });

  it("the worker keeps the last main-chat and per-subagent pair; side calls are ignored", () => {
    const s = new SessionStatus();
    const d = (o: Partial<DecisionInfo>): DecisionInfo => ({ id: "x", at: 0, sessionId: "s1", agentId: null, kind: "main", turn: "new", conv: null, requestedModel: OPUS, sentModel: OPUS, ...o });
    s.observe(d({ sentModel: SONNET }));
    s.observe(d({ turn: "side", sentModel: HAIKU }));
    s.observe(d({ kind: "subagent", agentId: "a1", conv: "c-a1", sentModel: HAIKU }));
    s.observe(d({ kind: "subagent", agentId: "a1", conv: "c-a1", turn: "continuation", sentModel: HAIKU }));
    assert.deepEqual(s.get("s1"), { main: { requested: OPUS, sent: SONNET }, subagents: [{ title: null, model: { requested: OPUS, sent: HAIKU }, effort: null }], effort: { main: null }, cost: 0 });
    assert.deepEqual(s.get("other"), { main: null, subagents: [], effort: { main: null }, cost: 0 });
  });

  it("the cost is every record at the model sent", () => {
    const s = new SessionStatus();
    const rec = (o: Record<string, unknown>) => ({ id: "r", at: "2026-09-23T10:00:00.000Z", turn: "new", requested: { model: OPUS, tier: "opus" }, usage: { input: 1_000_000, output: 0, cache_read: 0, cache_create: 0 }, ...o }) as unknown as DecisionRecord;
    s.addRecord(rec({ forwarded: { model: SONNET, rewritten: true, fallback: false } }), "s1"); // $4 at Opus 5.5, $2 at Sonnet
    s.addRecord(rec({ forwarded: { model: OPUS, rewritten: false, fallback: false } }), "s1"); // not routed
    s.addRecord(rec({ turn: "side", forwarded: { model: HAIKU, rewritten: true, fallback: false } }), "s1"); // side calls count too
    s.addRecord(rec({ forwarded: { model: HAIKU, rewritten: true, fallback: false } }), "s2"); // another session
    assert.equal(s.get("s1").cost, 2 + 4 + 1, "the cost: every record at the model sent, side calls included"); // Sonnet $2, Opus $4, Haiku $1
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: OPUS }, subagents: [], cost: 7.004 })), "Reflex: Opus 5.5 · Est. Cost: $7.00");
    assert.equal(plain(formatStatus({ worker: "up", main: { requested: OPUS, sent: OPUS }, subagents: [], cost: 0.001 })), "Reflex: Opus 5.5");
  });

  it("shows the effort level REFLEX_EFFORT applied when it differs from the one asked for", () => {
    const main = { requested: OPUS, sent: OPUS };
    const lvl = (level: string) => ({ requested: "high", level });
    const subagents = [{ title: "Explore", model: { requested: OPUS, sent: HAIKU }, effort: lvl("low") }, { title: "Same", model: { requested: OPUS, sent: OPUS }, effort: lvl("high") }, { title: "Review", model: { requested: OPUS, sent: OPUS }, effort: lvl("max") }];
    assert.equal(plain(formatStatus({ worker: "up", main, subagents, effort: { main: lvl("low") } })), "Reflex: Opus 5.5 · Effort: ⇣ low (asked high)\n↳ Explore: ⇣ Haiku 4.5 (asked Opus 5.5) · Effort: ⇣ low (asked high)\n↳ Same: Opus 5.5\n↳ Review: Opus 5.5 · Effort: ⇡ max (asked high)");
    assert.equal(plain(formatStatus({ worker: "up", main, subagents: [], effort: { main: lvl("high") } })), "Reflex: Opus 5.5", "same level: nothing to say");
    assert.equal(plain(formatStatus({ worker: "up", main, subagents: [], effort: { main: { requested: null, level: "low" } } })), "Reflex: Opus 5.5", "the client's level unknown: no comparison");
  });

  it("the worker keeps the last APPLIED level per main chat and per subagent; unapplied and rejected ones are ignored", () => {
    const s = new SessionStatus();
    const rec = (o: Record<string, unknown>) => ({ id: "r", at: "2026-09-24T10:00:00.000Z", turn: "new", kind: "main", conv: "c-main", requested: { model: OPUS, tier: "opus", effort: "high" }, forwarded: { model: OPUS, rewritten: true, fallback: false }, ...o }) as unknown as DecisionRecord;
    s.addRecord(rec({ effort: { pick: "low", target: "low", via: "message", reasons: ["effort_down"] } }), "s1");
    s.addRecord(rec({ effort: { pick: "max", target: "high", via: null, reasons: ["effort_midturn_off"] } }), "s1"); // not applied: low holds
    s.addRecord(rec({ kind: "subagent", conv: "c-a1", effort: { pick: "low", target: "low", via: "message", reasons: ["effort_down"] } }), "s1");
    s.addRecord(rec({ kind: "subagent", conv: "c-a2", effort: { pick: "low", target: "low", via: "message", reasons: [] }, forwarded: { model: OPUS, rewritten: true, fallback: true } }), "s1");
    assert.deepEqual(s.get("s1").effort, { main: { requested: "high", level: "low" } });
    assert.deepEqual(s.get("s1").subagents, [{ title: null, model: null, effort: { requested: "high", level: "low" } }]);
  });

  it("a subagent is titled by the Agent call that started it, joined on its task text; titles are cleaned", () => {
    const s = new SessionStatus();
    s.title("s1", hashId("Run ls and report") as string, "List docs");
    s.observe({ id: "x", at: 0, sessionId: "s1", agentId: "a1", kind: "subagent", turn: "new", conv: "c-a1", requestedModel: OPUS, sentModel: HAIKU, taskHash: hashId("Run ls and report") });
    s.observe({ id: "y", at: 0, sessionId: "s1", agentId: "a2", kind: "subagent", turn: "new", conv: "c-a2", requestedModel: OPUS, sentModel: HAIKU, taskHash: hashId("other") });
    assert.deepEqual(s.get("s1").subagents.map((x) => x.title), ["List docs", null]);
    assert.equal(cleanTitle(`evil\x1b[31m title\n${"x".repeat(60)}`), `evil [31m title ${"x".repeat(23)}…`);
  });

  it("a subagent's line goes at its SubagentStop, and a record landing after the stop does not bring it back", () => {
    const s = new SessionStatus();
    const obs = (agentId: string) => s.observe({ id: agentId, at: 0, sessionId: "s1", agentId, kind: "subagent", turn: "continuation", conv: `c-${agentId}`, requestedModel: OPUS, sentModel: HAIKU });
    obs("a1");
    obs("a2");
    s.stop("s1", "a1");
    s.stop("other", "a2"); // another session's stop changes nothing here
    obs("a1");
    s.addRecord({ id: "r", at: "2026-09-24T10:00:00.000Z", turn: "continuation", kind: "subagent", conv: "c-a1", requested: { model: OPUS, tier: "opus", effort: "high" }, forwarded: { model: HAIKU, rewritten: true, fallback: false }, effort: { pick: "low", target: "low", via: "message", reasons: [] } } as unknown as DecisionRecord, "s1");
    assert.deepEqual(s.get("s1").subagents, [{ title: null, model: { requested: OPUS, sent: HAIKU }, effort: null }]);
  });

  it("never replaces the user's own status line", () => {
    const ours = { type: "command", command: "reflex statusline" };
    assert.deepEqual(mergeSettings(null, { env: {}, statusLine: ours })["statusLine"], ours);
    const theirs = { type: "command", command: "my-line" };
    assert.deepEqual(mergeSettings({ statusLine: theirs }, { env: {}, statusLine: ours })["statusLine"], theirs);
    const files: Record<string, string> = { a: '{"model":"opus"}', b: '{"statusLine":{"type":"command","command":"x"}}', c: "{broken" };
    const read = (f: string): string => { const t = files[f]; if (t === undefined) throw new Error("ENOENT"); return t; };
    assert.equal(hasOwnStatusLine(["a", "c", "missing"], read), false);
    assert.equal(hasOwnStatusLine(["a", "b"], read), true);
  });
});
