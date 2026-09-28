import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { percentile } from "../../src/report/format.js";
import { buildReport, buildReportJson, reportCommand, type ReportJson } from "../../src/report/index.js";
import { parseDuration, parseRecords, sinceView } from "../../src/report/records.js";
import { breakEvenOf, classifyMoves, costOf, fingerprintGroups, hintArms, HARNESS_FEATURES, MIN_OUTCOME_N, outcomeGroups, s0Workflow, s1Decisions, s2MassVsArgmax, s3ShadowVsActual, s4Guard, s5Fallbacks, s8Cost, s11Fingerprints, s12SideRouting, s13Escalations, s14Effort, escalationRows, abArms, abComparison, abCostUnits, ratioInterval, harnessFeatureCost, SECTIONS, sideRoutingEstimate, workProfile, wouldRoute, type Ctx } from "../../src/report/sections.js";
import { at, dec, large, mixed, outcome, sideCallLog, singleTurnLongLoop, toJsonl, update, type Rec } from "../support/report-fixtures.js";

const GOLDEN_DIR = path.join("test", "fixtures", "report");
const parse = (text: string) => parseRecords([{ source: "test.jsonl", text }]);
const ctxOf = (text: string, usd = false): Ctx => {
  const rec = parse(text);
  return { rec, byId: new Map(rec.decisions.map((d) => [d.id, d])), usd };
};

/** Compares with test/fixtures/report/<name>.txt; UPDATE_GOLDEN=1 rewrites it (review the diff). */
function golden(name: string, actual: string): void {
  const file = path.join(GOLDEN_DIR, `${name}.txt`);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(file, actual);
  }
  assert.equal(actual, fs.readFileSync(file, "utf8"), `report differs from ${file} (UPDATE_GOLDEN=1 to accept)`);
}

describe("report: golden files", () => {
  it("empty input: every section is present and says there is nothing", () => {
    const out = buildReport(parse(""), { usd: false });
    for (const s of SECTIONS) assert.ok(out.includes(s.title), s.title);
    golden("empty", out);
  });
  it("a single record", () => {
    golden("single", buildReport(parse(toJsonl([dec({ id: "only", t: 0, probs: [1, 0, 0], pickMass: "haiku", sent: "haiku" })])), { usd: false }));
  });
  it("a mixed shadow + route log (usage headroom)", () => {
    golden("mixed", buildReport(parse(mixed()), { usd: false }));
  });
  it("the same log with --usd", () => {
    golden("mixed-usd", buildReport(parse(mixed()), { usd: true }));
  });
  it("a large log (6000 decisions) renders quickly and matches", () => {
    const text = large(6000);
    const started = Date.now();
    const out = buildReport(parse(text), { usd: true });
    assert.ok(Date.now() - started < 5000, "report over 6000 records takes under 5 s");
    golden("large", out);
  });
});

describe("report: optional harness features", () => {
  it("splits the two features sharing the notification side kind, by marker", () => {
    const lines = harnessFeatureCost(parse(sideCallLog()).decisions, true).join("\n");
    // The synthetic log has one session_recap and one task_notification, both side_kind `notification`.
    assert.match(lines, /Session recap\s+1\s/, lines);
    assert.doesNotMatch(lines, /upper bound/, "the row is exact now, not an upper bound");
    assert.match(lines, /awaySummaryEnabled/);
    assert.match(lines, /promptSuggestionEnabled/);
  });

  it("says what each cost, and without --usd points at the flag rather than silently omitting it", () => {
    const withUsd = harnessFeatureCost(parse(sideCallLog()).decisions, true).join("\n");
    assert.match(withUsd, /\$ at requested model/);
    const without = harnessFeatureCost(parse(sideCallLog()).decisions, false).join("\n");
    assert.doesNotMatch(without, /\$ at requested model/);
    assert.match(without, /rerun with --usd/, "the block promises a cost, so it must say how to see it");
  });

  it("always prints the block, with a zero row per feature, even when nothing is attributable", () => {
    // A missing block reads as "these features cost nothing"; a zero row says it was measured. The block vanished in
    // 0.2.3 on a log whose side calls carried no feature marker, which is exactly when it is most worth seeing.
    const none = toJsonl([dec({ id: "n1", t: 0, conv: "n", turn: "new" }), dec({ id: "n2", t: 10, conv: "n", turn: "side", side: "no_tools" })]);
    const lines = harnessFeatureCost(parse(none).decisions, true).join("\n");
    assert.match(lines, /optional Claude Code features/, lines);
    for (const f of HARNESS_FEATURES) assert.match(lines, new RegExp(`${f.feature}\\s+0\\s`), `${f.feature} has a zero row`);
    assert.match(lines, /awaySummaryEnabled/, "the switches are still named");
  });

  it("counts side calls that predate the marker separately instead of attributing them", () => {
    const old = toJsonl([
      dec({ id: "o1", t: 0, conv: "o", turn: "new" }),
      { ...dec({ id: "o2", t: 10, conv: "o", turn: "side", side: "notification" }), side_marker: null },
    ]);
    const lines = harnessFeatureCost(parse(old).decisions, true).join("\n");
    assert.match(lines, /1 side call\(s\) of these kinds carry no marker id/, lines);
  });
});

