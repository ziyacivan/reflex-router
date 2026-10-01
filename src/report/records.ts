// Reading decisions.jsonl for `reflex report`. Tolerant on purpose: archived logs predate several fields (no `record` before
// M4, no pick_mass/pick_argmax/connection before the mass rule), so every field is optional and a bad line is counted, not fatal.
import fs from "node:fs";
import path from "node:path";
import { TIERS, type Tier } from "../config.js";
import { tierOfModel } from "../tiers.js";

export type J = Record<string, unknown>;
export const isObj = (v: unknown): v is J => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const tierOf = (v: unknown): Tier | null => (typeof v === "string" && (TIERS as readonly string[]).includes(v) ? (v as Tier) : null);
const at = (o: unknown, ...keys: string[]): unknown => keys.reduce<unknown>((cur, k) => (isObj(cur) ? cur[k] : undefined), o);

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreate: number;
}
export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheCreate;

export interface Dec {
  readonly id: string;
  readonly at: string;
  readonly atMs: number;
  readonly session: string | null;
  readonly conv: string | null;
  readonly kind: string;
  readonly turn: string;
  readonly sideKind: string | null;
  /** Marker id that named this side call; null on older records and on kinds recognised by shape. */
  readonly sideMarker: string | null;
  /** Which shape test produced an `unclassified` residual; null on records written before the field existed. */
  readonly unclassifiedReason: string | null;
  /** `new` turns: how the prompt arrived (`string`/`blocks`); null on older records and on non-new turns. */
  readonly promptEncoding: string | null;
  /** The arm of the removed REFLEX_AB (`control`/`routed`) on a record written while it ran; null otherwise. */
  readonly ab: string | null;
  /** The wire-format cross-check fired on this request (src/wire/drift.ts); null otherwise. */
  readonly drift: string | null;
  readonly modeRequested: string | null;
  readonly modeEffective: string | null;
  readonly degradedReason: string | null;
  readonly requestedModel: string | null;
  readonly requestedTier: Tier | null;
  readonly sentModel: string | null;
  readonly sentTier: Tier | null;
  /** The request was rewritten to another model and that rewrite was not rejected. */
  readonly routed: boolean;
  readonly fallback: boolean;
  readonly fallbackStatus: number | null;
  readonly fallbackError: string | null;
  readonly reasons: readonly string[];
  /** Tier the plan targeted (would-route in shadow, routed in route mode); null = stay on the requested model. */
  readonly planTier: Tier | null;
  /** Reached the backend and got an answer. */
  readonly decided: boolean;
  readonly appliedPick: Tier | null;
  readonly pickMass: Tier | null;
  readonly pickArgmax: { readonly value: Tier | null; readonly confidence: number | null } | null;
  readonly latencyMs: number | null;
  readonly connection: string | null;
  readonly guard: { readonly allowed: boolean; readonly reason: string; readonly penaltyUsd: number | null } | null;
  readonly error: string | null;
  readonly usage: Usage | null;
  readonly msToHeaders: number | null;
  /** From the `timing` block; null for records written before it existed. */
  readonly decisionWaitMs: number | null;
  readonly decisionDeadlineMs: number | null;
  readonly upstreamFirstByteMs: number | null;
  readonly claudeVersion: string | null;
  /** The request carried the `extended-cache-ttl` beta (1-hour cache writes allowed). null: older record, not logged. */
  readonly cacheTtlBeta: boolean | null;
  /** `cache_ttl`: the TTL the request's last cache breakpoint asked for. null: none, unknown, or an older record. */
  readonly cacheTtl: "5m" | "1h" | null;
  /** `side_fingerprint` of an unclassified side call, as logged (src/wire/fingerprint.ts); null when absent. */
  readonly fingerprint: J | null;
  /** Delegation hint version the session ran with (`delegate_hint`); null: off, or recorded before it existed. */
  readonly hint: string | null;
  /** Decision-backend version that answered (`backend_version`, e.g. `jev-1.13.0`); null: no backend call, or an older record. */
  readonly backendVersion: string | null;
  /** Set only on a turn REFLEX_ESCALATE raised (`escalation`); null everywhere else. */
  readonly escalation: EscalationRec | null;
  /** `REFLEX_ESCALATE=shadow`: what escalation would have done. Never set alongside `escalation`. */
  readonly wouldEscalate: EscalationRec | null;
  /** The client's effort level (`requested.effort`); null when it sent none. */
  readonly requestedEffort: string | null;
  /** REFLEX_EFFORT's decision on a new turn (`effort`); null with the setting off or on other requests. */
  readonly effort: EffortRec | null;
  /** From `forwarded.fields`: this request carried an effort message reflex added now, and how many it re-inserted. */
  readonly effortAdded: boolean;
  readonly effortReinserted: number;
  /** `quota`: the subscription windows the response reported (used fraction, reset epoch s); null when it carried none. */
  readonly quota: Readonly<Record<string, QuotaRec>> | null;
}

