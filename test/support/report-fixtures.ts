// Synthetic decision-log records for the report tests. Shapes follow src/log/decision-log.ts and src/outcome/tracker.ts;
// nothing here comes from a real session.
export type Rec = Record<string, unknown>;

const T0 = Date.parse("2026-09-19T10:00:00.000Z");
export const at = (offsetSec: number): string => new Date(T0 + offsetSec * 1000).toISOString();

const MODEL = { haiku: "claude-haiku-4-5-20251001", sonnet: "claude-sonnet-5", opus: "claude-opus-5" } as const;
type T = keyof typeof MODEL;

export interface DecOpts {
  id: string;
  t: number;
  session?: string;
  conv?: string;
  kind?: "main" | "subagent" | "unknown";
  turn?: "new" | "continuation" | "side";
  side?: string | null;
  /** Marker id; defaults from `side` where unambiguous. `notification` has two (session_recap, task_notification). */
  sideMarker?: string | null;
  mode?: "shadow" | "route";
  degraded?: string | null;
  requested?: T;
  sent?: T;
  rewritten?: boolean;
  fallback?: { status: number; error: string | null } | null;
  /** Backend answer: [haiku, sonnet, opus] probabilities and confidence; omitted = no decision. */
  probs?: [number, number, number];
  confidence?: number;
  pickMass?: T;
  pickArgmax?: T;
  applied?: T;
  latency?: number;
  connection?: "new" | "reused" | null;
  planTier?: T | null;
  reasons?: string[];
  guard?: { allowed: boolean; reason: string; penalty: number | null } | null;
  error?: string | null;
  usage?: [number, number, number, number] | null;
  msToHeaders?: number;
  /** Route-mode decision wait (ms); default 0. */
  wait?: number;
  /** Omit the `timing` block, like a record written before it existed. */
  legacyTiming?: boolean;
  /** REFLEX_AB arm tag. */
  ab?: "control" | "routed" | null;
  /** `prompt_encoding` on a new turn. */
  promptEncoding?: "string" | "blocks" | "other";
  /** Delegation hint version on the record (`delegate_hint`). */
  hint?: string | null;
  /** Decision-backend version on the record; defaults to `jev-test` on a decided turn, null otherwise. */
  backendVersion?: string | null;
  /** Escalation block (REFLEX_ESCALATE), as the router writes it. */
  escalation?: { signal: "correction" | "test_failure" | "reverted_edit"; from: T; to: T; decisionId: string | null; turnSeq?: number } | null;
  /** REFLEX_ESCALATE=shadow: recorded, not applied. */
  wouldEscalate?: { signal: "correction" | "test_failure" | "reverted_edit"; from: T; to: T; decisionId: string | null; turnSeq?: number } | null;
  /** `quota` as the router writes it: per window, the used fraction and the reset (epoch s). */
  quota?: Record<string, { util: number; reset: number | null }>;
}

