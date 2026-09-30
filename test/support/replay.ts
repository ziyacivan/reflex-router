// Replaying captured fixtures through a running stack and reading back decisions.jsonl.
import type http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import type { UpstreamHandler } from "./fake-upstream.js";
import type { Fixture } from "./fixtures.js";
import { request, waitFor } from "./http.js";
import type { Stack } from "./stack.js";
import { completeJsonl } from "./jsonl.js";

export const SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":20,"cache_read_input_tokens":30,"output_tokens":1}}}',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":40}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
].join("\n\n") + "\n\n";
export const USAGE = { input: 10, output: 40, cache_read: 30, cache_create: 20 };

/** Answers like the API: SSE, compressed when the request allows gzip. */
export const sseHandler: UpstreamHandler = (req, res) => {
  const gzip = String(req.headers["accept-encoding"] ?? "").includes("gzip");
  const body = gzip ? zlib.gzipSync(SSE) : Buffer.from(SSE);
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", ...(gzip ? { "content-encoding": "gzip" } : {}) });
  res.end(body);
};

export type Rec = Record<string, unknown> & {
  turn: string;
  side_kind: string | null;
  decision: unknown;
  plan: { reasons: string[]; would_route_to: string | null; routed_to: string | null; target: { tier: string } | null } | null;
  error: string | null;
  pin: string | null;
  override: string | null;
  mode_effective: string;
  guard: { allowed: boolean; reason: string; ctx: number | null; penalty_usd: number | null; saving_usd?: number | null } | null;
  forwarded: { requested_model: string | null; model: string | null; rewritten: boolean; fields: string[]; fallback: boolean; fallback_status: number | null; fallback_error: string | null };
};
/**
 * Every complete line of decisions.jsonl (decisions and the outcome records keyed to them). The worker appends
 * `JSON + "\n"` while tests read, so whatever follows the last newline may be a line still being written: it is
 * skipped now and seen on a later poll.
 */
export const allRecords = (stack: Stack): Record<string, unknown>[] => completeJsonl(path.join(stack.config.home, "decisions.jsonl"));
/** Decision records only. */
export const records = (stack: Stack): Rec[] => allRecords(stack).filter((r) => r["record"] === "decision") as Rec[];
export const requestHeaders = (fx: Fixture): http.OutgoingHttpHeaders => {
  const { host: _h, "content-length": _c, ...rest } = fx.headers;
  return rest;
};
/** Sends one fixture and waits for its record, so records line up with requests. */
export async function replay(stack: Stack, fx: Fixture, body: Buffer = fx.body, headers = requestHeaders(fx)): Promise<{ status: number; rec: Rec; ms: number }> {
  const before = records(stack).length;
  const t0 = Date.now();
  const r = await request(`${stack.url}/v1/messages?beta=true`, { method: "POST", headers, body });
  const ms = Date.now() - t0;
  const all = await waitFor(() => (records(stack).length > before ? records(stack) : null), { what: `record for ${fx.file}` });
  return { status: r.status, rec: all[before]!, ms };
}