export interface QuotaRec {
  readonly util: number;
  readonly reset: number | null;
}

export interface EffortRec {
  readonly pick: string | null;
  readonly target: string | null;
  readonly via: string | null;
  readonly reasons: readonly string[];
  readonly ab: string | null;
}

export interface EscalationRec {
  readonly signal: string;
  readonly from: Tier | null;
  readonly to: Tier | null;
  readonly decisionId: string | null;
  readonly turnSeq: number | null;
}

export interface OutcomeRec {
  readonly at: string;
  readonly atMs: number;
  readonly decisionId: string | null;
  readonly scope: string;
  readonly edits: number;
  readonly testRuns: number;
  /** null: no next typed prompt to score. */
  readonly correctionScore: number | null;
  readonly testFailureAfterEdit: boolean;
  readonly revertedInWindow: boolean;
  readonly noDecisionReason: string | null;
  /** How the window was joined. `interjection` shares its decision with the turn that owns it, so such a window is
   * never counted inside a per-arm rate (it would inflate n and double-count the turn's edits). */
  readonly attribution: string | null;
}

export interface OutcomeUpdate {
  readonly atMs: number;
  readonly decisionId: string;
  readonly signal: string;
}

export interface Records {
  readonly decisions: readonly Dec[];
  readonly outcomes: readonly OutcomeRec[];
  readonly updates: readonly OutcomeUpdate[];
  /** Timestamps of `harness_injected` records. */
  readonly harnessInjected: readonly number[];
  /** `delegate_hint` records: a hint actually returned to Claude Code. */
  readonly hints: readonly { readonly atMs: number; readonly session: string | null; readonly version: string }[];
  readonly other: number;
  /** Lines not turned into a record: not valid JSON objects, plus every unterminated final line (below). */
  readonly skippedLines: number;
  /** Files whose last line has no newline yet: the worker may still be writing it, so it is skipped now and read by the next report. */
  readonly unterminatedLines: number;
  readonly sources: readonly string[];
}

const toEffort = (v: unknown): EffortRec | null => {
  if (!isObj(v)) return null;
  const r = v["reasons"];
  return { pick: str(v["pick"]), target: str(v["target"]), via: str(v["via"]), reasons: Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [], ab: str(v["ab"]) };
};

const toQuota = (v: unknown): Readonly<Record<string, QuotaRec>> | null => {
  if (!isObj(v)) return null;
  const out: Record<string, QuotaRec> = {};
  for (const [w, x] of Object.entries(v)) {
    const util = num(at(x, "util"));
    if (util !== null) out[w] = { util, reset: num(at(x, "reset")) };
  }
  return Object.keys(out).length === 0 ? null : out;
};

const toEscalation = (e: unknown): EscalationRec | null => {
  if (!isObj(e)) return null;
  const signal = str(e["signal"]);
  return signal === null ? null : { signal, from: tierOf(e["from"]), to: tierOf(e["to"]), decisionId: str(e["decision_id"]), turnSeq: num(e["turn_seq"]) };
};