/** One `decision` record. */
export function dec(o: DecOpts): Rec {
  const requested = o.requested ?? "opus";
  const sent = o.sent ?? requested;
  const turn = o.turn ?? "new";
  const mode = o.mode ?? "route";
  const decided = o.probs !== undefined;
  const p = o.probs ?? [0, 0, 1];
  return {
    v: 1,
    record: "decision",
    id: o.id,
    at: at(o.t),
    session: o.session ?? "aaaaaaaaaaaaaaaa",
    conv: o.conv ?? "aaaaaaaaaaaaaaaa:m:0000000000000001",
    kind: o.kind ?? "main",
    signal: "none",
    signals: { header: false, s1: false, s2: false, s3: true },
    turn,
    side_kind: turn === "side" ? (o.side ?? "suggestion") : null,
    side_marker: turn === "side" ? (o.sideMarker ?? MARKER_OF[o.side ?? "suggestion"] ?? null) : null,
    entrypoint: "cli",
    mode_requested: mode,
    mode_effective: mode,
    degraded_reason: o.degraded ?? null,
    shape: { status: "verified", violations: [] },
    claude_version: "2.1.277",
    backend: "jev",
    ...(o.promptEncoding ? { prompt_encoding: o.promptEncoding } : {}),
    ab: o.ab ?? null,
    ...(o.hint !== undefined ? { delegate_hint: o.hint } : {}),
    backend_version: o.backendVersion === undefined ? (decided ? "jev-test" : null) : o.backendVersion,
    escalation: o.escalation ? { signal: o.escalation.signal, from: o.escalation.from, to: o.escalation.to, decision_id: o.escalation.decisionId, turn_seq: o.escalation.turnSeq ?? 1 } : null,
    would_escalate: o.wouldEscalate ? { signal: o.wouldEscalate.signal, from: o.wouldEscalate.from, to: o.wouldEscalate.to, decision_id: o.wouldEscalate.decisionId, turn_seq: o.wouldEscalate.turnSeq ?? 1 } : null,
    requested: { model: MODEL[requested], tier: requested, effort: "medium" },
    decision: decided
      ? {
          picks: { tier: { value: o.applied ?? o.pickMass ?? "opus", confidence: o.confidence ?? 0.9, probabilities: { haiku: p[0], sonnet: p[1], opus: p[2] } } },
          rule: "mass",
          pick_mass: { value: o.pickMass ?? "opus", above_mass: 0 },
          pick_argmax: { value: o.pickArgmax ?? o.pickMass ?? "opus", confidence: o.confidence ?? 0.9 },
          vetoes: { reasoning_demand: 1 },
          latencyMs: o.latency ?? 400,
          tokensIn: 1000,
          backendModel: "jev-test",
          connection: o.connection === undefined ? "reused" : o.connection,
        }
      : null,
    plan: turn === "new" ? { target: o.planTier === undefined ? (sent !== requested ? { tier: sent } : null) : o.planTier ? { tier: o.planTier } : null, would_route_to: null, routed_to: null, reasons: o.reasons ?? [], would_upgrade: false } : null,
    guard: o.guard ? { allowed: o.guard.allowed, reason: o.guard.reason, ctx: 50000, penalty_usd: o.guard.penalty } : null,
    override: null,
    pin: null,
    forwarded: {
      requested_model: MODEL[requested],
      model: MODEL[sent],
      rewritten: o.rewritten ?? sent !== requested,
      fields: [],
      fallback: o.fallback != null,
      fallback_status: o.fallback?.status ?? null,
      fallback_error: o.fallback?.error ?? null,
    },
    upstream: { status: 200, msToHeaders: o.msToHeaders ?? 900 },
    ...(o.legacyTiming ? {} : { timing: { decision_wait_ms: o.wait ?? 0, decision_deadline_ms: 1500, upstream_first_byte_ms: Math.max(0, (o.msToHeaders ?? 900) - (o.wait ?? 0)) } }),
    usage: o.usage === null ? null : o.usage ? { input: o.usage[0], output: o.usage[1], cache_read: o.usage[2], cache_create: o.usage[3] } : { input: 5, output: 200, cache_read: 40000, cache_create: 500 },
    usage_unknown_reason: null,
    ...(o.quota ? { quota: o.quota } : {}),
    error: o.error ?? null,
    sent: decided ? { keys: ["task", "context"], chars: 100 } : null,
  };
}

export interface OutOpts {
  id: string;
  t: number;
  decision: string | null;
  scope?: "main" | "subagent";
  edits?: number;
  testRuns?: number;
  score?: number | null;
  testFailure?: boolean;
  reverted?: boolean;
  noDecision?: string;
}

