import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DecisionLog, PROMPT_PREVIEW_MAX, promptPreview, type DecisionRecord } from "../../src/log/decision-log.js";
import { JsonlWriter } from "../../src/log/jsonl.js";
import { Breaker } from "../../src/worker/breaker.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "reflex-log-"));
const record = (id: string): DecisionRecord => ({
  v: 1, record: "decision", id, at: "2026-09-19T00:00:00.000Z", session: null, conv: null, kind: "main", signal: "none", signals: { header: false, s1: false, s2: false, s3: true },
  turn: "new", side_kind: null, side_marker: null, entrypoint: "cli", mode_requested: "shadow", mode_effective: "shadow", degraded_reason: null, shape: { status: "checking", violations: [] },
  claude_version: "2.1.277", cache_ttl_beta: true, backend: "jev", requested: { model: "claude-sonnet-5", tier: "sonnet", effort: "medium" }, decision: null, plan: null, guard: null, override: null, pin: null,
  forwarded: { requested_model: "claude-sonnet-5", model: "claude-sonnet-5", rewritten: false, fields: [], fallback: false, fallback_status: null, fallback_error: null }, upstream: { status: 200, msToHeaders: 5 }, timing: { decision_wait_ms: 0, decision_deadline_ms: 1500, upstream_first_byte_ms: 5 }, usage: null, usage_unknown_reason: null, error: null, sent: null, delegate_hint: null, backend_version: null, escalation: null, would_escalate: null,
});
const lines = (file: string): Record<string, unknown>[] => fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("decision log", () => {
  it("creates the directory 0700 and the file 0600", async () => {
    const home = path.join(tmp(), "nested", ".reflex");
    const log = new DecisionLog(home, true);
    await log.append(record("a"), "hello");
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
    assert.equal(fs.statSync(log.file).mode & 0o777, 0o600);
    assert.equal(lines(log.file)[0]?.["prompt_preview"], "hello");
  });

  it("caps the preview at 300 code points on multi-byte text, and redacts it", () => {
    const p = promptPreview("é😀".repeat(400) + " apikey_abcdefgh12345678");
    assert.equal(Array.from(p).length, PROMPT_PREVIEW_MAX);
    assert.doesNotMatch(p, /[\uD800-\uDBFF]$/, "no split surrogate at the cut");
    assert.match(promptPreview("key apikey_abcdefgh12345678 here"), /\[REDACTED:typesafe_key\]/);
  });

  it("REFLEX_LOG_PROMPTS=0 omits the preview entirely, and a caller-set preview is never trusted", async () => {
    const log = new DecisionLog(tmp(), false);
    await log.append({ ...record("b"), prompt_preview: "sneaky" }, "secret task");
    assert.equal("prompt_preview" in (lines(log.file)[0] ?? {}), false);
  });

  it("appends in order and rotates by size, keeping N files", async () => {
    const dir = tmp();
    const w = new JsonlWriter(path.join(dir, "x.jsonl"), { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) void w.append({ i, pad: "x".repeat(40) });
    await w.flush();
    const files = fs.readdirSync(dir).sort();
    assert.deepEqual(files, ["x.jsonl", "x.jsonl.1", "x.jsonl.2"]);
    const last = lines(path.join(dir, "x.jsonl"));
    assert.equal(last.at(-1)?.["i"], 19);
    for (const f of files) assert.ok(fs.statSync(path.join(dir, f)).size <= 200);
  });

  it("a write failure is reported, never thrown", async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "blocker"), "");
    const errors: Error[] = [];
    const w = new JsonlWriter(path.join(dir, "blocker", "x.jsonl"), { onError: (e) => errors.push(e) });
    await w.append({ a: 1 });
    assert.equal(errors.length, 1);
  });
});

describe("Breaker", () => {
  it("opens after 3 consecutive failures for the open period, then allows a trial; a failed trial reopens at once", () => {
    let t = 0;
    const b = new Breaker(3, 1000, () => t);
    b.failure();
    b.failure();
    b.success();
    b.failure();
    b.failure();
    assert.equal(b.closed, true, "a success resets the count");
    b.failure();
    assert.equal(b.closed, false);
    assert.equal(b.timesOpened, 1);
    t = 999;
    assert.equal(b.closed, false);
    t = 1000;
    assert.equal(b.closed, true, "half-open trial");
    b.failure();
    assert.equal(b.closed, false, "failed trial reopens immediately");
    t = 2000;
    b.success();
    b.failure();
    assert.equal(b.closed, true, "after a success, the full threshold applies again");
  });
});
