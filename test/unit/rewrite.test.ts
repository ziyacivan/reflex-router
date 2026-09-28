import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retarget, retargetBetas, HAIKU_THINKING_BUDGET, STRIP_BETAS } from "../../src/wire/rewrite.js";
import { loadFixtures } from "../support/fixtures.js";

type Json = Record<string, unknown>;
const HAIKU = "claude-haiku-4-5-20251001";
const fixtures = loadFixtures();
const fx = (name: string): Buffer => {
  const f = fixtures.find((x) => x.file === name);
  assert.ok(f, name);
  return f.body;
};
const toHaiku = (body: Buffer, drop = false): Json => {
  const r = retarget(body, { from: "sonnet", to: "haiku", model: HAIKU, dropHistoryThinking: drop });
  assert.ok(r.ok);
  return JSON.parse(r.body.toString()) as Json;
};
const roles = (b: Json): string => (b["messages"] as Json[]).map((m) => String(m["role"])[0]).join("");
const cacheMarks = (v: unknown): number => (JSON.stringify(v).match(/"cache_control"/g) ?? []).length;

describe("retarget Sonnet 5 -> Haiku 4.5", () => {
  it("matches the native Haiku request field by field on the fields the API requires", () => {
    const b = toHaiku(fx("sonnet-agent-run.main-new-turn.request.json"));
    assert.equal(b["model"], HAIKU);
    assert.equal(b["output_config"], undefined, "effort was its only key");
    assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET, display: "omitted" });
    assert.ok(!(b["messages"] as Json[]).some((m) => m["role"] === "system"));
    const native = JSON.parse(fx("haiku-mcp-draft4.main-new-turn.request.json").toString()) as Json;
    assert.deepEqual(b["context_management"], native["context_management"], "context_management is kept, as natively");
    assert.equal((native["thinking"] as Json)["type"], "enabled");
  });

  it("reports exactly the fields it rewrote", () => {
    const r = retarget(fx("sonnet-agent-run.main-continuation-tool-error.request.json"), { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    assert.deepEqual(r.fields, ["model", "output_config.effort", "thinking", "messages.system_folded:3"]);
  });

  it("folds mid-list and trailing system messages into the closest earlier user message, keeping tool_result first", () => {
    const before = JSON.parse(fx("sonnet-agent-run.main-continuation-tool-error.request.json").toString()) as Json;
    assert.equal(roles(before), "usausaus");
    const b = toHaiku(fx("sonnet-agent-run.main-continuation-tool-error.request.json"));
    assert.equal(roles(b), "uauau", "strict user/assistant alternation");
    const msgs = b["messages"] as Json[];
    const last = msgs.at(-1)!["content"] as Json[];
    assert.equal(last[0]!["type"], "tool_result", "tool_result blocks stay first");
    assert.equal(cacheMarks(b["messages"]), cacheMarks(before["messages"]), "cache_control markers are neither lost nor added");
  });

  it("handles the interactive shape: system at index 1, thinking without `display`", () => {
    const b = toHaiku(fx("interactive.main-continuation.request.json"));
    assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET });
    assert.equal(roles(b), "uau");
  });

  it("a system message before any user message goes to the start of the next user message", () => {
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64000, messages: [{ role: "system", content: "S" }, { role: "user", content: [{ type: "text", text: "U" }] }] }));
    const b = toHaiku(body);
    assert.deepEqual(b["messages"], [{ role: "user", content: [{ type: "text", text: "S" }, { type: "text", text: "U" }] }]);
  });

  it("is deterministic over a growing tool loop: request k's rewritten history is a prefix of request k+1's", () => {
    const k = [{ role: "user", content: [{ type: "text", text: "go" }] }, { role: "system", content: "env" }];
    const k1 = [...k, { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] }, { role: "system", content: "later" }];
    const mk = (messages: unknown[]): Buffer => Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 64000, messages }));
    const a = toHaiku(mk(k))["messages"] as Json[];
    const c = toHaiku(mk(k1))["messages"] as Json[];
    assert.deepEqual(c[0], a[0]);
  });

  it("keeps other output_config keys (e.g. a JSON-schema format) and only removes effort", () => {
    const body = Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 100, messages: [], output_config: { effort: "high", format: { type: "json_schema" } }, thinking: { type: "disabled" } }));
    const r = retarget(body, { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.deepEqual(b["output_config"], { format: { type: "json_schema" } });
    assert.deepEqual(b["thinking"], { type: "disabled" });
    assert.deepEqual(r.fields, ["model", "output_config.effort"]);
  });

  it("caps the thinking budget below max_tokens, and refuses when no valid budget fits", () => {
    const mk = (max: number): Buffer => Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: max, messages: [], thinking: { type: "adaptive" } }));
    const r = retarget(mk(8000), { from: "sonnet", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    assert.deepEqual((JSON.parse(r.body.toString()) as Json)["thinking"], { type: "enabled", budget_tokens: 7999 });
    assert.deepEqual(retarget(mk(1000), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "thinking_budget_too_small" });
  });

  it("lowers max_tokens to the target's ceiling (Opus 5.5 asks for 128000; Haiku takes 64000), and only when above it", () => {
    const mk = (max: number): Buffer => Buffer.from(JSON.stringify({ model: "claude-opus-5-5", max_tokens: max, messages: [], thinking: { type: "adaptive" } }));
    const r = retarget(mk(128_000), { from: "opus", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.equal(b["max_tokens"], 64_000);
    assert.deepEqual(b["thinking"], { type: "enabled", budget_tokens: HAIKU_THINKING_BUDGET }, "the budget is taken below the clamped value");
    assert.deepEqual(r.fields, ["model", "max_tokens", "thinking"]);
    const s = retarget(mk(128_000), { from: "opus", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(s.ok);
    assert.deepEqual(s.fields, ["model"], "Sonnet takes 128000: untouched");
    const small = retarget(mk(32_000), { from: "opus", to: "haiku", model: HAIKU });
    assert.ok(small.ok && !small.fields.includes("max_tokens"));
  });

  it("optionally drops another model's thinking blocks from the history, and says how many", () => {
    const r = retarget(fx("interactive.main-continuation.request.json"), { from: "sonnet", to: "haiku", model: HAIKU, dropHistoryThinking: true });
    assert.ok(r.ok);
    assert.ok(r.fields.includes("messages.thinking_dropped:1"));
    assert.doesNotMatch(r.body.toString(), /"type":"thinking"/);
  });

  it("refuses non-JSON and bodies without messages", () => {
    assert.deepEqual(retarget(Buffer.from("x"), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "not_json" });
    assert.deepEqual(retarget(Buffer.from("{}"), { from: "sonnet", to: "haiku", model: HAIKU }), { ok: false, reason: "no_messages" });
  });
});

describe("retargetBetas: header values a target rejects", () => {
  const opus1m = fixtures.find((f) => f.file === "interactive-opus1m.main-new-turn.request.json");
  assert.ok(opus1m, "the opus[1m] fixture exists");
  const header = String(opus1m.headers["anthropic-beta"]);

  it("the opus[1m] fixture carries the long-context beta (route acceptance session B1's shape)", () => {
    assert.match(header, /(^|,)context-1m-2025-08-07(,|$)/);
  });

  it("to Haiku: removes exactly the long-context beta and keeps every other value in order", () => {
    const r = retargetBetas(header, "haiku");
    assert.deepEqual(r.stripped, ["context-1m-2025-08-07"]);
    assert.deepEqual(r.value?.split(","), header.split(",").filter((b) => b !== "context-1m-2025-08-07"));
    assert.match(r.value ?? "", /context-management-2025-06-27/, "a similar prefix is not touched");
  });

  it("to Sonnet or Opus: unchanged (both accept it)", () => {
    for (const t of ["sonnet", "opus"] as const) assert.deepEqual(retargetBetas(header, t), { value: header, stripped: [] });
  });

  it("no header, or no rejected value: unchanged", () => {
    assert.deepEqual(retargetBetas(undefined, "haiku"), { value: undefined, stripped: [] });
    assert.deepEqual(retargetBetas("a-1,b-2", "haiku"), { value: "a-1,b-2", stripped: [] });
  });

  it("every strip rule names its evidence", () => {
    for (const r of STRIP_BETAS) assert.ok(r.evidence.length > 20 && r.prefix.endsWith("-"));
  });
});

describe("retarget within the adaptive families", () => {
  it("Opus -> Sonnet swaps only the model", () => {
    const r = retarget(fx("interactive.main-continuation.request.json"), { from: "opus", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    assert.deepEqual(r.fields, ["model"]);
  });
});

describe("retarget from Fable 5.1: per-message output_config", () => {
  // The shape Fable 5.1 requests carry (2.1.278, observed): a system message with its own per-turn effort.
  const fable = Buffer.from(JSON.stringify({
    model: "claude-fable-5-1",
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: [{ type: "text", text: "U" }] }, { role: "system", content: [{ type: "text", text: "S" }], output_config: { effort: "high" } }],
  }));
  it("Sonnet: the system message stays, its output_config goes; the top-level effort stays", () => {
    const r = retarget(fable, { from: "fable", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.deepEqual((b["messages"] as Json[])[1], { role: "system", content: [{ type: "text", text: "S" }] });
    assert.deepEqual(b["output_config"], { effort: "high" });
    assert.deepEqual(r.fields, ["model", "messages.output_config_dropped:1"]);
  });
  it("Sonnet: only the effort key goes; any other key of the message's output_config stays", () => {
    const b0 = JSON.parse(fable.toString()) as { messages: Json[] };
    b0.messages[1]!["output_config"] = { effort: "high", format: { type: "json_schema" } };
    const r = retarget(Buffer.from(JSON.stringify(b0)), { from: "fable", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    assert.deepEqual((JSON.parse(r.body.toString()) as { messages: Json[] }).messages[1]!["output_config"], { format: { type: "json_schema" } });
    assert.deepEqual(r.fields, ["model", "messages.output_config.effort:1"]);
  });
  it("Opus keeps it: only the model changes", () => {
    const r = retarget(fable, { from: "fable", to: "opus", model: "claude-opus-5" });
    assert.ok(r.ok);
    assert.deepEqual(r.fields, ["model"]);
    assert.deepEqual((JSON.parse(r.body.toString()) as { messages: Json[] }).messages[1]!["output_config"], { effort: "high" });
  });
});

describe("retarget with MCP tool search on (2.1.282)", () => {
  const TS = "toolsearch.main-new-turn.request.json";
  const orig = JSON.parse(fx(TS).toString()) as Json;
  const additions = (b: Json): string[] =>
    (b["messages"] as Json[]).flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Json[]) : [])).filter((c) => c["type"] === "tool_addition").map((c) => String((c["tool"] as Json)["name"]));
  const deferred = (b: Json): string[] => (b["tools"] as Json[]).filter((t) => t["defer_loading"] === true).map((t) => String(t["name"]));

  it("Haiku takes no role:system message, so each tool_addition becomes its tool without defer_loading", () => {
    const added = additions(orig);
    assert.ok(added.length > 0 && added.every((n) => deferred(orig).includes(n)), "the fixture announces deferred tools");
    const r = retarget(fx(TS), { from: "opus", to: "haiku", model: HAIKU });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.deepEqual(additions(b), [], "API: 'tool_addition'/'tool_removal' blocks are only permitted within role: \"system\" messages");
    assert.ok(!(b["messages"] as Json[]).some((m) => m["role"] === "system"));
    assert.deepEqual(deferred(b), deferred(orig).filter((n) => !added.includes(n)), "tools the harness never announced stay deferred");
    assert.equal((b["tools"] as Json[]).length, (orig["tools"] as Json[]).length);
    assert.ok(r.fields.includes(`tools.undeferred:${added.length}`) && r.fields.includes(`messages.tool_addition_lifted:${added.length}`));
    assert.equal(cacheMarks(b["messages"]), cacheMarks(orig["messages"]), "the breakpoint on the last tool_addition moves, it is not lost");
    // The ToolSearch tool and every tool definition other than the flag are kept as they were.
    const strip = (t: Json): Json => Object.fromEntries(Object.entries(t).filter(([k]) => k !== "defer_loading"));
    assert.deepEqual((b["tools"] as Json[]).map(strip), (orig["tools"] as Json[]).map(strip));
  });

  it("a tool_removal, or any other block reflex does not know, in a system message leaves the request unchanged", () => {
    for (const block of [{ type: "tool_removal", tool: { type: "tool_reference", name: "x" } }, { type: "something_new" }]) {
      const b = JSON.parse(fx(TS).toString()) as Json;
      const sys = (b["messages"] as Json[]).find((m) => m["role"] === "system")!;
      (sys["content"] as Json[]).push(block);
      const r = retarget(Buffer.from(JSON.stringify(b)), { from: "opus", to: "haiku", model: HAIKU });
      assert.deepEqual(r, { ok: false, reason: "system_block_unfoldable" });
    }
  });

  it("Sonnet 5 keeps its system messages but not tool_addition blocks ('not supported on this model')", () => {
    const r = retarget(fx(TS), { from: "opus", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.deepEqual(additions(b), []);
    assert.ok((b["messages"] as Json[]).some((m) => m["role"] === "system"), "the hook text stays a system message");
    assert.deepEqual(deferred(b), deferred(orig).filter((n) => !additions(orig).includes(n)));
    assert.equal(cacheMarks(b["messages"]), cacheMarks(orig["messages"]));
  });

  it("a system message that held only tool_addition blocks goes, and its cache breakpoint moves to the message before", () => {
    const b0 = JSON.parse(fx(TS).toString()) as Json;
    const msgs = b0["messages"] as Json[];
    const sys = msgs.find((m) => m["role"] === "system")!;
    sys["content"] = (sys["content"] as Json[]).filter((c) => c["type"] === "tool_addition");
    const r = retarget(Buffer.from(JSON.stringify(b0)), { from: "opus", to: "sonnet", model: "claude-sonnet-5" });
    assert.ok(r.ok);
    const b = JSON.parse(r.body.toString()) as Json;
    assert.equal((b["messages"] as Json[]).length, msgs.length - 1, "no empty system message is sent");
    assert.equal(cacheMarks(b["messages"]), cacheMarks(msgs));
  });

  it("Opus 5.5 and Fable 5.1 take tool_addition natively: blocks and defer_loading stay as they are", () => {
    for (const [from, to, model] of [["opus", "fable", "claude-fable-5-1"], ["fable", "opus", "claude-opus-5-5"]] as const) {
      const r = retarget(fx(TS), { from, to, model });
      assert.ok(r.ok);
      const b = JSON.parse(r.body.toString()) as Json;
      assert.deepEqual(b["tools"], orig["tools"]);
      assert.deepEqual(additions(b), additions(orig));
    }
  });
});

describe("retarget: shapes a target rejects and no rewrite can keep", () => {
  const body = (o: Json): Buffer => Buffer.from(JSON.stringify({ model: "claude-sonnet-5", max_tokens: 32000, messages: [{ role: "user", content: "hi" }], ...o }));
  const to = (model: string, tier: "opus" | "fable" | "sonnet", o: Json) => retarget(body(o), { from: "sonnet", to: tier, model });

  it("thinking disabled is never sent to Opus 5.5 or Fable 5.x (400 at every effort); Opus 5 and Sonnet take it", () => {
    const off = { thinking: { type: "disabled" } };
    assert.deepEqual(to("claude-opus-5-5", "opus", off), { ok: false, reason: "thinking_disabled_rejected" });
    assert.deepEqual(to("claude-opus-5-5[1m]", "opus", off), { ok: false, reason: "thinking_disabled_rejected" });
    assert.deepEqual(to("claude-fable-5-1", "fable", off), { ok: false, reason: "thinking_disabled_rejected" });
    assert.deepEqual(to("claude-fable-5", "fable", off), { ok: false, reason: "thinking_disabled_rejected" });
    assert.ok(to("claude-opus-5", "opus", off).ok);
    assert.ok(retarget(body(off), { from: "opus", to: "sonnet", model: "claude-sonnet-5" }).ok);
  });

  it("forced tool_choice (any, tool) is never sent to Opus 5.5 or Fable 5.1; auto and none are", () => {
    for (const type of ["any", "tool"]) {
      const forced = { tool_choice: { type, ...(type === "tool" ? { name: "Bash" } : {}) } };
      assert.deepEqual(to("claude-opus-5-5", "opus", forced), { ok: false, reason: "forced_tool_choice_rejected" });
      assert.deepEqual(to("claude-fable-5-1", "fable", forced), { ok: false, reason: "forced_tool_choice_rejected" });
      assert.ok(to("claude-fable-5", "fable", forced).ok, "Fable 5 takes forced tool use");
      assert.ok(to("claude-opus-5", "opus", forced).ok);
    }
    for (const type of ["auto", "none"]) assert.ok(to("claude-opus-5-5", "opus", { tool_choice: { type } }).ok);
  });

  it("thinking enabled with a budget still becomes adaptive for Opus 5.5 (the rewrite that keeps its meaning)", () => {
    const r = to("claude-opus-5-5", "opus", { thinking: { type: "enabled", budget_tokens: 8000 } });
    assert.ok(r.ok);
    assert.deepEqual((JSON.parse(r.body.toString()) as Json)["thinking"], { type: "adaptive" });
  });
});
