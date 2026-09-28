// The sections of `reflex report`. Each takes the normalised records and returns lines of text; the numbers a section
// computes that are worth testing on their own (moves, cost, outcome join) are exported. Pure, no I/O, no network.
import { TIERS, type Tier } from "../config.js";
import { DOWNGRADE_MIN_CONFIDENCE } from "../policy.js";
import { cacheReadRate, cacheWriteRate, LAST_VERIFIED, usageCostUsd, type CacheTtl } from "../pricing.js";
import { DECISION_GRACE_MS } from "../timing.js";
import { CONTEXT_CEILING, fitsContext, tierOfModel, tierRank } from "../tiers.js";
import { countBy, int, mean, median, ms, pct, percentile, sum, table, usd } from "./format.js";
import { num, totalTokens, type Dec, type OutcomeRec, type Records, type Usage } from "./records.js";

/** Below this many outcome windows in a group no rate is shown (docs/observations.md: a handful of turns says little). */
export const MIN_OUTCOME_N = 20;

export interface Ctx {
  /** The records in range. */
  readonly rec: Records;
  /** Every decision in the files, in range or not: outcome records are joined to their decision here. */
  readonly byId: ReadonlyMap<string, Dec>;
  readonly usd: boolean;
}

const NONE = ["  (no records)"];
const tierCols = (used: ReadonlySet<string>): string[] => [...TIERS.filter((t) => used.has(t)), ...(used.has("?") ? ["?"] : [])];
const tl = (t: Tier | null): string => t ?? "?";
const newTurns = (d: readonly Dec[]): Dec[] => d.filter((x) => x.turn === "new");
const tokens = (d: Dec): number => (d.usage ? totalTokens(d.usage) : 0);

/** Where a request's tokens count in the workflow profile. Anything not a positively identified turn or loop step is `side`, as in the classifier. */
export type WorkCategory = "new" | "continuation" | "subagent" | "side";
export const workCategory = (d: Dec): WorkCategory =>
  d.turn !== "new" && d.turn !== "continuation" ? "side" : d.kind === "subagent" ? "subagent" : d.turn;

/** The plan for this new turn put it below the requested tier (shadow: would have; route: before the cost guard), or it was sent there. */
const planMovesDown = (x: Dec): boolean =>
  x.requestedTier !== null && ((x.planTier !== null && tierRank(x.planTier) < tierRank(x.requestedTier)) || (x.routed && x.sentTier !== null && tierRank(x.sentTier) < tierRank(x.requestedTier)));

export interface WorkProfile {
  readonly requests: Readonly<Record<WorkCategory, number>>;
  readonly tokens: Readonly<Record<WorkCategory, number>>;
  readonly total: number;
  /** Work units: a new turn (main chat or subagent) and the continuations of its conversation up to the next new turn. */
  readonly units: number;
  readonly touchableUnits: number;
  /** New turns whose plan has no target and that never reached the backend (guard refusal before it, errors, no key). */
  readonly undecidedNew: number;
  /** Continuations with no new turn before them in the log (it started mid-loop): no unit, not touchable. */
  readonly orphanContinuations: number;
  /** Tokens of the units whose plan moved below the requested tier: the most any per-turn routing could have moved. */
  readonly touchable: number;
  readonly touchableSubagent: number;
}

/** Pure. Side calls are never rewritten, so they are never touchable; a loop is touchable when the turn that started it was. */
/** What each drift reason (src/wire/drift.ts) says, for section 1. */
const DRIFT_MEANING: Readonly<Record<string, string>> = {
  typed_prompts_without_new_turns: "the classifier found far fewer new turns than the user typed prompts",
  unseen_requested_model: "a requested model no fixture holds",
  unseen_max_tokens: "a max_tokens value no fixture holds",
  rewrite_rejected: "the upstream rejected a rewritten request (the original bytes were sent instead)",
};

export function workProfile(d: readonly Dec[]): WorkProfile {
  const requests: Record<WorkCategory, number> = { new: 0, continuation: 0, subagent: 0, side: 0 };
  const tok: Record<WorkCategory, number> = { new: 0, continuation: 0, subagent: 0, side: 0 };
  for (const x of d) {
    requests[workCategory(x)]++;
    tok[workCategory(x)] += tokens(x);
  }
  const byConv = new Map<string, Dec[]>();
  for (const x of d) {
    if (workCategory(x) === "side") continue;
    const k = x.conv ?? `\u0000${x.id}`; // no conversation key: the request is a unit (or an orphan) on its own
    byConv.set(k, [...(byConv.get(k) ?? []), x]);
  }
  let units = 0;
  let touchableUnits = 0;
  let undecidedNew = 0;
  let orphanContinuations = 0;
  let touchable = 0;
  let touchableSubagent = 0;
  for (const list of byConv.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let unit: boolean | null = null; // null: no new turn seen yet in this conversation
    for (const x of list) {
      if (x.turn === "new") {
        units++;
        unit = planMovesDown(x);
        if (unit) touchableUnits++;
        if (!x.decided && x.planTier === null) undecidedNew++;
      } else if (unit === null) orphanContinuations++;
      if (unit) {
        touchable += tokens(x);
        if (x.kind === "subagent") touchableSubagent += tokens(x);
      }
    }
  }
  return { requests, tokens: tok, total: sum(Object.values(tok)), units, touchableUnits, undecidedNew, orphanContinuations, touchable, touchableSubagent };
}

/** Shown per session before the list is cut. */
const MAX_SESSION_ROWS = 20;
/** Below this many sessions on either side the delegation comparison says so. */
export const MIN_DELEGATION_SESSIONS = 5;
const HINT_OFF = "off";

export interface HintArm {
  /** Hint version, or "off" (REFLEX_DELEGATE off, or records from before it existed). */
  readonly hint: string;
  readonly sessions: number;
  /** `delegate_hint` records: hints actually returned to Claude Code in these sessions. */
  readonly delivered: number;
  readonly userTurns: number;
  readonly tokens: number;
  readonly usdAtSent: number;
  readonly subagentTokens: number;
  readonly sideTokens: number;
}

/** Sessions grouped by the delegation hint their decision records carry; all their requests, side calls included. */
export function hintArms(rec: Records): HintArm[] {
  const bySession = new Map<string, Dec[]>();
  for (const x of rec.decisions) bySession.set(x.session ?? "?", [...(bySession.get(x.session ?? "?") ?? []), x]);
  const arms = new Map<string, { sessions: Set<string>; d: Dec[] }>();
  for (const [s, v] of bySession) {
    const hint = v.find((x) => x.hint !== null)?.hint ?? HINT_OFF;
    const a = arms.get(hint) ?? { sessions: new Set<string>(), d: [] };
    a.sessions.add(s);
    a.d.push(...v);
    arms.set(hint, a);
  }
  return [...arms.entries()]
    .map(([hint, a]) => {
      const p = workProfile(a.d);
      return {
        hint,
        sessions: a.sessions.size,
        delivered: rec.hints.filter((h) => a.sessions.has(h.session ?? "?")).length,
        userTurns: p.requests.new,
        tokens: p.total,
        usdAtSent: costOf(a.d).atSentUsd,
        subagentTokens: p.tokens.subagent,
        sideTokens: p.tokens.side,
      };
    })
    .sort((a, b) => (a.hint === HINT_OFF ? -1 : b.hint === HINT_OFF ? 1 : a.hint.localeCompare(b.hint)));
}
const perTurn = (v: number, turns: number): number | null => (turns === 0 ? null : v / turns);