/** One `outcome` record. */
export function outcome(o: OutOpts): Rec {
  return {
    v: 1,
    record: "outcome",
    id: o.id,
    at: at(o.t),
    session: "aaaaaaaaaaaaaaaa",
    decision_id: o.decision,
    turn_id: "1111111111111111",
    turn_seq: 1,
    scope: o.scope ?? "main",
    agent: null,
    agent_type: null,
    attribution: "prompt_id",
    models: { requested: MODEL.opus, sent: MODEL.opus },
    window: { closed_by: "next_prompt", duration_ms: 1000, ms_to_last_stop: 900 },
    counts: { edits: o.edits ?? 0, bash: 0, bash_failures: 0, test_runs: o.testRuns ?? 0, test_failures: o.testFailure ? 1 : 0, injected_prompts: 0 },
    signals: {
      correction: o.score === null ? null : { score: o.score ?? 0, matched: [], prompt_chars: 20 },
      test_failure_after_edit: { detected: o.testFailure ?? false, runs: [] },
      reverted_edit: { detected: o.reverted ?? false, events: [] },
    },
    params: { heuristics_version: 1, revert_window_turns: 3, correction_window_chars: 300 },
    ...(o.decision === null ? { no_decision: { reason: o.noDecision ?? "no_wire_turn", nearest_wire: null } } : {}),
  };
}

export const update = (id: string, t: number, decision: string): Rec => ({ v: 1, record: "outcome_update", id, at: at(t), session: "aaaaaaaaaaaaaaaa", decision_id: decision, turn_id: "1111111111111111", turn_seq: 1, scope: "main", agent: null, signal: "reverted_edit", detail: { kind: "inverse_edit", file: "ffffffffffffffff", offset_turns: 1, detected_in_turn_seq: 2 } });

export const toJsonl = (records: readonly Rec[], extraLines: readonly string[] = []): string => [...records.map((r) => JSON.stringify(r)), ...extraLines].join("\n") + "\n";

