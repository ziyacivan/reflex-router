// The transport every remote decision backend shares: one JSON POST over a persistent keep-alive agent, under a hard
// deadline that includes connection setup. No semantic retries (an SDK's default retries would add seconds); the only
// second attempt is for a keep-alive socket the server had silently closed, inside the same deadline. Errors never
// include the response body or the key.
import http from "node:http";
import https from "node:https";
import { BackendError } from "./types.js";

/** Upper bound on a response body; anything larger is not a valid answer. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface RawResponse {
  readonly status: number;
  readonly body: string;
  /** The request went over an already-open keep-alive connection. */
  readonly reused: boolean;
}

class TransportError extends Error {
  constructor(
    message: string,
    /** Failed before any response byte arrived on a reused connection: the server had closed it while idle. */
    readonly staleSocket: boolean,
  ) {
    super(message);
  }
}

/**
 * One POST over a persistent keep-alive agent. Global fetch closes idle connections after ~4 s, so decisions minutes
 * apart each paid a fresh TCP+TLS handshake; this agent keeps the connection until the server closes it.
 */
function post(url: URL, agent: http.Agent, headers: http.OutgoingHttpHeaders, body: string, signal: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method: "POST", agent, headers: { ...headers, "content-length": Buffer.byteLength(body) }, signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) req.destroy(new TransportError("response too large", false));
        else chunks.push(c);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), reused: req.reusedSocket }));
      res.on("error", (e) => reject(new TransportError(e.message, false)));
    });
    req.on("error", (e) => reject(e instanceof TransportError ? e : new TransportError(e.message, req.reusedSocket && !signal.aborted)));
    req.end(body);
  });
}

export class KeepAliveClient {
  readonly #url: URL;
  readonly #agent: http.Agent;

  constructor(url: URL) {
    this.#url = url;
    // No socket cap: the deadline runs from decide(), so a decision queued behind busy sockets spent its budget waiting
    // (4 sockets, 8 subagents started at once, 800 ms answers: the last 4 timed out). Only 2 idle ones are kept.
    const agentOpts = { keepAlive: true, maxFreeSockets: 2, scheduling: "lifo" as const };
    this.#agent = url.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
  }

  /**
   * Opens the keep-alive connection ahead of the first decision with a bare `HEAD /`: no key, no body, response
   * ignored. Best effort; any failure is silent (the first decision then connects as usual).
   */
  warm(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      try {
        const lib = this.#url.protocol === "https:" ? https : http;
        const req = lib.request(new URL("/", this.#url), { method: "HEAD", agent: this.#agent, timeout: timeoutMs }, (res) => {
          res.resume();
          res.on("error", () => resolve());
        });
        // Resolve once the socket is back in the pool (the agent's `free`), so the next request can reuse it.
        req.on("socket", (socket) => socket.once("free", () => resolve()));
        req.on("close", () => resolve());
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve());
        req.end();
      } catch {
        resolve(); // e.g. a synchronous connect failure; warming is best effort
      }
    });
  }

  /** Closes idle keep-alive connections (worker shutdown, tests). */
  close(): void {
    this.#agent.destroy();
  }

  /**
   * POSTs `payload` and resolves with the raw response, whatever its status. Rejects with a BackendError of kind
   * `timeout` (deadlineMs passed), `aborted` (the caller's signal) or `network`.
   */
  async post(headers: http.OutgoingHttpHeaders, payload: string, deadlineMs: number, signal: AbortSignal): Promise<RawResponse> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, deadlineMs);
    const onAbort = (): void => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    const fail = (): never => {
      if (timedOut) throw new BackendError("timeout", `no answer within ${deadlineMs} ms`);
      if (signal.aborted) throw new BackendError("aborted", "aborted by caller");
      throw new BackendError("network", "request failed");
    };
    try {
      try {
        return await post(this.#url, this.#agent, headers, payload, ac.signal);
      } catch (e) {
        // A keep-alive connection the server closed while idle fails before any byte: one fresh attempt, same deadline.
        if (!(e instanceof TransportError && e.staleSocket) || ac.signal.aborted) fail();
        try {
          return await post(this.#url, this.#agent, headers, payload, ac.signal);
        } catch {
          return fail();
        }
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