/** 0. Workflow profile: where the tokens go, and how much of them per-turn routing could reach at all. */
export function s0Workflow({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const sessions = new Map<string, Dec[]>();
  for (const x of [...d].sort((a, b) => a.atMs - b.atMs)) sessions.set(x.session ?? "?", [...(sessions.get(x.session ?? "?") ?? []), x]);
  const userTurns = (v: readonly Dec[]): number => v.filter((x) => workCategory(x) === "new").length;
  const perSession = [...sessions.values()].map(userTurns);
  const out = [
    "  tokens = input + output + cache read + cache write of each classified request; each request counts once",
    `  ${sessions.size} session${sessions.size === 1 ? "" : "s"}; user turns (main-chat new turns) per session: p50 ${int(median(perSession))}, max ${int(Math.max(...perSession))}`,
    ...table([
      ["session", "user turns", "subagent runs", "requests", "tokens"],
      ...[...sessions.entries()].slice(0, MAX_SESSION_ROWS).map(([s, v]) => [s.slice(0, 8), String(userTurns(v)), String(v.filter((x) => x.kind === "subagent" && x.turn === "new").length), String(v.length), int(sum(v.map(tokens)))]),
    ], "    "),
  ];
  if (sessions.size > MAX_SESSION_ROWS) out.push(`    ... ${sessions.size - MAX_SESSION_ROWS} more session(s)`);
  const p = workProfile(d);
  const label: Record<WorkCategory, string> = {
    new: "(a) new turns, main chat",
    continuation: "(b) tool-loop continuations, main chat",
    subagent: "(c) subagents (first request and loop)",
    side: "(d) side calls",
  };
  out.push("", "  where the tokens went:", ...table([
    ["category", "requests", "tokens", "% tokens"],
    ...(["new", "continuation", "subagent", "side"] as const).map((c) => [label[c], String(p.requests[c]), int(p.tokens[c]), pct(p.tokens[c], p.total)]),
    ["total", String(d.length), int(p.total), pct(p.total, p.total)],
  ], "    "));
  out.push(`  work units (a new turn and its continuations): ${p.units}; ${p.touchableUnits} with a plan below the requested tier (ignoring the cost guard)${p.undecidedNew > 0 ? `; ${p.undecidedNew} new turn(s) without a decision count as not touchable` : ""}${p.orphanContinuations > 0 ? `; ${p.orphanContinuations} continuation(s) before any new turn count as not touchable` : ""}`);
  const arms = hintArms(rec);
  out.push("", `  by delegation hint (REFLEX_DELEGATE; "${HINT_OFF}" = not set or recorded before it existed); $ = the tokens at the sent model's list price, an estimate (section 8):`, ...table([
    ["hint", "sessions", "hints delivered", "user turns", "tokens", "tokens per user turn", "$ at sent", "$ per user turn", "subagent share", "side-call share"],
    ...arms.map((a) => [a.hint, String(a.sessions), a.hint === HINT_OFF ? "-" : String(a.delivered), String(a.userTurns), int(a.tokens), int(perTurn(a.tokens, a.userTurns)), usd(a.usdAtSent), a.userTurns === 0 ? "-" : usd(a.usdAtSent / a.userTurns), pct(a.subagentTokens, a.tokens), pct(a.sideTokens, a.tokens)]),
  ], "    "));
  out.push(`  routing can touch at most ${pct(p.touchable, p.total)} of your tokens; ${pct(p.touchableSubagent, p.touchable)} of that is in subagents`);
  return out;
}

/** 1. Decisions by kind, turn and tier (requested -> sent), mode and degraded reasons. */
export function s1Decisions({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const out: string[] = [`  ${d.length} classified requests`];
  const turns = ["new", "continuation", "side", "unknown"].filter((t) => d.some((x) => x.turn === t));
  const kinds = [...new Set(d.map((x) => x.kind))].sort();
  out.push("", "  by kind and turn:", ...table([["kind", ...turns], ...kinds.map((k) => [k, ...turns.map((t) => String(d.filter((x) => x.kind === k && x.turn === t).length))])], "    "));
  // How typed prompts arrived on the wire, split by the delegation hint. The hint is appended to the trailing
  // role:"system" message, not to the user's own message, so it should not move these counts at all - and that is
  // exactly the claim worth being able to check from a log rather than argue about.
  const newTurnsMain = d.filter((x) => x.kind === "main" && x.turn === "new");
  const encoded = newTurnsMain.filter((x) => x.promptEncoding !== null);
  if (encoded.length > 0) {
    const hints = [...new Set(newTurnsMain.map((x) => x.hint ?? HINT_OFF))].sort();
    const encs = [...new Set(encoded.map((x) => x.promptEncoding!))].sort();
    out.push(
      "",
      "  main-chat new turns by prompt encoding (2.1.277 sent every typed prompt as blocks; 2.1.278 sends plain strings too):",
      ...table([
        ["delegation hint", ...encs, "not recorded"],
        ...hints.map((h) => {
          const rows = newTurnsMain.filter((x) => (x.hint ?? HINT_OFF) === h);
          return [h, ...encs.map((e) => String(rows.filter((x) => x.promptEncoding === e).length)), String(rows.filter((x) => x.promptEncoding === null).length)];
        }),
      ], "    "),
    );
  }
  const sides = countBy(d.filter((x) => x.turn === "side"), (x) => x.sideKind ?? "unknown");
  if (sides.length > 0) out.push("", `  side calls by kind: ${sides.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const used = new Set(d.flatMap((x) => [tl(x.requestedTier), tl(x.sentTier)]));
  const cols = tierCols(used);
  out.push("", "  tier, requested (rows) -> sent (columns):", ...table([["requested", ...cols], ...cols.map((r) => [r, ...cols.map((c) => String(d.filter((x) => tl(x.requestedTier) === r && tl(x.sentTier) === c).length))])], "    "));
  out.push("", `  mode requested -> effective: ${countBy(d, (x) => `${x.modeRequested ?? "?"} -> ${x.modeEffective ?? "?"}`).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const deg = countBy(d.filter((x) => x.degradedReason !== null), (x) => x.degradedReason!);
  out.push(`  degraded: ${deg.length === 0 ? "none" : deg.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  // Drift is an alarm about the classifier, not a routing state: it never degrades a session (src/wire/drift.ts).
  // One record may carry several reasons, comma-separated.
  const drift = countBy(d.flatMap((x) => (x.drift ?? "").split(",").filter(Boolean).map((r) => ({ r }))), (x) => x.r);
  out.push(`  drift: ${drift.length === 0 ? "none" : `${drift.map(([k, n]) => `${k} ${n}`).join(", ")} - routing was not changed, but this build may not recognise this Claude Code version`}`);
  for (const [k] of drift) if (DRIFT_MEANING[k]) out.push(`    ${k}: ${DRIFT_MEANING[k]}`);
  return out;
}

/** Label for a record with no `backend_version` (older logs, or no backend call). */
export const BACKEND_VERSION_UNKNOWN = "not recorded";

/**
 * Per decision-backend version, how often mass and argmax agreed. Calibration has to be splittable by version: the
 * backend's answers are the input to every threshold, so two versions are two populations. Printed only when the
 * records actually carry a version, so logs written before the field existed read exactly as they did.
 */
export function byBackendVersion(decided: readonly Dec[], heading: string): string[] {
  const versions = countBy(decided, (x) => x.backendVersion ?? BACKEND_VERSION_UNKNOWN);
  if (versions.length === 0 || (versions.length === 1 && versions[0]![0] === BACKEND_VERSION_UNKNOWN)) return [];
  const rows = versions.map(([ver, n]) => {
    const d = decided.filter((x) => (x.backendVersion ?? BACKEND_VERSION_UNKNOWN) === ver);
    const agree = d.filter((x) => x.pickMass !== null && x.pickArgmax?.value != null && x.pickMass === x.pickArgmax.value).length;
    return [ver, String(n), String(agree), pct(agree, n)];
  });
  return ["", heading, ...table([["backend version", "new turns", "agree", "% agree"], ...rows], "    ")];
}

/** What a rule would route to, given the requested tier: never above it (upgrades are off by default) and, for argmax, only down with enough confidence. */
export function wouldRoute(rule: "mass" | "argmax", d: Dec): Tier | null {
  if (d.requestedTier === null) return null;
  const pick = rule === "mass" ? d.pickMass : d.pickArgmax && (d.pickArgmax.confidence ?? 0) >= DOWNGRADE_MIN_CONFIDENCE ? d.pickArgmax.value : d.requestedTier;
  if (pick === null) return null;
  return tierRank(pick) < tierRank(d.requestedTier) ? pick : d.requestedTier;
}

/** 2. mass vs argmax: agreement matrix and what each rule would have routed. */
export function s2MassVsArgmax({ rec }: Ctx): string[] {
  const decided = newTurns(rec.decisions).filter((x) => x.decided);
  if (decided.length === 0) return NONE;
  const both = decided.filter((x) => x.pickMass !== null && x.pickArgmax?.value != null);
  const out = [`  ${decided.length} new turns reached the backend; ${both.length} log both readings (older records log only the applied pick)`];
  if (both.length === 0) return out;
  const cols = tierCols(new Set(both.flatMap((x) => [tl(x.pickMass), tl(x.pickArgmax!.value)])));
  out.push("", "  agreement, mass pick (rows) x argmax pick (columns):", ...table([["mass \\ argmax", ...cols], ...cols.map((r) => [r, ...cols.map((c) => String(both.filter((x) => tl(x.pickMass) === r && tl(x.pickArgmax!.value) === c).length))])], "    "));
  const agree = both.filter((x) => x.pickMass === x.pickArgmax!.value).length;
  out.push(`  agree on ${agree} of ${both.length} (${pct(agree, both.length)})`);
  const routable = both.filter((x) => x.requestedTier !== null);
  const rows = (["mass", "argmax"] as const).map((rule) => {
    const w = routable.map((x) => wouldRoute(rule, x)!);
    return [rule, ...TIERS.filter((t) => routable.some((x) => wouldRoute("mass", x) === t || wouldRoute("argmax", x) === t)).map((t) => String(w.filter((v) => v === t).length)), String(routable.filter((x) => tierRank(wouldRoute(rule, x)!) < tierRank(x.requestedTier!)).length)];
  });
  const tiersShown = TIERS.filter((t) => routable.some((x) => wouldRoute("mass", x) === t || wouldRoute("argmax", x) === t));
  out.push("", `  what each rule would route to (n=${routable.length}; ignores guard, veto and context ceiling; argmax moves down only at confidence >= ${DOWNGRADE_MIN_CONFIDENCE}):`, ...table([["rule", ...tiersShown, "moved down"], ...rows], "    "));
  const massLower = routable.filter((x) => tierRank(wouldRoute("mass", x)!) < tierRank(wouldRoute("argmax", x)!)).length;
  const argmaxLower = routable.filter((x) => tierRank(wouldRoute("argmax", x)!) < tierRank(wouldRoute("mass", x)!)).length;
  out.push(`  they differ on ${massLower + argmaxLower}: mass routes lower on ${massLower}, argmax on ${argmaxLower}`);
  out.push(...byBackendVersion(both, "  agreement by backend version (a rate measured across versions is two measurements added together):"));
  return out;
}

/** 3. Shadow vs actual: requested tier x would-route tier with the share of tokens, and requested vs sent model for routed records. */
export function s3ShadowVsActual({ rec }: Ctx): string[] {
  const decided = newTurns(rec.decisions).filter((x) => x.decided && x.requestedTier !== null);
  const out: string[] = [];
  if (decided.length === 0) out.push(...NONE);
  else {
    const totalTok = sum(decided.map(tokens));
    const cells = new Map<string, Dec[]>();
    for (const x of decided) {
      const k = `${x.requestedTier}\u0000${tl(x.planTier ?? x.requestedTier)}`;
      cells.set(k, [...(cells.get(k) ?? []), x]);
    }
    const rows = [...cells.entries()]
      .map(([k, v]) => ({ req: k.split("\u0000")[0]!, would: k.split("\u0000")[1]!, v }))
      .sort((a, b) => tierRank(a.req as Tier) - tierRank(b.req as Tier) || TIERS.indexOf(a.would as Tier) - TIERS.indexOf(b.would as Tier));
    out.push(`  new turns that reached the backend (n=${decided.length}); tokens = input + output + cache read + cache write of that turn's own request`, ...table([
      ["requested", "would route to", "turns", "% turns", "% tokens", "actually sent there"],
      ...rows.map((r) => [r.req, r.would, String(r.v.length), pct(r.v.length, decided.length), pct(sum(r.v.map(tokens)), totalTok), String(r.v.filter((x) => tl(x.sentTier) === r.would).length)]),
    ], "    "));
  }
  const routed = rec.decisions.filter((x) => x.routed);
  out.push("", `  routed records (rewritten and accepted; includes pinned continuations): ${routed.length}`);
  if (routed.length > 0) out.push(...table([["requested model", "sent model", "records"], ...countBy(routed, (x) => `${x.requestedModel ?? "?"}\u0000${x.sentModel ?? "?"}`).map(([k, n]) => [...k.split("\u0000"), String(n)])], "    "));
  return out;
}

/** 4. Guard skips. */
export function s4Guard({ rec }: Ctx): string[] {
  const g = rec.decisions.filter((x) => x.guard !== null);
  if (g.length === 0) return ["  (no records with a guard evaluation; the guard runs in route mode only)"];
  const reasons = countBy(g, (x) => x.guard!.reason).map(([r]) => r);
  const rows = reasons.map((r) => {
    const v = g.filter((x) => x.guard!.reason === r);
    const pen = v.map((x) => x.guard!.penaltyUsd).filter((p): p is number => p !== null && p > 0);
    return [r, String(v.length), String(v.filter((x) => x.guard!.allowed).length), String(v.filter((x) => !x.guard!.allowed).length), pen.length ? `$${median(pen)!.toFixed(4)}` : "-", pen.length ? `$${Math.max(...pen).toFixed(4)}` : "-"];
  });
  const blocked = g.filter((x) => !x.guard!.allowed);
  const skipped = blocked.filter((x) => !x.decided);
  return [
    `  ${g.length} guard evaluations, ${blocked.length} refused`,
    ...table([["reason", "evaluated", "allowed", "refused", "penalty p50", "penalty max"], ...rows], "    "),
    `  refused before the backend was asked (backend call skipped): ${skipped.length} of ${blocked.length} refusals`,
  ];
}

/** 5. Fallbacks and breaker. */
export function s5Fallbacks({ rec }: Ctx): string[] {
  const d = rec.decisions;
  if (d.length === 0) return NONE;
  const fb = d.filter((x) => x.fallback);
  const out = [`  rewrites rejected by the upstream and re-sent with the original bytes: ${fb.length}`];
  if (fb.length > 0) {
    out.push(...table([["status", "records"], ...countBy(fb, (x) => String(x.fallbackStatus ?? "?")).map(([k, n]) => [k, String(n)])], "    "));
    const errs = countBy(fb.filter((x) => x.fallbackError !== null), (x) => x.fallbackError!.slice(0, 100));
    for (const [e, n] of errs) out.push(`    ${n}x ${e}`);
    if (fb.some((x) => x.fallbackError === null)) out.push(`    ${fb.filter((x) => x.fallbackError === null).length}x (no error text: recorded before fallback_error existed)`);
  }
  const count = (reason: string): number => d.filter((x) => x.reasons.includes(reason)).length;
  out.push(`  tier switched off after a rejection (tier_disabled): ${count("tier_disabled")}`);
  out.push(`  rewrite_failed: ${count("rewrite_failed")}, stay_pinned_backend_error: ${count("stay_pinned_backend_error")}`);
  const errors = countBy(d.filter((x) => x.error !== null), (x) => x.error!);
  out.push(`  breaker_open: ${d.filter((x) => x.error === "breaker_open").length}`);
  out.push(`  backend and pipeline errors: ${errors.length === 0 ? "none" : errors.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  return out;
}

/** 6. Latency: Jev p50/p95 by connection; added route latency. */
export function s6Latency({ rec }: Ctx): string[] {
  const d = rec.decisions;
  const withLatency = d.filter((x) => x.latencyMs !== null);
  const out: string[] = [];
  if (withLatency.length === 0) out.push("  Jev decision latency: no decided requests");
  else {
    const groups = [["all", withLatency], ...(["new", "reused"] as const).map((c) => [`${c} connection`, withLatency.filter((x) => x.connection === c)] as const), ["connection not logged", withLatency.filter((x) => x.connection === null)]] as const;
    out.push("  Jev decision latency (nearest-rank percentiles):", ...table([["", "n", "p50", "p95"], ...groups.filter(([, v]) => v.length > 0).map(([name, v]) => [name, String(v.length), ms(percentile(v.map((x) => x.latencyMs!), 50)), ms(percentile(v.map((x) => x.latencyMs!), 95))])], "    "));
  }
  // msToHeaders is measured from the request's arrival: in route mode it is the decision wait, the router's own work and the
  // upstream's first byte (the `timing` block splits them; records from before it existed have only the total).
  const nt = newTurns(d).filter((x) => x.msToHeaders !== null && x.modeEffective === "route");
  const arms = [
    ["routed (after a decision)", nt.filter((x) => x.routed)],
    ["unrouted, after a decision", nt.filter((x) => !x.routed && x.decided)],
    ["unrouted, no decision made (guard refusal, backend failure)", nt.filter((x) => !x.routed && !x.decided)],
  ] as const;
  const pc = (v: readonly (number | null)[], p: number): string => {
    const xs = v.filter((n): n is number => n !== null);
    return xs.length === 0 ? "-" : ms(percentile(xs, p));
  };
  out.push("", "  time to upstream response headers, new turns in route mode, split into the wait for the decision and the upstream's first byte (different models and prompts, so a rough comparison only):");
  if (nt.length === 0) out.push("    no new turns in route mode");
  else {
    out.push(...table([
      ["", "n", "headers p50", "headers p95", "decision wait p50", "decision wait p95", "upstream first byte p50", "upstream first byte p95"],
      ...arms.filter(([, v]) => v.length > 0).map(([name, v]) => [name, String(v.length), pc(v.map((x) => x.msToHeaders), 50), pc(v.map((x) => x.msToHeaders), 95), pc(v.map((x) => x.decisionWaitMs), 50), pc(v.map((x) => x.decisionWaitMs), 95), pc(v.map((x) => x.upstreamFirstByteMs), 50), pc(v.map((x) => x.upstreamFirstByteMs), 95)]),
    ], "    "));
    const legacy = nt.filter((x) => x.decisionWaitMs === null).length;
    if (legacy > 0) out.push(`    ${legacy} of ${nt.length} of these records predate the timing block: they count in n and "headers" but not in the two components`);
  }
  // A decision that timed out must not have held the request longer than the deadline plus the router's grace.
  const timedOut = newTurns(d).filter((x) => x.modeEffective === "route" && x.error !== null && /^(backend:timeout|decision_late)/.test(x.error));
  if (timedOut.length > 0) {
    const timed = timedOut.filter((x) => x.decisionWaitMs !== null && x.decisionDeadlineMs !== null);
    const over = timed.filter((x) => x.decisionWaitMs! > x.decisionDeadlineMs! + DECISION_GRACE_MS);
    const longest = timed.length === 0 ? null : Math.max(...timed.map((x) => x.decisionWaitMs!));
    out.push(`  timed-out decisions in route mode: ${timedOut.length}; ${timed.length} with timing${longest === null ? " (cannot be checked against the deadline: recorded before the timing block)" : `, longest wait ${ms(longest)}, deadline ${[...new Set(timed.map((x) => x.decisionDeadlineMs))].join("/")} ms + ${DECISION_GRACE_MS} ms grace: ${over.length === 0 ? "all within" : `${over.length} EXCEEDED it`}`}`);
  }
  return out;
}

export interface OutcomeGroup {
  readonly scope: string;
  /** `interjection`: a window sharing its decision with the turn that owns it; never counted inside a rate. */
  readonly arm: "routed" | "unchanged" | "interjection" | "no decision";
  readonly windows: readonly OutcomeRec[];
  /** Windows with a revert found later (`outcome_update`) or in the window. */
  readonly reverted: ReadonlySet<OutcomeRec>;
}

const ARM_ORDER: readonly OutcomeGroup["arm"][] = ["routed", "unchanged", "interjection", "no decision"];

/** Joins outcome windows to their decision: routed (the decision's request was rewritten) vs unchanged. */
export function outcomeGroups(ctx: Ctx): OutcomeGroup[] {
  const revertedIds = new Set(ctx.rec.updates.filter((u) => u.signal === "reverted_edit").map((u) => u.decisionId));
  const map = new Map<string, OutcomeRec[]>();
  for (const o of ctx.rec.outcomes) {
    const dec = o.decisionId === null ? undefined : ctx.byId.get(o.decisionId);
    // An interjection window shares its decision with the turn that owns it. Counting it in that decision's arm would
    // inflate n and count the turn's edits twice, so it gets an arm of its own and never enters a rate.
    const arm = o.attribution === "interjection" ? "interjection" : dec === undefined ? "no decision" : dec.routed ? "routed" : "unchanged";
    const k = `${o.scope}\u0000${arm}`;
    map.set(k, [...(map.get(k) ?? []), o]);
  }
  return [...map.entries()]
    .map(([k, windows]) => {
      const [scope, arm] = k.split("\u0000") as [string, OutcomeGroup["arm"]];
      return { scope, arm, windows, reverted: new Set(windows.filter((w) => w.revertedInWindow || (w.decisionId !== null && revertedIds.has(w.decisionId)))) };
    })
    .sort((a, b) => a.scope.localeCompare(b.scope) || ARM_ORDER.indexOf(a.arm) - ARM_ORDER.indexOf(b.arm));
}

export interface AbArm {
  readonly arm: "routed" | "control";
  readonly windows: readonly OutcomeRec[];
  readonly scored: number;
  readonly corrected: number;
  readonly withEdits: number;
  readonly testFailures: number;
  readonly reverts: number;
}

/**
 * The randomised arms of REFLEX_AB. Only turns the router actually randomised carry an `ab` tag, and only those may
 * be compared: every other routed turn was routed BECAUSE the backend judged it easy, so comparing it with an
 * unrouted turn compares the difficulty of the work, not the effect of routing. This is the one comparison in the
 * report that can support a causal reading, and only once both arms are large enough.
 */
export function abArms(ctx: Ctx): AbArm[] {
  const revertedIds = new Set(ctx.rec.updates.filter((u) => u.signal === "reverted_edit").map((u) => u.decisionId));
  return (["routed", "control"] as const).map((arm) => {
    const windows = ctx.rec.outcomes.filter((o) => {
      if (o.scope !== "main" || o.attribution === "interjection" || o.decisionId === null) return false;
      return ctx.byId.get(o.decisionId)?.ab === arm;
    });
    const withEdits = windows.filter((w) => w.edits > 0);
    return {
      arm,
      windows,
      scored: windows.filter((w) => w.correctionScore !== null).length,
      corrected: windows.filter((w) => (w.correctionScore ?? 0) > 0).length,
      withEdits: withEdits.length,
      testFailures: withEdits.filter((w) => w.testFailureAfterEdit).length,
      reverts: withEdits.filter((w) => w.revertedInWindow || (w.decisionId !== null && revertedIds.has(w.decisionId))).length,
    };
  });
}

/** The randomised block inside section 7. Empty when no turn was ever randomised. */
export function abComparison(ctx: Ctx): string[] {
  const arms = abArms(ctx);
  if (arms.every((a) => a.windows.length === 0)) return [];
  const out = [
    "",
    "  randomised comparison (REFLEX_AB): of the turns the backend wanted to route below the requested tier, a random",
    "  fraction was held on the requested model instead. Only these turns are comparable with each other - every other",
    "  routed turn was routed BECAUSE the backend judged it easy, so the arms above differ in difficulty, not treatment.",
    ...table([
      ["arm", "windows", "scored", "correction > 0", "windows with edits", "test failure", "revert"],
      ...arms.map((a) => [a.arm, String(a.windows.length), String(a.scored), String(a.corrected), String(a.withEdits), String(a.testFailures), String(a.reverts)]),
    ], "    "),
  ];
  const small = arms.filter((a) => a.windows.length < MIN_OUTCOME_N);
  if (small.length > 0) {
    out.push(`    insufficient data: ${small.map((a) => `${a.arm} n=${a.windows.length}`).join(", ")} < ${MIN_OUTCOME_N}; no rates shown and no comparison is made`);
    return out;
  }
  for (const a of arms) {
    out.push(`    ${a.arm}: correction > 0 in ${pct(a.corrected, a.scored)} of scored; test failure ${pct(a.testFailures, a.withEdits)} and revert ${pct(a.reverts, a.withEdits)} of windows with edits`);
  }
  out.push("    this is a difference between randomly assigned arms; it is still one log, and the report states no interval for it.");
  return out;
}

/** 7. Outcome rates for routed vs unchanged turns. */
export function s7Outcomes(ctx: Ctx): string[] {
  const groups = outcomeGroups(ctx);
  if (groups.length === 0) return ["  (no outcome records; outcome capture runs in shadow and route sessions since M4)"];
  const out: string[] = [];
  for (const g of groups) {
    const w = g.windows;
    const scored = w.filter((x) => x.correctionScore !== null);
    const withEdits = w.filter((x) => x.edits > 0);
    const head = `  ${g.scope} / ${g.arm}: ${w.length} window${w.length === 1 ? "" : "s"}`;
    if (g.arm === "interjection") {
      const joined = w.filter((x) => x.decisionId !== null).length;
      out.push(`${head}: messages typed mid-tool-loop, joined to the turn's own decision (${joined} joined). Kept out of the rates above: they share a decision with that turn, so counting them would inflate n and count its edits twice`);
      continue;
    }
    if (g.arm === "no decision") {
      const reasons = countBy(w, (x) => x.noDecisionReason ?? "not recorded");
      out.push(`${head} (${reasons.map(([k, n]) => `${k} ${n}`).join(", ")}); not attributable to a routing decision`);
      continue;
    }
    const buckets = [["0", scored.filter((x) => x.correctionScore === 0).length], ["0-0.5", scored.filter((x) => x.correctionScore! > 0 && x.correctionScore! < 0.5).length], [">=0.5", scored.filter((x) => x.correctionScore! >= 0.5).length]] as const;
    out.push(head);
    out.push(`    correction score: ${scored.length} scored (${w.length - scored.length} had no next prompt): ${buckets.map(([k, n]) => `${k}: ${n}`).join(", ")}`);
    out.push(`    test failure after an edit: ${w.filter((x) => x.testFailureAfterEdit).length} of ${withEdits.length} windows with edits (${w.filter((x) => x.testRuns > 0).length} windows ran tests)`);
    out.push(`    reverted edits: ${withEdits.filter((x) => g.reverted.has(x)).length} of ${withEdits.length} windows with edits`);
    const vers = countBy(w, (x) => (x.decisionId === null ? BACKEND_VERSION_UNKNOWN : ctx.byId.get(x.decisionId)?.backendVersion ?? BACKEND_VERSION_UNKNOWN));
    if (vers.length > 1 || (vers.length === 1 && vers[0]![0] !== BACKEND_VERSION_UNKNOWN)) {
      out.push(`    by backend version: ${vers.map(([v, n]) => `${v} ${n}`).join(", ")}`);
    }
    if (w.length < MIN_OUTCOME_N) out.push(`    insufficient data: n=${w.length} < ${MIN_OUTCOME_N}; no rates shown`);
    else {
      out.push(`    rates: correction > 0 in ${pct(scored.filter((x) => x.correctionScore! > 0).length, scored.length)} of scored; test failure ${pct(w.filter((x) => x.testFailureAfterEdit).length, withEdits.length)} and revert ${pct(withEdits.filter((x) => g.reverted.has(x)).length, withEdits.length)} of windows with edits`);
    }
  }
  out.push(...abComparison(ctx));
  const arms = new Set(groups.filter((g) => g.arm !== "no decision" && g.windows.length >= MIN_OUTCOME_N).map((g) => `${g.scope}/${g.arm}`));
  const scopes = new Set(groups.map((g) => g.scope));
  for (const s of scopes) if (!(arms.has(`${s}/routed`) && arms.has(`${s}/unchanged`))) out.push(`  ${s}: routed vs unchanged is not comparable yet (each arm needs n >= ${MIN_OUTCOME_N})`);
  if (ctx.rec.harnessInjected.length > 0) out.push(`  harness_injected records: ${ctx.rec.harnessInjected.length}`);
  return out;
}

