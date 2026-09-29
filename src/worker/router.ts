// Classification, decisions, pins and rewrites for POST /v1/messages. Two modes:
//   shadow  forward the original bytes immediately; decide off the critical path; record what would have happened.
//   route   a positively identified `new` turn waits for its decision (bounded by the Jev deadline) and is rewritten
//           when policy, the main-chat cost guard, disabled tiers and the verified-rewrite list all allow it; its
//           continuations reuse that pin (per conversation, i.e. per agent id for subagents). Side calls are never
//           decided; a pinned subagent's progress summary follows its pin, and every side call gets the conversation's
//           effort marks, so both read the cache their conversation already wrote.
// Every failure ends in "forward the original bytes"; the retry-with-original on a rejected rewrite lives in server.ts.
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { decisionDeadlineMs, type Config, type Tier } from "../config.js";
import type { EffectiveMode } from "../effective-mode.js";
import { guard, type GuardResult } from "../guard.js";
import { assessVersion, type VersionLevel } from "../launcher/version.js";
import { hashId, type CompareBlock, type DecisionLog, type DecisionRecord } from "../log/decision-log.js";
import { parseOverride } from "../overrides.js";
import { DECISION_GRACE_MS } from "../timing.js";
import { buildQuestions, clampUp, effortPlan, judge, plan } from "../policy.js";
import { buildState } from "../privacy/state.js";
import { estimateTokens, fitsContext, tierOfModel, tierRank } from "../tiers.js";
import type { DecisionState, Effort, QuestionSet, ReasonCode } from "../types.js";
import type { Log } from "../util/log.js";
import { isPromptTooLong, ModelRestorer, usageFormat } from "../wire/anthropic.js";
import type { ChunkEdit } from "../net/forward.js";
import { followsPin, isMessagesRequest, parseRequest, type RequestView } from "../wire/claude-code.js";
import { sideFingerprint, type SideFingerprint } from "../wire/fingerprint.js";
import { EFFORTS, effortVia, messageEffort, withEffort, withTopEffort, type EffortEdit } from "../wire/effort.js";
import { isVerifiedRetarget, retarget, retargetBetas } from "../wire/rewrite.js";
import { parseQuota, type Quota } from "../wire/ratelimit.js";
import { ShapeTracker } from "../wire/shape.js";
import { DRIFT_MIN_TYPED_PROMPTS, DriftTracker } from "../wire/drift.js";
import { TESTED_CLAUDE_VERSIONS } from "../wire/tested-versions.generated.js";
import { BackendError, type DecisionBackend } from "../backend/types.js";
import type { LayaBackend } from "../backend/laya.js";
import { FEATURE_VERSION } from "../backend/laya-calibration.js";
import type { Breaker } from "./breaker.js";
import { UsageTee } from "./usage-tee.js";
import type { DecisionInfo } from "../outcome/tracker.js";
import { HINT_VERSION } from "../delegate/hint.js";
import type { EffortStore } from "./effort-store.js";
import { decay, escalatedTier, raise, type EscalationEvent, type EscalationState } from "./escalation.js";

/** A tier whose rewritten request was rejected stays off for the session this long. */
export const TIER_DISABLE_MS = 30 * 60 * 1000;
/** Safety margin on top of the backend's own deadline before route mode gives up waiting. */

export interface RouterDeps {
  readonly config: Config;
  readonly effectiveMode: EffectiveMode;
  readonly degradedReason: string | null;
  readonly claudeVersion: string | null;
  readonly backend: DecisionBackend | null;
  /** REFLEX_COMPARE=laya: asked the same state after the primary backend, recorded only. */
  readonly compare?: LayaBackend | null;
  readonly breaker: Breaker;
  readonly log: DecisionLog;
  readonly logger: Log;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Outcome capture: told about every classified request (raw ids stay in memory). */
  readonly onDecision?: (d: DecisionInfo) => void;
  /** Every decision record as it is written, with the raw session id (the record only holds its hash). */
  readonly onRecord?: (record: DecisionRecord, sessionId: string | null) => void;
  /** Uniform [0,1) source for REFLEX_AB's randomisation. Injected so the experiment is testable. */
  readonly random?: () => number;
  /** How many prompts the user typed in a session, for the wire-drift cross-check only (src/wire/drift.ts). */
  readonly typedPromptCount?: (sessionId: string | null) => number;
  /** The newest typed prompt no wire turn has claimed; the only one that may promote a plain-string message. */
  readonly newestTypedPrompt?: (sessionId: string | null) => string | null;
  /** Called when a main `new` turn is recognised: it consumed the newest typed prompt, whatever encoding it used. */
  readonly claimTypedPrompt?: (sessionId: string | null) => void;
  /** Prompts UserPromptSubmit delivered in a session (memory only); null when none arrived. Keeps them out of fingerprints. */
  readonly typedPrompts?: (sessionId: string | null) => readonly string[] | null;
  /** The effort messages added to conversations (REFLEX_EFFORT); re-inserted whenever present. */
  readonly effortStore?: EffortStore | null;
  /** The model the Agent tool call gave this subagent's task explicitly (PreToolUse), or null when it inherits. */
  readonly explicitModel?: (sessionId: string | null, task: string) => string | null;
  /** Every response that reported the subscription quota, as its headers arrive (worker-global: the quota is the account's). */
  readonly onQuota?: (quota: Quota, atMs: number) => void;
}

/** Handed to server.ts for one request as it is forwarded. */
export interface Observation {
  /** Returns the edit to apply to the response bytes (the client's model restored after a retarget), if any. */
  headers(status: number, headers: IncomingHttpHeaders): ChunkEdit | null;
  readonly tap: (chunk: Buffer) => void;
  /** The rewritten request was rejected with `status` (redacted error summary); the original bytes are sent instead. */
  fallback(status: number, error: string | null): void;
  /** Called once: `complete` = the response was relayed to the end. Never throws; the record is written async. */
  finish(complete: boolean): void;
}

