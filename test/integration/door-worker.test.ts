import assert from "node:assert/strict";
import { fork } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, describe, it } from "node:test";
import { echoHandler } from "../support/fake-upstream.js";
import { request, requestStream, waitFor } from "../support/http.js";
import { spawnWorkerProcess } from "../../src/launcher/worker-process.js";
import { startStack, testConfig, type Stack } from "../support/stack.js";

const SESSION_HEADERS = {
  authorization: "Bearer fake-oauth-token",
  "x-api-key": "fake-key",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
  "x-claude-code-session-id": "5e551011-0000-4000-8000-000000000001",
  "x-claude-code-agent-id": "a0123456789abcdef",
  "user-agent": "claude-cli/2.1.277 (external, sdk-cli)",
  "content-type": "application/json",
};

describe("front door + worker: passthrough fidelity", () => {
  let stack: Stack;
  before(async () => {
    stack = await startStack();
  });
  after(async () => {
    await stack.close();
  });
  afterEach(() => {
    stack.upstream.setHandler(echoHandler);
    stack.upstream.seen.length = 0;
  });

  it("a request goes through the worker, and the upstream sees the same method, path, query, headers and bytes", async () => {
    const body = JSON.stringify({ model: "claude-sonnet-5", messages: [{ role: "user", content: "héllo ✓" }], stream: true });
    const r = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: SESSION_HEADERS, body });
    assert.equal(r.status, 200);
    assert.ok(stack.door.counters.viaWorker >= 1, "should have gone through the worker");
    const seen = stack.upstream.seen[0];
    assert.ok(seen);
    assert.equal(seen.method, "POST");
    assert.equal(seen.url, "/v1/messages?beta=true");
    assert.equal(seen.body.toString(), body, "request bytes must be identical");
    for (const [k, v] of Object.entries(SESSION_HEADERS)) assert.equal(seen.headers[k], v, `header ${k}`);
    assert.equal(seen.headers["host"], `127.0.0.1:${stack.upstream.port}`, "Host must name the upstream, not the proxy");
  });

  it("never adds reflex headers or leaks the TypeSafe key to the upstream", async () => {
    await request(`${stack.url}/v1/messages`, { method: "POST", headers: SESSION_HEADERS, body: "{}" });
    const seen = stack.upstream.seen[0];
    assert.ok(seen);
    const everything = JSON.stringify(seen.headers) + seen.body.toString();
    assert.doesNotMatch(everything, /apikey_test|typesafe|reflex/i);
  });

  it("returns upstream status, headers and body untouched (errors included)", async () => {
    stack.upstream.setHandler((_req, res) => {
      const b = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
      res.writeHead(529, { "content-type": "application/json", "retry-after": "3", "request-id": "req_x", "content-length": Buffer.byteLength(b) });
      res.end(b);
    });
    const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(r.status, 529);
    assert.equal(r.headers["retry-after"], "3");
    assert.equal(r.headers["request-id"], "req_x");
    assert.match(r.body.toString(), /Overloaded/);
  });

  it("passes a gzip-encoded response through byte for byte, with content-encoding intact", async () => {
    const payload = gzipSync(Buffer.from("event: message_start\ndata: {}\n\n".repeat(200)));
    stack.upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip", "content-length": payload.length });
      res.end(payload);
    });
    const r = await request(`${stack.url}/v1/messages`, { method: "POST", headers: { "accept-encoding": "gzip, br" }, body: "{}" });
    assert.equal(r.headers["content-encoding"], "gzip");
    assert.ok(r.body.equals(payload), "compressed bytes must be identical");
    assert.equal(stack.upstream.seen[0]?.headers["accept-encoding"], "gzip, br", "accept-encoding must reach the upstream");
  });

  it("streams: the first chunk reaches the client while the upstream is still producing", async () => {
    stack.upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\n\n");
      setTimeout(() => res.write("event: b\n\n"), 250);
      setTimeout(() => res.end("event: c\n\n"), 500);
    });
    const t0 = Date.now();
    const { res } = await requestStream(`${stack.url}/v1/messages`, { method: "POST", body: "{}" });
    const chunks: { at: number; text: string }[] = [];
    await new Promise<void>((resolve) => {
      res.on("data", (c: Buffer) => chunks.push({ at: Date.now() - t0, text: c.toString() }));
      res.on("end", resolve);
    });
    assert.equal(chunks.map((c) => c.text).join(""), "event: a\n\nevent: b\n\nevent: c\n\n");
    assert.ok((chunks[0]?.at ?? 999) < 200, `first chunk was buffered until ${String(chunks[0]?.at)} ms`);
    assert.ok(chunks.length >= 2);
  });

  it("forwards a large request body intact", async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024);
    stack.upstream.setHandler((_req, res, body) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(crypto.createHash("sha256").update(body).digest("hex"));
    });
    const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: big });
    assert.equal(r.body.toString(), crypto.createHash("sha256").update(big).digest("hex"));
  });

  it("handles HEAD (Claude Code's startup probe is HEAD /api/hello) and GET without a body", async () => {
    const head = await request(`${stack.url}/api/hello`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(stack.upstream.seen[0]?.method, "HEAD");
    assert.equal(stack.upstream.seen[0]?.url, "/api/hello");
    const get = await request(`${stack.url}/v1/models?limit=5`);
    assert.equal(get.status, 200);
    assert.equal(stack.upstream.seen[1]?.url, "/v1/models?limit=5");
  });

  it("an empty POST body is sent as content-length 0", async () => {
    await request(`${stack.url}/v1/messages`, { method: "POST" });
    assert.equal(stack.upstream.seen[0]?.headers["content-length"], "0");
  });

  it("client disconnect mid-stream aborts the upstream request", async () => {
    stack.upstream.aborted = 0;
    stack.upstream.setHandler((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: a\n\n");
      // never finishes
    });
    const { res, req } = await requestStream(`${stack.url}/v1/messages`, { method: "POST", body: "{}" });
    await new Promise<void>((r) => res.once("data", () => r()));
    req.destroy();
    await waitFor(() => stack.upstream.aborted === 1, { what: "upstream to notice the abort" });
  });

  it("GET /__reflex/health reports the worker as up; unknown /__reflex/ paths are 404", async () => {
    const h = await request(`${stack.url}/__reflex/health`);
    assert.equal(h.status, 200);
    assert.equal((JSON.parse(h.body.toString()) as { worker: string }).worker, "up");
    assert.equal((await request(`${stack.url}/__reflex/nope`)).status, 404);
    assert.equal(stack.upstream.seen.length, 0, "internal endpoints must never reach the upstream");
  });

  it("GET /__reflex/status answers the worker's view of a session and never reaches the upstream", async () => {
    const r = await request(`${stack.url}/__reflex/status?session=unknown`);
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body.toString()) as { worker: string; main: unknown; subagents: unknown[]; cost: number };
    assert.deepEqual([j.worker, j.main, j.subagents, j.cost], ["up", null, [], 0]);
    assert.equal(stack.upstream.seen.length, 0);
  });

  it("the hook endpoint answers 204 (empty body) and never reaches the upstream", async () => {
    const r = await request(`${stack.url}/__reflex/hook`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"hook_event_name":"Stop"}' });
    assert.equal(r.status, 204);
    assert.equal(r.body.length, 0);
    assert.equal(stack.upstream.seen.length, 0);
  });
});