/** A small session pair exercising every section: shadow turns, a routed main chat with a guard refusal, moves, a fallback, errors, a subagent, outcomes. */
export function mixed(): string {
  const S = "bbbbbbbbbbbbbbbb";
  const C = `${S}:m:0000000000000002`;
  const A = `${S}:a:0000000000000003`;
  const shadow: Rec[] = [
    dec({ id: "s1", t: 0, mode: "shadow", probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", latency: 1100, connection: "new", usage: [3, 100, 0, 60000], msToHeaders: 1500 }),
    dec({ id: "s2", t: 30, mode: "shadow", probs: [0.45, 0.55, 0], confidence: 0.3, pickMass: "sonnet", pickArgmax: "sonnet", planTier: "sonnet", latency: 700, connection: "reused" }),
    dec({ id: "s3", t: 60, mode: "shadow", probs: [0.7, 0.3, 0], confidence: 0.6, pickMass: "sonnet", pickArgmax: "haiku", planTier: "sonnet", latency: 650, connection: "reused" }),
    dec({ id: "s4", t: 90, mode: "shadow", probs: [0, 0.05, 0.95], pickMass: "opus", planTier: null, latency: 600, connection: "reused", reasons: ["same_tier"] }),
    dec({ id: "s5", t: 91, mode: "shadow", turn: "continuation", usage: [2, 50, 60000, 400] }),
    dec({ id: "s6", t: 92, mode: "shadow", turn: "side", side: "suggestion", usage: [2, 20, 70000, 1800] }),
    dec({ id: "s7", t: 93, mode: "shadow", turn: "side", side: "no_tools", usage: [1, 10, 0, 9000] }),
    dec({ id: "s8", t: 94, mode: "shadow", degraded: "claude_version:major_mismatch", turn: "new", usage: null }),
  ];
  const route: Rec[] = [
    dec({ id: "r1", t: 1000, session: S, conv: C, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", sent: "haiku", reasons: ["downgrade"], guard: { allowed: true, reason: "fresh", penalty: null }, latency: 420, wait: 430, msToHeaders: 1800, usage: [4, 300, 0, 63000] }),
    dec({ id: "r2", t: 1010, session: S, conv: C, turn: "continuation", sent: "haiku", usage: [4, 200, 63000, 7500], msToHeaders: 700 }),
    dec({ id: "r3", t: 1011, session: S, conv: C, turn: "side", side: "suggestion", usage: [2, 20, 61000, 10000] }),
    dec({ id: "r4", t: 1100, session: S, conv: C, probs: [0.1, 0.85, 0.05], pickMass: "sonnet", planTier: "sonnet", sent: "sonnet", reasons: ["return_up"], guard: { allowed: true, reason: "no_switch", penalty: 0 }, usage: [4, 300, 61000, 13400], wait: 410, msToHeaders: 1900 }),
    dec({ id: "r5", t: 1200, session: S, conv: C, probs: [0.9, 0.1, 0], pickMass: "haiku", planTier: null, sent: "opus", reasons: ["guard_blocked"], guard: { allowed: false, reason: "over_limit", penalty: 0.11 }, usage: [4, 100, 74000, 5900], wait: 405, msToHeaders: 800 }),
    dec({ id: "r6", t: 1300, session: S, conv: C, probs: [0, 0.2, 0.8], pickMass: "opus", planTier: null, reasons: ["same_tier"], guard: { allowed: true, reason: "no_switch", penalty: 0 }, usage: [4, 100, 74000, 200], wait: 402, msToHeaders: 1300 }),
    dec({ id: "r7", t: 1400, session: S, conv: C, kind: "main", guard: { allowed: false, reason: "ctx_unknown", penalty: null }, reasons: ["guard_blocked"], planTier: null, usage: [4, 100, 0, 70000], msToHeaders: 600 }),
    dec({ id: "r8", t: 1500, session: S, conv: C, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", sent: "opus", rewritten: false, fallback: { status: 400, error: "invalid_request_error: long context beta is not yet available" }, reasons: ["downgrade", "rewrite_failed", "tier_disabled"], guard: { allowed: true, reason: "within_limit", penalty: 0.004 }, usage: [4, 100, 0, 71000], wait: 401, msToHeaders: 2400 }),
    dec({ id: "r9", t: 1600, session: S, conv: C, error: "backend:timeout", reasons: [], planTier: null, usage: [4, 100, 74000, 300], wait: 1500, msToHeaders: 1700 }),
    dec({ id: "r10", t: 1700, session: S, conv: C, error: "breaker_open", reasons: [], planTier: null, usage: [4, 100, 74000, 300], msToHeaders: 950 }),
    dec({ id: "r11", t: 1750, session: S, conv: C, error: "decision_late", reasons: [], planTier: null, usage: [4, 100, 74000, 300], wait: 1740, msToHeaders: 2600 }),
    dec({ id: "r12", t: 1780, session: S, conv: C, legacyTiming: true, error: "backend:http:500", reasons: [], planTier: null, usage: [4, 100, 74000, 300], msToHeaders: 1100 }),
    dec({ id: "a1", t: 1800, session: S, conv: A, kind: "subagent", probs: [0.5, 0.5, 0], confidence: 0.3, pickMass: "sonnet", pickArgmax: "haiku", planTier: "sonnet", sent: "sonnet", reasons: ["downgrade"], usage: [3, 400, 0, 20000], wait: 415, msToHeaders: 1600 }),
    dec({ id: "a2", t: 1810, session: S, conv: A, kind: "subagent", turn: "continuation", sent: "sonnet", usage: [3, 400, 20000, 2000], msToHeaders: 600 }),
  ];
  const outcomes: Rec[] = [
    outcome({ id: "o1", t: 1050, decision: "r1", edits: 1, testRuns: 1, score: 0 }),
    outcome({ id: "o2", t: 1150, decision: "r4", edits: 2, testRuns: 1, testFailure: true, score: 0.8 }),
    outcome({ id: "o3", t: 1250, decision: "r5", edits: 1, score: 0 }),
    outcome({ id: "o4", t: 1350, decision: "r6", score: null }),
    outcome({ id: "o5", t: 1850, decision: "a1", scope: "subagent", edits: 1, score: null }),
    outcome({ id: "o6", t: 1900, decision: null, noDecision: "no_wire_turn", score: null }),
    update("u1", 1901, "r5"),
    { v: 1, record: "harness_injected", id: "h1", at: at(1902), session: S, decision_id: "s4", conv: C, reason: "no_user_prompt_submit" },
  ];
  return toJsonl([...shadow, ...route, ...outcomes], ["this line is not json", '{"v":1,"record":"future_record","id":"x1","at":"2026-09-19T10:00:00.000Z"}']);
}

/** A deterministic pseudo-random log of `n` decisions (and outcomes for some new turns). */
export function large(n: number): string {
  let seed = 12345;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const pickOf = (): T => (["haiku", "sonnet", "opus"] as const)[Math.floor(rnd() * 3)]!;
  const out: Rec[] = [];
  for (let i = 0; i < n; i++) {
    const conv = `cccccccccccccccc:m:${String(Math.floor(i / 8)).padStart(16, "0")}`;
    const r = rnd();
    const t = i * 20;
    if (r < 0.15) {
      const pick = pickOf();
      const routed = rnd() < 0.6 && pick !== "opus";
      out.push(dec({ id: `L${i}`, t, conv, session: "cccccccccccccccc", probs: pick === "haiku" ? [0.9, 0.1, 0] : pick === "sonnet" ? [0.1, 0.8, 0.1] : [0, 0.1, 0.9], pickMass: pick, pickArgmax: rnd() < 0.8 ? pick : pickOf(), planTier: pick === "opus" ? null : pick, sent: routed ? pick : "opus", latency: 300 + Math.floor(rnd() * 900), connection: rnd() < 0.8 ? "reused" : "new", msToHeaders: 600 + Math.floor(rnd() * 2000), usage: [4, 200, Math.floor(rnd() * 80000), Math.floor(rnd() * 20000)], guard: rnd() < 0.3 ? { allowed: rnd() < 0.5, reason: "over_limit", penalty: rnd() * 0.2 } : { allowed: true, reason: "fresh", penalty: null } }));
      if (rnd() < 0.7) out.push(outcome({ id: `LO${i}`, t: t + 10, decision: `L${i}`, edits: Math.floor(rnd() * 3), testRuns: Math.floor(rnd() * 2), score: rnd() < 0.8 ? (rnd() < 0.85 ? 0 : 0.8) : null, testFailure: rnd() < 0.1, reverted: rnd() < 0.05 }));
    } else if (r < 0.6) out.push(dec({ id: `L${i}`, t, conv, session: "cccccccccccccccc", turn: "continuation", sent: rnd() < 0.4 ? "haiku" : "opus", usage: [4, 100, Math.floor(rnd() * 80000), Math.floor(rnd() * 9000)], msToHeaders: 400 + Math.floor(rnd() * 800) }));
    else out.push(dec({ id: `L${i}`, t, conv, session: "cccccccccccccccc", turn: "side", side: (["suggestion", "no_tools", "notification"] as const)[Math.floor(rnd() * 3)]!, usage: [2, 30, Math.floor(rnd() * 80000), Math.floor(rnd() * 3000)] }));
  }
  return toJsonl(out);
}

/**
 * Shaped like the first real-work dogfood (docs/observations.md, Phase 2 entry): two shadow sessions, one user turn each,
 * judged opus, followed by long tool loops (20 and 23 continuations), no subagents, two unclassified side calls of
 * ~226k tokens each and three prompt suggestions. 50 requests, ~8.9M tokens. Synthetic numbers of that shape only.
 */
export function singleTurnLongLoop(): string {
  const out: Rec[] = [];
  const session = (s: string, t0: number, loop: number, extraSuggestion: boolean): void => {
    const conv = `${s}:m:0000000000000009`;
    const base = { session: s, conv, mode: "shadow" as const };
    out.push(dec({ ...base, id: `${s.slice(0, 2)}-new`, t: t0, probs: [0, 0.05, 0.95], confidence: 0.9, pickMass: "opus", planTier: null, reasons: ["same_tier"], usage: [5, 1500, 60000, 120000] }));
    for (let i = 0; i < loop; i++) out.push(dec({ ...base, id: `${s.slice(0, 2)}-c${i}`, t: t0 + 10 + i * 10, turn: "continuation", usage: [5, 900, 180000, 4000] }));
    out.push(dec({ ...base, id: `${s.slice(0, 2)}-u`, t: t0 + 20 + loop * 10, turn: "side", side: "unclassified", usage: [10, 300, 200000, 26000] }));
    for (let i = 0; i < (extraSuggestion ? 2 : 1); i++) out.push(dec({ ...base, id: `${s.slice(0, 2)}-s${i}`, t: t0 + 30 + loop * 10 + i, turn: "side", side: "suggestion", usage: [3, 50, 40000, 0] }));
  };
  session("d1d1d1d1d1d1d1d1", 0, 20, false);
  session("d2d2d2d2d2d2d2d2", 5000, 23, true);
  return toJsonl(out);
}

/**
 * A log shaped like the side-call traffic the routing estimate is about: one conversation whose routable side calls
 * cluster inside the 5-minute TTL (warm) with one long gap that goes cold, a second conversation routed DOWN and then
 * back up (the exposure case), and one non-routable kind that must be ignored.
 */
/** Default marker id per side kind, so a fixture need not spell it out; `notification` is ambiguous and must be given. */
const MARKER_OF: Readonly<Record<string, string | undefined>> = { suggestion: "suggestion", agent_summary: "agent_summary", compaction: "compaction", cross_session: "cross_session" };

export function sideCallLog(): string {
  const A = "conv-side-a";
  const B = "conv-exposed-b";
  const recs: Rec[] = [
    dec({ id: "a-new", t: 0, conv: A, turn: "new", usage: [10, 300, 0, 60_000] }),
    // three suggestion calls 60 s apart: the 2nd and 3rd are warm on a 5-minute TTL
    dec({ id: "a-s1", t: 60, conv: A, turn: "side", side: "suggestion", usage: [5, 40, 60_000, 800] }),
    dec({ id: "a-s2", t: 120, conv: A, turn: "side", side: "suggestion", usage: [5, 40, 61_000, 600] }),
    dec({ id: "a-s3", t: 180, conv: A, turn: "side", side: "suggestion", usage: [5, 40, 62_000, 600] }),
    // a notification 20 s later: warm, and it shares the conversation prefix with the suggestions
    dec({ id: "a-n1", t: 200, conv: A, turn: "side", side: "notification", sideMarker: "session_recap", usage: [2, 90, 63_000, 400] }),
    // 40 minutes later: past the 5-minute TTL, so this one is cold again
    dec({ id: "a-n2", t: 2600, conv: A, turn: "side", side: "notification", sideMarker: "task_notification", usage: [2, 90, 70_000, 500] }),
    // a small no_tools call: little prefix, the amortisation rule does not apply to it
    dec({ id: "a-t1", t: 2610, conv: A, turn: "side", side: "no_tools", usage: [4_000, 30, 2_000, 100] }),
    // never routable: must not appear in the estimate at all
    dec({ id: "a-x1", t: 2620, conv: A, turn: "side", side: "cross_session", usage: [5, 60, 64_000, 300] }),
    // conversation B: routed down, then back to the requested tier (an up-move paying a cold write)
    dec({ id: "b-new", t: 300, conv: B, turn: "new", sent: "haiku", rewritten: true, usage: [10, 200, 0, 45_000] }),
    dec({ id: "b-c1", t: 360, conv: B, turn: "continuation", sent: "haiku", rewritten: true, usage: [5, 150, 45_000, 900] }),
    dec({ id: "b-up", t: 420, conv: B, turn: "new", sent: "opus", usage: [10, 250, 1_000, 47_000] }),
  ];
  return toJsonl(recs);
}
