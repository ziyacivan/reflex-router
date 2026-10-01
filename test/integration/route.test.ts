// Route mode end to end: real front door + supervisor + worker, fake upstream, fake Jev, captured fixtures.
// Each describe block uses its own session ids so pins, overrides and disabled tiers never leak between cases.
import assert from "node:assert/strict";
import type http from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import zlib from "node:zlib";
import { DEFAULT_MODELS } from "../../src/config.js";
import { DECISION_GRACE_MS } from "../../src/timing.js";
import { startFakeJev, type FakeJev } from "../support/fake-jev.js";
import { loadFixtures, type Fixture } from "../support/fixtures.js";
import { request, waitFor } from "../support/http.js";
import { records, replay, requestHeaders, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";
import { retargetBetas } from "../../src/wire/rewrite.js";

type Json = Record<string, unknown>;
const HAIKU = "claude-haiku-4-5-20251001";
const fixtures = loadFixtures();
const fx = (name: string): Fixture => {
  const f = fixtures.find((x) => x.file === `interactive.${name}.request.json`);
  assert.ok(f, name);
  return f;
};

/** The same fixture in another session: header and metadata.user_id change together, so the shape check still passes. */
function inSession(f: Fixture, sid: string, mutate?: (b: Json) => void): Fixture {
  const b = JSON.parse(f.body.toString()) as Json;
  const md = b["metadata"] as { user_id: string };
  md.user_id = JSON.stringify({ ...(JSON.parse(md.user_id) as Json), session_id: sid });
  mutate?.(b);
  return { ...f, headers: { ...f.headers, "x-claude-code-session-id": sid }, body: Buffer.from(JSON.stringify(b)) };
}
/** Prefixes the user's own text (the last text block of the last message) with `prefix`. */
const prefixTask = (prefix: string) => (b: Json): void => {
  const msgs = b["messages"] as { role: string; content: { type: string; text?: string }[] }[];
  const last = [...msgs].reverse().find((m) => m.role === "user")!;
  const block = [...last.content].reverse().find((c) => c.type === "text" && !c.text?.startsWith("<system-reminder>"))!;
  block.text = prefix + block.text!;
};
/** Inserts `token` right after the prompt's opening <pasted_content id=…> tag. */
const insertAfterPasteTag = (token: string) => (b: Json): void => {
  const msgs = b["messages"] as { role: string; content: { type: string; text?: string }[] }[];
  const last = [...msgs].reverse().find((m) => m.role === "user")!;
  const block = last.content.find((c) => c.type === "text" && /^\s*<pasted_content id="[^"]*">/.test(c.text ?? ""))!;
  block.text = block.text!.replace(/^(\s*<pasted_content id="[^"]*">)/, `$1${token}`);
};
const sentBody = (stack: Stack, i: number): Json => JSON.parse(stack.upstream.seen[i]!.body.toString()) as Json;

interface Timing {
  decision_wait_ms: number;
  decision_deadline_ms: number;
  upstream_first_byte_ms: number | null;
}
const timingOf = (rec: object): Timing => (rec as { timing: Timing }).timing;

describe("route mode", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "haiku", confidence: 0.9, reasoning: 0.4 });
    stack = await startStack({ effectiveMode: "route", config: { mode: "route", jevBaseUrl: jev.url, jevDeadlineMs: 500 } });
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });
  beforeEach(() => {
    stack.upstream.setHandler(sseHandler);
    jev.set({ kind: "answer", tier: "haiku", confidence: 0.9, reasoning: 0.4 });
  });

  describe("subagents", () => {
    it("the first request is decided and rewritten to Haiku; the record lists requested model, rewritten model and fields", async () => {
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-sub"));
      assert.equal(status, 200);
      const b = sentBody(stack, n);
      assert.equal(b["model"], HAIKU);
      assert.equal(b["output_config"], undefined);
      assert.equal((b["thinking"] as Json)["type"], "enabled");
      assert.ok(!(b["messages"] as Json[]).some((m) => m["role"] === "system"));
      assert.equal(rec.mode_effective, "route");
      assert.equal(rec.pin, "set");
      assert.deepEqual(rec.forwarded, { requested_model: "claude-sonnet-5", model: HAIKU, rewritten: true, fields: ["model", "output_config.effort", "thinking", "messages.system_folded:1"], fallback: false, fallback_status: null, fallback_error: null });
      assert.equal(rec.plan?.routed_to, HAIKU);
    });

    it("its continuation reuses the pin (same agent id) with zero Jev calls", async () => {
      const calls = jev.calls.length;
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-continuation"), "s-sub"));
      assert.equal(jev.calls.length, calls);
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.equal(rec.pin, "hit");
      assert.equal(rec.forwarded.rewritten, true);
    });

    it("every record carries a timing breakdown: a decided new turn waited for the backend, a continuation did not", async () => {
      const first = await replay(stack, inSession(fx("subagent-new-turn"), "s-timing"));
      const cont = await replay(stack, inSession(fx("subagent-continuation"), "s-timing"));
      const a = timingOf(first.rec);
      assert.equal(a.decision_deadline_ms, 500);
      assert.ok(a.decision_wait_ms >= 0 && a.decision_wait_ms < 500 + DECISION_GRACE_MS, `waited ${a.decision_wait_ms} ms`);
      assert.ok(a.upstream_first_byte_ms !== null && a.upstream_first_byte_ms >= 0);
      const b = timingOf(cont.rec);
      assert.equal(b.decision_wait_ms, 0, "a pinned continuation never waits for the backend");
      assert.ok(b.upstream_first_byte_ms !== null);
    });

    it("the pinned subagent's progress summary follows the pin (its loop's cache lives there); no Jev call", async () => {
      const calls = jev.calls.length;
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-summary"), "s-sub"));
      assert.equal(jev.calls.length, calls);
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.equal(rec.turn, "side");
      assert.equal(rec.side_kind, "agent_summary");
      assert.equal(rec.forwarded.rewritten, true);
    });

    it("an unpinned subagent's progress summary passes through unchanged", async () => {
      const f = inSession(fx("subagent-summary"), "s-summary-nopin");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.forwarded.rewritten, false);
    });

    it("a continuation with no pin (unknown agent / restarted worker) goes out unchanged: pin miss", async () => {
      const f = inSession(fx("subagent-continuation"), "s-nopin");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.pin, "miss");
    });
  });

  describe("main chat behind the cost guard", () => {
    it("a fresh conversation's first turn may be routed (nothing is cached yet); its continuation follows the pin", async () => {
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("main-new-turn"), "s-main"));
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.deepEqual(rec.guard, { allowed: true, reason: "fresh", ctx: null, penalty_usd: null, saving_usd: null });
      const c = await replay(stack, inSession(fx("main-continuation"), "s-main"));
      assert.equal(c.rec.pin, "hit");
      assert.equal(sentBody(stack, n + 1)["model"], HAIKU);
      // What `reflex statusline` reads: the model the client asked for and the one reflex sent.
      const st = JSON.parse((await request(`${stack.url}/__reflex/status?session=s-main`)).body.toString()) as { main: { requested: string; sent: string } };
      assert.equal(st.main.sent, HAIKU);
      assert.notEqual(st.main.requested, HAIKU);
    });

    it("a later turn with unknown context is refused before the backend is asked", async () => {
      const calls = jev.calls.length;
      const f = inSession(fx("main-new-turn-plain"), "s-guard");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(jev.calls.length, calls, "no Jev call when no target could pass the guard");
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.guard?.reason, "ctx_unknown");
      assert.deepEqual(rec.plan?.reasons, ["guard_blocked"]);
    });

    it("a later turn whose measured context makes the switch too expensive is refused (over_limit), without asking Jev", async () => {
      // Turn 1: Jev keeps Sonnet, and the response reports a 200k-token prompt (all cache writes on Sonnet).
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      stack.upstream.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":200000,"cache_read_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n');
      });
      const first = await replay(stack, inSession(fx("main-new-turn"), "s-big"));
      assert.deepEqual(first.rec.plan?.reasons, ["same_tier"]);
      // Turn 2 in the same conversation: a switch to Haiku would rewrite 200k tokens into a new 1h cache.
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.1 });
      const calls = jev.calls.length;
      const f = inSession(fx("main-new-turn-plain"), "s-big");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(jev.calls.length, calls);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.guard?.reason, "over_limit");
      assert.equal(rec.guard?.ctx, 200005);
      assert.ok((rec.guard?.penalty_usd ?? 0) > 0.3);
    });

    it("the quota the upstream reports reaches the decision record and the status line", async () => {
      stack.upstream.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream", "anthropic-ratelimit-unified-5h-utilization": "0.42", "anthropic-ratelimit-unified-5h-reset": "4102444800", "anthropic-ratelimit-unified-7d-utilization": "0.07" });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":0,"output_tokens":1}}}\n\n');
      });
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      const { rec } = await replay(stack, inSession(fx("main-new-turn"), "s-quota"));
      assert.deepEqual(rec.quota, { "5h": { util: 0.42, reset: 4102444800 }, "7d": { util: 0.07, reset: null } });
      const st = JSON.parse((await request(`${stack.url}/__reflex/status?session=another-session`)).body.toString()) as { quota: { name: string; pct: number }[] };
      assert.deepEqual(st.quota.map((w) => [w.name, w.pct]), [["5h", 42], ["7d", 7]], "the account's quota, whatever the session");
    });

    it("break-even: once the conversation has averages past its first response, a switch they would pay back is allowed", async () => {
      // Every response: a 20k-token prompt and 20k output tokens. The first response's write is the whole prompt and
      // is not averaged, so turn 2 has no averages (over_limit) and turn 3 has one response to average (breakeven).
      stack.upstream.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_creation_input_tokens":20000,"cache_read_input_tokens":0,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":20000}}\n\n');
      });
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      await replay(stack, inSession(fx("main-new-turn"), "s-even"));
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.1 });
      const second = await replay(stack, inSession(fx("main-new-turn-plain"), "s-even"));
      assert.equal(second.rec.guard?.reason, "over_limit");
      assert.equal(second.rec.guard?.saving_usd, null);
      const third = await replay(stack, inSession(fx("main-new-turn-plain"), "s-even"));
      assert.equal(third.rec.guard?.reason, "breakeven");
      assert.ok((third.rec.guard?.saving_usd ?? 0) > 0);
    });
  });

  describe("model-change notice", () => {
    const hook = (sid: string, event: Json) =>
      request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: sid, ...event }) });

    it("the next main-chat hook after a rewrite carries a systemMessage, once; subagent hooks never do", async () => {
      await replay(stack, inSession(fx("main-new-turn"), "s-notice"));
      assert.equal((await hook("s-notice", { hook_event_name: "Stop", agent_id: "A1" })).status, 204, "a subagent's hook");
      const r = await hook("s-notice", { hook_event_name: "Stop" });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body.toString()), { systemMessage: `reflex downgraded the model: claude-sonnet-5 → ${HAIKU}` });
      assert.equal((await hook("s-notice", { hook_event_name: "Stop" })).status, 204, "delivered once");
      await replay(stack, inSession(fx("main-continuation"), "s-notice"));
      assert.equal((await hook("s-notice", { hook_event_name: "Stop" })).status, 204, "still on Haiku: nothing new");
    });
  });

  describe("the client's model in routed responses (a resumed conversation asks for the transcript's model)", () => {
    /** Answers like the API: SSE naming the model it was sent, gzipped when the request allows it. */
    const echoModel = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void => {
      const model = (JSON.parse(body.toString()) as Json)["model"] as string;
      const text = `event: message_start\ndata: {"type":"message_start","message":{"model":"${model}","usage":{"input_tokens":1,"output_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
      const gzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
      res.writeHead(200, { "content-type": "text/event-stream", ...(gzip ? { "content-encoding": "gzip" } : {}) });
      res.end(gzip ? zlib.gzipSync(text) : text);
    };
    const send = async (f: Fixture): Promise<string> => {
      const before = records(stack).length;
      const r = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: { ...requestHeaders(f), "accept-encoding": "gzip" }, body: f.body });
      await waitFor(() => (records(stack).length > before ? true : null), { what: "its record" });
      const ce = r.headers["content-encoding"];
      return (ce === "gzip" ? zlib.gunzipSync(r.body) : r.body).toString();
    };

    it("a retargeted request goes out uncompressed and its message_start names the requested model again", async () => {
      stack.upstream.setHandler(echoModel);
      const n = stack.upstream.seen.length;
      const text = await send(inSession(fx("main-new-turn"), "s-restore"));
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.equal(stack.upstream.seen[n]!.headers["accept-encoding"], "identity");
      assert.match(text, /"model":"claude-sonnet-5"/);
      assert.doesNotMatch(text, /haiku/);
    });

    it("a request reflex did not retarget is relayed byte for byte, compression included", async () => {
      stack.upstream.setHandler(echoModel);
      const f = inSession(fx("subagent-summary"), "s-restore");
      const n = stack.upstream.seen.length;
      const text = await send(f);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(stack.upstream.seen[n]!.headers["accept-encoding"], "gzip");
      assert.match(text, new RegExp(`"model":"${(JSON.parse(f.body.toString()) as Json)["model"] as string}"`));
    });
  });

  describe("Opus sessions (verified: Opus -> Sonnet, Opus -> Haiku)", () => {
    const opus = (b: Json): void => {
      b["model"] = "claude-opus-5";
    };
    it("a subagent Jev judges sonnet-level goes to Sonnet with only the model swapped; its continuation follows", async () => {
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-opus1", opus));
      assert.deepEqual(rec.forwarded, { requested_model: "claude-opus-5", model: "claude-sonnet-5-5", rewritten: true, fields: ["model"], fallback: false, fallback_status: null, fallback_error: null });
      const orig = JSON.parse(inSession(fx("subagent-new-turn"), "s-opus1", opus).body.toString()) as Json;
      assert.deepEqual({ ...sentBody(stack, n), model: "claude-opus-5" }, orig, "nothing but the model changed");
      const c = await replay(stack, inSession(fx("subagent-continuation"), "s-opus1", opus));
      assert.equal(c.rec.pin, "hit");
      assert.equal(sentBody(stack, n + 1)["model"], "claude-sonnet-5-5");
    });

    it("a subagent Jev judges haiku-level goes to Haiku with the full rewrite", async () => {
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, inSession(fx("subagent-new-turn"), "s-opus2", opus));
      assert.equal(rec.forwarded.model, HAIKU);
      assert.deepEqual(rec.forwarded.fields, ["model", "output_config.effort", "thinking", "messages.system_folded:1"]);
      assert.equal((sentBody(stack, n)["thinking"] as Json)["type"], "enabled");
    });
  });

  describe("opus[1m] sessions: the long-context beta (acceptance session B1)", () => {
    const opus1m = (): Fixture => {
      const f = fixtures.find((x) => x.file === "interactive-opus1m.main-new-turn.request.json");
      assert.ok(f);
      return f;
    };
    it("to Haiku: the beta is removed from anthropic-beta, the rest kept, and the record lists it", async () => {
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.2 });
      const f = inSession(opus1m(), "s-1m-h");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      const sent = String(stack.upstream.seen[n]!.headers["anthropic-beta"]);
      const orig = String(f.headers["anthropic-beta"]);
      assert.doesNotMatch(sent, /context-1m/);
      assert.deepEqual(sent.split(","), orig.split(",").filter((b) => !b.startsWith("context-1m-")));
      assert.ok(rec.forwarded.fields.includes("anthropic-beta:-context-1m-2025-08-07"));
      assert.equal(stack.upstream.seen[n]!.headers["authorization"], f.headers["authorization"], "credentials untouched");
    });

    it("to Sonnet: headers untouched", async () => {
      jev.set({ kind: "answer", tier: "sonnet", confidence: 0.9, reasoning: 2 });
      const f = inSession(opus1m(), "s-1m-s");
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(stack.upstream.seen[n]!.headers["anthropic-beta"], f.headers["anthropic-beta"]);
      assert.deepEqual(rec.forwarded.fields, ["model"]);
    });

    it("a rejected Haiku rewrite is retried with the original headers, beta included", async () => {
      jev.set({ kind: "answer", tier: "haiku", confidence: 0.99, reasoning: 0.2 });
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "x" } }));
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(opus1m(), "s-1m-fb");
      const n = stack.upstream.seen.length;
      await replay(stack, f);
      assert.equal(stack.upstream.seen[n + 1]!.headers["anthropic-beta"], f.headers["anthropic-beta"]);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body));
    });
  });

  describe("manual overrides", () => {
    it("`reflex:haiku` inside a pasted prompt bypasses Jev; a subagent spawned in that turn records it at its first request", async () => {
      const calls = jev.calls.length;
      // The fixture's prompt is wrapped in <pasted_content id="ec1f">…; the token follows the opening tag.
      const main = await replay(stack, inSession(fx("main-new-turn"), "s-ovr", insertAfterPasteTag("reflex:haiku ")));
      assert.equal(main.rec.override, "haiku");
      assert.deepEqual(main.rec.plan?.reasons, ["override"]);
      const n = stack.upstream.seen.length;
      const sub = await replay(stack, inSession(fx("subagent-new-turn"), "s-ovr"));
      assert.equal(jev.calls.length, calls, "overrides never ask the backend");
      assert.equal(sub.rec.override, "haiku");
      assert.equal(sentBody(stack, n)["model"], HAIKU);
    });

    it("an override up to Opus 5.5 (the opus default) is applied: Sonnet -> Opus 5.5 is verified", async () => {
      const f = inSession(fx("main-new-turn"), "s-ovr2", prefixTask("reflex:opus "));
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, f);
      assert.equal(sentBody(stack, n)["model"], "claude-opus-5-5");
      assert.deepEqual(rec.plan?.reasons, ["override"]);
      assert.equal(rec.forwarded.rewritten, true);
    });
  });

  describe("safety nets", () => {
    it("a rejected rewrite is retried once with the original bytes; the tier is then disabled for the session", async () => {
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          const err = zlib.gzipSync(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "nope" } }));
          res.writeHead(400, { "content-type": "application/json", "content-encoding": "gzip" });
          res.end(err);
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(fx("subagent-new-turn"), "s-rej");
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, f);
      assert.equal(status, 200, "the client sees the original request's answer");
      assert.equal(stack.upstream.seen.length, n + 2);
      assert.equal(sentBody(stack, n)["model"], HAIKU);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body), "the retry is the original bytes");
      assert.equal(rec.forwarded.fallback, true);
      assert.equal(rec.forwarded.fallback_status, 400);
      assert.equal(rec.forwarded.fallback_error, "invalid_request_error: nope", "the upstream's error is kept (redacted)");
      assert.match(typeof rec["drift"] === "string" ? rec["drift"] : "", /(^|,)rewrite_rejected(,|$)/, "a rejected rewrite is wire drift in section 1");
      assert.equal(rec.forwarded.model, "claude-sonnet-5");

      const again = await replay(stack, inSession(fx("subagent-new-turn"), "s-rej", (b) => ((b["messages"] as Json[]).length = 1)));
      assert.ok(again.rec.plan?.reasons.includes("tier_disabled"));
      assert.equal(again.rec.forwarded.rewritten, false);
    });

    it("a rewrite rejected as too long for the target is retried with the original, and the tier stays enabled", async () => {
      stack.upstream.setHandler((req, res, body) => {
        if (body.toString().includes(HAIKU)) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 244258 tokens > 200000 maximum" } }));
          return;
        }
        sseHandler(req, res, body);
      });
      const f = inSession(fx("subagent-new-turn"), "s-long");
      const n = stack.upstream.seen.length;
      const { status, rec } = await replay(stack, f);
      assert.equal(status, 200);
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(f.body), "the retry is the original bytes");
      assert.equal(rec.forwarded.fallback_status, 400);

      stack.upstream.setHandler(sseHandler);
      const again = await replay(stack, inSession(fx("subagent-new-turn"), "s-long", (b) => ((b["messages"] as Json[]).length = 1)));
      assert.ok(!again.rec.plan?.reasons.includes("tier_disabled"), "a size rejection does not disable Haiku for the session");
      assert.equal(again.rec.forwarded.model, HAIKU);
    });

    it("a hanging backend fails open within the deadline: unchanged bytes, and the loop stays on the requested model", async () => {
      jev.set({ kind: "hang" });
      const f = inSession(fx("subagent-new-turn"), "s-hang");
      const n = stack.upstream.seen.length;
      const { rec, ms } = await replay(stack, f);
      assert.ok(ms < 500 + 250 + 400, `took ${ms} ms`);
      assert.ok(stack.upstream.seen[n]!.body.equals(f.body));
      assert.equal(rec.error, "backend:timeout");
      // The timing breakdown is what shows, from the log alone, that the wait stayed within the deadline.
      const t = timingOf(rec);
      assert.equal(t.decision_deadline_ms, 500);
      assert.ok(t.decision_wait_ms >= 450 && t.decision_wait_ms <= 500 + DECISION_GRACE_MS, `decision waited ${t.decision_wait_ms} ms`);
      assert.ok(t.upstream_first_byte_ms !== null && t.upstream_first_byte_ms >= 0);
      const ttfb = (rec["upstream"] as { msToHeaders: number }).msToHeaders;
      assert.ok(ttfb >= t.decision_wait_ms + t.upstream_first_byte_ms && ttfb - (t.decision_wait_ms + t.upstream_first_byte_ms) < 100, "msToHeaders = decision wait + router work + upstream first byte");
      const c = inSession(fx("subagent-continuation"), "s-hang");
      const cont = await replay(stack, c);
      assert.equal(cont.rec.pin, "hit");
      assert.ok(stack.upstream.seen[n + 1]!.body.equals(c.body));
    });

    it("a shape violation stops routing for the session (records say shadow)", async () => {
      const f = inSession(fx("subagent-new-turn"), "s-shape");
      const bad = { ...f, headers: { ...f.headers, "x-claude-code-session-id": "s-shape-other" } };
      const n = stack.upstream.seen.length;
      const { rec } = await replay(stack, bad);
      assert.ok(stack.upstream.seen[n]!.body.equals(bad.body));
      assert.equal(rec.mode_effective, "shadow");
      assert.match(String(rec["degraded_reason"]), /shape:session_id/);
    });

    it("MCP tool search survives the proxy: beta header, defer_loading, tool_addition and tool_reference, both ways", async () => {
      // What ENABLE_TOOL_SEARCH=true (src/launcher/launch.ts proxyEnv) relies on, on real 2.1.282 requests that reflex
      // rewrites to Haiku (the one target that takes no role:system message, so tool_addition blocks are lifted).
      const ts = (name: string): Fixture => {
        const f = fixtures.find((x) => x.file === `toolsearch.${name}.request.json`);
        assert.ok(f, name);
        return f;
      };
      const tools = (b: Json): Json[] => b["tools"] as Json[];
      const blocks = (b: Json): Json[] => (b["messages"] as Json[]).flatMap((m) => (Array.isArray(m["content"]) ? (m["content"] as Json[]) : []));
      const first = inSession(ts("subagent-new-turn"), "s-toolsearch");
      const n = stack.upstream.seen.length;
      const a = await replay(stack, first);
      assert.equal(a.rec.forwarded.model, HAIKU);
      assert.equal(a.rec.forwarded.fallback, false);
      const beta = String(first.headers["anthropic-beta"]);
      assert.equal(stack.upstream.seen[n]!.headers["anthropic-beta"], retargetBetas(beta, "haiku").value);
      assert.match(String(stack.upstream.seen[n]!.headers["anthropic-beta"]), /advanced-tool-use-2025-11-20/);
      const sentA = sentBody(stack, n);
      assert.ok(!blocks(sentA).some((c) => c["type"] === "tool_addition"));
      assert.ok(tools(sentA).some((t) => t["name"] === "DeferredToolPlaceholder" && t["defer_loading"] === true), "unannounced tools stay deferred");

      // The pinned tool-loop step that returns a ToolSearch result ("Tool loaded." beside tool_reference blocks).
      const result = { type: "tool_result", tool_use_id: "toolu_ts", content: [{ type: "tool_reference", tool_name: "CronList" }] };
      const step = inSession(ts("subagent-continuation"), "s-toolsearch", (b) => {
        (b["messages"] as Json[]).push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_ts", name: "ToolSearch", input: { query: "select:CronList" } }] }, { role: "user", content: [result, { type: "text", text: "Tool loaded." }] });
      });
      const k = stack.upstream.seen.length;
      const c = await replay(stack, step);
      assert.equal(c.rec.turn, "continuation");
      assert.equal(c.rec.pin, "hit");
      assert.equal(c.rec.forwarded.model, HAIKU);
      const sentC = sentBody(stack, k);
      assert.deepEqual((sentC["messages"] as Json[]).at(-1), { role: "user", content: [result, { type: "text", text: "Tool loaded." }] });
      assert.deepEqual(tools(sentC), tools(sentA), "the same tools on every step of the loop, so the Haiku cache holds");

      // Unrewritten: request bytes and a streamed tool_use response pass through byte for byte.
      const sse = [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}}',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_2","name":"ToolSearch","input":{}}}',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"select:CronList\\"}"}}',
        'event: message_stop\ndata: {"type":"message_stop"}',
      ].join("\n\n") + "\n\n";
      stack.upstream.setHandler((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(sse);
      });
      const plain = inSession(ts("main-continuation-tool-loaded"), "s-toolsearch-passthrough");
      const m = stack.upstream.seen.length;
      const r = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: requestHeaders(plain), body: plain.body });
      assert.ok(stack.upstream.seen[m]!.body.equals(plain.body), "an unrewritten request is byte-identical");
      assert.equal(stack.upstream.seen[m]!.headers["anthropic-beta"], plain.headers["anthropic-beta"]);
      assert.equal(r.body.toString(), sse);
    });

    it("the TypeSafe key never reaches the upstream in route mode either", () => {
      for (const s of stack.upstream.seen) assert.doesNotMatch(JSON.stringify(s.headers) + s.body.toString(), /apikey_test/);
      assert.ok(stack.upstream.seen.every((s) => s.headers["authorization"] === requestHeaders(fx("main-new-turn"))["authorization"] || s.headers["authorization"] === undefined));
    });
  });
});

describe("route mode: upgrades (REFLEX_UPGRADES=on, verified Haiku -> Opus)", () => {
  let jev: FakeJev;
  let stack: Stack;
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "opus", confidence: 0.9, reasoning: 4 });
    // Opus 5 (verified), not the Opus 5.5 default (unverified): this suite is about the upgrade path itself.
    stack = await startStack({ effectiveMode: "route", config: { mode: "route", upgrades: "on", jevBaseUrl: jev.url, jevDeadlineMs: 500, models: { ...DEFAULT_MODELS, opus: "claude-opus-5" } } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await jev.close();
  });

  it("a Haiku main-chat turn the backend wants on Opus is rewritten, and the chat is told", async () => {
    const f = inSession(fixtures.find((x) => x.file === "haiku-mcp-draft4.main-new-turn.request.json")!, "s-up");
    const n = stack.upstream.seen.length;
    const { rec } = await replay(stack, f);
    const b = sentBody(stack, n);
    assert.equal(b["model"], "claude-opus-5");
    assert.equal((b["thinking"] as Json)["type"], "adaptive");
    assert.deepEqual(rec.plan?.reasons, ["upgrade"]);
    assert.equal(rec.forwarded.rewritten, true);
    const r = await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: "s-up", hook_event_name: "Stop" }) });
    assert.deepEqual(JSON.parse(r.body.toString()), { systemMessage: "reflex upgraded the model: claude-haiku-4-5-20251001 → claude-opus-5" });
  });
});

describe("route mode: the upgrade follows the backend's own answer", () => {
  let jev: FakeJev;
  const models = { ...DEFAULT_MODELS, opus: "claude-opus-5" };
  const stackWith = async (): Promise<Stack> => {
    const s = await startStack({ effectiveMode: "route", config: { mode: "route", upgrades: "on", jevBaseUrl: jev.url, jevDeadlineMs: 500, models } });
    s.upstream.setHandler(sseHandler);
    return s;
  };
  before(async () => {
    jev = await startFakeJev({ kind: "answer", tier: "opus", confidence: 0.9, reasoning: 4 });
  });
  after(async () => {
    await jev.close();
  });

  it("the backend's own answer being opus: the upgrade is applied", async () => {
    jev.set({ kind: "answer", tier: "opus", confidence: 0.9, reasoning: 4 });
    const stack = await stackWith();
    try {
      const { rec } = await replay(stack, inSession(fx("main-new-turn"), "s-abup-off"));
      assert.equal(rec.forwarded.model, "claude-opus-5");
      assert.deepEqual(rec.plan?.reasons, ["upgrade"]);
    } finally {
      await stack.close();
    }
  });

  it("a tail of mass on opus with sonnet as the backend's own answer does not move the model", async () => {
    // confidence 0.7: the other two tiers share 0.3, so opus holds 0.15 (> the 0.10 margin) while sonnet stays the answer.
    jev.set({ kind: "answer", tier: "sonnet", confidence: 0.7, reasoning: 2 });
    const stack = await stackWith();
    try {
      const { rec } = await replay(stack, inSession(fx("main-new-turn"), "s-abup-tail"));
      assert.equal(rec.forwarded.model, "claude-sonnet-5");
      assert.equal(rec.forwarded.rewritten, false);
      assert.ok(rec.plan?.reasons.includes("upgrade_to_effort"), String(rec.plan?.reasons));
    } finally {
      await stack.close();
    }
  });
});