describe("report: side-call routing estimate", () => {
  it("break-even is null, not 2.5e9, when a warm read saves nothing (Sonnet 5 vs Opus 5.5: both $0.20/MTok)", () => {
    assert.equal(breakEvenOf(2.5, 0), null);
    assert.equal(breakEvenOf(2.5, -0.1), null);
    assert.equal(breakEvenOf(2.5, 0.5), 5);
  });
  const archiveDir = path.join(GOLDEN_DIR, "archives");
  it("golden: a synthetic log with warm clusters, a cold gap and an exposed conversation", () => {
    golden("side-routing-synthetic", s12SideRouting(ctxOf(sideCallLog(), true)).join("\n") + "\n");
  });
  it("golden: the archived real sessions", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    golden("side-routing-archives", s12SideRouting({ rec, byId: new Map(), usd: true }).join("\n") + "\n");
  });

  it("only go-list kinds count; cross_session and the rest are never estimated", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    assert.deepEqual(e.perKind.map((k) => k.kind).sort(), ["no_tools", "notification", "suggestion"]);
    assert.equal(e.calls, 6, "the cross_session call and both non-side turns are excluded");
  });

  it("warm follows the TTL: calls inside it reuse the prefix, one past it pays a full write again", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    // a-s1 cold (first), a-s2/a-s3/a-n1 warm, a-n2 cold (40 min later), a-t1 warm (10 s after a-n2)
    assert.equal(e.cold, 2);
    assert.equal(e.warm, 4);
  });

  it("a cold call is priced as a full write of the whole prompt, so it costs more than leaving it alone", () => {
    // One lone side call in its own conversation can never be warm: the estimate must not show it as a saving.
    const lone = toJsonl([dec({ id: "c-new", t: 0, conv: "c", turn: "new" }), dec({ id: "c-s", t: 10, conv: "c", turn: "side", side: "notification", usage: [2, 50, 100_000, 500] })]);
    const e = sideRoutingEstimate(parse(lone).decisions, { tier: "haiku" });
    assert.equal(e.warm, 0);
    assert.equal(e.cold, 1);
    assert.ok(e.usdAtSide > e.usdAtRequested, `a cold swap must cost more: at side ${e.usdAtSide}, at requested ${e.usdAtRequested}`);
  });

  it("exposure lists only conversations routed below requested or moving up, with each up-move's cache write", () => {
    const e = sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" });
    const b = e.convs.find((c) => c.conv === "conv-exposed-b");
    assert.ok(b, "the routed conversation is listed");
    assert.equal(b.pinnedBelow, true);
    assert.equal(b.upMoves, 1);
    assert.deepEqual(b.upMoveCacheWrites, [47_000]);
    assert.ok(!e.convs.some((c) => c.conv === "conv-side-a"), "a conversation that never moved tier is not exposed");
  });

  it("a call larger than the side tier's context ceiling is not routable and never counts as a saving", () => {
    // The biggest side calls in real logs are hundreds of thousands of tokens; haiku cannot hold them at all.
    const big = toJsonl([
      dec({ id: "d-new", t: 0, conv: "d", turn: "new" }),
      dec({ id: "d-s", t: 10, conv: "d", turn: "side", side: "notification", usage: [2, 50, 400_000, 500] }),
    ]);
    const e = sideRoutingEstimate(parse(big).decisions, { tier: "haiku" });
    assert.equal(e.calls, 0, "nothing is routable");
    assert.equal(e.overCeiling, 1);
    assert.equal(e.usdAtRequested - e.usdAtSide, 0, "an unroutable call contributes no saving either way");
    assert.equal(e.perKind.find((k) => k.kind === "notification")?.overCeiling, 1);
  });

  it("the target tier's ceiling decides what is routable: sonnet has none, haiku cannot hold a big call", () => {
    const big = toJsonl([
      dec({ id: "e-new", t: 0, conv: "e", turn: "new" }),
      dec({ id: "e-s", t: 10, conv: "e", turn: "side", side: "notification", usage: [2, 50, 400_000, 500] }),
    ]);
    const decs = parse(big).decisions;
    assert.equal(sideRoutingEstimate(decs, { tier: "haiku" }).calls, 0);
    assert.equal(sideRoutingEstimate(decs, { tier: "sonnet" }).calls, 1, "sonnet has no context ceiling");
  });

  it("the carve-out drops conversations ever pinned below the requested tier", () => {
    const decs = parse(sideCallLog()).decisions;
    const all = sideRoutingEstimate(decs, { tier: "sonnet" });
    const carved = sideRoutingEstimate(decs, { tier: "sonnet", excludePinnedBelow: true });
    assert.ok(all.calls > 0);
    assert.equal(carved.calls, all.calls, "conv-exposed-b has no side calls, so the carve-out removes none here");
    // A side call inside the routed conversation IS removed by the carve-out.
    const withSide = toJsonl([
      dec({ id: "f-new", t: 0, conv: "f", turn: "new", sent: "haiku", rewritten: true, usage: [10, 200, 0, 40_000] }),
      dec({ id: "f-s", t: 60, conv: "f", turn: "side", side: "notification", usage: [2, 50, 40_000, 400] }),
    ]);
    const d2 = parse(withSide).decisions;
    assert.equal(sideRoutingEstimate(d2, { tier: "sonnet" }).calls, 1);
    assert.equal(sideRoutingEstimate(d2, { tier: "sonnet", excludePinnedBelow: true }).calls, 0, "the routed conversation's side call is carved out");
  });

  it("forcing a TTL prices both sides at it and stops claiming it was assumed", () => {
    const decs = parse(sideCallLog()).decisions;
    const short = sideRoutingEstimate(decs, { tier: "sonnet", ttl: "5m" });
    const long = sideRoutingEstimate(decs, { tier: "sonnet", ttl: "1h" });
    assert.equal(short.ttlAssumed, false);
    assert.ok(long.warm >= short.warm, "a longer TTL can only keep more calls warm");
  });

  it("the candidates table prices only the measured TTL when every record agrees, both while it is unknown", () => {
    const decs = (ttl: boolean | null): string => toJsonl(sideCallLog().trim().split("\n").map((l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      return ttl === null ? o : { ...o, cache_ttl_beta: ttl };
    }));
    const rows = (log: string): string[] => s12SideRouting({ rec: parse(log), byId: new Map(), usd: true }).filter((l) => /^\s+(haiku|sonnet)\s+(150,000|none)\s+(5m|1h)\s/.test(l));
    const unknown = rows(decs(null));
    assert.equal(unknown.filter((r) => / 5m /.test(r)).length, 2, unknown.join("\n"));
    assert.equal(unknown.filter((r) => / 1h /.test(r)).length, 2, "both TTLs are candidates while the log cannot say");

    const measured = rows(decs(true));
    assert.equal(measured.filter((r) => / 1h /.test(r)).length, 2, measured.join("\n"));
    assert.equal(measured.filter((r) => / 5m /.test(r)).length, 0, "a TTL the traffic never used is not a candidate");
    assert.match(s12SideRouting({ rec: parse(decs(true)), byId: new Map(), usd: true }).join("\n"), /at the 1h cache TTL every priced side call in range reports/);
  });

  it("the TTL a request asked for (cache_ttl) wins over the beta flag, which only permits a 1-hour write", () => {
    const side = (o: Record<string, unknown>) => parse(toJsonl([{ ...dec({ id: "z", t: 0, conv: "z", turn: "side", side: "notification" }), ...o }])).decisions;
    const est = (o: Record<string, unknown>) => sideRoutingEstimate(side(o), { tier: "haiku" });
    assert.equal(est({ cache_ttl: "5m", cache_ttl_beta: true }).ttlAssumed, false);
    const log = (o: Record<string, unknown>): string => toJsonl(sideCallLog().trim().split("\n").map((l) => ({ ...(JSON.parse(l) as Record<string, unknown>), ...o })));
    const text = (o: Record<string, unknown>): string => s12SideRouting({ rec: parse(log(o)), byId: new Map(), usd: true }).join("\n");
    assert.match(text({ cache_ttl: "5m", cache_ttl_beta: true }), /at the 5m cache TTL every priced side call in range reports/, "the beta did not make these 1-hour writes");
    assert.match(text({ cache_ttl: null, cache_ttl_beta: true }), /at the 1h cache TTL/, "without cache_ttl, the older beta reading stands");
  });

  it("the TTL is flagged as assumed when no record logged the beta", () => {
    assert.equal(sideRoutingEstimate(parse(sideCallLog()).decisions, { tier: "haiku" }).ttlAssumed, true);
    const withBeta = toJsonl([{ ...dec({ id: "z", t: 0, conv: "z", turn: "side", side: "notification" }), cache_ttl_beta: true }]);
    assert.equal(sideRoutingEstimate(parse(withBeta).decisions, { tier: "haiku" }).ttlAssumed, false);
  });
});

describe("report: workflow profile", () => {
  const archiveDir = path.join(GOLDEN_DIR, "archives");
  it("golden: the archived real sessions (structural copies, scripts/report/strip-archive.mjs)", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    assert.ok(files.length >= 6, "the six archived logs are present");
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    golden("workflow-archives", s0Workflow({ rec, byId: new Map(), usd: false }).join("\n") + "\n");
  });
  it("golden: a single-turn, long-loop log shaped like the first real-work dogfood", () => {
    golden("workflow-single-turn-long-loop", s0Workflow(ctxOf(singleTurnLongLoop())).join("\n") + "\n");
  });
  it("single-turn long loops judged opus: nothing is touchable, continuations carry the tokens", () => {
    const p = workProfile(parse(singleTurnLongLoop()).decisions);
    assert.deepEqual(p.requests, { new: 2, continuation: 43, subagent: 0, side: 5 });
    assert.equal(p.tokens.side, 2 * 226_310 + 3 * 40_053);
    assert.equal(p.touchable, 0);
    assert.equal(p.units, 2);
    const out = s0Workflow(ctxOf(singleTurnLongLoop())).join("\n");
    assert.match(out, /routing can touch at most 0\.0% of your tokens; - of that is in subagents/);
  });
  it("a turn planned below the requested tier makes its whole loop touchable; subagent share is of the touchable part", () => {
    const S = "eeeeeeeeeeeeeeee";
    const M = `${S}:m:0000000000000001`;
    const A = `${S}:a:0000000000000002`;
    const text = toJsonl([
      dec({ id: "m1", t: 0, session: S, conv: M, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 100] }),
      dec({ id: "m2", t: 1, session: S, conv: M, turn: "continuation", usage: [0, 0, 0, 100] }),
      dec({ id: "a1", t: 2, session: S, conv: A, kind: "subagent", probs: [0, 1, 0], pickMass: "sonnet", planTier: "sonnet", usage: [0, 0, 0, 200] }),
      dec({ id: "a2", t: 3, session: S, conv: A, kind: "subagent", turn: "continuation", usage: [0, 0, 0, 200] }),
      dec({ id: "m3", t: 4, session: S, conv: M, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", usage: [0, 0, 0, 50] }),
      dec({ id: "m4", t: 5, session: S, conv: M, turn: "continuation", usage: [0, 0, 0, 50] }),
      dec({ id: "sd", t: 6, session: S, conv: M, turn: "side", side: "suggestion", usage: [0, 0, 0, 300] }),
      dec({ id: "x1", t: 7, session: S, conv: "orphan", turn: "continuation", usage: [0, 0, 0, 0] }),
      dec({ id: "g1", t: 8, session: S, conv: "guarded", planTier: null, guard: { allowed: false, reason: "over_limit", penalty: 0.1 }, reasons: ["guard_blocked"], usage: [0, 0, 0, 0] }),
    ]);
    const p = workProfile(parse(text).decisions);
    assert.equal(p.total, 1000);
    assert.equal(p.touchable, 500, "the subagent loop (400) and the second main turn with its continuation (100); the first turn and the side call are not");
    assert.equal(p.touchableSubagent, 400);
    assert.equal(p.orphanContinuations, 1);
    assert.equal(p.undecidedNew, 1);
    assert.match(s0Workflow(ctxOf(text)).join("\n"), /routing can touch at most 50\.0% of your tokens; 80\.0% of that is in subagents/);
  });
});