describe("front door: upstream variants", () => {
  it("keeps a gateway path prefix on the upstream URL", async () => {
    const stack = await startStack({ upstreamPath: "/anthropic" });
    try {
      await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", body: "{}" });
      assert.equal(stack.upstream.seen[0]?.url, "/anthropic/v1/messages?beta=true");
    } finally {
      await stack.close();
    }
  });

  it("answers 502 in the Anthropic error shape when the upstream is unreachable", async () => {
    const stack = await startStack();
    await stack.upstream.close();
    try {
      const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: "{}" });
      assert.equal(r.status, 502);
      const j = JSON.parse(r.body.toString()) as { type: string; error: { type: string } };
      assert.equal(j.type, "error");
      assert.equal(j.error.type, "api_error");
    } finally {
      await stack.door.close();
      await stack.supervisor.stop();
    }
  });

  it("rejects an oversized request with 413 instead of buffering it", async () => {
    const stack = await startStack({ doorOptions: { maxBodyBytes: 1024 } });
    try {
      const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: Buffer.alloc(4096) });
      assert.equal(r.status, 413);
      assert.equal(stack.upstream.seen.length, 0);
    } finally {
      await stack.close();
    }
  });
});

describe("front door: the worker is optional (fail-open)", () => {
  let stack: Stack;
  afterEach(async () => {
    await stack.close();
  });

  it("with no worker at all, requests are served directly and identically", async () => {
    stack = await startStack({ noWorker: true });
    const r = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers: SESSION_HEADERS, body: '{"a":1}' });
    assert.equal(r.status, 200);
    assert.equal(stack.door.counters.direct, 1);
    assert.equal(stack.door.counters.viaWorker, 0);
    assert.equal(stack.upstream.seen[0]?.body.toString(), '{"a":1}');
    for (const [k, v] of Object.entries(SESSION_HEADERS)) assert.equal(stack.upstream.seen[0]?.headers[k], v, k);
  });

  it("with no worker the hook endpoint still answers 204, so a dead worker never breaks a session", async () => {
    stack = await startStack({ noWorker: true });
    const r = await request(`${stack.url}/__reflex/hook`, { method: "POST", body: "{}" });
    assert.equal(r.status, 204);
    assert.equal(stack.door.counters.hooksDropped, 1);
  });

  it("with no worker the status endpoint says so (the status line then reads \"passthrough\")", async () => {
    stack = await startStack({ noWorker: true });
    const r = await request(`${stack.url}/__reflex/status?session=s1`);
    assert.deepEqual(JSON.parse(r.body.toString()), { worker: "down" });
  });

  it("the door health endpoint says the worker is down", async () => {
    stack = await startStack({ noWorker: true });
    const j = JSON.parse((await request(`${stack.url}/__reflex/health`)).body.toString()) as { worker: string };
    assert.equal(j.worker, "down");
  });

  it("kill -9 of the worker: the next request is still served, then the worker comes back", async () => {
    stack = await startStack();
    const pid = await stack.workerPid();
    assert.ok(pid);
    const port = stack.door.port;
    process.kill(pid, "SIGKILL");
    const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: '{"after":"kill"}' });
    assert.equal(r.status, 200);
    assert.equal(stack.upstream.seen.at(-1)?.body.toString(), '{"after":"kill"}');
    assert.equal(stack.door.port, port, "the door keeps its port");
    await waitFor(async () => {
      const p = await stack.workerPid();
      return p !== null && p !== pid;
    }, { timeoutMs: 15_000, what: "a new worker" });
    const viaWorkerBefore = stack.door.counters.viaWorker;
    assert.equal((await request(`${stack.url}/v1/messages`, { method: "POST", body: "{}" })).status, 200);
    assert.equal(stack.door.counters.viaWorker, viaWorkerBefore + 1, "traffic should flow through the new worker again");
  });

  it("a hung worker (SIGSTOP) is detected by the liveness probe, killed, and traffic is not lost", async () => {
    stack = await startStack();
    const pid = await stack.workerPid();
    assert.ok(pid);
    process.kill(pid, "SIGSTOP");
    try {
      const t0 = Date.now();
      const r = await request(`${stack.url}/v1/messages`, { method: "POST", body: '{"during":"hang"}' });
      assert.equal(r.status, 200);
      assert.ok(Date.now() - t0 < 10_000, "must not wait forever for a frozen worker");
      assert.equal(stack.upstream.seen.at(-1)?.body.toString(), '{"during":"hang"}');
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    await waitFor(async () => {
      const p = await stack.workerPid();
      return p !== null && p !== pid;
    }, { timeoutMs: 15_000, what: "a replacement worker" });
  });

  it("a crash loop ends in passthrough: every request is still served, on the same port", async () => {
    stack = await startStack({ spawnWorker: () => Promise.reject(new Error("always crashes")), timings: { backoffInitialMs: 10, backoffMaxMs: 10, passthroughMs: 60_000 } });
    await waitFor(() => stack.supervisor.snapshot().state === "passthrough", { what: "passthrough state" });
    for (let i = 0; i < 3; i++) assert.equal((await request(`${stack.url}/v1/messages`, { method: "POST", body: "{}" })).status, 200);
    assert.equal(stack.door.counters.direct, 3);
  });

  it("recovers from passthrough by itself when a worker can start again", async () => {
    let fail = true;
    stack = await startStack({
      spawnWorker: () =>
        fail
          ? Promise.reject(new Error("not yet"))
          : spawnWorkerProcess({
              init: { type: "init", config: testConfig("http://127.0.0.1:1"), effectiveMode: "shadow", degradedReason: null, claudeVersion: null },
              readyTimeoutMs: 15_000, logFile: null, log: () => undefined,
            }),
      timings: { backoffInitialMs: 10, backoffMaxMs: 10, passthroughMs: 300 },
    });
    await waitFor(() => stack.supervisor.snapshot().state === "passthrough", { what: "passthrough" });
    fail = false;
    await waitFor(() => stack.supervisor.snapshot().state === "up", { timeoutMs: 15_000, what: "recovery" });
    assert.ok(stack.supervisor.workerOrigin());
  });
});

describe("worker process lifecycle", () => {
  it("exits by itself when the launcher disappears (no orphans)", async () => {
    // Run the worker via an intermediate parent that we can kill without cleanup.
    const parentScript = fileURLToPath(new URL("../support/orphan-parent.ts", import.meta.url));
    const cfg = JSON.stringify(testConfig("http://127.0.0.1:1"));
    const parent = fork(parentScript, [cfg], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const workerPid = await new Promise<number>((resolve, reject) => {
      parent.once("message", (m: unknown) => resolve((m as { workerPid: number }).workerPid));
      parent.once("exit", () => reject(new Error("parent exited early")));
    });
    const alive = (): boolean => {
      try {
        process.kill(workerPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    assert.ok(alive());
    parent.kill("SIGKILL");
    await waitFor(() => !alive(), { timeoutMs: 5000, what: "the worker to exit after its parent died" });
  });
});

