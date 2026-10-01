// Outcome capture end to end: hook events POSTed to the real front door reach the worker's tracker, and the outcome
// records it writes into decisions.jsonl are joined to the decision record of the same turn.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { allRecords, replay, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";
import { parseRequest } from "../../src/wire/claude-code.js";

const fixture = loadFixtures().find((f) => f.file === "interactive.main-new-turn.request.json")!;
const SESSION = String(fixture.headers["x-claude-code-session-id"]);
/**
 * The fixture's own typed words. With hooks arriving, a main new turn needs the typed prompt behind it
 * (no_typed_prompt), so each UserPromptSubmit here carries them after its own words.
 */
const TASK = (() => { const r = parseRequest(fixture.headers, fixture.body); assert.ok(r.ok && r.view.task); return r.view.task; })();

describe("outcome capture through the front door", () => {
  let jev: FakeJev;
  let stack: Stack;
  const hook = async (event: Record<string, unknown>): Promise<number> =>
    (await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) })).status;

  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
    stack = await startStack({ config: { jevBaseUrl: jev.url } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("prompt -> wire turn -> edit -> failing test -> correction: one outcome record keyed to that turn's decision", async () => {
    assert.equal(await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "P1", prompt: `fix the parser ${TASK}` }), 204);
    const { rec } = await replay(stack, fixture);
    assert.equal(await hook({ hook_event_name: "PostToolUse", prompt_id: "P1", tool_name: "Edit", tool_input: { file_path: "/r/p.ts", old_string: "a", new_string: "b" }, tool_response: {} }), 204);
    assert.equal(await hook({ hook_event_name: "PostToolUseFailure", prompt_id: "P1", tool_name: "Bash", tool_input: { command: "npm test" }, error: "Exit code 1" }), 204);
    assert.equal(await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "P2", prompt: `no, that's wrong ${TASK}` }), 204);

    const outcome = await waitFor(() => allRecords(stack).find((r) => r["record"] === "outcome"), { what: "outcome record" });
    assert.equal(outcome["decision_id"], rec["id"], "joined to the decision of the same turn");
    const signals = outcome["signals"] as { test_failure_after_edit: { detected: boolean }; correction: { score: number } };
    assert.equal(signals.test_failure_after_edit.detected, true);
    assert.ok(signals.correction.score >= 1);
    assert.doesNotMatch(JSON.stringify(allRecords(stack)), /fix the parser|that's wrong|\/r\/p\.ts/, "no prompt text or paths in the log");
  });

  it("malformed or unknown hook bodies are still answered 204 and ignored", async () => {
    assert.equal(await hook({ hook_event_name: "SomethingNew" }), 204);
    assert.equal((await request(`${stack.url}/__reflex/hook`, { method: "POST", body: "not json" })).status, 204);
  });
});

// ---- Phase 2b: auto-escalation (REFLEX_ESCALATE=1) --------------------------------------------------------------

