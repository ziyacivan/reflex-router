// Explicit subagent models, side calls of pinned conversations, and effort marks on side calls: real front door +
// worker, fake upstream, fake Jev, the 2.1.280 fixtures. Each case uses its own session id.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { records, sseHandler, type Rec } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";
import { parseRequest } from "../../src/wire/claude-code.js";

type Json = Record<string, unknown>;
type Msg = { role: string; content: unknown; output_config?: { effort: string } };
interface Req {
  headers: Json;
  body: Json & { messages: Msg[]; metadata: { user_id: string } };
}

const fx = loadFixtures();
const get = (name: string): Req => {
  const f = fx.find((x) => x.version === "2.1.280" && x.file === `print-agent.${name}.request.json`)!;
  return { headers: f.headers, body: JSON.parse(f.body.toString()) as Req["body"] };
};
// Continuations are built on the new turn's own messages: the history Claude Code really sends back.
const later = (first: Req, name: string): Req => ({ headers: first.headers, body: { ...get(name).body, messages: [...first.body.messages, ...get(name).body.messages.slice(2)] } });
const mainNew = get("main-new-turn");
const mainCont = later(mainNew, "main-continuation");
const subNew = get("subagent-new-turn");
const subCont = later(subNew, "subagent-continuation");
const subTask = ((): string => {
  const r = parseRequest(subNew.headers as never, Buffer.from(JSON.stringify(subNew.body)));
  assert.ok(r.ok && r.view.task !== null);
  return r.view.task;
})();

/** The request in session `sid` (agent `agent` for a subagent), with `extra` messages appended and `model` swapped. */
function at(req: Req, sid: string, o: { agent?: string; extra?: Msg[]; model?: string } = {}): { headers: Json; body: Buffer } {
  const b = structuredClone(req.body);
  b.metadata.user_id = JSON.stringify({ ...(JSON.parse(b.metadata.user_id) as Json), session_id: sid });
  if (o.extra) b.messages = [...b.messages, ...o.extra];
  if (o.model) b["model"] = o.model;
  const { host: _h, "content-length": _c, ...h } = req.headers;
  return { headers: { ...h, "x-claude-code-session-id": sid, ...(o.agent ? { "x-claude-code-agent-id": o.agent } : {}) }, body: Buffer.from(JSON.stringify(b)) };
}
const said = (text: string): Msg[] => [{ role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: [{ type: "text", text }] }];
const SUMMARY = said("Describe your most recent action in 3-5 words.");

