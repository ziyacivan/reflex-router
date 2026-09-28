// The subscription quota: header parsing (src/wire/ratelimit.ts), the worker's climb and projection
// (src/worker/quota-watch.ts), its status-line text, and report section 15 (tokens per 1% step).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isoWeek, quotaSteps, s15Quota } from "../../src/report/sections.js";
import { parseRecords } from "../../src/report/records.js";
import { shareRecord } from "../../src/report/share.js";
import { dur, formatStatus } from "../../src/statusline.js";
import { parseQuota } from "../../src/wire/ratelimit.js";
import { QuotaWatch } from "../../src/worker/quota-watch.js";
import { at, dec, toJsonl } from "../support/report-fixtures.js";

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, "g");
const plain = (s: string | null): string | null => (s === null ? null : s.replace(ANSI, ""));
const H = "anthropic-ratelimit-unified-";
const MIN = 60_000;
const T = Date.parse("2026-09-28T10:00:00.000Z");
const RESET_S = T / 1000 + 4 * 3600; // the 5h window resets in 4 hours

describe("quota: headers", () => {
  it("reads every window's share, reset and status as the API sends them (observed values: 0.dd, epoch seconds)", () => {
    const q = parseQuota({
      [`${H}5h-utilization`]: "0.31", [`${H}5h-reset`]: "1790300400", [`${H}5h-status`]: "allowed",
      [`${H}7d-utilization`]: "0.48", [`${H}7d-reset`]: "1790647200", [`${H}7d-status`]: "allowed_warning",
      [`${H}7d_oi-utilization`]: "0.05",
      [`${H}status`]: "allowed", [`${H}representative-claim`]: "five_hour", "anthropic-organization-id": "org",
    });
    assert.deepEqual(q, {
      "5h": { util: 0.31, reset: 1790300400, status: "allowed" },
      "7d": { util: 0.48, reset: 1790647200, status: "allowed_warning" },
      "7d_oi": { util: 0.05, reset: null, status: null },
    });
  });

  it("anything unexpected is left out, never an error; no quota headers is null", () => {
    assert.equal(parseQuota({ "content-type": "text/event-stream" }), null);
    assert.equal(parseQuota({ [`${H}5h-utilization`]: "31%" }), null);
    assert.equal(parseQuota({ [`${H}5h-utilization`]: ["0.1", "0.2"] }), null);
    assert.equal(parseQuota({ [`${H}Weird Name-utilization`]: "0.1" }), null);
    assert.deepEqual(parseQuota({ [`${H}5h-utilization`]: "0.2", [`${H}5h-reset`]: "soon", [`${H}5h-status`]: "\u001b[31mx" }), { "5h": { util: 0.2, reset: null, status: null } });
  });
});

const q5 = (util: number, reset = RESET_S, status = "allowed") => ({ "5h": { util, reset, status } });

describe("quota: the worker's projection", () => {
  it("projects 100% from the rise since the oldest step in the last hour; the first value seen is not a step", () => {
    const w = new QuotaWatch();
    w.observe(q5(0.3), T); // may be hours old
    w.observe(q5(0.31), T + 10 * MIN);
    w.observe(q5(0.32), T + 20 * MIN);
    assert.equal(w.get(T + 20 * MIN)[0]!.limitInS, null, "a 1% rise is too short to tell");
    w.observe(q5(0.33), T + 30 * MIN);
    // 2% in 20 min from the 31% step: 67% more takes 670 min, past the reset in 3.5 h: nothing to say.
    assert.equal(w.get(T + 30 * MIN)[0]!.limitInS, null);
    w.observe(q5(0.6), T + 40 * MIN); // a heavy stretch: 29% in 30 min
    const s = w.get(T + 40 * MIN)[0]!;
    assert.equal(s.pct, 60);
    assert.equal(s.limitInS, Math.round(0.4 / (0.29 / (30 * 60))));
    assert.equal(s.resetInS, 4 * 3600 - 40 * 60);
    // Idle time since the last step slows the rate.
    assert.ok(w.get(T + 70 * MIN)[0]!.limitInS! > s.limitInS);
  });

  it("a new reset time starts over; an older reading after a newer one is noise; a window past its reset is gone", () => {
    const w = new QuotaWatch();
    w.observe(q5(0.5), T);
    w.observe(q5(0.51), T + MIN);
    w.observe(q5(0.5), T + 2 * MIN); // a concurrent request's older value
    assert.equal(w.get(T + 2 * MIN)[0]!.pct, 51);
    w.observe(q5(0.02, RESET_S + 5 * 3600), T + 3 * MIN);
    assert.equal(w.get(T + 3 * MIN)[0]!.pct, 2);
    assert.deepEqual(w.get(RESET_S * 1000 + 6 * 3600 * 1000), []);
  });
});

