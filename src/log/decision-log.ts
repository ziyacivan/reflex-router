// decisions.jsonl: one record per classified /v1/messages request (schema v:1). A `new` turn carries the backend's
// decision and the would-be plan; continuation and side requests carry decision: null, so drift in the classifier
// and the token usage of every request are visible. Never contains credentials, ids in clear, or full prompts.
import crypto from "node:crypto";
import path from "node:path";
import type { Tier } from "../config.js";
import { head } from "../privacy/budget.js";
import { redact } from "../privacy/redact.js";
import type { Effort, EffortReason, ReasonCode } from "../types.js";
import type { SideFingerprint } from "../wire/fingerprint.js";
import { JsonlWriter, type JsonlOptions } from "./jsonl.js";

/** Hard cap on the prompt preview, in code points. A constant, deliberately not configurable. */
export const PROMPT_PREVIEW_MAX = 300;

export interface PickRecord {
  readonly value: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
}

export interface DecisionRecord {
  readonly v: 1;
  /** Record type in the shared JSONL: decisions, and the outcome records keyed to them (src/outcome/tracker.ts). */
  readonly record: "decision";
  readonly id: string;
  readonly at: string;
  /** sha256(session id), truncated. */
  readonly session: string | null;
  readonly conv: string | null;
  readonly kind: "main" | "subagent" | "unknown";
  readonly signal: string;
  readonly signals: { readonly header: boolean; readonly s1: boolean; readonly s2: boolean; readonly s3: boolean };
  readonly turn: "new" | "continuation" | "side";
  readonly side_kind: string | null;
  /** Which harness marker named this side call (src/wire/markers.ts). Two features can share a side kind, so the
   * marker id is what tells them apart; null when the kind came from shape alone. */
  readonly side_marker: string | null;
  /**
   * `turn: "new"` only: how the prompt's message carried its content, `string` or `blocks` (`other` for anything
   * else). 2.1.277 sent every typed prompt as blocks; 2.1.278 sends plain strings too, and once a turn is recognised
   * the two are indistinguishable, so without this a log cannot say which encoding its turns arrived in.
   */
  readonly prompt_encoding?: "string" | "blocks" | "other";
  /** Present only on `side_kind: "unclassified"`: which shape test produced the residual (src/wire/claude-code.ts). */
  readonly unclassified_reason?: string;
  /** Present only when the wire-format cross-check fired for this session (src/wire/drift.ts). An alarm; it changes nothing. */
  readonly drift?: string;
  /** Present only when true: a `continuation` whose tool results arrived with a message the user typed mid-loop. */
  readonly interjection?: true;
  readonly entrypoint: string | null;
  readonly mode_requested: string;
  readonly mode_effective: string;
  readonly degraded_reason: string | null;
  readonly shape: { readonly status: string; readonly violations: readonly string[] };
  readonly claude_version: string | null;
  /** The request carried the `extended-cache-ttl` beta, so its cache writes may be 1-hour ones. The beta permits a
   * 1-hour write, it does not prove every breakpoint used one; `cache_ttl` says which one the request asked for. */
  readonly cache_ttl_beta: boolean;
  /** The `ttl` of the request's last cache breakpoint (src/wire/claude-code.ts `lastBreakpointTtl`): when the prefix it
   * wrote lapses. null: no breakpoint, or a TTL reflex does not know. Absent on records written before it existed. */
  readonly cache_ttl?: "5m" | "1h" | null;
  /** The subscription quota the response reported (src/wire/ratelimit.ts): per window, the used fraction and the reset
   * time (epoch seconds). Account-wide, so usage outside reflex moves it too. Absent when the response carried none. */
  readonly quota?: Readonly<Record<string, { readonly util: number; readonly reset: number | null }>>;
  readonly backend: string | null;
  /**
   * Version of the decision backend that answered, as the backend itself reported it (Jev returns it as `model`, e.g.
   * `jev-1.13.0`). Present on every decision record; null when no backend call happened (guard skip, override, side
   * call) or when the backend named no version. Calibration must be splittable by it: a rate measured across two
   * backend versions is two different measurements added together.
   */
  readonly backend_version: string | null;
  readonly requested: { readonly model: string | null; readonly tier: Tier | null; readonly effort: string | null };
  readonly decision: {
    /** `picks.tier.value` is the applied pick; confidence/probabilities are the backend's answer as given. */
    readonly picks: { readonly tier: PickRecord };
    /** Which rule produced the applied pick; both readings are always logged for comparison. */
    readonly rule: "mass" | "argmax";
    readonly pick_mass: { readonly value: string; readonly above_mass: number };
    readonly pick_argmax: { readonly value: string; readonly confidence: number };
    readonly vetoes: Readonly<Record<string, number>>;
    readonly latencyMs: number;
    readonly tokensIn: number | null;
    readonly backendModel: string;
    /** Whether the Jev call reused a keep-alive connection. */
    readonly connection: "new" | "reused" | null;
  } | null;
  readonly plan: {
    readonly target: { readonly tier: Tier; readonly effort?: Effort } | null;
    readonly would_route_to: string | null;
    readonly routed_to: string | null;
    readonly reasons: readonly ReasonCode[];
    readonly would_upgrade: boolean;
  } | null;
  /**
   * REFLEX_EFFORT, on a decided new turn: the level read from reasoning_demand (`pick`), the level the turn should run
   * at (`target`; null = the client's), how it was applied (`via`; null = not applied: shadow, a model it is not
   * verified for, or a failed decision) and why. Absent with the setting off. What a request's body carried is in
   * `forwarded.fields` (`messages.effort_added`, `messages.effort_reinserted:<n>`, `output_config.effort`).
   */
  readonly effort?: {
    readonly pick: Effort;
    readonly target: Effort | null;
    readonly via: "message" | "top-level" | null;
    readonly reasons: readonly EffortReason[];
    /** REFLEX_EFFORT_AB arm, only on turns whose target differed from the client's level; absent otherwise. */
    readonly ab?: "control" | "treated";
  } | null;
  /** Main-chat cost guard, when it was evaluated. */
  readonly guard: { readonly allowed: boolean; readonly reason: string; readonly ctx: number | null; readonly penalty_usd: number | null; readonly saving_usd: number | null } | null;
  /** Manual `!tier` override in effect for this decision (main chat: from the prompt; subagent: captured at its first request). */
  readonly override: Tier | null;
  /** Continuations: whether a pin for this conversation/agent existed; `set` on a decided new turn. */
  readonly pin: "set" | "hit" | "miss" | null;
  readonly forwarded: {
    /** What the client asked for. */
    readonly requested_model: string | null;
    /** What was actually sent upstream (after a fallback: the original again). */
    readonly model: string | null;
    readonly rewritten: boolean;
    /** Fields changed by the rewrite (src/wire/rewrite.ts), empty when not rewritten. */
    readonly fields: readonly string[];
    /** The rewritten request was rejected and the original bytes were sent instead. */
    readonly fallback: boolean;
    readonly fallback_status: number | null;
    /** The upstream's error for the rejected rewrite, `type: message`, redacted and capped at 500 characters. */
    readonly fallback_error: string | null;
  };
  readonly upstream: { readonly status: number | null; readonly msToHeaders: number | null };
  /**
   * Where the time to the upstream's response headers went. `msToHeaders` (measured from the request's arrival) is
   * decision_wait_ms + the router's own work + upstream_first_byte_ms.
   */
  readonly timing: {
    /** Time the request waited for the backend decision before going upstream: route mode, `new` turns; 0 otherwise (shadow decides off the critical path). Bounded by decision_deadline_ms + DECISION_GRACE_MS (src/timing.ts). */
    readonly decision_wait_ms: number;
    /** REFLEX_JEV_DEADLINE_MS in force. */
    readonly decision_deadline_ms: number;
    /** From handing the request to the upstream until its response headers (the first response byte we see); includes a rejected first attempt and the retry after a fallback. null: no response. */
    readonly upstream_first_byte_ms: number | null;
  };
  readonly usage: { readonly input: number; readonly output: number; readonly cache_read: number; readonly cache_create: number } | null;
  readonly usage_unknown_reason: string | null;
  /** Backend or pipeline error category; never a message body. */
  readonly error: string | null;
  readonly sent: { readonly keys: readonly string[]; readonly chars: number } | null;
  /** `side` / `unclassified` only: the request's structure, so the call can be given a side_kind (src/wire/fingerprint.ts). null: could not be built. */
  readonly side_fingerprint?: SideFingerprint | null;
  /** Version of the delegation hint this session runs with (REFLEX_DELEGATE=1, src/delegate/hint.ts); null when off. */
  readonly delegate_hint: string | null;
  /**
   * REFLEX_ESCALATE=1 only: this new turn was planned one tier above `from` because the conversation's previous routed
   * turn closed with `signal`. `decision_id` is that turn's decision, so the report can join cause to effect and price
   * what escalation cost. null on every other record (src/worker/escalation.ts).
   */
  readonly escalation: EscalationBlock | null;
  /**
   * `REFLEX_ESCALATE=shadow`: what escalation WOULD have done to this turn. Nothing was changed - the turn routed
   * exactly as the policy decided - so this never appears alongside `escalation`, and `plan.reasons` carries no
   * `escalated:` entry. It is what lets a log price escalation before anyone turns it on.
   */
  readonly would_escalate: EscalationBlock | null;
  /**
   * REFLEX_AB only. This turn entered the randomised experiment because the backend wanted to route it below the
   * requested tier: `control` means the draw left it on the requested model, `routed` means it was routed as planned.
   * null means the turn never entered the randomisation, and such turns must be kept out of any comparison of the two
   * arms - that is the whole point of the tag.
   */
  readonly ab: "control" | "routed" | null;
  /** REFLEX_COMPARE only, on a turn the primary backend decided: the second backend's view, numbers only. */
  readonly compare?: CompareBlock;
  readonly prompt_preview?: string;
}