export interface Prepared {
  /** What to send upstream first. */
  readonly body: Buffer;
  /** Headers to send with `body` when the rewrite changed them (e.g. a beta the target rejects); else undefined. */
  readonly headers?: IncomingHttpHeaders;
  /** True when `body` is a rewrite; server.ts then retries with the original bytes on a rejection. */
  readonly rewritten: boolean;
  readonly obs: Observation | null;
}

interface Pin {
  readonly target: { readonly tier: Tier; readonly model: string } | null;
  readonly from: Tier | null;
}
interface ConvState {
  pin: Pin | null;
  /** Tier that last served a new/continuation request of this conversation: where its prompt cache lives. */
  cacheTier: Tier | null;
  /** Prompt size (input + cache read + cache write) of that last response. */
  lastCtx: number | null;
  /** Sums over the responses after the first (whose cache write is the whole prompt): new tokens, output tokens, count. */
  sums: { write: number; output: number; n: number };
  /** REFLEX_EFFORT on Sonnet: the top-level level set on this conversation's first request, kept for all its requests. */
  topEffort: Effort | null;
  /** REFLEX_EFFORT: the level set on the conversation's first system message; put back if Claude Code rebuilds it. */
  effortFirst: Effort | null;
}
interface SessionState {
  readonly shape: ShapeTracker;
  /** Wire-format alarm only; deliberately not consulted by `routing` (src/wire/drift.ts). */
  readonly drift: DriftTracker;
  /** `!tier` from the latest user-typed main-chat turn; subagents capture it at their first request. */
  turnOverride: Tier | null;
  readonly disabledUntil: Map<Tier, number>;
  readonly convs: Map<string, ConvState>;
  /** A request carrying an effort change was rejected: no new level is set in this session (added ones are kept). */
  effortOff: boolean;
  /** The model the main chat last asked for on a turn of its own: a subagent asking for another tier was given it. */
  mainModel: string | null;
}

type DecisionPart = Pick<DecisionRecord, "decision" | "plan" | "error" | "sent" | "backend" | "guard" | "override" | "escalation" | "would_escalate" | "ab" | "effort">;
interface Outcome {
  readonly part: DecisionPart;
  /** Where route mode sends this turn; null = the requested model. */
  readonly target: { readonly tier: Tier; readonly model: string } | null;
  readonly reasons: ReasonCode[];
}

const SEVERITY: Readonly<Record<VersionLevel, number>> = { ok: 0, warn: 1, degrade: 2 };
const NONE: DecisionPart = { decision: null, plan: null, error: null, sent: null, backend: null, guard: null, override: null, escalation: null, would_escalate: null, ab: null };
const quotaRecord = (q: Quota): NonNullable<DecisionRecord["quota"]> => Object.fromEntries(Object.entries(q).map(([w, x]) => [w, { util: x.util, reset: x.reset }]));
const guardRecord = (g: GuardResult | null): DecisionPart["guard"] => (g ? { allowed: g.allowed, reason: g.reason, ctx: g.ctx, penalty_usd: g.penaltyUsd, saving_usd: g.savingUsd } : null);

