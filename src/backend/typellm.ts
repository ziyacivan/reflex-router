// TypeLLM (REFLEX_BACKEND=typellm): POST {base}/v1/generate, Bearer key, {model, context, questions}, over the shared
// keep-alive transport (http-client.ts). TypeLLM asks typed questions about a context, not System One questions about
// a state, so this module translates both ways: the state is sent as JSON text in `context`; a `choice` becomes a
// string enum over its options, a `score` a string enum over its levels ("0".."n-1"), a `noul` a boolean, each with
// `return_probabilities` and the question's instructions and criteria flattened into `instructions`. The answers come
// back as reflex's Answer shape. This translation is the one measured against Jev (docs/observations.md,
// 2026-09-30): changing its text changes what was measured. Strict validation, as for Jev: any odd or partial answer
// is an error, so the caller fails open. Errors never include the response body or the key.
import { DEFAULT_TYPELLM_MODEL } from "../config.js";
import type { Answer, Decision, DecisionState, Question, QuestionSet } from "../types.js";
import { KeepAliveClient } from "./http-client.js";
import { BackendError, type DecisionBackend } from "./types.js";

export const TYPELLM_PATH = "/v1/generate";
/** Probabilities must sum to 1 within this tolerance. */
const SUM_TOLERANCE = 0.02;

export interface TypeLLMOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Hard deadline for one decision, connection setup included. On expiry the caller fails open. */
  readonly deadlineMs: number;
  readonly model?: string;
  /** Injectable for tests. */
  readonly now?: () => number;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const isUnit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const text = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** A question's instructions as one string: a plain string as is, an object's values joined in order. */
function instructionsText(ins: unknown): string {
  if (typeof ins === "string") return ins;
  if (isObj(ins)) return Object.values(ins).map(text).join(" ");
  return "";
}

function optionLine(option: string, c: unknown): string {
  if (!isObj(c)) return `- ${option}: ${text(c)}`;
  const examples = Array.isArray(c["examples"]) && c["examples"].length > 0 ? ` Examples: ${c["examples"].map(text).join("; ")}.` : "";
  return `- ${option}: ${text(c["what"])}${c["not_for"] !== undefined ? ` Not for: ${text(c["not_for"])}` : ""}${examples}`;
}

/** The enum values TypeLLM answers with for one question. */
const candidates = (q: Question): readonly string[] =>
  q.type === "choice" ? Object.keys(q.criteria) : q.type === "score" ? q.criteria.map((_, i) => String(i)) : ["true", "false"];

/** One reflex question as a TypeLLM question. */
export function toTypeLLMQuestion(q: Question): Json {
  const base = instructionsText(q.instructions);
  switch (q.type) {
    case "choice": {
      const lines = Object.entries(q.criteria).map(([o, c]) => optionLine(o, c));
      return { type: "string", enum: candidates(q), instructions: `${base}\nOptions:\n${lines.join("\n")}`, return_probabilities: true };
    }
    case "score": {
      const lines = q.criteria.map((c, i) => `- ${i}: ${isObj(c) ? text(c["what"]) : text(c)}`);
      return { type: "string", enum: candidates(q), instructions: `${base}\nLevels:\n${lines.join("\n")}`, return_probabilities: true };
    }
    case "noul": {
      const c = q.criteria;
      const meaning = c?.true !== undefined || c?.false !== undefined ? `\n${c.true !== undefined ? `Yes: ${c.true}` : ""}${c.true !== undefined && c.false !== undefined ? " " : ""}${c.false !== undefined ? `No: ${c.false}` : ""}` : "";
      return { type: "boolean", instructions: base + meaning, return_probabilities: true };
    }
  }
}

function probabilities(v: unknown, keys: readonly string[], what: string): Record<string, number> {
  if (!isObj(v)) throw new BackendError("invalid_response", `${what}: probabilities missing`);
  const out: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
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

/**
 * TypeLLM reports no confidence; this is 1 - normalised entropy of the distribution, the same spread statistic the Laya
 * head reports (laya-calibration.ts). It is not Jev's confidence, so REFLEX_DECISION_RULE=argmax thresholds tuned on Jev
 * do not carry over; the default `mass` rule reads only the probabilities.
 */
function spread(ps: readonly number[]): number {
  if (ps.length < 2) return 1;
  const h = -ps.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  return Math.min(1, Math.max(0, 1 - h / Math.log(ps.length)));
}

/** Validates one TypeLLM field against the question that was asked and maps it to reflex's Answer. */
export function fromTypeLLMAnswer(id: string, q: Question, a: unknown): Answer {
  if (!isObj(a)) throw new BackendError("invalid_response", `${id}: answer missing`);
  const keys = candidates(q);
  const p = probabilities(a["probabilities"], keys, id);
  switch (q.type) {
    case "choice": {
      const choice = a["value"];
      if (typeof choice !== "string" || !keys.includes(choice)) throw new BackendError("invalid_response", `${id}: choice is not one of the options`);
      return { type: "choice", choice, confidence: spread(keys.map((k) => p[k]!)), probabilities: p };
    }
    case "score": {
      // The score is the distribution's expected level, as Jev's is (e.g. {0: 0.77, 1: 0.23} -> 0.23).
      const score = keys.reduce((s, k) => s + Number(k) * p[k]!, 0);
      return { type: "score", score, confidence: spread(keys.map((k) => p[k]!)), probabilities: p };
    }
    case "noul":
      return { type: "noul", p: p["true"]! };
  }
}

export class TypeLLMBackend implements DecisionBackend {
  readonly id = "typellm" as const;
  readonly #client: KeepAliveClient;

  constructor(private readonly opts: TypeLLMOptions) {
    this.#client = new KeepAliveClient(new URL(opts.baseUrl.replace(/\/+$/, "") + TYPELLM_PATH));
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
    const headers = { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json", accept: "application/json" };
    const model = this.opts.model ?? DEFAULT_TYPELLM_MODEL;
    const payload = JSON.stringify({
      model,
      context: JSON.stringify(state),
      questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, toTypeLLMQuestion(q)])),
    });
    const res = await this.#client.post(headers, payload, this.opts.deadlineMs, signal);
    if (res.status < 200 || res.status >= 300) throw new BackendError("http", `HTTP ${res.status}`, res.status); // body never read or logged
    let body: unknown;
    try {
      body = JSON.parse(res.body);
    } catch {
      throw new BackendError("invalid_response", "response is not JSON");
    }
    if (!isObj(body) || !isObj(body["result"])) throw new BackendError("invalid_response", "result missing");
    const raw = body["result"];
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = fromTypeLLMAnswer(id, q, raw[id]);
    const usage = body["usage"];
    const tokensIn = isObj(usage) && typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : null;
    const backendModel = typeof body["model"] === "string" ? body["model"] : model;
    return { answers, latencyMs: now() - started, backendModel, tokensIn, connection: res.reused ? "reused" : "new" };
  }
}