/**
 * What the comparison backend made of the same state (REFLEX_COMPARE=laya). Only numbers: `x` is Laya's feature
 * vector (src/backend/laya-calibration.ts, `feature_version`), from which the calibration head is fitted against the
 * primary backend's `decision` in the same record. Never read by routing.
 */
export interface CompareBlock {
  readonly backend: "laya";
  /** The checkpoint asked (REFLEX_LAYA_MODEL). */
  readonly model: string;
  readonly feature_version: string;
  readonly x: readonly number[] | null;
  readonly latency_ms: number | null;
  /** Error category when Laya did not answer; null when it did. */
  readonly error: string | null;
}

/** An escalation, applied (`escalation`) or recorded in shadow (`would_escalate`). */
export interface EscalationBlock {
  readonly signal: "correction" | "test_failure" | "reverted_edit";
  /** The tier the policy itself picked, i.e. what this turn would have routed to without the signal. */
  readonly from: Tier;
  readonly to: Tier;
  /** The decision whose outcome window produced the signal, so cause can be joined to effect. */
  readonly decision_id: string | null;
  readonly turn_seq: number;
}

/** One per delegation hint actually returned to Claude Code (a UserPromptSubmit answered with the hint). */
export interface DelegateHintRecord {
  readonly v: 1;
  readonly record: "delegate_hint";
  readonly id: string;
  readonly at: string;
  readonly session: string | null;
  readonly version: string;
}