describe("report: delegation hint split", () => {
  // Session H (hint on): two user turns, a subagent carries most tokens. Session N (off): one turn, a long loop.
  const text = (): string => {
    const H = "hhhhhhhhhhhhhhhh";
    const N = "nnnnnnnnnnnnnnnn";
    const hinted = (r: Rec): Rec => ({ ...r, delegate_hint: "delegate-1" });
    return toJsonl([
      hinted(dec({ id: "h1", t: 0, session: H, conv: `${H}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] })),
      hinted(dec({ id: "h2", t: 1, session: H, conv: `${H}:a:2`, kind: "subagent", probs: [0, 1, 0], pickMass: "sonnet", planTier: "sonnet", usage: [0, 0, 0, 3000] })),
      hinted(dec({ id: "h3", t: 2, session: H, conv: `${H}:a:2`, kind: "subagent", turn: "continuation", usage: [0, 0, 0, 3000] })),
      hinted(dec({ id: "h4", t: 3, session: H, conv: `${H}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] })),
      hinted(dec({ id: "h5", t: 4, session: H, conv: `${H}:m:1`, turn: "side", side: "suggestion", usage: [0, 0, 0, 2000] })),
      { v: 1, record: "delegate_hint", id: "dh1", at: at(0), session: H, version: "delegate-1" },
      { v: 1, record: "delegate_hint", id: "dh2", at: at(3), session: H, version: "delegate-1" },
      dec({ id: "n1", t: 10, session: N, conv: `${N}:m:1`, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 1000] }),
      dec({ id: "n2", t: 11, session: N, conv: `${N}:m:1`, turn: "continuation", usage: [0, 0, 0, 4000] }),
    ]);
  };
  it("arms by hint version: sessions, delivered hints, user turns, tokens, subagent and side shares", () => {
    const arms = hintArms(parse(text()));
    assert.deepEqual(arms.map((a) => [a.hint, a.sessions, a.delivered, a.userTurns, a.tokens, a.subagentTokens, a.sideTokens]), [
      ["off", 1, 0, 1, 5000, 0, 0],
      ["delegate-1", 1, 2, 2, 10000, 6000, 2000],
    ]);
    assert.ok(arms.every((a) => a.usdAtSent > 0));
  });
  it("the profile shows tokens and $ per user turn by hint; section 8 compares with and without, marking n", () => {
    const profile = s0Workflow(ctxOf(text())).join("\n");
    assert.match(profile, /delegate-1\s+1\s+2\s+2\s+10,000\s+5,000\s+\$\S+\s+\$\S+\s+60\.0%\s+20\.0%/);
    assert.match(profile, /off\s+1\s+-\s+1\s+5,000\s+5,000/);
    const s8 = s8Cost(ctxOf(text())).join("\n");
    assert.match(s8, /delegation \(all requests incl\. side calls.*too few to compare\): with delegate-1 \(n=1 session, 2 user turns\): subagent share 60\.0%, 5,000 tokens per user turn; without \(n=1 session, 1 user turn\): subagent share 0\.0%, 5,000 tokens per user turn/);
    assert.match(s8Cost(ctxOf(text(), true)).join("\n"), /5,000 tokens and \$\S+ per user turn/);
    assert.match(s8Cost(ctxOf(singleTurnLongLoop())).join("\n"), /delegation: no session ran with the hint/);
  });
  it("delegate_hint records are counted in the header, not as unknown records", () => {
    const out = buildReport(parse(text()), { usd: false });
    assert.match(out, /2 delegate_hint/);
    assert.doesNotMatch(out, /of an unknown type/);
  });
});

describe("report: reading", () => {
  it("counts lines that are not records and ignores unknown record types, without failing", () => {
    const r = parse(mixed());
    assert.equal(r.skippedLines, 1);
    assert.equal(r.unterminatedLines, 0);
    assert.equal(r.other, 1);
    assert.equal(r.decisions.length, 8 + 14);
  });
  it("ignores an unterminated last line (a log being written) and counts it as skipped; the next read has it", () => {
    const a = JSON.stringify(dec({ id: "a", t: 0 }));
    const full = JSON.stringify(dec({ id: "b", t: 1, error: "x".repeat(900) }));
    const torn = full.slice(0, 954); // cut mid-string, the shape of the CI failure
    const r = parse(`${a}\n${torn}`);
    assert.deepEqual(r.decisions.map((d) => d.id), ["a"]);
    assert.equal(r.skippedLines, 1);
    assert.equal(r.unterminatedLines, 1);
    assert.match(buildReport(r, { usd: false }), /skipped 1 line\(s\): 0 not valid records, 1 unterminated last line\(s\) \(still being written/);
    const later = parse(`${a}\n${full}\n`);
    assert.deepEqual(later.decisions.map((d) => d.id), ["a", "b"]);
    assert.equal(later.skippedLines, 0);
  });
  it("skips a last line that has no newline even if it happens to parse, and counts it separately per file", () => {
    const line = JSON.stringify(dec({ id: "only", t: 0 }));
    const r = parseRecords([{ source: "live", text: `${JSON.stringify(dec({ id: "a", t: 0 }))}\n${line}` }, { source: "rotated", text: `${JSON.stringify(dec({ id: "c", t: 2 }))}\nnot json\n` }]);
    assert.deepEqual(r.decisions.map((d) => d.id), ["a", "c"]);
    assert.equal(r.unterminatedLines, 1);
    assert.equal(r.skippedLines, 2, "the unterminated line plus one complete line that is not JSON");
    assert.match(buildReport(r, { usd: false }), /skipped 2 line\(s\): 1 not valid records, 1 unterminated last line\(s\)/);
  });
  it("reads records from before M4 (no `record` field, no pick_mass, no connection)", () => {
    const legacy = { v: 1, id: "old", at: at(0), session: "s", conv: "s:m:1", kind: "main", turn: "new", side_kind: null, mode_requested: "shadow", mode_effective: "shadow", requested: { model: "claude-opus-5", tier: "opus" }, forwarded: { model: "claude-opus-5", rewritten: false, fallback: false }, upstream: { status: 200, msToHeaders: 1000 }, usage: { input: 1, output: 2, cache_read: 3, cache_create: 4 }, decision: { picks: { tier: { value: "haiku", confidence: 0.99, probabilities: { haiku: 1 } } }, vetoes: {}, latencyMs: 800, tokensIn: 1, backendModel: "jev" }, plan: { target: { tier: "haiku" }, would_route_to: "claude-haiku-4-5-20251001", routed_to: "claude-opus-5", reasons: ["guard_not_evaluated", "downgrade"], would_upgrade: false } };
    const r = parse(toJsonl([legacy]));
    assert.equal(r.decisions.length, 1);
    assert.equal(r.decisions[0]!.pickMass, null);
    assert.equal(r.decisions[0]!.connection, null);
    assert.equal(r.decisions[0]!.planTier, "haiku");
    assert.match(buildReport(r, { usd: false }), /0 log both readings/);
  });
  it("counts a record once when it appears in a live file and its archived copy", () => {
    const text = toJsonl([dec({ id: "dup", t: 0 })]);
    assert.equal(parseRecords([{ source: "a", text }, { source: "b", text }]).decisions.length, 1);
  });
  it("parseDuration accepts s/m/h/d and nothing else", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("7d"), 604_800_000);
    for (const bad of ["", "2", "h", "2 weeks", "-1h", "1.5h"]) assert.equal(parseDuration(bad), null, bad);
  });
  it("percentile is nearest-rank", () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([5], 95), 5);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([4, 1, 3, 2], 75), 3);
    assert.equal(percentile([1, 2, 3, 4], 95), 4);
  });
});

