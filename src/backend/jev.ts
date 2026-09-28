// TypeSafe Jev (System One) over node:http(s) with a keep-alive agent: POST {base}/v1/systemone, Bearer key,
// {state, model, questions}. Laya's `laya-serve` speaks the same wire format, so the same client serves both. No semantic retries (an SDK's default retries would add seconds); the only second attempt
// is for a keep-alive socket the server had silently closed, inside the same hard deadline. Strict validation: any
// odd or partial answer is an error, so the caller fails open. Errors never include the response body or the key.
import http from "node:http";
import https from "node:https";
import { DEFAULT_JEV_MODEL } from "../config.js";
import type { Answer, Decision, DecisionState, QuestionSet } from "../types.js";
import { BackendError, type DecisionBackend } from "./types.js";

/** The model asked for when the caller names none: the pinned version (src/config.ts). */
export const JEV_MODEL = DEFAULT_JEV_MODEL;
export const JEV_PATH = "/v1/systemone";
/** Probabilities must sum to 1 within this tolerance. */
const SUM_TOLERANCE = 0.02;

export interface JevOptions {
  /** Which backend this client talks to; the wire format is the same. Default `jev`. */
  readonly id?: "jev" | "laya";
  readonly baseUrl: string;
  /** Sent as a Bearer token; no `authorization` header at all when absent. */
  readonly apiKey?: string | undefined;
  /** Hard deadline for one decision, connection setup included. On expiry the caller fails open. */
  readonly deadlineMs: number;
  readonly model?: string;
  /** Injectable for tests. */
  readonly now?: () => number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

function probabilities(v: unknown, keys: readonly string[], what: string): Record<string, number> {
  if (!isObj(v)) throw new BackendError("invalid_response", `${what}: probabilities missing`);
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, p] of Object.entries(v)) {
    if (!keys.includes(k)) throw new BackendError("invalid_response", `${what}: probability for an unknown option`);
    if (!isUnit(p)) throw new BackendError("invalid_response", `${what}: probability out of range`);
    out[k] = p;
    sum += p;
  }
  if (Math.abs(sum - 1) > SUM_TOLERANCE) throw new BackendError("invalid_response", `${what}: probabilities do not sum to 1`);
  return out;
}

/** Validates one answer against the question that was asked. */
export function validateAnswer(id: string, q: QuestionSet[string], a: unknown): Answer {
  if (!isObj(a) || a["type"] !== q.type) throw new BackendError("invalid_response", `${id}: answer type does not match the question`);
  switch (q.type) {
    case "choice": {
      const options = Object.keys(q.criteria);
      const choice = a["choice"];
      if (typeof choice !== "string" || !options.includes(choice)) throw new BackendError("invalid_response", `${id}: choice is not one of the options`);
      if (!isUnit(a["confidence"])) throw new BackendError("invalid_response", `${id}: confidence out of range`);
      return { type: "choice", choice, confidence: a["confidence"], probabilities: probabilities(a["probabilities"], options, id) };
    }
    case "score": {
      const levels = q.criteria.map((_, i) => String(i));
      const score = a["score"];
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels.length - 1) throw new BackendError("invalid_response", `${id}: score out of range`);
      if (!isUnit(a["confidence"])) throw new BackendError("invalid_response", `${id}: confidence out of range`);
      return { type: "score", score, confidence: a["confidence"], probabilities: probabilities(a["probabilities"], levels, id) };
    }
    case "noul": {
      if (!isUnit(a["noul"])) throw new BackendError("invalid_response", `${id}: noul out of range`);
      return { type: "noul", p: a["noul"] };
    }
  }
}

/** Upper bound on a Jev response body; anything larger is not a valid answer. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

interface RawResponse {
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

export class JevBackend implements DecisionBackend {
  readonly id: "jev" | "laya";
  readonly #url: URL;
  readonly #agent: http.Agent;

  constructor(private readonly opts: JevOptions) {
    this.id = opts.id ?? "jev";
    this.#url = new URL(opts.baseUrl.replace(/\/+$/, "") + JEV_PATH);
    // No socket cap: the deadline runs from decide(), so a decision queued behind busy sockets spent its budget waiting
    // (4 sockets, 8 subagents started at once, 800 ms answers: the last 4 timed out). Only 2 idle ones are kept.
    const agentOpts = { keepAlive: true, maxFreeSockets: 2, scheduling: "lifo" as const };
    this.#agent = this.#url.protocol === "https:" ? new https.Agent(agentOpts) : new http.Agent(agentOpts);
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

  async decide(state: DecisionState, questions: QuestionSet, { signal }: { readonly signal: AbortSignal }): Promise<Decision> {
    const now = this.opts.now ?? Date.now;
    const started = now();
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.opts.deadlineMs);
    const onAbort = (): void => ac.abort();
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    const headers = { ...(this.opts.apiKey !== undefined ? { authorization: `Bearer ${this.opts.apiKey}` } : {}), "content-type": "application/json", accept: "application/json" };
    const payload = JSON.stringify({ state, model: this.opts.model ?? JEV_MODEL, questions });
    const fail = (): never => {
      if (timedOut) throw new BackendError("timeout", `no answer within ${this.opts.deadlineMs} ms`);
      if (signal.aborted) throw new BackendError("aborted", "aborted by caller");
      throw new BackendError("network", "request failed");
    };
    try {
      let res: RawResponse;
      try {
        res = await post(this.#url, this.#agent, headers, payload, ac.signal);
      } catch (e) {
        // A keep-alive connection the server closed while idle fails before any byte: one fresh attempt, same deadline.
        if (!(e instanceof TransportError && e.staleSocket) || ac.signal.aborted) fail();
        try {
          res = await post(this.#url, this.#agent, headers, payload, ac.signal);
        } catch {
          return fail();
        }
      }
      if (res.status < 200 || res.status >= 300) throw new BackendError("http", `HTTP ${res.status}`, res.status); // body never read or logged
      let body: unknown;
      try {
        body = JSON.parse(res.body);
      } catch {
        throw new BackendError("invalid_response", "response is not JSON");
      }
      if (!isObj(body) || !isObj(body["answers"])) throw new BackendError("invalid_response", "answers missing");
      const raw = body["answers"];
      const answers: Record<string, Answer> = {};
      for (const [id, q] of Object.entries(questions)) answers[id] = validateAnswer(id, q, raw[id]);
      const usage = body["usage"];
      const tokensIn = isObj(usage) && typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : null;
      const backendModel = typeof body["model"] === "string" ? body["model"] : (this.opts.model ?? JEV_MODEL);
      return { answers, latencyMs: now() - started, backendModel, tokensIn, connection: res.reused ? "reused" : "new" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