export const hashId = (id: string | null): string | null => (id === null ? null : crypto.createHash("sha256").update(id).digest("hex").slice(0, 16));

/** Redacted, whitespace-collapsed, capped at PROMPT_PREVIEW_MAX code points. */
export const promptPreview = (text: string): string => head(redact(text).replace(/\s+/g, " ").trim(), PROMPT_PREVIEW_MAX);

export class DecisionLog {
  readonly #writer: JsonlWriter;

  constructor(
    home: string,
    private readonly logPrompts: boolean,
    opts: JsonlOptions = {},
  ) {
    this.#writer = new JsonlWriter(path.join(home, "decisions.jsonl"), opts);
  }

  get file(): string {
    return this.#writer.file;
  }

  /** `preview` is the raw task text; it is redacted and capped here, or dropped when prompt logging is off. */
  append(record: DecisionRecord, preview: string | null): Promise<void> {
    const { prompt_preview: _ignored, ...rest } = record;
    const out: DecisionRecord = this.logPrompts && preview ? { ...rest, prompt_preview: promptPreview(preview) } : rest;
    return this.#writer.append(out);
  }

  /** Outcome-capture records (outcome, outcome_update, harness_injected); they carry no prompt text. */
  appendRecord(record: { readonly v: 1; readonly record: string }): Promise<void> {
    return this.#writer.append(record);
  }

  flush(): Promise<void> {
    return this.#writer.flush();
  }
}