describe("report: section numbers", () => {
  it("wouldRoute: mass takes its pick; argmax moves down only at confidence >= 0.7; neither goes above the requested tier", () => {
    const d = (o: Partial<Parameters<typeof dec>[0]>) => parse(toJsonl([dec({ id: "x", t: 0, probs: [0, 1, 0], ...o })])).decisions[0]!;
    assert.equal(wouldRoute("mass", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.3 })), "sonnet");
    assert.equal(wouldRoute("argmax", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.3 })), "opus");
    assert.equal(wouldRoute("argmax", d({ pickMass: "sonnet", pickArgmax: "haiku", confidence: 0.9 })), "haiku");
    assert.equal(wouldRoute("mass", d({ requested: "sonnet", pickMass: "opus", pickArgmax: "opus" })), "sonnet");
  });

  it("cache moves follow the session B pattern: down writes the whole context, up short of requested writes more than back to requested", () => {
    const S = "cccccccccccccccc:m:1";
    const rows = [
      dec({ id: "1", t: 0, conv: S, sent: "haiku", usage: [1, 1, 0, 63689] }),
      dec({ id: "2", t: 10, conv: S, turn: "continuation", sent: "haiku", usage: [1, 1, 63689, 7557] }),
      dec({ id: "3", t: 20, conv: S, sent: "sonnet", usage: [1, 1, 61130, 13385] }),
      dec({ id: "4", t: 30, conv: S, sent: "opus", usage: [1, 1, 74398, 5924] }),
      dec({ id: "5", t: 40, conv: S, sent: "opus", usage: [1, 1, 74398, 60] }),
      dec({ id: "6", t: 41, conv: S, turn: "side", sent: "opus", usage: [1, 1, 74398, 60] }),
    ];
    const moves = classifyMoves(parse(toJsonl(rows)).decisions);
    assert.deepEqual(moves.map((m) => [m.dec.id, m.move]), [["1", "down"], ["3", "up_one_tier"], ["4", "back_to_requested"], ["5", "stayed"]]);
  });

  it("cost prices the same tokens at the sent and the requested model", () => {
    const d = parse(toJsonl([dec({ id: "1", t: 0, sent: "haiku", usage: [1_000_000, 0, 0, 0] }), dec({ id: "2", t: 1, usage: [1_000_000, 0, 0, 0] })])).decisions;
    const c = costOf(d);
    assert.equal(c.n, 2);
    assert.equal(c.atSentUsd, 1 + 5); // haiku $1/M input + opus $5/M input
    assert.equal(c.atRequestedUsd, 5 + 5);
  });

  it("outcomes are joined to their decision: routed vs unchanged, later reverts counted, no-decision windows say why", () => {
    const text = toJsonl([
      dec({ id: "R", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku" }),
      dec({ id: "U", t: 1, probs: [0, 0, 1] }),
      outcome({ id: "o1", t: 5, decision: "R", edits: 1 }),
      outcome({ id: "o2", t: 6, decision: "U", edits: 1, testFailure: true }),
      outcome({ id: "o3", t: 7, decision: null }),
      update("u1", 8, "R"),
    ]);
    const g = outcomeGroups(ctxOf(text));
    const by = (arm: string) => g.find((x) => x.arm === arm)!;
    assert.equal(by("routed").windows.length, 1);
    assert.equal(by("routed").reverted.size, 1);
    assert.equal(by("unchanged").windows[0]!.testFailureAfterEdit, true);
    assert.equal(by("no decision").windows[0]!.noDecisionReason, "no_wire_turn");
  });

  it(`shows no rates below n=${MIN_OUTCOME_N} and says so; shows them at the minimum`, () => {
    const mk = (n: number): string => {
      const rows: Rec[] = [dec({ id: "U", t: 0, probs: [0, 0, 1] })];
      for (let i = 0; i < n; i++) rows.push(outcome({ id: `o${i}`, t: 1 + i, decision: "U", edits: 1, score: 0 }));
      return toJsonl(rows);
    };
    const small = buildReport(parse(mk(MIN_OUTCOME_N - 1)), { usd: false });
    assert.match(small, /insufficient data: n=19 < 20; no rates shown/);
    assert.doesNotMatch(small, /rates: correction/);
    assert.match(buildReport(parse(mk(MIN_OUTCOME_N)), { usd: false }), /rates: correction > 0 in 0\.0% of scored/);
  });

  it("timed-out decisions are checked against deadline + grace: within, exceeded, and unverifiable (no timing block)", () => {
    const rows = (wait: number | null): string =>
      toJsonl([dec({ id: "t", t: 0, error: "backend:timeout", reasons: [], planTier: null, ...(wait === null ? { legacyTiming: true } : { wait }) })]);
    assert.match(buildReport(parse(rows(1500)), { usd: false }), /timed-out decisions in route mode: 1; 1 with timing, longest wait 1,500 ms, deadline 1500 ms \+ 250 ms grace: all within/);
    assert.match(buildReport(parse(rows(1750)), { usd: false }), /all within/, "the bound itself is allowed");
    assert.match(buildReport(parse(rows(1751)), { usd: false }), /1 EXCEEDED it/);
    assert.match(buildReport(parse(rows(null)), { usd: false }), /timed-out decisions in route mode: 1; 0 with timing \(cannot be checked against the deadline/);
  });

  it("the latency section shows the decision wait and the upstream first byte, and counts records that predate them", () => {
    const text = toJsonl([
      dec({ id: "a", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku", wait: 400, msToHeaders: 1000 }),
      dec({ id: "b", t: 1, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku", legacyTiming: true, msToHeaders: 2000 }),
    ]);
    const out = buildReport(parse(text), { usd: false });
    assert.match(out, /routed \(after a decision\)\s+2\s+1,000 ms\s+2,000 ms\s+400 ms\s+400 ms\s+600 ms\s+600 ms/);
    assert.match(out, /1 of 2 of these records predate the timing block/);
  });

  it("side calls are never attributed to the routed model", () => {
    const text = toJsonl([dec({ id: "1", t: 0, sent: "haiku", usage: [0, 0, 0, 1000] }), dec({ id: "2", t: 1, turn: "side", usage: [0, 0, 0, 5000] })]);
    const out = buildReport(parse(text), { usd: false });
    assert.match(out, /9\. Side-call usage\n {2}1 side calls[^\n]*\n[^\n]*\n {4}suggestion\s+1\s+5,000/);
    assert.match(out, /side calls sent to a model other than the requested one: 0\n/);
    assert.match(out, /routed only\s+1\s+1,000/); // section 8 holds only the 1000 routed tokens
  });

  it("--since keeps the outcome-to-decision join even when the decision is out of range", () => {
    const rows = [dec({ id: "old", t: 0, sent: "haiku", probs: [1, 0, 0], pickMass: "haiku" }), outcome({ id: "o1", t: 100, decision: "old", edits: 1 })];
    const all = parse(toJsonl(rows));
    const out = buildReport(all, { usd: false, fromMs: Date.parse(at(50)) });
    assert.match(out, /records in range: 0 decisions, 1 outcomes/);
    assert.match(out, /main \/ routed: 1 window/);
  });
});

describe("reflex report (command)", () => {
  const run = (args: string[], env: NodeJS.ProcessEnv, now?: number) => {
    let stdout = "";
    let stderr = "";
    const code = reportCommand(args, { env, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), ...(now !== undefined ? { now: () => now } : {}) });
    return { code, stdout, stderr };
  };
  const home = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-report-"));

  it("reads decisions.jsonl and its rotations under REFLEX_HOME and prints all ten sections", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "decisions.jsonl"), toJsonl([dec({ id: "a", t: 10 })]));
    fs.writeFileSync(path.join(h, "decisions.jsonl.1"), toJsonl([dec({ id: "b", t: 0 })]));
    const r = run([], { REFLEX_HOME: h });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /records in range: 2 decisions/);
    for (const s of SECTIONS) assert.ok(r.stdout.includes(s.title), s.title);
  });
  it("without a log it still prints every section, and says where it looked", () => {
    const r = run([], { REFLEX_HOME: home() });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /no decision log at/);
    for (const s of SECTIONS) assert.ok(r.stdout.includes(s.title), s.title);
  });
  it("--since filters by time, --usd adds dollar columns", () => {
    const h = home();
    const file = path.join(h, "d.jsonl");
    fs.writeFileSync(file, toJsonl([dec({ id: "old", t: 0, sent: "haiku" }), dec({ id: "new", t: 7000, sent: "haiku" })]));
    const now = Date.parse(at(7200));
    const r = run(["--since", "1h", "--usd", file], {}, now);
    assert.match(r.stdout, /records in range: 1 decisions/);
    assert.match(r.stdout, /\$ at requested/);
    assert.doesNotMatch(run([file], {}).stdout, /\$ at requested/);
  });
  it("rejects a bad --since and an unknown option (exit 2), and an unreadable file (exit 1)", () => {
    assert.equal(run(["--since", "soon"], {}).code, 2);
    assert.equal(run(["--since"], {}).code, 2);
    assert.equal(run(["--nope"], {}).code, 2);
    const r = run([path.join(home(), "missing.jsonl")], {});
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot read/);
  });
  it("--json emits the same sections as one JSON object, keyed by section number, and leaves the text report untouched", () => {
    const h = home();
    const file = path.join(h, "d.jsonl");
    fs.writeFileSync(file, toJsonl([dec({ id: "only", t: 0, probs: [1, 0, 0], pickMass: "haiku", sent: "haiku" })]));
    const text = run([file], {}).stdout;
    const r = run(["--json", file], {});
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout) as ReportJson;
    for (const s of SECTIONS) {
      assert.ok(Object.hasOwn(out.sections, s.id), s.id);
      assert.equal(out.sections[s.id]!.title, s.title);
      assert.deepEqual(out.sections[s.id]!.lines, s.run({ rec: parseRecords([{ source: file, text: fs.readFileSync(file, "utf8") }]), byId: new Map(), usd: false }));
    }
    assert.equal(out.counts.decisions, 1);
    assert.ok(out.span !== null);
    // The text report is built independently and must not change shape because --json exists.
    assert.match(text, /reflex report/);
    for (const s of SECTIONS) assert.ok(text.includes(s.title), s.title);
  });
  it("--json and --fingerprints together are rejected (exit 2); each alone still works", () => {
    const h = home();
    const file = path.join(h, "d.jsonl");
    fs.writeFileSync(file, toJsonl([dec({ id: "only", t: 0 })]));
    assert.equal(run(["--json", "--fingerprints", file], {}).code, 2);
    assert.equal(run(["--json", file], {}).code, 0);
    assert.equal(run(["--fingerprints", file], {}).code, 0);
  });
  it("--json --usd includes the same dollar-formatted lines as the text report with --usd", () => {
    const h = home();
    const file = path.join(h, "d.jsonl");
    fs.writeFileSync(file, toJsonl([dec({ id: "1", t: 0, sent: "haiku", usage: [0, 0, 0, 1000] })]));
    const text = run(["--usd", file], {}).stdout;
    const out = JSON.parse(run(["--json", "--usd", file], {}).stdout) as ReportJson;
    const s8 = out.sections["8"]!.lines.join("\n");
    assert.match(s8, /\$ at requested/);
    assert.match(text, /\$ at requested/);
  });
  it("makes no network connection and writes nothing (it only reads)", () => {
    const h = home();
    fs.writeFileSync(path.join(h, "decisions.jsonl"), toJsonl([dec({ id: "a", t: 0 })]));
    const before = fs.readdirSync(h);
    run([], { REFLEX_HOME: h });
    assert.deepEqual(fs.readdirSync(h), before);
  });
});