const PRICED_TTL = "5m" as const;

export interface CostRow {
  readonly n: number;
  readonly tokens: number;
  readonly atSentUsd: number;
  readonly atRequestedUsd: number;
}

/** The same token counts priced at the model actually sent and at the model requested. Records without usage or a known tier are skipped. */
export function costOf(d: readonly Dec[]): CostRow {
  let n = 0;
  let tok = 0;
  let sent = 0;
  let requested = 0;
  for (const x of d) {
    if (x.usage === null || x.sentTier === null || x.requestedTier === null) continue;
    n++;
    tok += totalTokens(x.usage);
    sent += usageCostUsd(x.sentTier, x.usage, PRICED_TTL, x.sentModel);
    requested += usageCostUsd(x.requestedTier, x.usage, PRICED_TTL, x.requestedModel);
  }
  return { n, tokens: tok, atSentUsd: sent, atRequestedUsd: requested };
}

/**
 * REFLEX_AB work units: each randomised main-chat turn with the continuations that follow it in its conversation, until
 * the next new turn, priced at the model sent. Intention to treat: the `routed` arm keeps the turns the guard held on the
 * requested model, because leaving them out would compare the turns the guard let through with all of `control`.
 */
export function abCostUnits(d: readonly Dec[]): Record<"routed" | "control", number[]> {
  const out = { routed: [] as number[], control: [] as number[] };
  const byConv = new Map<string, Dec[]>();
  for (const x of d) if (x.kind === "main" && x.turn !== "side" && x.conv !== null) byConv.set(x.conv, [...(byConv.get(x.conv) ?? []), x]);
  for (const list of byConv.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let unit: Dec[] | null = null;
    const close = (u: Dec[] | null): void => {
      const arm = u?.[0]?.ab;
      if (u === null || (arm !== "routed" && arm !== "control") || u[0]!.usage === null) return;
      out[arm].push(costOf(u).atSentUsd);
    };
    for (const x of list) {
      if (x.turn === "new") {
        close(unit);
        unit = [x];
      } else unit?.push(x);
    }
    close(unit);
  }
  return out;
}