/** One decision record as the report reads it; null when it is not one. */
export function toDec(o: J): Dec | null {
  const id = str(o["id"]);
  const atStr = str(o["at"]);
  const atMs = atStr === null ? NaN : Date.parse(atStr);
  if (id === null || atStr === null || Number.isNaN(atMs)) return null;
  const requestedModel = str(at(o, "requested", "model"));
  const sentModel = str(at(o, "forwarded", "model")) ?? requestedModel;
  const requestedTier = tierOf(at(o, "requested", "tier")) ?? tierOfModel(requestedModel);
  const sentTier = tierOfModel(sentModel);
  const fallback = at(o, "forwarded", "fallback") === true;
  const u = at(o, "usage");
  const usage = isObj(u) ? { input: num(u["input"]) ?? 0, output: num(u["output"]) ?? 0, cacheRead: num(u["cache_read"]) ?? 0, cacheCreate: num(u["cache_create"]) ?? 0 } : null;
  const d = at(o, "decision");
  const am = at(d, "pick_argmax");
  const g = at(o, "guard");
  const reasons = at(o, "plan", "reasons");
  const fl = at(o, "forwarded", "fields");
  const fields = Array.isArray(fl) ? fl.filter((f): f is string => typeof f === "string") : [];
  return {
    id,
    at: atStr,
    atMs,
    session: str(o["session"]),
    conv: str(o["conv"]),
    kind: str(o["kind"]) ?? "unknown",
    turn: str(o["turn"]) ?? "unknown",
    sideKind: str(o["side_kind"]),
    sideMarker: str(o["side_marker"]),
    unclassifiedReason: str(o["unclassified_reason"]),
    promptEncoding: str(o["prompt_encoding"]),
    ab: str(o["ab"]),
    drift: str(o["drift"]),
    modeRequested: str(o["mode_requested"]),
    modeEffective: str(o["mode_effective"]),
    degradedReason: str(o["degraded_reason"]),
    requestedModel,
    requestedTier,
    sentModel,
    sentTier,
    routed: at(o, "forwarded", "rewritten") === true && !fallback && sentTier !== null && requestedTier !== null && sentTier !== requestedTier,
    fallback,
    fallbackStatus: num(at(o, "forwarded", "fallback_status")),
    fallbackError: str(at(o, "forwarded", "fallback_error")),
    reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
    planTier: tierOf(at(o, "plan", "target", "tier")),
    decided: isObj(d),
    appliedPick: tierOf(at(d, "picks", "tier", "value")),
    pickMass: tierOf(at(d, "pick_mass", "value")),
    pickArgmax: isObj(am) ? { value: tierOf(am["value"]), confidence: num(am["confidence"]) } : null,
    latencyMs: num(at(d, "latencyMs")),
    connection: str(at(d, "connection")),
    guard: isObj(g) ? { allowed: g["allowed"] === true, reason: str(g["reason"]) ?? "unknown", penaltyUsd: num(g["penalty_usd"]) } : null,
    error: str(o["error"]),
    usage,
    msToHeaders: num(at(o, "upstream", "msToHeaders")),
    decisionWaitMs: num(at(o, "timing", "decision_wait_ms")),
    decisionDeadlineMs: num(at(o, "timing", "decision_deadline_ms")),
    upstreamFirstByteMs: num(at(o, "timing", "upstream_first_byte_ms")),
    claudeVersion: str(o["claude_version"]),
    cacheTtlBeta: typeof o["cache_ttl_beta"] === "boolean" ? o["cache_ttl_beta"] : null,
    cacheTtl: o["cache_ttl"] === "5m" || o["cache_ttl"] === "1h" ? o["cache_ttl"] : null,
    fingerprint: isObj(o["side_fingerprint"]) ? o["side_fingerprint"] : null,
    hint: str(o["delegate_hint"]),
    backendVersion: str(o["backend_version"]) ?? str(at(o, "decision", "backendModel")),
    escalation: toEscalation(at(o, "escalation")),
    wouldEscalate: toEscalation(at(o, "would_escalate")),
    requestedEffort: str(at(o, "requested", "effort")),
    effort: toEffort(at(o, "effort")),
    effortAdded: fields.includes("messages.effort_added"),
    effortReinserted: fields.reduce((n, f) => n + (f.startsWith("messages.effort_reinserted:") ? Number(f.slice("messages.effort_reinserted:".length)) || 0 : 0), 0),
    quota: toQuota(o["quota"]),
  };
}