describe("report: --json schema", () => {
  const archiveDir = path.join(GOLDEN_DIR, "archives");

  /**
   * Structural checks that must hold for `--json` on any input: field types, `sections` keyed by section
   * number (matching the text report's own numbering) for every entry in `SECTIONS`, in order and nothing
   * else, each carrying its title and lines identical to running that section directly on the same
   * (already time-filtered) records — so the JSON view cannot silently drift from what `SECTIONS[i].run`
   * actually computes or from the number the text report prints beside the same title.
   */
  function assertSchema(out: ReportJson, rec: ReturnType<typeof parseRecords>, usd: boolean): void {
    assert.ok(Array.isArray(out.files));
    for (const f of out.files) assert.equal(typeof f, "string");
    const counts = out.counts;
    for (const k of ["decisions", "outcomes", "outcomeUpdates", "harnessInjected", "delegateHints", "sessions"] as const) {
      assert.equal(typeof counts[k], "number", k);
      assert.ok(Number.isInteger(counts[k]) && counts[k] >= 0, k);
    }
    assert.equal(counts.decisions, rec.decisions.length);
    assert.equal(counts.outcomes, rec.outcomes.length);
    if (out.span === null) {
      assert.equal(rec.decisions.length + rec.outcomes.length, 0, "span is null only when there is nothing to span");
    } else {
      assert.equal(typeof out.span.from, "string");
      assert.equal(typeof out.span.to, "string");
      assert.ok(!Number.isNaN(Date.parse(out.span.from)), "span.from is a valid date");
      assert.ok(!Number.isNaN(Date.parse(out.span.to)), "span.to is a valid date");
      assert.ok(Date.parse(out.span.from) <= Date.parse(out.span.to));
    }
    for (const k of ["skippedLines", "unterminatedLines", "otherRecords"] as const) assert.equal(typeof out[k], "number", k);
    assert.deepEqual(Object.keys(out.sections), SECTIONS.map((s) => s.id), "sections are keyed by number, in order, exactly matching SECTIONS, and nothing else");
    const ctx: Ctx = { rec, byId: new Map(rec.decisions.map((d) => [d.id, d])), usd };
    for (const s of SECTIONS) {
      const entry = out.sections[s.id];
      assert.ok(entry, s.id);
      assert.equal(entry.title, s.title, s.id);
      assert.ok(Array.isArray(entry.lines), s.id);
      for (const line of entry.lines) assert.equal(typeof line, "string", s.id);
      assert.deepEqual(entry.lines, s.run(ctx), `section ${s.id}: --json content must match running the section directly`);
      // The number the text report prints beside this title is the same number this section is keyed by in JSON.
      assert.ok(s.title.startsWith(`${s.id}.`), `${s.title} must start with its own id ${s.id}`);
    }
    // No cycles, no functions, no undefined slipping through: what json.parse(stringify(out)) gives back is out itself.
    assert.deepEqual(JSON.parse(JSON.stringify(out)) as unknown, out);
  }

  it("empty log: valid schema, null span, zero counts, every section still present", () => {
    const rec = parse("");
    const out = buildReportJson(rec, { usd: false });
    assertSchema(out, rec, false);
    assert.equal(out.span, null);
    assert.deepEqual(out.counts, { decisions: 0, outcomes: 0, outcomeUpdates: 0, harnessInjected: 0, delegateHints: 0, sessions: 0 });
    assert.deepEqual(out.files, ["test.jsonl"], "the fixture's source name, from Records.sources");
  });

  it("the archived real sessions, concatenated: valid schema at both --usd settings", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    assert.ok(files.length >= 6, "the six archived logs are present");
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    assert.ok(rec.decisions.length > 0, "the archives are not empty");
    for (const usd of [false, true]) assertSchema(buildReportJson(rec, { usd }), rec, usd);
  });

  it("each archived log read on its own: valid schema", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const rec = parseRecords([{ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") }]);
      assertSchema(buildReportJson(rec, { usd: false }), rec, false);
    }
  });

  it("--since narrows counts and span but the schema, and the section content it applies to, hold the same", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort();
    const all = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(path.join(archiveDir, f), "utf8") })));
    const times = all.decisions.map((d) => d.atMs);
    const fromMs = Math.round((Math.min(...times) + Math.max(...times)) / 2);
    const out = buildReportJson(all, { usd: false, fromMs, sinceText: "test" });
    assert.equal(out.since, "test");
    assert.ok(out.counts.decisions > 0 && out.counts.decisions < all.decisions.length, "the cut actually narrows the set");
    assertSchema(out, sinceView(all, fromMs), false);
  });

  it("through the CLI, --json output parses and matches buildReportJson on the same files", () => {
    const files = fs.readdirSync(archiveDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => path.join(archiveDir, f));
    let stdout = "";
    const code = reportCommand(["--json", "--usd", ...files], { env: {}, stdout: (t) => (stdout += t), stderr: () => {} });
    assert.equal(code, 0);
    const out = JSON.parse(stdout) as ReportJson;
    const rec = parseRecords(files.map((f) => ({ source: f, text: fs.readFileSync(f, "utf8") })));
    assertSchema(out, rec, true);
    assert.deepEqual(out, buildReportJson(rec, { usd: true }));
  });
});


// Sections 1, 4, 5 and 11 had no test of their own (only whole-report golden files, which pin the wording of a
// section but assert nothing about what it counts); 2 and 3 had their shared `wouldRoute` helper tested but never
// their own output. These cover what each section computes, not how it is worded.

describe("report: 1. decisions by kind, turn and tier", () => {
  const log = (): string =>
    toJsonl([
      dec({ id: "m1", t: 0, kind: "main", turn: "new", sent: "haiku" }),
      dec({ id: "m2", t: 1, kind: "main", turn: "continuation", sent: "haiku" }),
      dec({ id: "m3", t: 2, kind: "main", turn: "side", side: "suggestion" }),
      dec({ id: "m4", t: 3, kind: "main", turn: "side", side: "notification", sideMarker: "session_recap" }),
      dec({ id: "a1", t: 4, kind: "subagent", turn: "new", sent: "sonnet" }),
    ]);

  it("counts every kind against every turn, and shows only the turn columns the log actually has", () => {
    const out = s1Decisions(ctxOf(log())).join("\n");
    assert.match(out, /5 classified requests/);
    assert.match(out, /main\s+1\s+1\s+2/, out); // new, continuation, side
    assert.match(out, /subagent\s+1\s+0\s+0/, out);
    assert.doesNotMatch(out, /unknown/, "no record has an unknown turn or kind, so neither column appears");
  });

  it("names the side kinds, and maps requested tier to the tier actually sent", () => {
    const out = s1Decisions(ctxOf(log())).join("\n");
    assert.match(out, /side calls by kind: notification 1, suggestion 1/, "ties are ordered by kind name (countBy), not by first appearance");
    // Everything requested opus; two went to haiku, one to sonnet, two stayed.
    assert.match(out, /opus\s+2\s+1\s+2/, out);
  });

  it("says `none` for degraded and drift rather than omitting the line", () => {
    const out = s1Decisions(ctxOf(log())).join("\n");
    assert.match(out, /degraded: none/);
    assert.match(out, /drift: none/);
  });

  it("a drift record is reported as a classifier alarm, and says routing was not changed", () => {
    const text = toJsonl([
      { ...dec({ id: "d1", t: 0 }), drift: "typed_prompts_without_new_turns" },
      { ...dec({ id: "d3", t: 2 }), drift: "unseen_requested_model,unseen_max_tokens" },
      { ...dec({ id: "d4", t: 3 }), drift: "rewrite_rejected" },
      dec({ id: "d2", t: 1, degraded: "version_unknown" }),
    ]);
    const out = s1Decisions(ctxOf(text)).join("\n");
    assert.match(out, /degraded: version_unknown 1/);
    assert.match(out, /drift: .*typed_prompts_without_new_turns 1/);
    assert.match(out, /unseen_requested_model 1, .*unseen_max_tokens 1|unseen_max_tokens 1, .*unseen_requested_model 1/, "a record's reasons are counted one by one");
    assert.match(out, /typed_prompts_without_new_turns: the classifier found far fewer new turns/);
    assert.match(out, /rewrite_rejected: the upstream rejected a rewritten request/);
    assert.match(out, /routing was not changed/, "drift must never read as a routing state");
  });

  it("an empty log says so instead of printing empty tables", () => {
    assert.deepEqual(s1Decisions(ctxOf("")), ["  (no records)"]);
  });
});