const BOOTSTRAP_RESAMPLES = 2000;

/** 95% bootstrap interval of mean(a)/mean(b) - 1. Seeded, so the report is the same on every run. */
export function ratioInterval(a: readonly number[], b: readonly number[]): { lo: number; hi: number } | null {
  if (a.length === 0 || b.length === 0) return null;
  let seed = 1;
  const rnd = (n: number): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed % n;
  };
  const resample = (v: readonly number[]): number => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[rnd(v.length)]!;
    return s / v.length;
  };
  const r: number[] = [];
  for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
    const mb = resample(b);
    if (mb > 0) r.push(resample(a) / mb - 1);
  }
  const lo = percentile(r, 2.5);
  const hi = percentile(r, 97.5);
  return lo === null || hi === null ? null : { lo, hi };
}

const signedPct = (x: number): string => `${x >= 0 ? "+" : ""}${(100 * x).toFixed(0)}%`;

/** Section 8's measured line: what a routed turn cost against a turn held back, both randomly chosen from the same pool. */
function abCostLine(d: readonly Dec[], showUsd: boolean): string[] {
  const u = abCostUnits(d);
  if (u.routed.length + u.control.length === 0) return ["  measured (REFLEX_AB): no randomised turns; the rows above are the only estimate, and they assume equal token counts"];
  const head = `  measured (REFLEX_AB, main chat only; a turn plus its tool loop, at the model sent; routed n=${u.routed.length}, control n=${u.control.length})`;
  if (Math.min(u.routed.length, u.control.length) < MIN_OUTCOME_N) return [`${head}: insufficient data, each arm needs n >= ${MIN_OUTCOME_N}`];
  const mr = mean(u.routed)!;
  const mc = mean(u.control)!;
  const ci = ratioInterval(u.routed, u.control);
  return [
    `${head}:`,
    `    a routed-arm turn cost ${signedPct(mr / mc - 1)} against a control turn${ci === null ? "" : ` (95% bootstrap interval ${signedPct(ci.lo)} to ${signedPct(ci.hi)})`}${showUsd ? `: ${usd(mr)} vs ${usd(mc)} per turn` : ""}`,
    "    this, not the rows above, is the saving: the rows above price the routed model's own token counts at the requested model, and a different model writes a different amount.",
  ];
}

/** 8. Cost at list prices (estimate). */
export function s8Cost({ rec, usd: showUsd }: Ctx): string[] {
  const work = rec.decisions.filter((x) => x.turn !== "side");
  const routed = work.filter((x) => x.routed);
  const all = costOf(work);
  const r = costOf(routed);
  const out = [
    `  ESTIMATE at list prices (src/pricing.ts, last verified ${LAST_VERIFIED}): the same token counts priced at the model sent vs the model requested.`,
    "  That assumes the requested model would have used the same tokens; it does not (Sonnet 5 wrote 2.7x Opus 5.5's output on the same tasks, observations.md). The measured line below replaces it where REFLEX_AB ran.",
    "  Not modelled: tokenizer differences between models, cache TTL (writes priced at the 5-minute rate), discounts, subscription limits.",
    "  The requested-model figure prices the routed model's cache writes as writes on the requested model too, although its cache was usually already warm from side calls (observations.md, cache cost model), so it overstates what staying would have cost.",
  ];
  if (all.n === 0) return [...out, "  no records with usage"];
  const line = (name: string, c: CostRow): string[] => [
    name, String(c.n), int(c.tokens), c.atRequestedUsd === 0 ? "-" : pct(c.atSentUsd, c.atRequestedUsd), ...(showUsd ? [usd(c.atRequestedUsd), usd(c.atSentUsd), usd(c.atRequestedUsd - c.atSentUsd)] : []),
  ];
  out.push(...table([
    ["main chat + subagent requests", "n", "tokens", "usage at sent as % of at requested", ...(showUsd ? ["$ at requested", "$ at sent", "$ difference"] : [])],
    line("routed only", r),
    line("all (unrouted count as equal)", all),
  ], "    "));
  if (!showUsd) out.push("  Dollar amounts: rerun with --usd. Without it only relative usage is shown.");
  out.push(...abCostLine(work, showUsd));
  out.push("  Side calls are excluded here and shown in section 9.");
  out.push(...delegationLine(hintArms(rec), showUsd));
  return out;
}

