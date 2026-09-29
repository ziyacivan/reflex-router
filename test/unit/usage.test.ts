import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { errorSummary, UsageParser, usageFormat } from "../../src/wire/anthropic.js";
import { UsageTee } from "../../src/worker/usage-tee.js";

const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,"output_tokens":1}}}',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"héllo ✓ 😀"}}',
  "event: ping\ndata: {\"type\": \"ping\"}",
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":57}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";
const EXPECTED = { input: 12, output: 57, cacheRead: 4000, cacheCreate: 300 };

const parseAll = (text: string, splits: number[], format: "sse" | "json" = "sse"): ReturnType<UsageParser["result"]> => {
  const p = new UsageParser(format);
  let at = 0;
  for (const s of [...splits, text.length]) {
    p.push(text.slice(at, s));
    at = s;
  }
  return p.result();
};

describe("UsageParser", () => {
  it("reads usage from message_start + message_delta", () => {
    assert.deepEqual(parseAll(SSE, []), EXPECTED);
  });

  it("gives the same answer when the stream is split at every character offset", () => {
    for (let i = 1; i < SSE.length; i++) assert.deepEqual(parseAll(SSE, [i]), EXPECTED, `split at ${i}`);
  });

  it("handles CRLF event separators", () => {
    assert.deepEqual(parseAll(SSE.replace(/\n/g, "\r\n"), [7, 100]), EXPECTED);
  });

  it("reads the captured subagent SSE fixture", () => {
    const text = fs.readFileSync("test/fixtures/claude-code/2.1.277/sonnet-agent-run.subagent-new-turn.response.sse.txt", "utf8");
    const u = parseAll(text, [1000, 1001, 5000]);
    assert.ok(u);
    assert.equal(u.output, 49);
    assert.equal(u.cacheCreate, 34813);
  });

  it("reads a non-streaming JSON body and ignores junk", () => {
    assert.deepEqual(parseAll(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } }), [5], "json"), { input: 3, output: 4, cacheRead: 0, cacheCreate: 0 });
    assert.equal(parseAll("not json", [], "json"), null);
    assert.equal(parseAll("data: {oops\n\n", []), null);
  });

  it("reads the stop reason, and a refusal's category (Sonnet 5.5 shape, 2.1.284)", () => {
    const p = new UsageParser("sse");
    p.push(SSE);
    assert.deepEqual(p.stop(), { reason: "end_turn", category: null });
    const refusal = SSE.replace('"delta":{"stop_reason":"end_turn"}', '"delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction","explanation":"This request was blocked"}}');
    for (const i of [1, 200, refusal.length - 40]) {
      const q = new UsageParser("sse");
      q.push(refusal.slice(0, i));
      q.push(refusal.slice(i));
      assert.deepEqual(q.stop(), { reason: "refusal", category: "reasoning_extraction" }, `split at ${i}`);
    }
    const j = new UsageParser("json");
    j.push(JSON.stringify({ stop_reason: "refusal", stop_details: { category: "cyber" }, usage: { input_tokens: 1, output_tokens: 0 } }));
    j.result();
    assert.deepEqual(j.stop(), { reason: "refusal", category: "cyber" });
    assert.equal(new UsageParser("sse").stop(), null);
  });

  it("maps content types", () => {
    assert.equal(usageFormat("text/event-stream; charset=utf-8"), "sse");
    assert.equal(usageFormat("application/json"), "json");
    assert.equal(usageFormat("text/html"), null);
    assert.equal(usageFormat(undefined), null);
  });
});

describe("UsageTee (decompression side branch)", () => {
  const feed = async (bytes: Buffer, encoding: string | undefined, chunk = 7, complete = true): Promise<Awaited<ReturnType<UsageTee["end"]>>> => {
    const tee = new UsageTee("text/event-stream", encoding);
    for (let i = 0; i < bytes.length; i += chunk) tee.write(bytes.subarray(i, i + chunk));
    return tee.end(complete);
  };
  const raw = Buffer.from(SSE);

  it("identity, gzip, br and deflate all yield the usage, even with multi-byte characters split across chunks", async () => {
    for (const [enc, bytes] of [[undefined, raw], ["gzip", zlib.gzipSync(raw)], ["br", zlib.brotliCompressSync(raw)], ["deflate", zlib.deflateSync(raw)]] as const) {
      const r = await feed(bytes, enc, 3);
      assert.deepEqual(r, { usage: EXPECTED, unknownReason: null, stop: { reason: "end_turn", category: null } }, String(enc));
    }
  });

  it("an undecodable coding (zstd) is recorded as unknown, not an error", async () => {
    assert.deepEqual(await feed(raw, "zstd"), { usage: null, unknownReason: "encoding:zstd", stop: null });
  });

  it("corrupt compressed data is a decode_error", async () => {
    assert.deepEqual(await feed(Buffer.from("definitely not gzip"), "gzip"), { usage: null, unknownReason: "decode_error", stop: null });
  });

  it("a response that broke off before any usage is incomplete; a non-SSE/JSON type is content_type", async () => {
    assert.deepEqual(await feed(Buffer.from("event: ping\n\n"), undefined, 7, false), { usage: null, unknownReason: "incomplete", stop: null });
    const tee = new UsageTee("text/html", undefined);
    tee.write(Buffer.from("<html>"));
    assert.deepEqual(await tee.end(true), { usage: null, unknownReason: "content_type", stop: null });
  });
});

describe("errorSummary", () => {
  it("reads type and message from an Anthropic error, gzip or plain; falls back to raw text", () => {
    const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: 128000 > 64000" } });
    assert.equal(errorSummary(Buffer.from(body), undefined), "invalid_request_error: max_tokens: 128000 > 64000");
    assert.equal(errorSummary(zlib.gzipSync(body), "gzip"), "invalid_request_error: max_tokens: 128000 > 64000");
    assert.equal(errorSummary(Buffer.from("<html>bad gateway</html>"), undefined), "<html>bad gateway</html>");
    assert.equal(errorSummary(Buffer.from("not gzip"), "gzip"), "undecodable body");
    assert.equal(errorSummary(Buffer.from(""), undefined), null);
    assert.equal(errorSummary(Buffer.from("x".repeat(2000)), undefined)?.length, 500);
  });
});
