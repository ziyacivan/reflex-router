// TypeSafe Jev (System One): POST {base}/v1/systemone, Bearer key, {state, model, questions}, over the shared
// keep-alive transport (http-client.ts). Laya's `laya-serve` speaks the same wire format, so the same client serves
// both. Strict validation: any odd or partial answer is an error, so the caller fails open. Errors never include the
// response body or the key.
import { DEFAULT_JEV_MODEL } from "../config.js";
import type { Answer, Decision, DecisionState, QuestionSet } from "../types.js";
import { KeepAliveClient } from "./http-client.js";
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

export class JevBackend implements DecisionBackend {
  readonly id: "jev" | "laya";
  readonly #client: KeepAliveClient;

  constructor(private readonly opts: JevOptions) {
    this.id = opts.id ?? "jev";
    this.#client = new KeepAliveClient(new URL(opts.baseUrl.replace(/\/+$/, "") + JEV_PATH));
  }

  /** Opens the keep-alive connection ahead of the first decision (best effort; see KeepAliveClient.warm). */
  warm(timeoutMs = 3000): Promise<void> {
    return this.#client.warm(timeoutMs);
  }

  /** Closes idle keep-alive connections (worker shutdown, tests). */
  close(): void {
    this.#client.close();
  }

  async decide(state: DecisionState, questions: QuestionSet, { signal }: { readonly signal: AbortSignal }): Promise<Decision> {
    const now = this.opts.now ?? Date.now;
    const started = now();
    const headers = { ...(this.opts.apiKey !== undefined ? { authorization: `Bearer ${this.opts.apiKey}` } : {}), "content-type": "application/json", accept: "application/json" };
    const payload = JSON.stringify({ state, model: this.opts.model ?? JEV_MODEL, questions });
    const res = await this.#client.post(headers, payload, this.opts.deadlineMs, signal);
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
  }
}