/** The delegation comparison for section 8: sessions with each hint version vs without, all requests (side calls included). */
function delegationLine(arms: readonly HintArm[], showUsd: boolean): string[] {
  const off = arms.find((a) => a.hint === HINT_OFF);
  const on = arms.filter((a) => a.hint !== HINT_OFF);
  if (on.length === 0) return ["  delegation: no session ran with the hint (REFLEX_DELEGATE=1); nothing to compare"];
  const arm = (name: string, a: HintArm | undefined): string =>
    a === undefined ? `${name} (n=0 sessions)`
    : `${name} (n=${a.sessions} session${a.sessions === 1 ? "" : "s"}, ${a.userTurns} user turn${a.userTurns === 1 ? "" : "s"}): subagent share ${pct(a.subagentTokens, a.tokens)}, ${int(perTurn(a.tokens, a.userTurns))} tokens${showUsd ? ` and ${a.userTurns === 0 ? "-" : usd(a.usdAtSent / a.userTurns)}` : ""} per user turn`;
  const few = [off, ...on].some((a) => (a?.sessions ?? 0) < MIN_DELEGATION_SESSIONS);
  return [`  delegation (all requests incl. side calls, per user turn; different sessions and tasks, not a controlled comparison${few ? `; fewer than ${MIN_DELEGATION_SESSIONS} sessions on a side: too few to compare` : ""}): ${[...on.map((a) => arm(`with ${a.hint}`, a)), arm("without", off)].join("; ")}`];
}

/** 9. Side-call usage on its own line. */
/**
 * Optional Claude Code features that make their own model calls, matched to the side kind they arrive as. The switch
 * is the name the user would change; nothing here recommends changing one. Sources: Claude Code docs, interactive-mode
 * and settings-reference, read 2026-09-19.
 *
 * `caveat` records where a row is an upper bound because the side kind carries more than that one feature; without it
 * the figure would overstate what the switch controls.
 */
export const HARNESS_FEATURES: readonly { readonly feature: string; readonly marker: string; readonly switch: string }[] = [
  { feature: "Session recap", marker: "session_recap", switch: "/config -> Session recap (settings: awaySummaryEnabled)" },
  { feature: "Prompt suggestions", marker: "suggestion", switch: "/config -> Prompt suggestions (settings: promptSuggestionEnabled, env CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)" },
];

/** What the optional harness features cost on this log, at the model they were actually billed to. */
export function harnessFeatureCost(decisions: readonly Dec[], showUsd: boolean): string[] {
  const rows: string[][] = [];
  const notes: string[] = [];
  // Records written before `side_marker` existed cannot be attributed to a feature; say how many rather than guess.
  const unmarked = decisions.filter((x) => x.turn === "side" && x.sideMarker === null && (x.sideKind === "notification" || x.sideKind === "suggestion")).length;

  // Every feature gets a row, including a zero one. A feature that cost nothing in range and a feature this build
  // failed to attribute look identical if the row is dropped, and the missing block reads as "nothing to see" -- which
  // is exactly how a marker regression hid itself. Zero is a measurement; absence is not.
  for (const f of HARNESS_FEATURES) {
    const calls = decisions.filter((x) => x.turn === "side" && x.sideMarker === f.marker);
    const withUsage = calls.filter((x) => x.usage !== null);
    rows.push([f.feature, int(calls.length), int(sum(withUsage.map(tokens))), ...(showUsd ? [usd(costOf(withUsage).atRequestedUsd)] : [])]);
    notes.push(`    ${f.feature}: ${f.switch}`);
  }
  const unmarkedNote = unmarked > 0 ? [`    ${int(unmarked)} side call(s) of these kinds carry no marker id (recorded before it was logged, or named by shape alone), so no feature above counts them.`] : [];
  return [
    "",
    "  optional Claude Code features, and what they cost here (each makes its own model call, billed to the requested model):",
    ...table([["feature", "calls", "tokens", ...(showUsd ? ["$ at requested model"] : [])], ...rows], "    "),
    ...(showUsd ? [] : ["    (rerun with --usd for what each one cost)"]),
    "",
    "    switches:",
    ...notes,
    ...(unmarked > 0 ? ["", ...unmarkedNote] : []),
  ];
}

export function s9SideCalls({ rec, usd: showUsd }: Ctx): string[] {
  const side = rec.decisions.filter((x) => x.turn === "side");
  if (side.length === 0) return NONE;
  const withUsage = side.filter((x) => x.usage !== null);
  const out = [`  ${side.length} side calls (${withUsage.length} with usage). Harness side calls are never rewritten, so they bill the requested model even while the conversation is routed.`];
  const kinds = countBy(side, (x) => x.sideKind ?? "unknown").map(([k]) => k);
  const rows = kinds.map((k) => {
    const v = withUsage.filter((x) => (x.sideKind ?? "unknown") === k);
    return [k, String(side.filter((x) => (x.sideKind ?? "unknown") === k).length), int(sum(v.map(tokens))), ...(showUsd ? [usd(costOf(v).atRequestedUsd)] : [])];
  });
  out.push(...table([["side kind", "calls", "tokens", ...(showUsd ? ["$ at requested model"] : [])], ...rows, ["total", String(side.length), int(sum(withUsage.map(tokens))), ...(showUsd ? [usd(costOf(withUsage).atRequestedUsd)] : [])]], "    "));
  const routedSide = side.filter((x) => x.sentTier !== x.requestedTier).length;
  out.push(`  side calls sent to a model other than the requested one: ${routedSide}${routedSide > 0 ? " (unexpected)" : ""}`);
  out.push(...harnessFeatureCost(rec.decisions, showUsd));
  return out;
}

export type MoveType = "down" | "up_one_tier" | "back_to_requested" | "stayed";

/**
 * Classifies each main-chat and subagent request by how its sent tier compares with the previous request of the same
 * conversation (the first request compares with the requested tier). `stayed` is kept for new turns only, as a baseline.
 */
export function classifyMoves(d: readonly Dec[]): { move: MoveType; dec: Dec }[] {
  const byConv = new Map<string, Dec[]>();
  for (const x of d) {
    if (x.turn === "side" || x.conv === null || x.usage === null || x.sentTier === null || x.requestedTier === null) continue;
    byConv.set(x.conv, [...(byConv.get(x.conv) ?? []), x]);
  }
  const out: { move: MoveType; dec: Dec }[] = [];
  for (const list of byConv.values()) {
    list.sort((a, b) => a.atMs - b.atMs);
    let prev: Tier | null = null;
    for (const x of list) {
      const from: Tier = prev ?? x.requestedTier!;
      const to = x.sentTier!;
      prev = to;
      if (to === from) {
        if (x.turn === "new") out.push({ move: "stayed", dec: x });
      } else if (tierRank(to) < tierRank(from)) out.push({ move: "down", dec: x });
      else out.push({ move: to === x.requestedTier ? "back_to_requested" : "up_one_tier", dec: x });
    }
  }
  return out;
}

/** 10. Cache writes by move type. */
export function s10CacheMoves({ rec }: Ctx): string[] {
  const moves = classifyMoves(rec.decisions);
  if (moves.length === 0) return NONE;
  const label: Record<MoveType, string> = { down: "down (to a cheaper tier)", up_one_tier: "up, short of the requested tier", back_to_requested: "back to the requested tier", stayed: "stayed (new turns, baseline)" };
  const rows = (["down", "up_one_tier", "back_to_requested", "stayed"] as const).flatMap((m) => {
    const v = moves.filter((x) => x.move === m).map((x) => x.dec.usage!);
    if (v.length === 0) return [];
    const w = v.map((u) => u.cacheCreate);
    return [[label[m], String(v.length), int(median(w)), int(mean(w)), int(Math.max(...w)), int(median(v.map((u) => u.cacheRead)))]];
  });
  return [
    "  first request after a tier change in a conversation (observations.md: moving up one tier can write more than returning to the requested model)",
    ...table([["move", "n", "cache write p50", "cache write mean", "cache write max", "cache read p50"], ...rows], "    "),
  ];
}

/** Fields that vary with the conversation's length, not with the kind of call: left out when grouping fingerprints. */
const COUNT_FIELD = "messages";
const VOLATILE = new Set([COUNT_FIELD, "roles"]);
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : typeof v === "object" && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])])) : v;

export interface FingerprintGroup {
  readonly n: number;
  readonly tokens: number;
  readonly kinds: readonly string[];
  readonly claude_versions: readonly string[];
  readonly message_count: { readonly min: number; readonly max: number };
  /** The most recent fingerprint of the group, complete. */
  readonly fingerprint: Readonly<Record<string, unknown>>;
}