describe("quota: status line", () => {
  const win = (name: string, pct: number, limitInS: number | null = null, status: string | null = "allowed", resetInS: number | null = 3600) => ({ name, pct, status, resetInS, limitInS });

  it("shows 5h and 7d, the time to the limit when the recent rate reaches it before the reset, and a refusal", () => {
    const line = (quota: ReturnType<typeof win>[]) => plain(formatStatus({ worker: "up", main: null, quota }));
    assert.equal(line([win("5h", 31), win("7d", 48)]), "Reflex · Quota: 5h 31%, 7d 48%");
    assert.equal(line([win("5h", 62, 40 * 60), win("7d", 48), win("7d_oi", 5)]), "Reflex · Quota: 5h 62% (limit in ~40m), 7d 48%");
    assert.equal(line([win("5h", 100, null, "rejected", 80 * 60), win("7d_oi", 91)]), "Reflex · Quota: 5h 100% (limited, resets in 1h 20m), 7d_oi 91%");
    assert.equal(line([]), "Reflex");
  });

  it("coarse durations", () => {
    assert.deepEqual([dur(20), dur(40 * 60), dur(2 * 3600), dur(130 * 60), dur(3 * 86400)], ["1m", "40m", "2h", "2h 10m", "3d"]);
  });
});

describe("quota: report section 15", () => {
  const quota = (util: number, reset = 1790300400) => ({ "5h": { util, reset }, "7d": { util: 0.4, reset: 1790647200 } });
  // usage [input, output, cache_read, cache_create]: 1,000 tokens per request
  const u: [number, number, number, number] = [100, 100, 700, 100];

  it("counts the tokens from one rise up to the next; the first value, a gap and a new reset start over", () => {
    const recs = parseRecords([{ source: "t", text: toJsonl([
      dec({ id: "a", t: 0, usage: u, quota: quota(0.3) }), // first value: not a rise
      dec({ id: "b", t: 60, usage: u, quota: quota(0.3) }),
      dec({ id: "c", t: 120, usage: u, quota: quota(0.31) }), // rise: the count starts here
      dec({ id: "d", t: 180, usage: u, quota: quota(0.31) }),
      dec({ id: "e", t: 240, usage: u, turn: "side", quota: quota(0.31) }), // side calls draw on the quota too
      dec({ id: "f", t: 300, usage: u, quota: quota(0.33) }), // +2% for c, d, e
      dec({ id: "g", t: 360, usage: u }), // no headers: its tokens still count
      dec({ id: "h", t: 420, usage: u, quota: quota(0.32) }), // older reading: ignored
      dec({ id: "i", t: 480, usage: u, quota: quota(0.34) }), // +1% for f, g, h
      dec({ id: "j", t: 480 + 31 * 60, usage: u, quota: quota(0.36) }), // after a gap: a first value again
      dec({ id: "k", t: 540 + 31 * 60, usage: u, quota: quota(0.37) }), // a rise, but only counting from here
      dec({ id: "k2", t: 560 + 31 * 60, usage: u, quota: quota(0.01, 1790318400) }), // new window
      dec({ id: "l", t: 600 + 31 * 60, usage: u, quota: quota(0.02, 1790318400) }),
    ]) }]);
    const steps = quotaSteps(recs.decisions, "5h");
    assert.deepEqual(steps.map((s) => [s.pct, s.tokens]), [[2, 3000], [1, 3000]]);
    assert.deepEqual(quotaSteps(recs.decisions, "7d"), []);
  });

  it("prints tokens per 1% by week and by model, $ only with --usd; without quota it says why", () => {
    const recs = parseRecords([{ source: "t", text: toJsonl([
      dec({ id: "a", t: 0, usage: u, quota: quota(0.3) }),
      dec({ id: "b", t: 60, usage: u, quota: quota(0.31) }),
      dec({ id: "c", t: 120, usage: u, sent: "haiku", quota: quota(0.32) }),
      dec({ id: "d", t: 180, usage: u, sent: "haiku", quota: quota(0.33) }),
    ]) }]);
    const ctx = { rec: recs, byId: new Map(recs.decisions.map((d) => [d.id, d])), usd: false };
    const text = s15Quota(ctx).join("\n");
    assert.match(text, /5h window: 2 steps/);
    assert.match(text, /2026-W38 \(few\)\s+2\s+2\s+1,000/);
    assert.match(text, /claude-opus-5 \(few\)\s+1\s+1\s+1,000/);
    assert.match(text, /claude-haiku-4-5-20251001 \(few\)\s+1\s+1\s+1,000/);
    assert.match(text, /7d window: no step yet/);
    assert.doesNotMatch(text, /\$ per 1%/);
    assert.match(s15Quota({ ...ctx, usd: true }).join("\n"), /Est\. \$ per 1%/);
    const empty = parseRecords([{ source: "t", text: toJsonl([dec({ id: "a", t: 0 })]) }]);
    assert.match(s15Quota({ rec: empty, byId: new Map(), usd: false }).join("\n"), /no quota recorded/);
  });

  it("ISO weeks", () => {
    assert.equal(isoWeek(Date.parse(at(0))), "2026-W38"); // Sat 2026-09-19
    assert.equal(isoWeek(Date.parse("2026-09-28T00:00:00Z")), "2026-W40");
    assert.equal(isoWeek(Date.parse("2027-01-01T12:00:00Z")), "2026-W53");
    assert.equal(isoWeek(Date.parse("2024-12-30T12:00:00Z")), "2025-W01");
  });

  it("the quota is not in a shared log", () => {
    assert.ok(!("quota" in shareRecord(dec({ id: "a", t: 0, quota: quota(0.3) }))!));
  });
});
