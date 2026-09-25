import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { hookRelayCommand, relayHook } from "../../src/outcome/hook-relay.js";

interface Got {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly type: string | undefined;
  readonly body: string;
}

/** A stand-in for the door: records what it was sent and answers with `reply`. */
async function door(reply: (res: http.ServerResponse) => void): Promise<{ url: string; got: Got[]; close: () => Promise<void> }> {
  const got: Got[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
      reply(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/__reflex/hook`, got, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const EVENT = Buffer.from(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "a ile A arasındaki fark ne" }));

describe("hook-relay (the command hook under Claude Code's sandbox)", () => {
  it("posts the event to the door byte for byte and prints nothing for a 204", async () => {
    const d = await door((res) => res.writeHead(204).end());
    try {
      assert.equal(await relayHook(EVENT, d.url), "");
      assert.deepEqual(d.got, [{ method: "POST", url: "/__reflex/hook", type: "application/json", body: EVENT.toString("utf8") }]);
    } finally {
      await d.close();
    }
  });

  it("prints the door's answer when it is a JSON object (the delegation hint, the model-change notice)", async () => {
    const answer = JSON.stringify({ systemMessage: "reflex: main chat now on Sonnet 5" });
    const d = await door((res) => res.writeHead(200, { "content-type": "application/json" }).end(answer));
    try {
      assert.equal(await relayHook(EVENT, d.url), answer);
    } finally {
      await d.close();
    }
  });

  it("prints nothing for any other answer: Claude Code would add plain stdout to the prompt's context", async () => {
    for (const [status, body] of [[200, "plain text"], [200, "[1,2]"], [200, "null"], [500, '{"error":1}'], [403, "{}"]] as const) {
      const d = await door((res) => res.writeHead(status).end(body));
      try {
        assert.equal(await relayHook(EVENT, d.url), "", `${status} ${body}`);
      } finally {
        await d.close();
      }
    }
  });

  it("gives up silently on a door that is gone or too slow", async () => {
    const d = await door(() => undefined); // never answers
    try {
      const t0 = Date.now();
      assert.equal(await relayHook(EVENT, d.url, 100), "");
      assert.ok(Date.now() - t0 < 1000);
    } finally {
      await d.close();
    }
    assert.equal(await relayHook(EVENT, d.url), ""); // closed: connection refused
  });

  it("talks to loopback only, and never throws on a bad url", async () => {
    assert.equal(await relayHook(EVENT, "http://example.com/__reflex/hook"), "");
    assert.equal(await relayHook(EVENT, "https://127.0.0.1:1/__reflex/hook"), "");
    assert.equal(await relayHook(EVENT, "not a url"), "");
    assert.equal(await relayHook(EVENT, ""), "");
  });

  it("the command reads stdin, writes the answer to stdout and always exits 0", async () => {
    const answer = JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "hint" } });
    const d = await door((res) => res.writeHead(200).end(answer));
    try {
      const out: string[] = [];
      const stdin = (): AsyncIterable<Buffer> => Readable.from([EVENT.subarray(0, 10), EVENT.subarray(10)]);
      assert.equal(await hookRelayCommand([d.url], { stdin: stdin(), stdout: (t) => void out.push(t) }), 0);
      assert.deepEqual(out, [answer]);
      assert.equal(d.got[0]?.body, EVENT.toString("utf8"));
      assert.equal(await hookRelayCommand([], { stdin: stdin(), stdout: (t) => void out.push(t) }), 0);
      assert.equal(out.length, 1);
    } finally {
      await d.close();
    }
  });
});