/** Unclassified side calls with a fingerprint, grouped by everything but their length; most frequent first. */
export function fingerprintGroups(d: readonly Dec[]): FingerprintGroup[] {
  const groups = new Map<string, Dec[]>();
  for (const x of d) {
    if (x.fingerprint === null) continue;
    const k = JSON.stringify(canonical(Object.fromEntries(Object.entries(x.fingerprint).filter(([f]) => !VOLATILE.has(f)).map(([f, v]) => [f, f === "last" && typeof v === "object" && v !== null ? { ...v, text_chars: undefined } : v]))));
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  return [...groups.values()]
    .map((v) => {
      const sorted = [...v].sort((a, b) => a.atMs - b.atMs);
      const counts = v.map((x) => num(x.fingerprint![COUNT_FIELD]) ?? 0);
      return {
        n: v.length,
        tokens: sum(v.map(tokens)),
        kinds: [...new Set(v.map((x) => x.kind))].sort(),
        claude_versions: [...new Set(v.map((x) => x.claudeVersion ?? "?"))].sort(),
        message_count: { min: Math.min(...counts), max: Math.max(...counts) },
        fingerprint: canonical(sorted.at(-1)!.fingerprint) as Record<string, unknown>,
      };
    })
    .sort((a, b) => b.n - a.n || b.tokens - a.tokens);
}

/** 11. Unclassified side calls: their structural fingerprints, to be sent back and given a side_kind. */
export function s11Fingerprints({ rec }: Ctx): string[] {
  const un = rec.decisions.filter((x) => x.turn === "side" && x.sideKind === "unclassified");
  if (un.length === 0) return ["  (no unclassified side calls)"];
  const groups = fingerprintGroups(un);
  const without = un.filter((x) => x.fingerprint === null).length;
  const out = [
    `  ${un.length} unclassified side call${un.length === 1 ? "" : "s"}, ${int(sum(un.map(tokens)))} tokens; ${groups.length} distinct fingerprint${groups.length === 1 ? "" : "s"}${without > 0 ? `; ${without} without one (recorded before fingerprints existed, or not buildable)` : ""}`,
    "  Structure only (docs/privacy.md). `reflex report --fingerprints` prints them as JSON lines to send back.",
  ];
  // Not one bucket: a plain string whose prompt hook was missed is the user's own turn, not an unknown harness shape.
  const byReason = countBy(un, (x) => x.unclassifiedReason ?? "unrecorded");
  if (byReason.length > 0) out.push(`  by reason: ${byReason.map(([k, n]) => `${k} ${n}`).join(", ")}`);
  for (const g of groups) out.push(`    n=${g.n}, ${int(g.tokens)} tokens, kind ${g.kinds.join("/")}, claude ${g.claude_versions.join("/")}, messages ${g.message_count.min === g.message_count.max ? g.message_count.min : `${g.message_count.min}-${g.message_count.max}`}: ${JSON.stringify(g.fingerprint)}`);
  return out;
}

/** `id` is the section number as it appears at the start of `title` (and nowhere else) — the `--json` key, stable across wording changes to the title. */
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const effortRank = (e: string | null): number => (e === null ? -1 : (EFFORT_LEVELS as readonly string[]).indexOf(e));

/** Outcome counts for the main-chat windows of a set of decisions (the section 7 measures). */
function outcomeArm(ctx: Ctx, ids: ReadonlySet<string>): { windows: number; scored: number; corrected: number; withEdits: number; testFailures: number; reverts: number } {
  const revertedIds = new Set(ctx.rec.updates.filter((u) => u.signal === "reverted_edit").map((u) => u.decisionId));
  const w = ctx.rec.outcomes.filter((o) => o.scope === "main" && o.attribution !== "interjection" && o.decisionId !== null && ids.has(o.decisionId));
  const withEdits = w.filter((x) => x.edits > 0);
  return {
    windows: w.length,
    scored: w.filter((x) => x.correctionScore !== null).length,
    corrected: w.filter((x) => (x.correctionScore ?? 0) > 0).length,
    withEdits: withEdits.length,
    testFailures: withEdits.filter((x) => x.testFailureAfterEdit).length,
    reverts: withEdits.filter((x) => x.revertedInWindow || (x.decisionId !== null && revertedIds.has(x.decisionId))).length,
  };
}

/** 14. REFLEX_EFFORT: what was decided and applied, what it did to output tokens, and outcomes by arm. */
export function s14Effort(ctx: Ctx): string[] {
  const all = ctx.rec.decisions;
  const decided = all.filter((d) => d.effort !== null);
  const carried = all.filter((d) => d.effortAdded || d.effortReinserted > 0);
  if (decided.length === 0 && carried.length === 0) return ["  (no effort decisions; REFLEX_EFFORT=1 turns them on)"];
  const applied = decided.filter((d) => d.effort!.via !== null);
  const rel = (d: Dec): string => {
    const t = effortRank(d.effort!.target);
    const r = effortRank(d.requestedEffort);
    return t < 0 || r < 0 ? "unknown" : t < r ? "lower" : t > r ? "higher" : "same";
  };
  const out = [
    `  decided turns: ${decided.length} (${countBy(decided, (d) => d.kind).map(([k, n]) => `${k} ${n}`).join(", ")})`,
    `  target vs the client's level: ${countBy(decided, rel).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    `  reasons: ${countBy(decided.flatMap((d) => d.effort!.reasons), (r) => r).map(([k, n]) => `${k} ${n}`).join(", ")}`,
    `  applied: ${countBy(decided, (d) => d.effort!.via ?? "not applied").map(([k, n]) => `${k} ${n}`).join(", ")} (not applied: shadow, a model without a verified way, or a rejected request)`,
    `  applied levels: ${EFFORT_LEVELS.map((l) => `${l} ${applied.filter((d) => d.effort!.target === l).length}`).join(", ")}`,
    `  requests carrying reflex's effort messages: ${carried.filter((d) => d.effortAdded).length} added one, ${carried.filter((d) => d.effortReinserted > 0).length} re-inserted earlier ones (${sum(carried.map((d) => d.effortReinserted))} in all); rejected and resent unchanged: ${carried.filter((d) => d.fallback).length}`,
  ];
  const withUsage = applied.filter((d) => d.usage !== null);
  if (withUsage.length > 0) {
    out.push(`  output tokens of the deciding request, by applied level: ${EFFORT_LEVELS.map((l) => { const x = withUsage.filter((d) => d.effort!.target === l); return x.length === 0 ? null : `${l} mean ${int(mean(x.map((d) => d.usage!.output)))} (n=${x.length})`; }).filter(Boolean).join(", ")}. The turn's tool loop is not included; levels differ in the work they were given, so this is not the effect of the level`);
  }
  const arms: [string, Set<string>][] = [
    ["lowered", new Set(applied.filter((d) => rel(d) === "lower" && !d.fallback && d.effort!.ab !== "control").map((d) => d.id))],
    ["at client level", new Set(decided.filter((d) => rel(d) === "same").map((d) => d.id))],
  ];
  const rows = arms.map(([name, ids]) => [name, outcomeArm(ctx, ids)] as const);
  out.push("", "  main-chat outcomes (NOT randomised: a turn is lowered because the backend judged it easy, so these arms differ in difficulty):");
  out.push(...table([["arm", "windows", "scored", "correction > 0", "windows with edits", "test failure", "revert"], ...rows.map(([n, a]) => [n, String(a.windows), String(a.scored), String(a.corrected), String(a.withEdits), String(a.testFailures), String(a.reverts)])], "    "));
  const ab = (["treated", "control"] as const).map((arm) => [arm, outcomeArm(ctx, new Set(decided.filter((d) => d.effort!.ab === arm).map((d) => d.id)))] as const);
  if (ab.some(([, a]) => a.windows > 0) || decided.some((d) => d.effort!.ab !== null)) {
    out.push("", "  randomised comparison (REFLEX_EFFORT_AB): of the turns whose target differed from the client's level, a random fraction ran at the client's level instead:");
    out.push(...table([["arm", "windows", "scored", "correction > 0", "windows with edits", "test failure", "revert"], ...ab.map(([n, a]) => [n, String(a.windows), String(a.scored), String(a.corrected), String(a.withEdits), String(a.testFailures), String(a.reverts)])], "    "));
    const small = ab.filter(([, a]) => a.windows < MIN_OUTCOME_N);
    if (small.length > 0) out.push(`    insufficient data: ${small.map(([n, a]) => `${n} n=${a.windows}`).join(", ")} < ${MIN_OUTCOME_N}; no rates shown and no comparison is made`);
    else for (const [n, a] of ab) out.push(`    ${n}: correction > 0 in ${pct(a.corrected, a.scored)} of scored; test failure ${pct(a.testFailures, a.withEdits)} and revert ${pct(a.reverts, a.withEdits)} of windows with edits`);
  }
  return out;
}

export const SECTIONS: readonly { readonly id: string; readonly title: string; readonly run: (c: Ctx) => string[] }[] = [
  { id: "0", title: "0. Workflow profile", run: s0Workflow },
  { id: "1", title: "1. Decisions by kind, turn and tier", run: s1Decisions },
  { id: "2", title: "2. mass vs argmax", run: s2MassVsArgmax },
  { id: "3", title: "3. Shadow vs actual", run: s3ShadowVsActual },
  { id: "4", title: "4. Guard skips", run: s4Guard },
  { id: "5", title: "5. Fallbacks and breaker", run: s5Fallbacks },
  { id: "6", title: "6. Latency", run: s6Latency },
  { id: "7", title: "7. Outcome rates, routed vs unchanged", run: s7Outcomes },
  { id: "8", title: "8. Cost at list prices (estimate)", run: s8Cost },
  { id: "9", title: "9. Side-call usage", run: s9SideCalls },
  { id: "10", title: "10. Cache writes by move type", run: s10CacheMoves },
  { id: "11", title: "11. Unclassified side-call fingerprints", run: s11Fingerprints },
  { id: "12", title: "12. Side-call routing estimate", run: s12SideRouting },
  { id: "13", title: "13. Escalations (REFLEX_ESCALATE)", run: s13Escalations },
  { id: "14", title: "14. Effort (REFLEX_EFFORT)", run: s14Effort },
];

// ---- 12. Side-call routing estimate ---------------------------------------------------------------------------

/**
 * Side kinds a cheaper tier may serve: the answer is consumed by the harness or shown as a disposable aid, never
 * folded into the conversation as the assistant's own reasoning. `cross_session`, injected peer and task-notification
 * prompts, the tool-result side kind and `unclassified` are deliberately absent (the names live in src/wire/markers.ts;
 * this list is a policy choice, so it is spelled out here rather than derived).
 */
export const SIDE_ROUTABLE_KINDS: readonly string[] = ["no_tools", "notification", "suggestion"];
/**
 * Above this cache-read share a call's cost is dominated by the cached prefix, so the amortisation rule below decides
 * whether moving it pays. Under it (title generation, quota probes) there is barely a cache to lose and the cheaper
 * tier wins on price alone, cold or not: the rule does not apply and is not quoted.
 */
export const PREFIX_DOMINATED_SHARE = 0.8;
/** Tiers a side call could be sent to, cheapest first. Both are priced: the cheaper one cannot hold the big calls. */
export const SIDE_TIER_CANDIDATES: readonly Tier[] = ["haiku", "sonnet"];
const TTL_SECONDS = { "5m": 300, "1h": 3600 } as const;
/** With no TTL on the record, assume the shorter window: it is the pessimistic reading. */
const ASSUMED_TTL: CacheTtl = "5m";

/**
 * The TTL a record's request ran at: `cache_ttl` (read from the body) when recorded; before that field existed, the
 * `extended-cache-ttl` beta, which permits a 1-hour write without proving one; null when the record carries neither.
 */
const knownTtl = (d: Dec): CacheTtl | null => d.cacheTtl ?? (d.cacheTtlBeta === null ? null : d.cacheTtlBeta ? "1h" : "5m");
const ttlOf = (d: Dec): CacheTtl => knownTtl(d) ?? ASSUMED_TTL;
/**
 * The TTL the priced traffic actually ran at, or null when the log cannot say.
 *
 * Scoped to the side calls section 12 prices, not to every record: a continuation's TTL says nothing about what
 * routing these calls would cost. Known only when every one of those that carries a TTL (`knownTtl`) agrees. Both other
 * cases stay null and keep both candidate rows: records written before the field existed carry nothing, and a mix is
 * real rather than an artefact -- some side calls legitimately ask for no 1-hour TTL (compaction is the documented one), so a
 * log can genuinely contain both windows and neither row would be the measured one.
 */
function measuredTtl(decisions: readonly Dec[]): CacheTtl | null {
  const priced = decisions.filter((d) => d.turn === "side" && d.sideKind !== null && SIDE_ROUTABLE_KINDS.includes(d.sideKind) && d.usage !== null && knownTtl(d) !== null);
  if (priced.length === 0) return null;
  const on = priced.filter((x) => knownTtl(x) === "1h").length;
  return on === priced.length ? "1h" : on === 0 ? "5m" : null;
}
/**
 * A side call can only be routed to a tier that can hold it. The recorded token count is used directly here, where the
 * router estimates from request bytes (src/tiers.ts) -- close enough to size the opportunity, not to decide a request.
 */
const fitsSideTier = (tier: Tier, u: Usage): boolean => fitsContext(tier, ctxOf(u));
const ceilingOf = (t: Tier): string => {
  const c = CONTEXT_CEILING[t];
  return c === null ? "none" : int(c);
};
/** The whole prompt of one request: what a cold target would have to write. */
const ctxOf = (u: Usage): number => u.input + u.cacheRead + u.cacheCreate;

export interface SideKindEstimate {
  readonly kind: string;
  readonly calls: number;
  readonly warm: number;
  readonly cold: number;
  readonly tokens: number;
  /** Cache read as a share of the call's tokens: the higher it is, the more a cold swap would lose. */
  readonly cacheReadShare: number;
  /** Seconds between consecutive routable side calls of the same conversation. */
  readonly gapP50: number | null;
  readonly usdAtRequested: number;
  readonly usdAtSide: number;
  /** Calls whose prompt is larger than the side tier's context ceiling: not routable at all, and excluded above. */
  readonly overCeiling: number;
  readonly overCeilingTokens: number;
}

/** One conversation's exposure to §4 of the design: only a conversation pinned below requested can lose a free warm cache. */
export interface ConvExposure {
  readonly conv: string;
  /** Some request of this conversation was actually routed below the tier the client asked for. */
  readonly pinnedBelow: boolean;
  /** Moves to a higher tier, including a return to the requested one. */
  readonly upMoves: number;
  /** Cache write tokens paid on each of those up-moves, in order. */
  readonly upMoveCacheWrites: readonly number[];
}

export interface SideRoutingEstimate {
  readonly tier: Tier;
  readonly perKind: SideKindEstimate[];
  readonly calls: number;
  readonly warm: number;
  readonly cold: number;
  readonly usdAtRequested: number;
  readonly usdAtSide: number;
  /**
   * Warm calls needed per cold write before a swap pays, at the TTL that dominates the sample; null when a warm read on
   * the side tier saves nothing over the requested model (Sonnet 5 vs Opus 5.5: both $0.20/MTok), so it never pays.
   */
  readonly breakEven: number | null;
  readonly observedWarmPerCold: number | null;
  readonly overCeiling: number;
  readonly overCeilingTokens: number;
  /** No record in the sample carried a TTL (`cache_ttl`, or the older beta flag), so the shorter TTL was assumed throughout. */
  readonly ttlAssumed: boolean;
  readonly convs: ConvExposure[];
}

/** Write cost over the per-token saving of each warm read; null when there is no saving to recover it from. */
export const breakEvenOf = (writeRate: number, readSaving: number): number | null => (readSaving > 0 ? writeRate / readSaving : null);

/**
 * Pure. What routing the go-list side kinds to one shared `SIDE_TIER` would have cost on this log, with every cold
 * write paid in full: a call is warm only when the previous routable side call of the same conversation was inside the
 * cache TTL, which is exactly what the real thing would get, since nothing else would keep that tier warm.
 * An estimate over recorded token counts, not a measurement of a run.
 */
export interface SideRoutingOptions {
  readonly tier: Tier;
  /** Price every request at this TTL instead of the one its record implies (a what-if across both windows). */
  readonly ttl?: CacheTtl;
  /** Drop conversations ever pinned below the requested tier: the carve-out that removes the §4 interaction. */
  readonly excludePinnedBelow?: boolean;
}

export function sideRoutingEstimate(decisions: readonly Dec[], opts: SideRoutingOptions): SideRoutingEstimate {
  const tier = opts.tier;
  const pinnedBelow = new Set(convExposure(decisions).filter((c) => c.pinnedBelow).map((c) => c.conv));
  const onGoList = decisions.filter((d) => d.turn === "side" && d.sideKind !== null && SIDE_ROUTABLE_KINDS.includes(d.sideKind) && d.usage !== null && d.requestedTier !== null && d.conv !== null && !(opts.excludePinnedBelow === true && pinnedBelow.has(d.conv)));
  // A prompt larger than the side tier's context ceiling cannot go there at all, however good the cache arithmetic is.
  const routable = onGoList.filter((d) => fitsSideTier(tier, d.usage!));
  const tooBig = onGoList.filter((d) => !fitsSideTier(tier, d.usage!));
  const byConv = new Map<string, Dec[]>();
  for (const d of routable) byConv.set(d.conv!, [...(byConv.get(d.conv!) ?? []), d]);

  const perKindAcc = new Map<string, { calls: number; warm: number; cold: number; tokens: number; read: number; gaps: number[]; atReq: number; atSide: number; over: number; overTok: number }>();
  const acc = (k: string): NonNullable<ReturnType<typeof perKindAcc.get>> => {
    let v = perKindAcc.get(k);
    if (!v) {
      v = { calls: 0, warm: 0, cold: 0, tokens: 0, read: 0, gaps: [], atReq: 0, atSide: 0, over: 0, overTok: 0 };
      perKindAcc.set(k, v);
    }
    return v;
  };

  for (const d of tooBig) {
    const a = acc(d.sideKind!);
    a.over++;
    a.overTok += totalTokens(d.usage!);
  }
  let warm = 0;
  let cold = 0;
  let usdAtRequested = 0;
  let usdAtSide = 0;
  const ttlsSeen: CacheTtl[] = [];
  for (const list of byConv.values()) {
    const sorted = [...list].sort((a, b) => a.atMs - b.atMs);
    let lastAt: number | null = null;
    let cached = 0; // tokens the side tier holds for this conversation
    for (const d of sorted) {
      const u = d.usage!;
      const ttl = opts.ttl ?? ttlOf(d);
      ttlsSeen.push(ttl);
      const ctx = ctxOf(u);
      const a = acc(d.sideKind!);
      const isWarm = lastAt !== null && (d.atMs - lastAt) / 1000 <= TTL_SECONDS[ttl];
      if (lastAt !== null) a.gaps.push((d.atMs - lastAt) / 1000);
      const read = isWarm ? Math.min(cached, ctx) : 0;
      const write = ctx - read;
      // The TTL is a property of the request, so both sides of the comparison are priced at the same one.
      const atReq = usageCostUsd(d.requestedTier!, u, ttl, d.requestedModel);
      // Same formula as usageCostUsd, with the request's own token counts replaced by this conversation's
      // modelled read/write split on the side tier (no separate uncached-input term: read+write cover it all).
      const atSide = usageCostUsd(tier, { input: 0, output: u.output, cacheRead: read, cacheCreate: write }, ttl);
      a.calls++;
      a.tokens += totalTokens(u);
      a.read += u.cacheRead;
      a.atReq += atReq;
      a.atSide += atSide;
      if (isWarm) {
        warm++;
        a.warm++;
      } else {
        cold++;
        a.cold++;
      }
      usdAtRequested += atReq;
      usdAtSide += atSide;
      cached = ctx;
      lastAt = d.atMs;
    }
  }

  const dominant: CacheTtl = opts.ttl !== undefined ? opts.ttl : ttlsSeen.filter((t) => t === "1h").length * 2 > ttlsSeen.length ? "1h" : ASSUMED_TTL;
  const readRate = cacheReadRate(tier);
  // Break-even against the cache-read rate of the model these calls asked for (the most common one; Opus when unknown).
  const reqModel = countBy(routable.filter((d) => d.requestedModel !== null), (d) => d.requestedModel!)[0]?.[0] ?? null;
  const perKind = [...perKindAcc.entries()]
    .map(([kind, v]) => ({
      kind,
      calls: v.calls,
      warm: v.warm,
      cold: v.cold,
      tokens: v.tokens,
      cacheReadShare: v.tokens === 0 ? 0 : v.read / v.tokens,
      gapP50: median(v.gaps),
      usdAtRequested: v.atReq,
      usdAtSide: v.atSide,
      overCeiling: v.over,
      overCeilingTokens: v.overTok,
    }))
    .filter((k) => k.calls > 0 || k.overCeiling > 0)
    .sort((a, b) => b.usdAtRequested - a.usdAtRequested || a.kind.localeCompare(b.kind));

  return {
    perKind,
    overCeiling: tooBig.length,
    overCeilingTokens: sum(tooBig.map((d) => totalTokens(d.usage!))),
    calls: routable.length,
    warm,
    cold,
    usdAtRequested,
    usdAtSide,
    tier,
    breakEven: breakEvenOf(cacheWriteRate(tier, dominant), cacheReadRate(tierOfModel(reqModel) ?? "opus", reqModel) - readRate),
    observedWarmPerCold: cold === 0 ? null : warm / cold,
    ttlAssumed: opts.ttl === undefined && decisions.every((d) => knownTtl(d) === null),
    convs: convExposure(decisions),
  };
}

/** Pure. Per conversation: was it ever routed below the requested tier, and what did each later up-move write. */
export function convExposure(decisions: readonly Dec[]): ConvExposure[] {
  const moves = classifyMoves(decisions);
  const byConv = new Map<string, { pinnedBelow: boolean; writes: number[] }>();
  for (const { move, dec } of moves) {
    const k = dec.conv!;
    const e = byConv.get(k) ?? { pinnedBelow: false, writes: [] };
    if (move === "down") e.pinnedBelow = true;
    if (move === "up_one_tier" || move === "back_to_requested") e.writes.push(dec.usage!.cacheCreate);
    byConv.set(k, e);
  }
  return [...byConv.entries()]
    .map(([conv, e]) => ({ conv, pinnedBelow: e.pinnedBelow, upMoves: e.writes.length, upMoveCacheWrites: e.writes }))
    .filter((c) => c.pinnedBelow || c.upMoves > 0)
    .sort((a, b) => b.upMoves - a.upMoves || a.conv.localeCompare(b.conv));
}

/** 12. What routing the go-list side kinds to a shared cheaper tier would have cost on this log. */
export function s12SideRouting({ rec, usd: showUsd }: Ctx): string[] {
  const d = rec.decisions;
  const primary = sideRoutingEstimate(d, { tier: SIDE_TIER_CANDIDATES[0]! });
  if (primary.calls === 0 && primary.overCeiling === 0) return ["  (no routable side calls with usage in range)"];

  const out = [
    `  ESTIMATE, not a measurement: what sending ${SIDE_ROUTABLE_KINDS.join(", ")} to one shared cheaper tier would have cost, over the tokens actually recorded.`,
    "  A call is warm only when the previous routable side call of the same conversation was inside the cache TTL; nothing else would keep that tier warm. Cold calls pay a full write of the whole prompt.",
    "  A call whose prompt exceeds the target tier's context ceiling cannot be routed there at all and is counted under \"over ceiling\", never in the saving.",
  ];

  // Both candidate tiers, both TTLs, gross and net of the carve-out: the cheaper tier cannot hold the biggest calls,
  // so the comparison is not a simple price ordering and has to be shown rather than argued.
  // Price the TTL the log actually recorded when it says so; both only while it is still a question. A row for a TTL
  // the traffic never used is a what-if presented as a candidate, and reads as a choice that is not on the table.
  const measured = measuredTtl(d);
  const ttls = measured === null ? (["5m", "1h"] as const) : ([measured] as const);
  out.push("", `  candidates (net = conversations ever pinned below the requested tier carved out, removing the warm-cache interaction)${measured === null ? ", at both cache TTLs since the log does not record one for these calls, or records both" : `, at the ${measured} cache TTL every priced side call in range reports`}:`);
  const rows: string[][] = [["tier", "ceiling", "TTL", "routable", "over ceiling", "$ at requested", "$ at tier", "$ saved gross", "$ saved net"]];
  for (const tier of SIDE_TIER_CANDIDATES) {
    for (const ttl of ttls) {
      const g = sideRoutingEstimate(d, { tier, ttl });
      const n = sideRoutingEstimate(d, { tier, ttl, excludePinnedBelow: true });
      rows.push([
        tier, ceilingOf(tier), ttl, int(g.calls), g.overCeiling === 0 ? "-" : int(g.overCeiling),
        usd(g.usdAtRequested), usd(g.usdAtSide), usd(g.usdAtRequested - g.usdAtSide), usd(n.usdAtRequested - n.usdAtSide),
      ]);
    }
  }
  out.push(...table(rows, "    "));

  // Per kind, for each tier at the TTL each record implies: what is reachable and what is not.
  for (const tier of SIDE_TIER_CANDIDATES) {
    const e = sideRoutingEstimate(d, { tier });
    out.push("", `  ${tier} (ceiling ${ceilingOf(tier)}; TTL per request${e.ttlAssumed ? `, none recorded so ${ASSUMED_TTL} assumed` : ""}):`);
    out.push(
      ...table([
        ["side kind", "routable", "warm", "cold", "over ceiling", "tokens", "cache read", "gap p50", ...(showUsd ? ["$ at requested", "$ at tier", "$ saved"] : [])],
        ...e.perKind.map((k) => [
          k.kind, int(k.calls), int(k.warm), int(k.cold), k.overCeiling === 0 ? "-" : `${int(k.overCeiling)} (${int(k.overCeilingTokens)} tok)`,
          int(k.tokens), k.calls === 0 ? "-" : pct(k.cacheReadShare, 1), k.gapP50 === null ? "-" : `${int(Math.round(k.gapP50))} s`,
          ...(showUsd ? [usd(k.usdAtRequested), usd(k.usdAtSide), usd(k.usdAtRequested - k.usdAtSide)] : []),
        ]),
      ], "    "),
    );
    const withRoutable = e.perKind.filter((k) => k.calls > 0);
    for (const k of e.perKind.filter((x) => x.calls === 0)) out.push(`    ${k.kind}: NOT ROUTABLE - all ${int(k.overCeiling)} calls exceed the ceiling (${int(k.overCeilingTokens)} tokens).`);
    // The amortisation rule only decides kinds whose cost IS the cached prefix; below that a cheaper tier wins on
    // price alone and quoting the rule would let a small-context kind look like a loss while it saves money.
    for (const k of withRoutable.filter((x) => x.cacheReadShare >= PREFIX_DOMINATED_SHARE)) {
      const r = k.cold === 0 ? null : k.warm / k.cold;
      out.push(`    ${k.kind}: ${r === null ? "no cold write" : `${r.toFixed(1)} warm per cold`} ${e.breakEven === null ? "with no break-even (a warm read saves nothing on this model)" : `against break-even ${e.breakEven.toFixed(1)}${r !== null && r < e.breakEven ? " - BELOW it" : ""}`}, ${k.usdAtRequested - k.usdAtSide >= 0 ? "saves" : "COSTS"} ${usd(Math.abs(k.usdAtRequested - k.usdAtSide))}`);
    }
    for (const k of withRoutable.filter((x) => x.cacheReadShare < PREFIX_DOMINATED_SHARE)) {
      out.push(`    ${k.kind}: ${pct(k.cacheReadShare, 1)} cache read - little prefix to lose, the amortisation rule does not apply; ${k.usdAtRequested - k.usdAtSide >= 0 ? "saves" : "COSTS"} ${usd(Math.abs(k.usdAtRequested - k.usdAtSide))}`);
    }
  }
  if (!showUsd) out.push("    (rerun with --usd for the per-kind dollar columns)");

  out.push("", "  exposure: only a conversation pinned below the requested tier can lose the free warm cache its side calls provide today (they would no longer bill the requested model).");
  const convs = primary.convs;
  out.push(`  conversations ever pinned below requested: ${convs.filter((c) => c.pinnedBelow).length} of ${new Set(d.map((x) => x.conv).filter((c) => c !== null)).size}`);
  if (convs.length === 0) out.push("    (no conversation was routed below the requested tier or moved up)");
  else
    out.push(
      ...table([
        ["conversation", "pinned below", "up-moves", "cache write on each up-move"],
        ...convs.map((c) => [c.conv.slice(0, 24), c.pinnedBelow ? "yes" : "no", int(c.upMoves), c.upMoveCacheWrites.map((w) => int(w)).join(", ") || "-"]),
      ], "    "),
    );
  return out;
}

// ---- 13. Escalations -------------------------------------------------------------------------------------------

export interface EscalationRow {
  /** The escalated turn's own decision. */
  readonly dec: Dec;
  /** `shadow`: REFLEX_ESCALATE=shadow recorded what it would have done and changed nothing. */
  readonly mode: "applied" | "shadow";
  readonly signal: string;
  readonly from: Tier | null;
  readonly to: Tier | null;
  /** The decision whose outcome window raised it; null when that record is not in this log. */
  readonly cause: Dec | null;
  /** The escalated turn's own outcome window, once it closed; null while it is still open or in a later log. */
  readonly outcome: OutcomeRec | null;
}

/**
 * Every turn REFLEX_ESCALATE raised, joined to the turn that caused it and to its own outcome window. Pure; a log with
 * the setting off produces an empty list, which is what makes this section free to ship.
 */
export function escalationRows(ctx: Ctx): EscalationRow[] {
  const byDecision = new Map<string, OutcomeRec>();
  for (const o of ctx.rec.outcomes) if (o.decisionId !== null && o.attribution !== "interjection") byDecision.set(o.decisionId, o);
  return ctx.rec.decisions
    .filter((d) => d.escalation !== null || d.wouldEscalate !== null)
    .map((d) => {
      const e = d.escalation ?? d.wouldEscalate!;
      return {
        dec: d,
        mode: d.escalation !== null ? "applied" : "shadow",
        signal: e.signal,
        from: e.from,
        to: e.to,
        cause: e.decisionId === null ? null : ctx.byId.get(e.decisionId) ?? null,
        outcome: byDecision.get(d.id) ?? null,
      };
    });
}

/** 13. What escalation did, and whether the turn it raised then went well. */
export function s13Escalations(ctx: Ctx): string[] {
  const rows = escalationRows(ctx);
  if (rows.length === 0) {
    return ["  no escalated turns in this log (REFLEX_ESCALATE is off by default; a turn is escalated only after a routed turn's outcome window closes with a signal)"];
  }
  const applied = rows.filter((r) => r.mode === "applied");
  const shadow = rows.filter((r) => r.mode === "shadow");
  const out = [`  ${rows.length} escalated turn${rows.length === 1 ? "" : "s"} (${applied.length} applied, ${shadow.length} shadow); "signal" is what the PREVIOUS routed turn on that conversation closed with`];
  if (shadow.length > 0) out.push("  shadow rows are REFLEX_ESCALATE=shadow: the tier was NOT changed, only what it would have been is recorded");
  out.push("", `  by signal: ${countBy(rows, (r) => r.signal).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  out.push(
    "",
    "  each escalated turn (tier before -> after is the policy's own pick vs what escalation planned; `sent` is what the guard and the rewrite finally allowed):",
    ...table([
      ["turn", "mode", "signal", "before", "after", "sent", "outcome window", "correction", "test failure", "revert"],
      ...rows.map((r) => [
        r.dec.id.slice(0, 8),
        r.mode,
        r.signal,
        tl(r.from),
        tl(r.to),
        tl(r.dec.sentTier),
        r.outcome === null ? "still open" : "closed",
        r.outcome === null ? "-" : r.outcome.correctionScore === null ? "not scored" : String(r.outcome.correctionScore),
        r.outcome === null ? "-" : r.outcome.testFailureAfterEdit ? "yes" : "no",
        r.outcome === null ? "-" : r.outcome.revertedInWindow ? "yes" : "no",
      ]),
    ], "    "),
  );
  const closed = applied.filter((r) => r.outcome !== null);
  const scored = closed.filter((r) => r.outcome!.correctionScore !== null);
  const bad = scored.filter((r) => r.outcome!.correctionScore! > 0).length;
  out.push("", `  of ${applied.length} APPLIED escalations, ${closed.length} window${closed.length === 1 ? "" : "s"} closed and ${scored.length} scored; ${bad} drew a correction`);
  if (scored.length < MIN_OUTCOME_N) out.push(`  insufficient data: n=${scored.length} < ${MIN_OUTCOME_N}; no rate is shown and none of this says whether escalation helps`);
  else out.push(`  correction > 0 after an escalation: ${pct(bad, scored.length)} of scored`);
  return out;
}