describe("side calls and explicit subagent models (route mode)", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev();
    stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, upgrades: "on", effort: true, effortMidturn: true } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  async function send(r: { headers: Json; body: Buffer }): Promise<{ sent: Json & { model: string; messages: Msg[] }; rec: Rec }> {
    const before = records(stack).length;
    const n = stack.upstream.seen.length;
    await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: r.headers as never, body: r.body });
    const all = await waitFor(() => (records(stack).length > before ? records(stack) : null));
    return { sent: JSON.parse(stack.upstream.seen[n]!.body.toString()) as Json & { model: string; messages: Msg[] }, rec: all[before]! };
  }
  const agentCall = (sid: string, model?: string): Promise<unknown> =>
    request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { description: "d", prompt: subTask, subagent_type: "general-purpose", ...(model ? { model } : {}) } }) });

  it("a subagent the Agent call gave a model explicitly runs on it; one that inherits is routed", async () => {
    jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
    await agentCall("x-inherit");
    assert.equal((await send(at(subNew, "x-inherit", { agent: "A" }))).sent.model, "claude-sonnet-5-5");

    await agentCall("x-opus", "opus");
    const down = await send(at(subNew, "x-opus", { agent: "A" }));
    assert.equal(down.sent.model, "claude-opus-5-5");
    assert.deepEqual(down.rec.plan?.reasons, ["model_explicit"]);

    jev.set({ kind: "answer", tier: "opus", reasoning: 1 });
    await agentCall("x-sonnet", "sonnet");
    assert.equal((await send(at(subNew, "x-sonnet", { agent: "A", model: "claude-sonnet-5" }))).sent.model, "claude-sonnet-5", "no upgrade either");
  });

  it("a pinned subagent's progress summary follows the pin; the next continuation still does", async () => {
    jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
    assert.equal((await send(at(subNew, "pin", { agent: "A" }))).sent.model, "claude-sonnet-5-5");
    const s = await send(at(subCont, "pin", { agent: "A", extra: SUMMARY }));
    assert.equal(s.rec.side_kind, "agent_summary");
    assert.equal(s.sent.model, "claude-sonnet-5-5");
    assert.equal((await send(at(subCont, "pin", { agent: "A" }))).sent.model, "claude-sonnet-5-5");
  });

  it("a main chat's task notifications, hand-backs and tool steps with harness text follow its pin; a suggestion does not", async () => {
    jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
    assert.equal((await send(at(mainNew, "mpin"))).sent.model, "claude-sonnet-5-5");
    const cases: [string, string, Msg[]][] = [
      ["cross_session", "claude-sonnet-5-5", said("Another Claude session sent a message:\nhello")],
      ["task_notification", "claude-sonnet-5-5", said("[SYSTEM NOTIFICATION - NOT USER INPUT] task done")],
      ["tool_result_text", "claude-sonnet-5-5", [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "a" }, { type: "text", text: "Harness note: output truncated." }] }]],
      ["suggestion", "claude-opus-5-5", said("[SUGGESTION MODE: Suggest what the user might naturally type next.]")],
    ];
    for (const [what, model, extra] of cases) assert.equal((await send(at(mainCont, "mpin", { extra }))).sent.model, model, what);
    jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
    await send(at(subNew, "mpin", { agent: "N" }));
    assert.equal((await send(at(subCont, "mpin", { agent: "N", extra: said("[SYSTEM NOTIFICATION - NOT USER INPUT] task done") }))).sent.model, "claude-sonnet-5-5", "a subagent's too");
  });

  it("a subagent asking for another tier than the main chat was given its model (agent definition): not routed", async () => {
    jev.set({ kind: "answer", tier: "opus", reasoning: 1 });
    await send(at(mainNew, "x-tier")); // the main chat asks for Opus 5.5 and stays there
    const r = await send(at(subNew, "x-tier", { agent: "A", model: "claude-sonnet-5" }));
    assert.equal(r.sent.model, "claude-sonnet-5", "no upgrade although upgrades are on");
    assert.deepEqual(r.rec.plan?.reasons, ["model_explicit"]);
    jev.set({ kind: "answer", tier: "sonnet", reasoning: 1 });
    assert.equal((await send(at(subNew, "x-tier", { agent: "B" }))).sent.model, "claude-sonnet-5-5", "the main chat's tier: inherited, routed");
  });

  it("when Claude Code rebuilds a subagent's history (background task resumed), its level is put back and kept", async () => {
    jev.set({ kind: "answer", tier: "opus", reasoning: 0 });
    await send(at(subNew, "rebuilt", { agent: "R" }));
    await send(at(subCont, "rebuilt", { agent: "R" }));
    const rebuilt: Req = { headers: subCont.headers, body: { ...subCont.body, messages: [{ role: "user", content: [{ type: "text", text: "the task, as Claude Code rebuilds it" }] }, ...subCont.body.messages.slice(1)] } };
    const n = await send(at(rebuilt, "rebuilt", { agent: "R", extra: said("[SYSTEM NOTIFICATION - NOT USER INPUT] task done") }));
    assert.equal(n.sent.messages[1]!.output_config?.effort, "low");
    assert.ok(n.rec.forwarded.fields.includes("messages.effort_kept"));
    const c = await send(at(rebuilt, "rebuilt", { agent: "R" }));
    assert.equal(c.sent.messages[1]!.output_config?.effort, "low");
    assert.ok(c.rec.forwarded.fields.includes("messages.effort_reinserted:1"));
  });

  it("every side call carries the effort marks its conversation's last request carried: the prefix is the same", async () => {
    jev.set({ kind: "answer", tier: "opus", reasoning: 0 }); // same model, level low (the client asks for medium)
    await send(at(mainNew, "marks"));
    const cont = await send(at(mainCont, "marks"));
    assert.equal(cont.sent.messages[1]!.output_config?.effort, "low");
    const sides: [string, Msg[]][] = [
      ["suggestion", said("[SUGGESTION MODE: Suggest what the user might naturally type next.]")],
      ["cross_session", said("Another Claude session sent a message:\nhello")],
      ["notification", said("[SYSTEM NOTIFICATION - NOT USER INPUT] task done")],
      ["notification", [{ role: "assistant", content: [{ type: "text", text: "done" }] }, { role: "user", content: "The user stepped away and is coming back. Recap in under 40 words." }]],
      ["tool_result_text", [{ role: "assistant", content: [{ type: "tool_use", id: "toolu_x", name: "Bash", input: { command: "ls" } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "a" }, { type: "text", text: "Harness note: output truncated." }] }]],
    ];
    const prefix = (m: Msg[]): string => JSON.stringify(m.slice(0, cont.sent.messages.length));
    for (const [kind, extra] of sides) {
      const s = await send(at(mainCont, "marks", { extra }));
      assert.equal(s.rec.side_kind, kind);
      assert.equal(prefix(s.sent.messages), prefix(cont.sent.messages), kind);
    }
    await send(at(subNew, "marks", { agent: "B" }));
    const sc = await send(at(subCont, "marks", { agent: "B" }));
    const ss = await send(at(subCont, "marks", { agent: "B", extra: SUMMARY }));
    assert.equal(ss.sent.messages[1]!.output_config?.effort, "low");
    assert.equal(prefix(ss.sent.messages), prefix(sc.sent.messages));
  });

  it("a side call in a conversation reflex never changed goes out byte for byte", async () => {
    // Marks are keyed by history, not session: a history of its own, so no mark from the other cases matches.
    const own: Req = { headers: mainCont.headers, body: { ...mainCont.body, messages: [{ role: "user", content: [{ type: "text", text: "another chat" }] }, ...mainCont.body.messages.slice(1)] } };
    const r = at(own, "untouched", { extra: said("[SUGGESTION MODE: x]") });
    const n = stack.upstream.seen.length;
    await send(r);
    assert.ok(stack.upstream.seen[n]!.body.equals(r.body));
  });
});