describe("escalation through the front door", () => {
  let jev: FakeJev;
  let stack: Stack;
  const hook = async (s: Stack, event: Record<string, unknown>): Promise<number> =>
    (await request(`${s.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) })).status;
  const newTurns = (s: Stack): Record<string, unknown>[] => allRecords(s).filter((r) => r["record"] === "decision" && r["turn"] === "new");

  before(async () => {
    // A confident haiku answer, so the policy's own pick is the bottom tier and one tier up is visible.
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.95, reasoning: 0.2 });
    stack = await startStack({
      effectiveMode: "route",
      config: { jevBaseUrl: jev.url, escalate: "on", escalateTarget: "next", escalateThreshold: 1, escalateWindowTurns: 2 },
    });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("a correction on a routed turn raises the conversation's next new turn one tier, and says why", async () => {
    await hook(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "E1", prompt: `rename the helper ${TASK}` });
    const { rec: first } = await replay(stack, fixture);
    assert.equal(first["forwarded"] && (first["forwarded"] as Record<string, unknown>)["model"], "claude-haiku-4-5-20251001", "the policy's own pick, unescalated");

    // The correction closes E1's window; the signal reaches the router before the next turn is decided.
    await hook(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "E2", prompt: `no, that's wrong ${TASK}` });
    await waitFor(() => allRecords(stack).find((r) => r["record"] === "outcome"), { what: "the first window to close" });

    const { rec: second } = await replay(stack, fixture);
    const esc = second["escalation"] as { signal: string; from: string; to: string; decision_id: string } | null;
    assert.ok(esc, "the second turn carries an escalation record");
    assert.equal(esc.signal, "correction");
    assert.equal(esc.from, "haiku", "what the policy would have picked");
    // The fixture requests claude-sonnet-5, so sonnet is both "one tier up from haiku" and the cap. E1 vs E2 is
    // distinguished in test/unit/escalation.test.ts, where the tiers can be chosen freely.
    assert.equal(esc.to, "sonnet", "one tier up, and never past the requested tier");
    assert.equal(esc.decision_id, first["id"], "joined to the turn whose window produced the signal");
    assert.equal((second["forwarded"] as Record<string, unknown>)["model"], "claude-sonnet-5");
    const reasons = (second["plan"] as { reasons: string[] }).reasons;
    assert.ok(reasons.includes("escalated:correction"), reasons.join(","));
    assert.doesNotMatch(JSON.stringify(allRecords(stack)), /that's wrong|rename the helper/, "no prompt text in the log");
  });

  it("the escalation decays: once its turns are spent the conversation routes normally again", async () => {
    // escalateWindowTurns is 2 and the turn above spent one; this one spends the last.
    await hook(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "E3", prompt: `go on ${TASK}` });
    await replay(stack, fixture);
    await hook(stack, { hook_event_name: "UserPromptSubmit", prompt_id: "E4", prompt: `go on ${TASK}` });
    const { rec: after } = await replay(stack, fixture);
    assert.equal(after["escalation"], null, "decayed");
    assert.equal((after["forwarded"] as Record<string, unknown>)["model"], "claude-haiku-4-5-20251001");
    assert.ok(newTurns(stack).length >= 4);
  });

  it("every decision record names the backend version that answered", () => {
    for (const d of newTurns(stack)) assert.equal(d["backend_version"], "jev-test", JSON.stringify(d["id"]));
  });
});

describe("escalation is off unless REFLEX_ESCALATE is set", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.95, reasoning: 0.2 });
    stack = await startStack({ effectiveMode: "route", config: { jevBaseUrl: jev.url } }); // escalate defaults to false
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("the same correction changes nothing about the next turn", async () => {
    const hook = async (event: Record<string, unknown>): Promise<number> =>
      (await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) })).status;
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "N1", prompt: `rename the helper ${TASK}` });
    await replay(stack, fixture);
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "N2", prompt: `no, that's wrong ${TASK}` });
    await waitFor(() => allRecords(stack).find((r) => r["record"] === "outcome"), { what: "the first window to close" });
    const { rec: second } = await replay(stack, fixture);
    assert.equal(second["escalation"], null);
    assert.equal((second["forwarded"] as Record<string, unknown>)["model"], "claude-haiku-4-5-20251001");
  });
});

describe("REFLEX_ESCALATE=shadow records what it would have done and changes nothing", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.95, reasoning: 0.2 });
    stack = await startStack({ effectiveMode: "route", config: { jevBaseUrl: jev.url, escalate: "shadow", escalateThreshold: 1, escalateWindowTurns: 2 } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("writes would_escalate, leaves the tier alone, and adds no escalated: reason", async () => {
    const hook = async (event: Record<string, unknown>): Promise<number> =>
      (await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: SESSION, ...event }) })).status;
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "S1", prompt: `rename the helper ${TASK}` });
    await replay(stack, fixture);
    await hook({ hook_event_name: "UserPromptSubmit", prompt_id: "S2", prompt: `no, that's wrong ${TASK}` });
    await waitFor(() => allRecords(stack).find((r) => r["record"] === "outcome"), { what: "the first window to close" });

    const { rec: second } = await replay(stack, fixture);
    const would = second["would_escalate"] as { signal: string; from: string; to: string } | null;
    assert.ok(would, "shadow still records the arithmetic");
    assert.equal(would.signal, "correction");
    assert.equal(would.from, "haiku");
    assert.equal(would.to, "sonnet", "straight back to the requested tier (the fixture requests sonnet)");
    assert.equal(second["escalation"], null, "never both");
    assert.equal((second["forwarded"] as Record<string, unknown>)["model"], "claude-haiku-4-5-20251001", "nothing moved");
    const reasons = (second["plan"] as { reasons: string[] }).reasons;
    assert.ok(!reasons.some((r) => r.startsWith("escalated:")), reasons.join(","));
  });
});