function toOutcome(o: J): OutcomeRec | null {
  const atStr = str(o["at"]);
  const atMs = atStr === null ? NaN : Date.parse(atStr);
  if (atStr === null || Number.isNaN(atMs)) return null;
  const corr = at(o, "signals", "correction");
  return {
    at: atStr,
    atMs,
    decisionId: str(o["decision_id"]),
    scope: str(o["scope"]) ?? "main",
    edits: num(at(o, "counts", "edits")) ?? 0,
    testRuns: num(at(o, "counts", "test_runs")) ?? 0,
    correctionScore: isObj(corr) ? num(corr["score"]) : null,
    testFailureAfterEdit: at(o, "signals", "test_failure_after_edit", "detected") === true,
    revertedInWindow: at(o, "signals", "reverted_edit", "detected") === true,
    noDecisionReason: str(at(o, "no_decision", "reason")),
    attribution: str(o["attribution"]),
  };
}

/**
 * Parses JSONL text (one or more files' worth). Lines that are not JSON objects count in `skippedLines`. Records end in a
 * newline, so text after a file's last newline is a line still being written (a report run during a session): it is
 * skipped and counted, never parsed.
 */
export function parseRecords(texts: readonly { readonly source: string; readonly text: string }[]): Records {
  const decisions: Dec[] = [];
  const outcomes: OutcomeRec[] = [];
  const updates: OutcomeUpdate[] = [];
  const seen = new Set<string>();
  const harnessInjected: number[] = [];
  const hints: { atMs: number; session: string | null; version: string }[] = [];
  let other = 0;
  let skippedLines = 0;
  let unterminatedLines = 0;
  for (const { text } of texts) {
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    if (tail.trim() !== "") {
      skippedLines++;
      unterminatedLines++;
    }
    for (const line of lines) {
      if (line.trim() === "") continue;
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        skippedLines++;
        continue;
      }
      if (!isObj(o)) {
        skippedLines++;
        continue;
      }
      // The same record can sit in a live file and its archived copy; count it once.
      const id = str(o["id"]);
      if (id !== null) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const kind = str(o["record"]) ?? "decision";
      const atMs = Date.parse(str(o["at"]) ?? "");
      if (kind === "decision") {
        const d = toDec(o);
        if (d === null) skippedLines++;
        else decisions.push(d);
      } else if (kind === "outcome") {
        const r = toOutcome(o);
        if (r === null) skippedLines++;
        else outcomes.push(r);
      } else if (kind === "outcome_update") {
        const decisionId = str(o["decision_id"]);
        const signal = str(o["signal"]);
        if (decisionId !== null && signal !== null) updates.push({ atMs, decisionId, signal });
      } else if (kind === "harness_injected") harnessInjected.push(atMs);
      else if (kind === "delegate_hint") hints.push({ atMs, session: str(o["session"]), version: str(o["version"]) ?? "?" });
      else other++;
    }
  }
  return { decisions, outcomes, updates, harnessInjected, hints, other, skippedLines, unterminatedLines, sources: texts.map((t) => t.source) };
}

/** Keeps what happened at or after `fromMs`. Outcome joins still look decisions up in the unfiltered set (see `allDecisions`). */
export function sinceView(r: Records, fromMs: number): Records {
  return {
    ...r,
    decisions: r.decisions.filter((d) => d.atMs >= fromMs),
    outcomes: r.outcomes.filter((o) => o.atMs >= fromMs),
    updates: r.updates.filter((u) => u.atMs >= fromMs),
    harnessInjected: r.harnessInjected.filter((t) => t >= fromMs),
    hints: r.hints.filter((h) => h.atMs >= fromMs),
  };
}

/** `2h`, `30m`, `45s`, `7d`; null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const m = /^(\d+)\s*([smhd])$/i.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]!.toLowerCase() as "s" | "m" | "h" | "d"];
}

/** The live file, its rotations (.1 ... .N) and any explicitly named files, whichever exist. */
export function defaultLogFiles(home: string, keep = 5): string[] {
  const base = path.join(home, "decisions.jsonl");
  return [base, ...Array.from({ length: keep }, (_, i) => `${base}.${i + 1}`)].filter((f) => fs.existsSync(f));
}

export function readLogFiles(files: readonly string[]): { source: string; text: string }[] {
  return files.map((source) => ({ source, text: fs.readFileSync(source, "utf8") }));
}