describe("report: 2. mass vs argmax", () => {
  // The five low-confidence vectors from the first dogfood session (docs/observations.md): torn between sonnet and
  // haiku with almost no mass on opus, every request asking for opus.
  const torn = (): string =>
    toJsonl([
      dec({ id: "t1", t: 0, probs: [0.45, 0.55, 0.0], confidence: 0.32, pickMass: "sonnet", pickArgmax: "sonnet" }),
      dec({ id: "t2", t: 1, probs: [0.73, 0.27, 0.0], confidence: 0.4, pickMass: "sonnet", pickArgmax: "haiku" }),
      dec({ id: "t3", t: 2, probs: [0.62, 0.29, 0.09], confidence: 0.45, pickMass: "sonnet", pickArgmax: "haiku" }),
      dec({ id: "c1", t: 3, probs: [1, 0, 0], confidence: 1.0, pickMass: "haiku", pickArgmax: "haiku" }),
    ]);

  it("counts agreement and reports where the two rules disagree, in each direction", () => {
    const out = s2MassVsArgmax(ctxOf(torn())).join("\n");
    assert.match(out, /4 new turns reached the backend; 4 log both readings/);
    assert.match(out, /agree on 2 of 4 \(50\.0%\)/);
  });

  it("under the confidence floor argmax stays on the requested tier, so mass is the rule that routes lower", () => {
    // All three torn turns sit under the 0.7 floor, so argmax moves none of them and they stay on the requested
    // opus; mass takes its sonnet pick on each. This is the observations.md finding, as a test.
    const out = s2MassVsArgmax(ctxOf(torn())).join("\n");
    assert.match(out, /they differ on 3: mass routes lower on 3, argmax on 0/, out);
    assert.match(out, /mass\s+1\s+3\s+0\s+4/, out); // haiku 1, sonnet 3, opus 0, moved down on all 4
    assert.match(out, /argmax\s+1\s+0\s+3\s+1/, out); // only the confident haiku moves; 3 stay on opus
  });

  it("records that log only the applied pick are counted but not compared", () => {
    const one = { ...dec({ id: "o1", t: 0, probs: [1, 0, 0], pickMass: "haiku" }) };
    (one["decision"] as Record<string, unknown>)["pick_mass"] = undefined;
    (one["decision"] as Record<string, unknown>)["pick_argmax"] = undefined;
    const out = s2MassVsArgmax(ctxOf(toJsonl([one]))).join("\n");
    assert.match(out, /1 new turns reached the backend; 0 log both readings/);
    assert.doesNotMatch(out, /agreement, mass pick/, "with nothing to compare the matrix is omitted");
  });

  it("turns that never reached the backend are not counted", () => {
    assert.deepEqual(s2MassVsArgmax(ctxOf(toJsonl([dec({ id: "u", t: 0 })]))), ["  (no records)"]);
  });
});