export class Router {
  readonly #sessions = new Map<string, SessionState>();
  /**
   * Per conversation, the escalation an outcome signal raised. Conversation keys already embed the session id, so one
   * flat map is enough. In memory only: a worker restart drops every escalation, which is the right fail-open
   * behaviour.
   */
  readonly #escalations = new Map<string, EscalationState>();
  #uaDegrade: string | null = null;
  #uaChecked = false;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(private readonly d: RouterDeps) {
    this.#now = d.now ?? Date.now;
    this.#newId = d.newId ?? (() => crypto.randomUUID());
  }

  /** True when this worker classifies traffic at all. */
  static active(mode: EffectiveMode): boolean {
    return mode === "shadow" || mode === "route";
  }

  /**
   * The outcome tracker's escalation channel (src/outcome/tracker.ts). Never throws; ignored entirely unless
   * REFLEX_ESCALATE=1, so with the setting off this is exactly as record-only as before. A correction has to reach
   * the configured threshold; the other two signals are already binary.
   */
  onEscalationSignal(e: EscalationEvent): void {
    try {
      const cfg = this.d.config;
      if (cfg.escalate === "off") return;
      if (e.signal === "correction" && (e.score === null || e.score < cfg.escalateThreshold)) return;
      this.#escalations.set(e.conv, raise(this.#escalations.get(e.conv) ?? null, e, cfg.escalateWindowTurns));
    } catch {
      // escalation is an optimisation; failing to record one must never affect a request
    }
  }

  /**
   * The escalation to apply to this main-chat `new` turn, or null. Consumes one turn of the conversation's escalation
   * lifetime whether or not there was anywhere to move to, so a signal cannot outlive its window by sitting on a
   * conversation whose pick is already at the requested tier.
   */
  #escalate(v: RequestView, kind: "main" | "subagent", pick: Tier, requested: Tier, ctx: number): { tier: Tier | null; state: EscalationState } | null {
    // Subagents are separate conversations with separate pins; a subagent failing says nothing about the main chat,
    // and side calls and pinned continuations never reach this method at all (only `turn === "new"` decides).
    if (kind !== "main" || v.convKey === null) return null;
    const state = this.#escalations.get(v.convKey);
    if (state === undefined) return null;
    const next = decay(state);
    if (next === null) this.#escalations.delete(v.convKey);
    else this.#escalations.set(v.convKey, next);
    // The state is returned even with nowhere to move the tier: it still keeps this turn's effort at the client's level.
    return { tier: escalatedTier(pick, requested, this.d.config.escalateTarget, this.d.config, ctx), state };
  }

  #session(v: RequestView): SessionState {
    const key = v.sessionId ?? "";
    let s = this.#sessions.get(key);
    if (!s) {
      s = { shape: new ShapeTracker(this.d.config.shapeCheckN), drift: new DriftTracker(), turnOverride: null, disabledUntil: new Map(), convs: new Map(), effortOff: false, mainModel: null };
      this.#sessions.set(key, s);
    }
    return s;
  }

  #conv(s: SessionState, key: string): ConvState {
    let c = s.convs.get(key);
    if (!c) {
      c = { pin: null, cacheTier: null, lastCtx: null, sums: { write: 0, output: 0, n: 0 }, topEffort: null, effortFirst: null };
      s.convs.set(key, c);
    }
    return c;
  }

  /** The user-agent names the client that actually talks to us; the more severe verdict wins. */
  #checkClientVersion(v: RequestView): void {
    if (this.#uaChecked || v.clientVersion === null) return;
    this.#uaChecked = true;
    const ua = assessVersion(v.clientVersion, TESTED_CLAUDE_VERSIONS);
    const launcher = assessVersion(this.d.claudeVersion, TESTED_CLAUDE_VERSIONS);
    if (ua.level === "degrade" && SEVERITY[ua.level] > SEVERITY[launcher.level] && !this.d.config.ignoreVersionCheck) this.#uaDegrade = `client_version:${ua.reason}`;
  }

  #tierDisabled(s: SessionState, t: Tier): boolean {
    const until = s.disabledUntil.get(t);
    return until !== undefined && this.#now() < until;
  }

  /** Never throws. Non-/v1/messages and unparseable requests get `obs: null` and are forwarded untouched. */
  async prepare(method: string, url: string, headers: IncomingHttpHeaders, body: Buffer): Promise<Prepared> {
    const untouched: Prepared = { body, rewritten: false, obs: null };
    try {
      if (!isMessagesRequest(method, url)) return untouched;
      const parsed = parseRequest(headers, body, this.d.typedPrompts, this.d.newestTypedPrompt);
      if (!parsed.ok) return untouched;
      return await this.#prepare(parsed.view, body, headers);
    } catch (e) {
      this.d.logger("error", `router: prepare failed: ${e instanceof Error ? e.message : String(e)}`);
      return untouched;
    }
  }

  async #prepare(v: RequestView, body: Buffer, headers: IncomingHttpHeaders): Promise<Prepared> {
    const started = this.#now();
    const at = new Date(started).toISOString();
    const id = this.#newId();
    this.#checkClientVersion(v);
    const s = this.#session(v);
    const violations = s.shape.observe(v);
    s.drift.observe(v);
    // A recognised main `new` turn consumes the newest typed prompt, so no later request can be promoted by it again.
    if (v.kind === "main" && v.turn === "new") this.d.claimTypedPrompt?.(v.sessionId);
    if (v.kind === "main" && v.turn !== "side" && v.requestedModel !== null) s.mainModel = v.requestedModel;
    // Alarm only: never an input to `routing` below. See src/wire/drift.ts.
    const drift: string[] = s.drift.check(this.d.typedPromptCount?.(v.sessionId) ?? 0, v);
    for (const r of drift) {
      const detail = r === "typed_prompts_without_new_turns" ? `typed prompts >= ${String(DRIFT_MIN_TYPED_PROMPTS)}, main new turns ${String(s.drift.newTurns)}` : r === "unseen_requested_model" ? `model ${String(v.requestedModel)}` : `max_tokens ${String(v.facts.maxTokens)}`;
      this.d.logger("warn", `router: wire drift: ${r} (${detail}). This Claude Code version may send shapes no fixture holds; routing is unaffected.`);
    }
    const routing = this.d.effectiveMode === "route" && s.shape.status !== "degraded" && this.#uaDegrade === null;
    const conv = v.convKey !== null && v.turn !== "side" ? this.#conv(s, v.convKey) : null;
    /** A side call's conversation, if this worker has seen it: read only, a side call never creates or moves state. */
    const sideConv = v.convKey !== null && v.turn === "side" ? (s.convs.get(v.convKey) ?? null) : null;
    const requestedTier = tierOfModel(v.requestedModel);
    // A pin belongs to the requested tier it was decided under. After the user switches models (/model) it is stale:
    // dropped, so this request goes to the new requested model and the next new turn decides afresh. Without this a
    // pinned subagent kept its old target, e.g. Opus while the user now asked for Sonnet (2.1.280 log, 2026-09-22).
    if (conv?.pin && conv.pin.from !== requestedTier) conv.pin = null;

    let outcomeP: Promise<Outcome> = Promise.resolve({ part: NONE, target: null, reasons: [] });
    /** REFLEX_COMPARE: set by #decide once the state is built; it never rejects and never delays the request. */
    const cmp: { p?: Promise<CompareBlock> } = {};
    /** How long this request waited for the backend before going upstream: route mode, `new` turns only (shadow decides off the critical path). */
    let decisionWaitMs = 0;
    let pinState: DecisionRecord["pin"] = null;
    let sendBody = body;
    let sendHeaders: IncomingHttpHeaders | undefined;
    let fields: readonly string[] = [];
    let sentModel = v.requestedModel;
    let extraReasons: ReasonCode[] = [];
    /** REFLEX_EFFORT: the level a decided new turn should run at (route mode); null = leave it. */
    let effortTarget: Effort | null = null;
    // Estimated context of this request: the larger of the last measured prompt size and the body-size estimate.
    const ctx = Math.max(conv?.lastCtx ?? 0, estimateTokens(body.length));
    /** A target whose context ceiling the request exceeds moves to the next enabled tier up (null: the requested model). */
    const fit = (t: { tier: Tier; model: string } | null): { tier: Tier; model: string } | null => {
      if (t === null || requestedTier === null || fitsContext(t.tier, ctx)) return t;
      extraReasons = [...extraReasons, "context_ceiling"];
      const up = clampUp(t.tier, this.d.config, requestedTier, ctx);
      return up !== null ? { tier: up, model: this.d.config.models[up] } : null;
    };
    /** Retargets body and beta header to `to`; false when the body cannot be rewritten. */
    const applyRetarget = (from: Tier, to: Tier, model: string): boolean => {
      // Every path that rewrites passes here, including a pin raised by the context ceiling: an unverified pair never goes out.
      if (!isVerifiedRetarget(from, to, v.requestedModel, model)) {
        extraReasons = [...extraReasons, "rewrite_unverified"];
        return false;
      }
      const r = retarget(body, { from, to, model });
      if (!r.ok) return false;
      const beta = headers["anthropic-beta"];
      const b = retargetBetas(typeof beta === "string" ? beta : undefined, to);
      sendBody = r.body;
      fields = [...r.fields, ...b.stripped.map((x) => `anthropic-beta:-${x}`)];
      // Uncompressed, so the response's model can be put back (ModelRestorer); the fallback resends the client's headers.
      sendHeaders = { ...headers, ...(b.stripped.length > 0 ? { "anthropic-beta": b.value } : {}), "accept-encoding": "identity" };
      sentModel = model;
      return true;
    };

    if (v.turn === "new") {
      outcomeP = this.#decide(v, s, conv, routing, ctx, cmp);
      if (routing) {
        const waitStarted = this.#now();
        let outcome = await this.#bounded(outcomeP);
        decisionWaitMs = this.#now() - waitStarted;
        // A decision that never arrived counts as a backend failure: a main-chat pin below the requested tier stays.
        const pinned = conv?.pin?.target;
        if (outcome.part.error === "decision_late" && v.kind === "main" && pinned && !this.#tierDisabled(s, pinned.tier)) {
          const reasons: ReasonCode[] = ["stay_pinned_backend_error"];
          outcome = { ...outcome, target: pinned, reasons, part: { ...outcome.part, plan: { target: null, would_route_to: null, routed_to: v.requestedModel, reasons, would_upgrade: false } } };
        }
        outcome = { ...outcome, target: fit(outcome.target) };
        if (conv) {
          conv.pin = { target: outcome.target, from: requestedTier };
          pinState = "set";
        }
        if (outcome.target && requestedTier && !applyRetarget(requestedTier, outcome.target.tier, outcome.target.model)) {
          if (!extraReasons.includes("rewrite_unverified")) extraReasons = ["rewrite_failed"];
          if (conv) conv.pin = { target: null, from: requestedTier };
        }
        effortTarget = outcome.part.effort?.target ?? null;
        outcomeP = Promise.resolve(outcome);
      }
    } else if (v.turn === "continuation" && conv) {
      pinState = conv.pin ? "hit" : "miss";
      let t = conv.pin?.target ?? null;
      if (routing && t && !fitsContext(t.tier, ctx)) {
        // The loop outgrew its tier: move the pin up for the rest of the loop.
        t = fit(t);
        conv.pin = { target: t, from: requestedTier };
      }
      if (routing && t && requestedTier && !this.#tierDisabled(s, t.tier) && !applyRetarget(requestedTier, t.tier, t.model) && !extraReasons.includes("rewrite_unverified")) extraReasons = ["rewrite_failed"];
    } else if (sideConv && followsPin(v)) {
      // Side calls that replay the conversation's history and whose answer belongs to it (a subagent's progress
      // summary, a tool-loop step with harness text, a task notification or subagent hand-back the chat answers): sent
      // where the loop runs, they read that loop's cache instead of writing a second one on the requested model, and
      // the conversation stays on one model. Never decided; the pin is only read, never moved.
      const t = sideConv.pin?.from === requestedTier ? (sideConv.pin?.target ?? null) : null;
      if (routing && t && requestedTier && !this.#tierDisabled(s, t.tier)) applyRetarget(requestedTier, t.tier, t.model);
    }

    // REFLEX_EFFORT (src/wire/effort.ts), after any retarget: `sentModel` is what goes upstream. Effort messages already
    // added to a conversation are re-inserted whatever the mode or the setting, because leaving one out edits the
    // history the model saw; a new level is only set on a decided turn in route mode. Side calls replay the same
    // history (a suggestion, a subagent's summary, a notification turn), so they get the marks too: without them the
    // prefix differs at the first changed message and the whole conversation's cache is written again.
    let effortAdded: EffortEdit["added"] = null;
    let effortApplied: "message" | "top-level" | null = null;
    let effortEdited = false;
    let effortSkip: "effort_midturn_off" | "effort_sonnet_main_chat" | null = null;
    const store = this.d.effortStore;
    const effortConv = conv ?? sideConv;
    if (conv || v.turn === "side") {
      // A subagent is one task, stated in its first request, so the level fits all of it. A main chat changes level
      // only with MIDTURN, turn by turn: a first-turn level alone would hold for the whole chat.
      const main = v.kind === "main";
      const decided = routing && this.d.config.effort && !s.effortOff ? effortTarget : null;
      const add = main && !this.d.config.effortMidturn ? null : decided;
      if (decided !== null && add === null) effortSkip = "effort_midturn_off";
      const via = effortVia(sentModel, v.facts.nonSystemMessages === 1);
      const me = messageEffort(sentModel);
      let e: EffortEdit | null = null;
      if (me && store) {
        // Only a main chat (MIDTURN) may insert; a subagent's level goes into its first request's own system message.
        e = withEffort(sendBody, (a) => store.get(a), via === "message" ? add : null, me.top, main, add === null ? (effortConv?.effortFirst ?? null) : null);
        effortAdded = e?.added ?? null;
      } else if (tierOfModel(sentModel) === "sonnet") {
        if (main && add !== null) effortSkip = "effort_sonnet_main_chat";
        else if (via === "top-level" && add !== null && conv) conv.topEffort = add;
        if (effortConv?.topEffort) e = withTopEffort(sendBody, effortConv.topEffort);
      }
      if (add !== null && via !== null && effortSkip === null && e?.insertRefused !== true) effortApplied = via;
      if (e && e.body !== sendBody) {
        sendBody = e.body;
        fields = [...fields, ...e.fields];
        effortEdited = true;
      }
    }

    let status: number | null = null;
    let msToHeaders: number | null = null;
    let upstreamFirstByteMs: number | null = null;
    /** Set just before the request is handed back for forwarding; the upstream clock starts here. */
    let forwardStarted = started;
    let tee: UsageTee | null = null;
    let finished = false;
    let refusalReleased = false;
    let fallbackStatus: number | null = null;
    let fallbackError: string | null = null;
    let quota: Quota | null = null;
    const rewritten = sendBody !== body;
    // An effort-only rewrite leaves the model alone: its rejection says nothing about a tier.
    const routedTier = rewritten && sentModel !== v.requestedModel ? tierOfModel(sentModel) : null;

    const obs: Observation = {
      headers: (st, h) => {
        status = st;
        // The model saw the added message only if the request went out as rewritten and was accepted.
        if (st === 200 && fallbackStatus === null && effortAdded && store) {
          store.add(effortAdded.anchor, effortAdded.effort, effortAdded.op);
          if (effortAdded.op === "set" && v.facts.nonSystemMessages === 1 && effortConv) effortConv.effortFirst = effortAdded.effort;
        }
        const arrived = this.#now();
        msToHeaders = arrived - started;
        upstreamFirstByteMs = arrived - forwardStarted;
        quota = parseQuota(h);
        if (quota !== null) this.d.onQuota?.(quota, arrived);
        const ct = h["content-type"];
        const ce = h["content-encoding"];
        tee = new UsageTee(typeof ct === "string" ? ct : undefined, typeof ce === "string" ? ce : undefined);
        const plain = (ce === undefined || ce === "identity") && h["content-length"] === undefined;
        const moved = fallbackStatus === null && v.requestedModel !== null && sentModel !== v.requestedModel;
        return st === 200 && moved && plain && usageFormat(typeof ct === "string" ? ct : undefined) === "sse" ? new ModelRestorer(v.requestedModel) : null;
      },
      tap: (chunk) => {
        tee?.write(chunk);
        // The model reflex moved this request to refused it. Claude Code answers a refusal by resending the turn, with a
        // note, to the model it asked for; the pin would send that to the refusing model again (2.1.284, Sonnet 5.5,
        // docs/wire-format.md §5.12). Released here, while the stream is still passing, so the resend finds it gone.
        if (!refusalReleased && routedTier !== null && fallbackStatus === null && tee?.stop?.reason === "refusal") {
          refusalReleased = true;
          if (conv) conv.pin = { target: null, from: requestedTier };
        }
      },
      fallback: (st, err) => {
        fallbackStatus = st;
        fallbackError = err;
        drift.push("rewrite_rejected");
        sentModel = v.requestedModel;
        // A request too large for the target says nothing about the tier: the size estimate let it through (dense text
        // has fewer bytes per token than the estimate assumes). Only this loop leaves the tier; its measured context,
        // recorded from the retry's usage, keeps the next turn off a tier it does not fit.
        if (routedTier && !isPromptTooLong(err)) s.disabledUntil.set(routedTier, this.#now() + TIER_DISABLE_MS);
        if (conv) conv.pin = { target: null, from: requestedTier }; // the rest of this loop stays on the requested model
        if (effortEdited) {
          s.effortOff = true;
          if (conv) conv.topEffort = null; // a top-level value is not history: dropping it is safe (added messages are not)
        }
      },
      finish: (complete) => {
        if (finished) return;
        finished = true;
        const usageP = tee ? tee.end(complete) : Promise.resolve({ usage: null, unknownReason: "no_response", stop: null });
        void Promise.all([outcomeP, usageP, cmp.p])
          .then(([outcome, u, compare]) => {
            if (conv && u.usage && status === 200) {
              if (conv.lastCtx !== null) {
                conv.sums.write += u.usage.input + u.usage.cacheCreate;
                conv.sums.output += u.usage.output;
                conv.sums.n++;
              }
              conv.cacheTier = tierOfModel(sentModel);
              conv.lastCtx = u.usage.input + u.usage.cacheRead + u.usage.cacheCreate;
            }
            const degraded = [this.d.degradedReason, this.#uaDegrade, s.shape.reason].filter(Boolean);
            const fingerprint = v.turn === "side" && v.sideKind === "unclassified" ? this.#fingerprint(v, headers, body) : undefined;
            const p = outcome.part.plan;
            const record: DecisionRecord = {
              v: 1,
              record: "decision",
              id,
              at,
              session: hashId(v.sessionId),
              conv: v.convKey,
              kind: v.kind,
              signal: v.signal,
              signals: v.signals,
              turn: v.turn,
              side_kind: v.sideKind,
              side_marker: v.sideMarker,
              ...(v.promptEncoding !== null ? { prompt_encoding: v.promptEncoding } : {}),
              // The backend names its own version in the answer (`decision.backendModel`); lifting it to the top level
              // is what lets the report group by it without reaching into the decision sub-object.
              backend_version: outcome.part.decision?.backendModel ?? null,
              ...(v.unclassifiedReason !== null ? { unclassified_reason: v.unclassifiedReason } : {}),
              ...(drift.length > 0 ? { drift: drift.join(",") } : {}),
              ...(v.interjection ? { interjection: true as const } : {}),
              entrypoint: v.entrypoint,
              mode_requested: this.d.config.mode,
              mode_effective: routing ? "route" : "shadow",
              degraded_reason: degraded.length > 0 ? degraded.join(";") : null,
              shape: { status: s.shape.status, violations: violations.map((x) => x.check) },
              claude_version: v.clientVersion ?? this.d.claudeVersion,
              cache_ttl_beta: v.facts.betaExtendedCacheTtl,
              cache_ttl: v.facts.cacheTtl,
              ...(quota !== null ? { quota: quotaRecord(quota) } : {}),
              requested: { model: v.requestedModel, tier: requestedTier, effort: v.requestedEffort },
              ...outcome.part,
              ...(outcome.part.effort ? { effort: { ...outcome.part.effort, via: fallbackStatus === null ? effortApplied : null, ...(effortSkip !== null ? { reasons: [...outcome.part.effort.reasons, effortSkip] } : {}) } } : {}),
              plan: p ? { ...p, routed_to: sentModel, reasons: [...p.reasons, ...extraReasons] } : extraReasons.length > 0 ? { target: null, would_route_to: null, routed_to: sentModel, reasons: extraReasons, would_upgrade: false } : null,
              pin: pinState,
              forwarded: { requested_model: v.requestedModel, model: sentModel, rewritten: rewritten && fallbackStatus === null, fields: rewritten ? fields : [], fallback: fallbackStatus !== null, fallback_status: fallbackStatus, fallback_error: fallbackError },
              upstream: { status, msToHeaders },
              timing: { decision_wait_ms: decisionWaitMs, decision_deadline_ms: decisionDeadlineMs(this.d.config), upstream_first_byte_ms: upstreamFirstByteMs },
              usage: u.usage ? { input: u.usage.input, output: u.usage.output, cache_read: u.usage.cacheRead, cache_create: u.usage.cacheCreate } : null,
              usage_unknown_reason: u.unknownReason,
              ...(u.stop?.reason === "refusal" ? { refusal: { category: u.stop.category, pin_released: refusalReleased } } : {}),
              ...(fingerprint !== undefined ? { side_fingerprint: fingerprint } : {}),
              delegate_hint: this.d.config.delegate ? HINT_VERSION : null,
              // Only next to a decision of the primary backend: a comparison needs both sides.
              ...(compare !== undefined && outcome.part.decision !== null ? { compare } : {}),
            };
            const et = outcome.part.effort?.target ?? null;
            const effortLowered = fallbackStatus === null && effortApplied !== null && et !== null && EFFORTS.indexOf(et) < EFFORTS.indexOf(v.requestedEffort as Effort);
            this.d.onDecision?.({ id, at: started, sessionId: v.sessionId, agentId: v.agentId, kind: v.kind, turn: v.turn, sideKind: v.sideKind, interjection: v.interjection, conv: v.convKey, requestedModel: v.requestedModel, sentModel, effortLowered, taskHash: v.kind === "subagent" && v.task !== null ? hashId(v.task.trim()) : null });
            this.d.onRecord?.(record, v.sessionId);
            return this.d.log.append(record, v.turn === "new" ? v.task : null);
          })
          .catch((e: unknown) => this.d.logger("error", `router: record failed: ${e instanceof Error ? e.message : String(e)}`));
      },
    };
    forwardStarted = this.#now();
    return { body: sendBody, ...(sendHeaders ? { headers: sendHeaders } : {}), rewritten, obs };
  }

  /** Built after the response, off the request's path; a failure leaves the record without one. */
  #fingerprint(v: RequestView, headers: IncomingHttpHeaders, body: Buffer): SideFingerprint | null {
    try {
      return sideFingerprint(headers, body, this.d.typedPrompts?.(v.sessionId) ?? null, v.unclassifiedReason);
    } catch (e) {
      this.d.logger("warn", `router: fingerprint failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Route mode never waits longer than the backend deadline plus a small grace; a late decision fails open. */
  async #bounded(p: Promise<Outcome>): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ part: { ...NONE, error: "decision_late" }, target: null, reasons: [] }), decisionDeadlineMs(this.d.config) + DECISION_GRACE_MS);
    });
    try {
      return await Promise.race([p, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Always resolves. Only positively identified `new` turns of a known kind are decided. */
  /** REFLEX_COMPARE: Laya's feature vector for the same state. Never throws; an error is recorded as its category. */
  async #compare(laya: LayaBackend, state: DecisionState, questions: QuestionSet): Promise<CompareBlock> {
    const base = { backend: "laya" as const, model: this.d.config.layaModel, feature_version: FEATURE_VERSION };
    try {
      // LayaBackend waits for a laya-serve that is still loading; this is off the request's path anyway.
      const { decision, features } = await laya.decideWithFeatures(state, questions, { signal: new AbortController().signal });
      return { ...base, x: features, latency_ms: decision.latencyMs, error: features === null ? "incomplete" : null };
    } catch (e) {
      return { ...base, x: null, latency_ms: null, error: e instanceof BackendError ? e.kind : "internal" };
    }
  }

  async #decide(v: RequestView, s: SessionState, conv: ConvState | null, routing: boolean, ctx: number, cmp: { p?: Promise<CompareBlock> } = {}): Promise<Outcome> {
    const none = (part: Partial<DecisionPart> = {}, reasons: ReasonCode[] = []): Outcome => ({ part: { ...NONE, ...part }, target: null, reasons });
    if (v.kind === "unknown" || v.task === null) return none();
    const cfg = this.d.config;
    const kind = v.kind;
    const requested = tierOfModel(v.requestedModel);

    // Overrides: a main-chat turn sets (or clears) it; a subagent captures it at its first request.
    if (kind === "main") s.turnOverride = parseOverride(v.task);
    const override = s.turnOverride;
    const planRecord = (target: Tier | null, reasons: ReasonCode[], wouldUpgrade = false): DecisionPart["plan"] => ({
      target: target ? { tier: target } : null,
      would_route_to: target ? cfg.models[target] : null,
      routed_to: v.requestedModel,
      reasons,
      would_upgrade: wouldUpgrade,
    });
    /** `policyTarget` is what the record shows as the plan's target; `candidate` is what may actually be routed. */
    const finalize = (policyTarget: Tier | null, candidate: Tier | null, reasons: ReasonCode[], part: Partial<DecisionPart>, g: GuardResult | null): Outcome => {
      let routeTo: Tier | null = candidate;
      const why = [...reasons];
      if (routeTo !== null && this.#tierDisabled(s, routeTo)) {
        why.push("tier_disabled");
        routeTo = null;
      }
      if (routeTo !== null && (requested === null || !isVerifiedRetarget(requested, routeTo, v.requestedModel, cfg.models[routeTo]))) {
        why.push("rewrite_unverified");
        routeTo = null;
      }
      return {
        part: { ...NONE, ...part, guard: guardRecord(g), override, plan: planRecord(policyTarget, why, part.plan?.would_upgrade ?? false) },
        target: routeTo !== null ? { tier: routeTo, model: cfg.models[routeTo] } : null,
        reasons: why,
      };
    };

    if (override !== null) {
      if (override === requested) return finalize(null, null, ["override", "same_tier"], {}, null);
      return finalize(override, override, ["override"], {}, null); // bypasses backend, confidence and the cost guard
    }
    // The Agent call named this subagent's model: a choice made on purpose, so it runs where it was sent.
    // A tier other than the main chat's comes from the Agent call or the agent's definition (`model:` frontmatter,
    // built-in agents): chosen as well, where the tool input alone cannot show it.
    const explicit = (this.d.explicitModel?.(v.sessionId, v.task) ?? null) !== null || (s.mainModel !== null && tierOfModel(s.mainModel) !== requested);
    if (kind === "subagent" && explicit) return none({ plan: planRecord(null, ["model_explicit"]) });
    if (kind === "main" && cfg.mainChat === "never") return none({ plan: planRecord(null, ["main_chat_disabled"]) });

    // The tier this main-chat conversation is pinned to now (its last decided target); the requested tier when it
    // has none. The guard only ever decides whether to LEAVE that tier for a cheaper one; a refusal keeps it.
    const current: Tier | null = kind === "main" && conv?.pin ? (conv.pin.target?.tier ?? requested) : requested;
    const belowRequested = current !== null && requested !== null && tierRank(current) < tierRank(requested);
    // A backend failure on a conversation pinned below the requested tier keeps the pin: the pin is a prior
    // decision, not an error path (tool-loop continuations stay pinned without the backend too). `reflex:<tier>`
    // leaves it. Everywhere else a failure forwards the request unchanged.
    const failed = (part: Partial<DecisionPart>): Outcome =>
      kind === "main" && belowRequested && current !== null ? finalize(null, current, ["stay_pinned_backend_error"], part, null) : none(part);

    // Main-chat cost guard, evaluated before the backend in route mode: a conversation still on the requested tier
    // skips the backend when even the cheapest enabled tier cannot pass. A conversation pinned below the requested
    // tier always asks (the answer may move it back up), and so does every conversation when upgrades are on (the
    // answer may move it above the requested tier; a downgrade still meets the guard after the decision).
    const fresh = v.facts.nonSystemMessages === 1;
    const guardFor = (to: Tier): GuardResult =>
      guard({ cacheTier: conv?.cacheTier ?? null, to, ctxTokens: conv?.lastCtx ?? null, ttl: v.facts.betaExtendedCacheTtl ? "1h" : "5m", fresh, maxPenaltyUsd: cfg.maxSwitchPenaltyUsd,
        perRequest: conv && conv.sums.n > 0 ? { write: conv.sums.write / conv.sums.n, output: conv.sums.output / conv.sums.n } : null, breakevenRequests: cfg.switchBreakevenRequests });
    // With REFLEX_EFFORT_MIDTURN on a model that takes the effort message the backend is asked anyway: every main-chat
    // turn's level can change without leaving the cache, and a tier move still meets the guard after the decision.
    const effortWanted = cfg.effort && cfg.effortMidturn && messageEffort(v.requestedModel) !== null;
    if (kind === "main" && routing && requested !== null && !belowRequested && cfg.upgrades === "off" && !effortWanted) {
      const cheapest = cfg.tiers.find((t) => tierRank(t) < tierRank(requested));
      if (cheapest === undefined) return none({ plan: planRecord(null, ["no_enabled_tier"]) });
      const pre = guardFor(cheapest);
      if (!pre.allowed) return none({ guard: guardRecord(pre), plan: planRecord(null, ["guard_blocked"]) });
    }

    const backend = this.d.backend;
    if (!backend) return failed({ error: "no_backend" });
    if (!this.d.breaker.closed) return failed({ backend: backend.id, error: "breaker_open" });
    let sent: DecisionPart["sent"] = null;
    try {
      const built = buildState({ kind, task: v.task, previousAssistantText: v.previousAssistantText, requestedModel: v.requestedModel }, cfg);
      sent = built.sent;
      const questions = buildQuestions(cfg);
      // Started alongside the primary backend, awaited only when the record is written (after the response).
      if (this.d.compare) cmp.p = this.#compare(this.d.compare, built.state, questions);
      const decision = await backend.decide(built.state, questions, { signal: new AbortController().signal });
      this.d.breaker.success();
      const j = judge(decision, cfg);
      if (!j.ok) return failed({ backend: backend.id, sent, error: `invalid_answer:${j.error}` });
      const p = plan({ kind, requestedModel: v.requestedModel, contextTokens: ctx }, j.judgement, cfg);
      const eff = cfg.effort ? effortPlan(j.judgement.vetoes["reasoning_demand"], v.requestedEffort, cfg.effortUp) : null;
      let effort: DecisionPart["effort"] = eff ? { ...eff, via: null } : undefined;
      const part: Partial<DecisionPart> = {
        backend: backend.id,
        sent,
        decision: {
          picks: { tier: { value: j.judgement.tier.value, confidence: j.judgement.tier.confidence, probabilities: j.judgement.tier.probabilities } },
          rule: j.judgement.rule,
          pick_mass: { value: j.judgement.readings.mass.value, above_mass: j.judgement.readings.mass.aboveMass },
          pick_argmax: { value: j.judgement.readings.argmax.value, confidence: j.judgement.readings.argmax.confidence },
          vetoes: j.judgement.vetoes,
          latencyMs: decision.latencyMs,
          tokensIn: decision.tokensIn,
          backendModel: decision.backendModel,
          connection: decision.connection,
        },
        plan: planRecord(p.target?.tier ?? null, [...p.reasons], p.wouldUpgrade),
      };
      let policyTarget = p.target?.tier ?? null;
      let candidate = policyTarget;
      const reasons = [...p.reasons];
      let escalation: DecisionPart["escalation"] = null;
      let wouldEscalate: DecisionPart["would_escalate"] = null;
      let ab: DecisionPart["ab"] = null;
      let g: GuardResult | null = null;
      if (kind === "main" && requested !== null && current !== null) {
        // Where the policy would put this turn; "no target" means "stay on the requested tier".
        let desired = policyTarget ?? requested;
        // Escalation, if any, is applied HERE: before the guard branch below, so it raises the floor the guard
        // evaluates against and never overrules the guard's own answer. It only ever moves `desired` up.
        const esc = this.#escalate(v, kind, desired, requested, ctx);
        // An escalated conversation's turn never runs below the client's effort level either (on, not shadow).
        if (esc !== null && cfg.escalate === "on" && effort?.target && EFFORTS.indexOf(effort.target) < EFFORTS.indexOf(v.requestedEffort as Effort)) {
          effort = { ...effort, target: v.requestedEffort as Effort, reasons: [...effort.reasons, "effort_escalated"] };
        }
        if (esc !== null && esc.tier !== null) {
          const block = { signal: esc.state.signal, from: desired, to: esc.tier, decision_id: esc.state.decisionId, turn_seq: esc.state.turnSeq };
          if (cfg.escalate === "shadow") {
            // Shadow: the same arithmetic, recorded and not applied. Section 13 can then price what escalation would
            // have cost before anyone turns it on, which is the only honest way to leave shadow.
            wouldEscalate = block;
          } else {
            escalation = block;
            reasons.push(`escalated:${esc.state.signal}`);
            desired = esc.tier;
            policyTarget = esc.tier;
          }
        }
        // REFLEX_AB, before the tier arithmetic: this turn is eligible for the randomised experiment only when the
        // conversation is ON the requested tier now and the policy wants to take it below. A conversation already
        // pinned below is not a control candidate - leaving it where it is would not put it on the requested model,
        // so it would be a control in name only. An escalated turn is already a treatment and is never randomised.
        // Both arms are tagged, because only turns that entered the randomisation may be compared with each other.
        const eligible = cfg.abFraction > 0 && escalation === null && current === requested && tierRank(desired) < tierRank(requested);
        if (eligible) ab = (this.d.random ?? Math.random)() < cfg.abFraction ? "control" : "routed";

        if (ab === "control") {
          // Held back on the requested model on purpose. No guard call: nothing is being moved.
          reasons.push("ab_control");
          candidate = null;
        } else if (tierRank(desired) > tierRank(current)) {
          // Moving up is never guarded: quality first, and the backend asked for more than the current tier.
          candidate = desired === requested ? null : desired;
          if (belowRequested) reasons.push("return_up");
        } else if (desired === current) {
          candidate = current === requested ? null : current;
          if (belowRequested) reasons.push("stay_pinned");
        } else {
          // Moving further down leaves the conversation's cache: the guard decides; a refusal keeps the current tier.
          g = guardFor(desired);
          if (!g.allowed) {
            reasons.push("guard_blocked");
            candidate = current === requested ? null : current;
            if (belowRequested) reasons.push("stay_pinned");
          }
        }
      }
      // REFLEX_EFFORT_AB: only a turn whose target differs from the client's level can be held back; an escalated one is
      // already decided. Both arms are tagged, since only turns that entered the randomisation compare.
      if (effort?.target && effort.target !== v.requestedEffort && !effort.reasons.includes("effort_escalated") && cfg.effortAbFraction > 0) {
        effort = (this.d.random ?? Math.random)() < cfg.effortAbFraction
          ? { ...effort, target: v.requestedEffort as Effort, reasons: [...effort.reasons, "effort_ab_control"], ab: "control" }
          : { ...effort, ab: "treated" };
      }
      return finalize(policyTarget, candidate, reasons, { ...part, escalation, would_escalate: wouldEscalate, ab, ...(effort ? { effort } : {}) }, g);
    } catch (e) {
      if (e instanceof BackendError) {
        if (e.kind !== "aborted") this.d.breaker.failure();
        return failed({ backend: backend.id, sent, error: e.status !== undefined ? `backend:${e.kind}:${e.status}` : `backend:${e.kind}` });
      }
      this.d.logger("error", `router: decision failed: ${e instanceof Error ? e.message : String(e)}`);
      return failed({ backend: backend.id, sent, error: "internal" });
    }
  }
}
