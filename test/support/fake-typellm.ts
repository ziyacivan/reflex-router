// A loopback stand-in for TypeLLM's /v1/generate. Scriptable: answers, latency, HTTP errors, junk, raw bodies, hangs.
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface TypeLLMQuestion {
  readonly type: string;
  readonly enum?: string[];
  readonly instructions: string;
  readonly return_probabilities?: boolean;
}

export interface TypeLLMCall {
  readonly headers: http.IncomingHttpHeaders;
  readonly body: { model: unknown; context: unknown; questions: Record<string, TypeLLMQuestion> };
  /** Client-side port of the TCP connection: equal ports mean a reused connection. */
  readonly remotePort: number | undefined;
}

export type TypeLLMBehaviour =
  | { readonly kind: "answer"; readonly tier: string; readonly p?: number; readonly delayMs?: number }
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "junk" }
  | { readonly kind: "raw"; readonly body: unknown }
  | { readonly kind: "hang" };

export interface FakeTypeLLM {
  readonly url: string;
  readonly calls: TypeLLMCall[];
  set(b: TypeLLMBehaviour): void;
  close(): Promise<void>;
}

/**
 * A well-formed result for whatever questions were asked: enum fields that list `tier` put `p` on it (the rest shared
 * out), level enums put 0.75 on "1" and 0.25 on "2", booleans are 0.2 true.
 */
export function resultFor(questions: Record<string, TypeLLMQuestion>, tier: string, p = 0.9): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "boolean") result[id] = { value: false, probabilities: { true: 0.2, false: 0.8 } };
    else if (q.enum?.includes(tier)) {
      const rest = (1 - p) / Math.max(1, q.enum.length - 1);
      result[id] = { value: tier, probabilities: Object.fromEntries(q.enum.map((o) => [o, o === tier ? p : rest])) };
    } else {
      const probabilities = Object.fromEntries((q.enum ?? []).map((o) => [o, o === "1" ? 0.75 : o === "2" ? 0.25 : 0]));
      result[id] = { value: "1", probabilities };
    }
  }
  return result;
}

export async function startFakeTypeLLM(initial: TypeLLMBehaviour = { kind: "answer", tier: "haiku" }): Promise<FakeTypeLLM> {
  let behaviour = initial;
  const calls: TypeLLMCall[] = [];
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/generate") {
      req.resume();
      res.writeHead(404, { "content-length": 0 }).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TypeLLMCall["body"];
      calls.push({ headers: req.headers, body, remotePort: req.socket.remotePort });
      const b = behaviour;
      const send = (status: number, payload: string): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(payload);
      };
      switch (b.kind) {
        case "answer":
          setTimeout(
            () => send(200, JSON.stringify({ id: "gen_test", model: "typellm-test", result: resultFor(body.questions, b.tier, b.p), thinking: {}, usage: { input_tokens: 654, thinking_tokens: 0 }, elapsed: 0.1 })),
            b.delayMs ?? 0,
          );
          return;
        case "status":
          send(b.status, JSON.stringify({ error: { type: "upstream_error", message: "secret-looking error body tl-sk-shouldnotleak" } }));
          return;
        case "junk":
          send(200, "<html>not json");
          return;
        case "raw":
          send(200, JSON.stringify(b.body));
          return;
        case "hang":
          return; // never answers; the client's deadline must fire
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    set: (b) => {
      behaviour = b;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