describe("report: 3. shadow vs actual", () => {
  it("shares out turns and tokens by requested -> would-route cell, and counts how many really went there", () => {
    const text = toJsonl([
      dec({ id: "s1", t: 0, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", sent: "opus", usage: [0, 0, 0, 300] }),
      dec({ id: "s2", t: 1, probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", sent: "haiku", usage: [0, 0, 0, 100] }),
      dec({ id: "s3", t: 2, probs: [0, 0, 1], pickMass: "opus", planTier: null, usage: [0, 0, 0, 600] }),
    ]);
    const out = s3ShadowVsActual(ctxOf(text)).join("\n");
    assert.match(out, /new turns that reached the backend \(n=3\)/);
    // opus -> haiku: 2 turns, 66.7% of turns, 40% of tokens, 1 of them actually sent to haiku.
    assert.match(out, /opus\s+haiku\s+2\s+66\.7%\s+40\.0%\s+1/, out);
    assert.match(out, /opus\s+opus\s+1\s+33\.3%\s+60\.0%\s+1/, out);
  });

  it("a shadow log routes nothing, and says so rather than leaving the reader to infer it", () => {
    const text = toJsonl([dec({ id: "s1", t: 0, mode: "shadow", probs: [1, 0, 0], pickMass: "haiku", planTier: "haiku", sent: "opus" })]);
    const out = s3ShadowVsActual(ctxOf(text)).join("\n");
    assert.match(out, /routed records \(rewritten and accepted; includes pinned continuations\): 0/);
    assert.doesNotMatch(out, /sent model/, "with nothing routed there is no requested-vs-sent table");
  });

  it("routed records are listed by requested and sent model, continuations included", () => {
    const text = toJsonl([
      dec({ id: "r1", t: 0, probs: [1, 0, 0], pickMass: "haiku", sent: "haiku" }),
      dec({ id: "r2", t: 1, turn: "continuation", sent: "haiku" }),
    ]);
    const out = s3ShadowVsActual(ctxOf(text)).join("\n");
    assert.match(out, /routed records[^\n]*: 2/);
    assert.match(out, /claude-opus-5\s+claude-haiku-4-5-20251001\s+2/, out);
  });
});

describe("report: 4. guard skips", () => {
  const g = (id: string, t: number, o: { allowed: boolean; reason: string; penalty: number | null; decided?: boolean }): Rec =>
    dec({ id, t, guard: { allowed: o.allowed, reason: o.reason, penalty: o.penalty }, ...(o.decided === false ? {} : { probs: [1, 0, 0] as [number, number, number], pickMass: "haiku" as const }) });

  it("distinguishes no guard evaluations from no records at all", () => {
    assert.deepEqual(s4Guard(ctxOf(toJsonl([dec({ id: "x", t: 0 })]))), ["  (no records with a guard evaluation; the guard runs in route mode only)"]);
  });

  it("splits each reason into allowed and refused, and totals the refusals", () => {
    const text = toJsonl([
      g("a", 0, { allowed: true, reason: "fresh", penalty: null }),
      g("b", 1, { allowed: true, reason: "within_limit", penalty: 0.004 }),
      g("c", 2, { allowed: false, reason: "over_limit", penalty: 0.2 }),
      g("d", 3, { allowed: false, reason: "over_limit", penalty: 0.4 }),
    ]);
    const out = s4Guard(ctxOf(text)).join("\n");
    assert.match(out, /4 guard evaluations, 2 refused/);
    // p50 is nearest-rank (median = percentile(.., 50)), so two penalties report the lower one, not their mean.
    assert.match(out, /over_limit\s+2\s+0\s+2\s+\$0\.2000\s+\$0\.4000/, out);
    assert.match(out, /within_limit\s+1\s+1\s+0\s+\$0\.0040\s+\$0\.0040/, out);
  });

  it("a reason that carries no priced penalty shows `-`, not $0.0000", () => {
    const out = s4Guard(ctxOf(toJsonl([g("a", 0, { allowed: true, reason: "fresh", penalty: null })]))).join("\n");
    assert.match(out, /fresh\s+1\s+1\s+0\s+-\s+-/, out);
  });

  it("counts only the refusals that skipped the backend, not every refusal", () => {
    const text = toJsonl([
      g("skipped", 0, { allowed: false, reason: "over_limit", penalty: 0.2, decided: false }),
      g("asked", 1, { allowed: false, reason: "over_limit", penalty: 0.3 }),
    ]);
    assert.match(s4Guard(ctxOf(text)).join("\n"), /refused before the backend was asked \(backend call skipped\): 1 of 2 refusals/);
  });
});

describe("report: 5. fallbacks and breaker", () => {
  it("counts rewrites the upstream rejected, by status, with the error text", () => {
    const text = toJsonl([
      dec({ id: "f1", t: 0, sent: "haiku", fallback: { status: 404, error: "model not found" } }),
      dec({ id: "f2", t: 1, sent: "haiku", fallback: { status: 404, error: "model not found" } }),
      dec({ id: "f3", t: 2, sent: "sonnet", fallback: { status: 400, error: "bad request" } }),
      dec({ id: "ok", t: 3, sent: "haiku" }),
    ]);
    const out = s5Fallbacks(ctxOf(text)).join("\n");
    assert.match(out, /re-sent with the original bytes: 3/);
    assert.match(out, /404\s+2/, out);
    assert.match(out, /400\s+1/, out);
    assert.match(out, /2x model not found/);
  });

  it("truncates a long upstream error to 100 characters", () => {
    const text = toJsonl([dec({ id: "f", t: 0, sent: "haiku", fallback: { status: 400, error: "e".repeat(300) } })]);
    const out = s5Fallbacks(ctxOf(text)).join("\n");
    assert.match(out, new RegExp(`1x e{100}(?!e)`), "the error is cut at 100 chars");
  });

  it("names records that predate fallback_error instead of counting them as an empty error", () => {
    const text = toJsonl([dec({ id: "f", t: 0, sent: "haiku", fallback: { status: 404, error: null } })]);
    assert.match(s5Fallbacks(ctxOf(text)).join("\n"), /1x \(no error text: recorded before fallback_error existed\)/);
  });

  it("counts the reason codes that mean a rewrite was abandoned, and the breaker separately from other errors", () => {
    const text = toJsonl([
      dec({ id: "r1", t: 0, reasons: ["tier_disabled"] }),
      dec({ id: "r2", t: 1, reasons: ["rewrite_failed"] }),
      dec({ id: "r3", t: 2, reasons: ["stay_pinned_backend_error"] }),
      dec({ id: "e1", t: 3, error: "breaker_open" }),
      dec({ id: "e2", t: 4, error: "backend:timeout" }),
    ]);
    const out = s5Fallbacks(ctxOf(text)).join("\n");
    assert.match(out, /tier switched off after a rejection \(tier_disabled\): 1/);
    assert.match(out, /rewrite_failed: 1, stay_pinned_backend_error: 1/);
    assert.match(out, /breaker_open: 1/);
    assert.match(out, /backend and pipeline errors: .*backend:timeout 1/);
  });

  it("a clean log reports zeroes and `none`, not an empty section", () => {
    const out = s5Fallbacks(ctxOf(toJsonl([dec({ id: "ok", t: 0 })]))).join("\n");
    assert.match(out, /re-sent with the original bytes: 0/);
    assert.match(out, /backend and pipeline errors: none/);
  });
});

describe("report: 11. unclassified side-call fingerprints", () => {
  const fp = (o: { tools?: number; messages?: number; roles?: string; chars?: number }): Record<string, unknown> => ({
    v: 3,
    unclassified_reason: "no_marker",
    messages: o.messages ?? 12,
    roles: o.roles ?? "suaua",
    tools: o.tools ?? 40,
    tool_result: true,
    system: { prompt: "blocks", prompt_blocks: 2, messages: 1 },
    last: { role: "user", content: "blocks", blocks: ["text"], text_chars: o.chars ?? 100 },
    max_tokens: 8192,
    thinking: null,
    effort: "medium",
    stream: true,
    betas: ["claude-code-20250219"],
    head: null,
    head_omitted: "typed_prompt",
  });
  const un = (id: string, t: number, fingerprint: Record<string, unknown> | null, usage: [number, number, number, number]): Rec => ({
    ...dec({ id, t, turn: "side", side: "unclassified", usage }),
    ...(fingerprint === null ? {} : { side_fingerprint: fingerprint }),
    unclassified_reason: "no_marker",
  });

  it("says so plainly when there are none", () => {
    assert.deepEqual(s11Fingerprints(ctxOf(toJsonl([dec({ id: "s", t: 0, turn: "side", side: "suggestion" })]))), ["  (no unclassified side calls)"]);
  });

  it("groups calls that differ only in length: message count and last-text size are not part of the identity", () => {
    const d = parse(toJsonl([
      un("a", 0, fp({ messages: 12, roles: "suaua", chars: 100 }), [0, 0, 0, 1000]),
      un("b", 1, fp({ messages: 40, roles: "suauaua", chars: 9000 }), [0, 0, 0, 2000]),
    ])).decisions;
    const groups = fingerprintGroups(d);
    assert.equal(groups.length, 1, "messages, roles and last.text_chars are volatile and must not split a group");
    assert.deepEqual(groups[0]!.message_count, { min: 12, max: 40 });
    assert.equal(groups[0]!.tokens, 3000);
    assert.equal(groups[0]!.fingerprint["messages"], 40, "the group keeps the most recent fingerprint, complete");
  });

  it("a structural difference makes its own group, and the most frequent group is listed first", () => {
    const d = parse(toJsonl([
      un("a", 0, fp({ tools: 40 }), [0, 0, 0, 1000]),
      un("b", 1, fp({ tools: 40 }), [0, 0, 0, 1000]),
      un("c", 2, fp({ tools: 3 }), [0, 0, 0, 5000]),
    ])).decisions;
    const groups = fingerprintGroups(d);
    assert.deepEqual(groups.map((g) => g.n), [2, 1]);
    assert.equal(groups[0]!.fingerprint["tools"], 40, "the larger group comes first even though the other holds more tokens");
  });

  it("counts calls with no fingerprint instead of dropping them, and totals tokens over all of them", () => {
    const out = s11Fingerprints(ctxOf(toJsonl([
      un("a", 0, fp({}), [0, 0, 0, 1000]),
      un("b", 1, null, [0, 0, 0, 2000]),
    ]))).join("\n");
    assert.match(out, /2 unclassified side calls, 3,000 tokens; 1 distinct fingerprint; 1 without one/);
    assert.match(out, /by reason: no_marker 2/);
  });

  it("singular wording for one call and one fingerprint", () => {
    const out = s11Fingerprints(ctxOf(toJsonl([un("a", 0, fp({}), [0, 0, 0, 10])]))).join("\n");
    assert.match(out, /1 unclassified side call, 10 tokens; 1 distinct fingerprint\n/);
    assert.doesNotMatch(out, /without one/, "nothing is missing, so the clause is omitted");
  });

  it("the printed group line carries the structure and points at the flag that exports it", () => {
    const out = s11Fingerprints(ctxOf(toJsonl([un("a", 0, fp({}), [0, 0, 0, 1000])]))).join("\n");
    assert.match(out, /n=1, 1,000 tokens, kind main, claude 2\.1\.277, messages 12: \{/);
    assert.match(out, /reflex report --fingerprints/);
  });
});

describe("report: 13. escalations", () => {
  const log = (): string =>
    toJsonl([
      dec({ id: "cause", t: 0, conv: "C1", probs: [0.9, 0.1, 0], pickMass: "haiku", sent: "haiku" }),
      dec({ id: "esc1", t: 2, conv: "C1", probs: [0.9, 0.1, 0], pickMass: "haiku", sent: "sonnet", escalation: { signal: "correction", from: "haiku", to: "sonnet", decisionId: "cause" } }),
      dec({ id: "plain", t: 4, conv: "C1", probs: [0.9, 0.1, 0], pickMass: "haiku", sent: "haiku" }),
    ]);

  it("says plainly when there is nothing, rather than printing an empty table", () => {
    const lines = s13Escalations(ctxOf(toJsonl([dec({ id: "a", t: 0 })]))).join("\n");
    assert.match(lines, /no escalated turns in this log/);
    assert.match(lines, /REFLEX_ESCALATE is off by default/);
  });

  it("lists each escalated turn with its signal, the tiers, and the turn that caused it", () => {
    const rows = escalationRows(ctxOf(log()));
    assert.equal(rows.length, 1, "only the escalated turn is listed");
    assert.equal(rows[0]!.dec.id, "esc1");
    assert.equal(rows[0]!.signal, "correction");
    assert.equal(rows[0]!.from, "haiku");
    assert.equal(rows[0]!.to, "sonnet");
    assert.equal(rows[0]!.cause?.id, "cause", "joined to the decision whose window produced the signal");
    const lines = s13Escalations(ctxOf(log())).join("\n");
    assert.match(lines, /1 escalated turn \(1 applied, 0 shadow\);/);
    assert.match(lines, /by signal: correction 1/);
    assert.match(lines, /insufficient data: n=0 < 20/, "no rate is claimed from one turn");
  });

  it("a shadow escalation is listed as shadow and never counted as applied", () => {
    const text = toJsonl([
      dec({ id: "cause", t: 0, conv: "C1", probs: [0.9, 0.1, 0], pickMass: "haiku", sent: "haiku" }),
      dec({ id: "sh1", t: 2, conv: "C1", probs: [0.9, 0.1, 0], pickMass: "haiku", sent: "haiku", wouldEscalate: { signal: "correction", from: "haiku", to: "opus", decisionId: "cause" } }),
    ]);
    const rows = escalationRows(ctxOf(text));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.mode, "shadow");
    assert.equal(rows[0]!.to, "opus");
    assert.equal(rows[0]!.dec.sentTier, "haiku", "the tier was not changed");
    const lines = s13Escalations(ctxOf(text)).join("\n");
    assert.match(lines, /\(0 applied, 1 shadow\)/);
    assert.match(lines, /the tier was NOT changed/);
    assert.match(lines, /of 0 APPLIED escalations/);
  });

  it("refuses a rate below MIN_OUTCOME_N and never implies escalation helped", () => {
    const lines = s13Escalations(ctxOf(log())).join("\n");
    assert.doesNotMatch(lines, /correction > 0 after an escalation/);
    assert.match(lines, /none of this says whether escalation helps/);
  });
});

describe("report: grouping by decision-backend version", () => {
  it("section 2 splits agreement by the version that answered", () => {
    const text = toJsonl([
      dec({ id: "a", t: 0, probs: [0.9, 0.1, 0], pickMass: "haiku", pickArgmax: "haiku", backendVersion: "jev-1.13.0" }),
      dec({ id: "b", t: 1, probs: [0.4, 0.5, 0.1], pickMass: "sonnet", pickArgmax: "haiku", backendVersion: "jev-1.13.0" }),
      dec({ id: "c", t: 2, probs: [0.9, 0.1, 0], pickMass: "haiku", pickArgmax: "haiku", backendVersion: "jev-1.14.0" }),
    ]);
    const lines = s2MassVsArgmax(ctxOf(text)).join("\n");
    assert.match(lines, /agreement by backend version/);
    assert.match(lines, /jev-1\.13\.0\s+2\s+1\s+50\.0%/);
    assert.match(lines, /jev-1\.14\.0\s+1\s+1\s+100\.0%/);
  });

  it("falls back to the version inside the decision block, so logs written before the field still group", () => {
    const text = toJsonl([dec({ id: "a", t: 0, probs: [1, 0, 0], pickMass: "haiku", backendVersion: null })]);
    assert.match(s2MassVsArgmax(ctxOf(text)).join("\n"), /jev-test\s+1\s+1\s+100\.0%/);
  });

  it("says nothing at all when neither field carries a version", () => {
    // No backend answer at all: the guard refused before the call, so there is no version to group by.
    const text = toJsonl([dec({ id: "a", t: 0 }), dec({ id: "b", t: 1 })]);
    assert.doesNotMatch(s2MassVsArgmax(ctxOf(text)).join("\n"), /agreement by backend version/);
  });
});

describe("report: prompt encoding by delegation hint", () => {
  it("counts main new turns by how the prompt arrived, split by hint", () => {
    const text = toJsonl([
      dec({ id: "a", t: 0, turn: "new", promptEncoding: "string", hint: null }),
      dec({ id: "b", t: 1, turn: "new", promptEncoding: "blocks", hint: null }),
      dec({ id: "c", t: 2, turn: "new", promptEncoding: "string", hint: "delegate-1" }),
      dec({ id: "d", t: 3, turn: "new", hint: "delegate-1" }), // older record, field absent
      dec({ id: "e", t: 4, turn: "continuation" }),
    ]);
    const out = s1Decisions(ctxOf(text)).join("\n");
    assert.match(out, /main-chat new turns by prompt encoding/);
    assert.match(out, /off\s+1\s+1\s+0/, out); // blocks 1, string 1, not recorded 0
    assert.match(out, /delegate-1\s+0\s+1\s+1/, out); // blocks 0, string 1, not recorded 1
  });

  it("says nothing when no record carries the field, so older logs read as before", () => {
    const out = s1Decisions(ctxOf(toJsonl([dec({ id: "a", t: 0, turn: "new" })]))).join("\n");
    assert.doesNotMatch(out, /prompt encoding/);
  });
});

describe("report: the randomised REFLEX_AB comparison", () => {
  const log = (routed: number, control: number): string => {
    const recs: Rec[] = [];
    let t = 0;
    for (let i = 0; i < routed; i++) {
      recs.push(dec({ id: `r${i}`, t: t++, turn: "new", sent: "haiku", ab: "routed" }));
      recs.push(outcome({ id: `or${i}`, t: t++, decision: `r${i}`, scope: "main", score: i % 5 === 0 ? 1 : 0, edits: 1 }));
    }
    for (let i = 0; i < control; i++) {
      recs.push(dec({ id: `c${i}`, t: t++, turn: "new", sent: "opus", ab: "control" }));
      recs.push(outcome({ id: `oc${i}`, t: t++, decision: `c${i}`, scope: "main", score: 0, edits: 1 }));
    }
    // A turn that never entered the randomisation must stay out of both arms.
    recs.push(dec({ id: "plain", t: t++, turn: "new", sent: "haiku" }));
    recs.push(outcome({ id: "oplain", t: t++, decision: "plain", scope: "main", score: 3, edits: 1 }));
    return toJsonl(recs);
  };

  it("counts only the randomised turns, in their assigned arms", () => {
    const arms = abArms(ctxOf(log(3, 2)));
    assert.deepEqual(arms.map((a) => [a.arm, a.windows.length]), [["routed", 3], ["control", 2]]);
    assert.equal(arms[0]!.corrected, 1, "the untagged turn's correction is not counted");
    assert.equal(arms[1]!.corrected, 0);
  });

  it("says nothing at all when nothing was randomised", () => {
    assert.deepEqual(abComparison(ctxOf(toJsonl([dec({ id: "a", t: 0, turn: "new" })]))), []);
  });

  it("refuses a comparison until BOTH arms pass MIN_OUTCOME_N", () => {
    const lines = abComparison(ctxOf(log(MIN_OUTCOME_N + 1, 3))).join("\n");
    assert.match(lines, /insufficient data: control n=3 < 20/);
    assert.doesNotMatch(lines, /correction > 0 in .* of scored/);
  });

  it("compares once both arms are large enough, and says what the comparison is worth", () => {
    const lines = abComparison(ctxOf(log(MIN_OUTCOME_N, MIN_OUTCOME_N))).join("\n");
    assert.doesNotMatch(lines, /insufficient data/);
    assert.match(lines, /routed: correction > 0 in/);
    assert.match(lines, /control: correction > 0 in/);
    assert.match(lines, /randomly assigned arms/);
    assert.match(lines, /the arms above differ in difficulty, not treatment/);
  });
});

describe("report: section 14 (REFLEX_EFFORT)", () => {
  const withEffort = (r: Rec, effort: object | null, fields: string[] = []): Rec => ({ ...r, requested: { ...(r["requested"] as object), effort: "high" }, ...(effort ? { effort } : {}), forwarded: { ...(r["forwarded"] as object), rewritten: fields.length > 0, fields } });
  it("counts decisions, applied levels, carried messages, and keeps the randomised arms apart", () => {
    const log = toJsonl([
      withEffort(dec({ id: "a", t: 0, probs: [0, 0, 1] }), { pick: "low", target: "low", via: "message", reasons: ["effort_down"], ab: "treated" }, ["messages.effort_added", "output_config.effort"]),
      withEffort(dec({ id: "b", t: 1, probs: [0, 0, 1] }), { pick: "low", target: "high", via: "message", reasons: ["effort_down", "effort_ab_control"], ab: "control" }),
      withEffort(dec({ id: "c", t: 2, probs: [0, 0, 1] }), { pick: "high", target: "high", via: null, reasons: ["effort_same"] }),
      withEffort(dec({ id: "d", t: 3, turn: "continuation" }), null, ["messages.effort_reinserted:2"]),
      outcome({ id: "o1", t: 5, decision: "a", score: 1 }),
      outcome({ id: "o2", t: 6, decision: "b", score: 0 }),
    ]);
    const text = s14Effort(ctxOf(log)).join("\n");
    assert.match(text, /decided turns: 3/);
    assert.match(text, /target vs the client's level: (?=.*lower 1)(?=.*same 2)/);
    assert.match(text, /applied: (?=.*message 2)(?=.*not applied 1)/);
    assert.match(text, /applied levels: low 1, medium 0, high 1, xhigh 0, max 0/);
    assert.match(text, /1 added one, 1 re-inserted earlier ones \(2 in all\)/);
    assert.match(text, /randomised comparison \(REFLEX_EFFORT_AB\)/);
    assert.match(text, /insufficient data: treated n=1, control n=1/);
    assert.doesNotMatch(text, /correction > 0 in/, "no rates below MIN_OUTCOME_N");
  });
  it("with no effort records it says how to turn them on", () => {
    assert.deepEqual(s14Effort(ctxOf(toJsonl([dec({ id: "x", t: 0 })]))), ["  (no effort decisions; REFLEX_EFFORT=1 turns them on)"]);
  });
});


describe("report: measured saving (REFLEX_AB)", () => {
  it("a unit is a randomised turn plus its tool loop; unrandomised turns and other conversations are not mixed in", () => {
    const M = 1_000_000;
    const recs = [
      dec({ id: "r1", t: 0, ab: "routed", sent: "sonnet", usage: [M, 0, 0, 0] }), // $2 at Sonnet
      dec({ id: "r1c", t: 1, turn: "continuation", sent: "sonnet", usage: [M, 0, 0, 0] }), // +$2, same unit
      dec({ id: "x", t: 2, usage: [M, 0, 0, 0] }), // a turn outside the experiment closes r1's unit
      dec({ id: "x2", t: 3, turn: "continuation", usage: [M, 0, 0, 0] }),
      dec({ id: "c1", t: 4, ab: "control", conv: "bbbbbbbbbbbbbbbb:m:0000000000000001", usage: [M, 0, 0, 0] }), // $5 at the fixtures' Opus
    ];
    assert.deepEqual(abCostUnits(parse(toJsonl(recs)).decisions), { routed: [4], control: [5] });
  });

  it("section 8 states the difference with an interval once both arms reach MIN_OUTCOME_N, and not before", () => {
    const arm = (a: "routed" | "control", n: number, output: number) =>
      Array.from({ length: n }, (_, i) => dec({ id: `${a}${i}`, t: i, ab: a, conv: `${a}:m:${i}`, usage: [0, output + i, 0, 0] }));
    const few = s8Cost(ctxOf(toJsonl([...arm("routed", 3, 1000), ...arm("control", 3, 1000)]))).join("\n");
    assert.match(few, /routed n=3, control n=3\): insufficient data/);
    const many = s8Cost(ctxOf(toJsonl([...arm("routed", MIN_OUTCOME_N, 2000), ...arm("control", MIN_OUTCOME_N, 1000)]))).join("\n");
    assert.match(many, /a routed-arm turn cost \+9\d% against a control turn \(95% bootstrap interval \+\d+% to \+\d+%\)/, many);
    assert.equal(ratioInterval([1], []), null);
  });
});
