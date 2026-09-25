import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { correctionSignal, coversFile, exitCode, gitRestoredPaths, REVERT_WINDOW_TURNS, testRunnerKind } from "../../src/outcome/heuristics.js";
import { outcomeHooks } from "../../src/outcome/hooks-config.js";
import { parseHookEvent, type HookEvent } from "../../src/outcome/hooks.js";
import { OutcomeTracker, type DecisionInfo, type OutcomeRecord, type OutcomeUpdate, type TrackerRecord } from "../../src/outcome/tracker.js";
import { hashId } from "../../src/log/decision-log.js";

const FIX = "test/fixtures/claude-code/2.1.277";
const events = (file: string): HookEvent[] =>
  fs.readFileSync(`${FIX}/${file}`, "utf8").trim().split("\n").map((l) => parseHookEvent(Buffer.from(l))).filter((e): e is HookEvent => e !== null);

describe("heuristics: correction strength", () => {
  const positive: [string, string][] = [
    ["no, that's wrong", "en:starts_no"],
    ["That's not what I asked for. Use the other file.", "en:thats_wrong"],
    ["please revert that change", "en:undo"],
    ["the tests are still failing", "en:still_failing"],
    ["you broke the build", "en:you_broke"],
    ["it doesn't work", "en:doesnt_work"],
    ["hayır, öyle değil", "tr:starts_no"],
    ["bu yanlış oldu", "tr:wrong"],
    ["olmadı, geri al", "tr:undo"],
    ["bunu istemedim", "tr:not_what_i_said"],
  ];
  for (const [text, rule] of positive) {
    it(`"${text}" matches ${rule}`, () => {
      const c = correctionSignal(text);
      assert.ok(c.matched.includes(rule), c.matched.join());
      assert.ok(c.score > 0);
    });
  }

  it("a short correction is boosted; a long neutral follow-up scores 0", () => {
    assert.equal(correctionSignal("no").score, 1.25);
    const neutral = ["now add tests for the parser", "great, thanks! next: the README", "Nobody uses that API anymore, remove it", "notify me when it's done", "the 'no-network' guard should stay", "şimdi README'yi güncelle", "hallettin mi? teşekkürler"];
    for (const t of neutral) assert.deepEqual(correctionSignal(t).matched, [], t);
  });

  it("only the first 300 characters count; the score is capped", () => {
    assert.equal(correctionSignal("x".repeat(400) + " that's wrong").score, 0);
    assert.ok(correctionSignal("no, that's wrong, not what I asked, undo it, you broke it, it doesn't work, try again").score <= 3);
  });
});

describe("heuristics: commands", () => {
  it("recognises test/build runners and returns a short kind", () => {
    const cases: [string, string | null][] = [
      ["npm test", "npm-test"], ["npm run typecheck", "npm-test"], ["pnpm t", "npm-test"], ["node scripts/run-tests.mjs unit/x", "node-test"],
      ["npx vitest run", "vitest"], ["pytest -q tests/", "pytest"], ["python -m pytest", "pytest"], ["go test ./...", "go-test"],
      ["cargo test", "cargo-test"], ["./gradlew test", "jvm-test"], ["npx tsc --noEmit", "tsc"], ["make check", "make-test"],
      ["ls -la", null], ["git status", null], ["npm install", null], ["cat test.txt", null], ["npm run lint", null],
    ];
    for (const [c, k] of cases) assert.equal(testRunnerKind(c), k, c);
  });

  it("parses the exit code from PostToolUseFailure.error", () => {
    assert.equal(exitCode("Exit code 1"), 1);
    assert.equal(exitCode("Exit code 127\nnot found"), 127);
    assert.equal(exitCode("interrupted"), null);
  });

  it("git commands that restore files", () => {
    assert.deepEqual(gitRestoredPaths("git checkout -- src/a.ts"), ["src/a.ts"]);
    assert.deepEqual(gitRestoredPaths("git restore src/a.ts src/b.ts"), ["src/a.ts", "src/b.ts"]);
    assert.deepEqual(gitRestoredPaths("git restore --staged src/a.ts"), [], "unstaging does not touch the working tree");
    assert.deepEqual(gitRestoredPaths("git reset --hard HEAD"), ["*"]);
    assert.deepEqual(gitRestoredPaths("git stash"), ["*"]);
    assert.deepEqual(gitRestoredPaths("git checkout ."), ["*"]);
    assert.deepEqual(gitRestoredPaths("git checkout main"), [], "a branch switch");
    assert.deepEqual(gitRestoredPaths("npm test && git checkout -- a.txt"), ["a.txt"]);
    assert.deepEqual(gitRestoredPaths("git reset --soft HEAD~1"), []);
    assert.ok(coversFile(["src/a.ts"], "/repo/src/a.ts"));
    assert.ok(coversFile(["*"], "/repo/x"));
    assert.ok(!coversFile(["src/a.ts"], "/repo/src/b.ts"));
  });
});

describe("hook payloads (2.1.277 fixtures)", () => {
  it("parse the captured streams; unknown or malformed events are null", () => {
    const e = events("sonnet-agent-run.hooks.jsonl");
    assert.ok(e.some((x) => x.type === "UserPromptSubmit"));
    const fail = e.find((x) => x.type === "PostToolUseFailure");
    assert.ok(fail && fail.type === "PostToolUseFailure");
    assert.equal(exitCode(fail.tool.error), 1);
    const edit = e.find((x) => x.type === "PostToolUse" && x.tool.name === "Edit");
    assert.ok(edit && edit.type === "PostToolUse" && edit.tool.edits.length === 1 && edit.tool.originalFile !== null);
    assert.equal(parseHookEvent(Buffer.from("{")), null);
    assert.equal(parseHookEvent(Buffer.from(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s" }))), null);
  });

  it("the injected settings register exactly the seven events, tool events limited to the observed tools", () => {
    const h = outcomeHooks(4321);
    assert.equal(h["PreToolUse"]?.[0]?.matcher, "Agent|Task");
    assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
    assert.equal(h["PostToolUse"]?.[0]?.matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
    assert.deepEqual(h["UserPromptSubmit"]?.[0]?.hooks[0], { type: "http", url: "http://127.0.0.1:4321/__reflex/hook", timeout: 2 });
  });

  it("under the sandbox the same events go through a command hook that relays to the same url", () => {
    const h = outcomeHooks(4321, { kind: "command", relay: '"/usr/bin/node" "/opt/reflex/bin/reflex.js" hook-relay' });
    assert.deepEqual(Object.keys(h).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
    assert.equal(h["PreToolUse"]?.[0]?.matcher, "Agent|Task");
    assert.equal(h["PostToolUse"]?.[0]?.matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash");
    const cmd = { type: "command", command: '"/usr/bin/node" "/opt/reflex/bin/reflex.js" hook-relay http://127.0.0.1:4321/__reflex/hook', timeout: 2 };
    for (const e of Object.keys(h)) assert.deepEqual(h[e]?.[0]?.hooks[0], cmd, e);
  });
});

// ---- tracker ------------------------------------------------------------------------------------------------------

function tracker(): { t: OutcomeTracker; out: TrackerRecord[]; tick: (ms: number) => void; now: () => number } {
  const out: TrackerRecord[] = [];
  let clock = 1_000_000;
  let n = 0;
  const t = new OutcomeTracker({ emit: (r) => out.push(r), now: () => clock, newId: () => `id-${++n}` });
  return { t, out, tick: (ms) => (clock += ms), now: () => clock };
}
const S = "session-1";
const base = (promptId: string, agentId: string | null = null): { sessionId: string; promptId: string; agentId: string | null } => ({ sessionId: S, promptId, agentId });
const prompt = (id: string, text: string): HookEvent => ({ type: "UserPromptSubmit", base: base(id), prompt: text });
const edit = (id: string, file: string, oldText: string, newText: string, originalFile: string | null = null, agent: string | null = null): HookEvent => ({
  type: "PostToolUse", base: base(id, agent), tool: { name: "Edit", filePath: file, edits: [{ oldText, newText }], originalFile, command: null, error: null },
});
const write = (id: string, file: string, content: string): HookEvent => ({ type: "PostToolUse", base: base(id), tool: { name: "Write", filePath: file, edits: [{ oldText: null, newText: content }], originalFile: null, command: null, error: null } });
const bash = (id: string, command: string, fail: string | null = null, agent: string | null = null): HookEvent => ({
  type: fail ? "PostToolUseFailure" : "PostToolUse", base: base(id, agent), tool: { name: "Bash", filePath: null, edits: [], originalFile: null, command, error: fail },
});
const outcomes = (out: TrackerRecord[]): OutcomeRecord[] => out.filter((r): r is OutcomeRecord => r.record === "outcome");
const decision = (over: Partial<DecisionInfo>): DecisionInfo => ({ id: "d", at: 0, sessionId: S, agentId: null, kind: "main", turn: "new", conv: "c", requestedModel: "claude-opus-5", sentModel: "claude-sonnet-5", ...over });

describe("OutcomeTracker", () => {
  it("the acceptance sequence: edit, failing test, correction, revert, each joined to the right turn", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "make the parser accept empty input"));
    t.onDecision(decision({ id: "D1", at: now() + 50 }));
    tick(1000);
    t.ingest(edit("P1", "/repo/src/parser.ts", "if (s) {", "if (s !== undefined) {"));
    t.ingest(bash("P1", "npm test", "Exit code 1\n3 failing"));
    tick(1000);
    t.ingest(prompt("P2", "no, that's wrong. revert it"));
    t.onDecision(decision({ id: "D2", at: now() + 50 }));
    t.ingest(edit("P2", "/repo/src/parser.ts", "if (s !== undefined) {", "if (s) {"));
    t.ingest(prompt("P3", "thanks"));
    t.flush();

    const [o1, o2, o3] = outcomes(out);
    assert.ok(o1 && o2 && o3);
    assert.equal(o1.decision_id, "D1");
    assert.equal(o1.turn_id, hashId("P1"));
    assert.deepEqual(o1.signals.test_failure_after_edit, { detected: true, runs: [{ kind: "npm-test", exit_code: 1, edits_before: 1 }] });
    assert.ok((o1.signals.correction?.score ?? 0) >= 1, "P2 reads as a correction of P1's reply");
    assert.ok(o1.signals.correction?.matched.includes("en:thats_wrong"));
    assert.equal(o1.window.closed_by, "next_prompt");
    // The revert happened in turn 2, after turn 1 had closed: it arrives as an update keyed to D1.
    const updates = out.filter((r): r is OutcomeUpdate => r.record === "outcome_update");
    const u = updates.find((r) => r.signal === "reverted_edit");
    assert.ok(u);
    assert.equal(u.decision_id, "D1");
    assert.deepEqual(u.detail, { kind: "inverse_edit", file: hashId("/repo/src/parser.ts"), offset_turns: 1, detected_in_turn_seq: 2 });
    assert.equal(o2.decision_id, "D2");
    assert.equal(o2.signals.correction?.score, 0, "'thanks' is not a correction");
    assert.equal(o3.window.closed_by, "session_end");
    assert.equal(o3.signals.correction, null);
    assert.doesNotMatch(JSON.stringify(out), /parser\.ts|make the parser|revert it|if \(s/, "no paths, prompts or code in the records");
  });

  it("same-turn reverts land in the turn's own record: Write restoring the original, git checkout", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "try something"));
    t.ingest(edit("P1", "/r/a.ts", "x", "y", "ORIGINAL A"));
    t.ingest(write("P1", "/r/a.ts", "ORIGINAL A"));
    t.ingest(edit("P1", "/r/b.ts", "1", "2"));
    t.ingest(bash("P1", "git checkout -- b.ts"));
    t.flush();
    const [o] = outcomes(out);
    assert.deepEqual(o?.signals.reverted_edit.events.map((e) => e.kind), ["write_restore", "git_restore"]);
    assert.ok(o?.signals.reverted_edit.detected);
  });

  it("a test failure without an earlier edit, and a passing test, are not test_failure_after_edit", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "run the tests"));
    t.ingest(bash("P1", "npm test", "Exit code 1"));
    t.ingest(bash("P1", "ls", "Exit code 2"));
    t.ingest(edit("P1", "/r/a.ts", "a", "b"));
    t.ingest(bash("P1", "npm test"));
    t.flush();
    const [o] = outcomes(out);
    assert.equal(o?.signals.test_failure_after_edit.detected, false);
    assert.deepEqual(o?.counts, { edits: 1, bash: 3, bash_failures: 2, test_runs: 2, test_failures: 1, injected_prompts: 0 });
  });

  it("a revert beyond the window is not attributed", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P0", "a"));
    t.ingest(edit("P0", "/r/a.ts", "a", "b"));
    for (let i = 1; i <= REVERT_WINDOW_TURNS + 1; i++) t.ingest(prompt(`P${i}`, "next"));
    t.ingest(edit(`P${REVERT_WINDOW_TURNS + 1}`, "/r/a.ts", "b", "a"));
    t.flush();
    assert.equal(out.filter((r) => r.record === "outcome_update").length, 0);
  });

  it("subagents: several open at once, each keyed by agent id; its failing test counts in its own window and in the turn", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "do two things"));
    t.ingest({ type: "SubagentStart", base: base("P1", "A1"), agentType: "general-purpose" });
    t.ingest({ type: "SubagentStart", base: base("P1", "A2"), agentType: "Explore" });
    t.onDecision(decision({ id: "DA1", kind: "subagent", agentId: "A1" }));
    t.ingest(edit("P1", "/r/x.ts", "1", "2", null, "A1"));
    t.ingest(bash("P1", "npm test", "Exit code 1", "A1"));
    t.ingest(bash("P1", "ls", null, "A2"));
    t.ingest({ type: "SubagentStop", base: base("P1", "A2") });
    t.ingest({ type: "SubagentStop", base: base("P1", "A1") });
    t.ingest({ type: "SubagentStop", base: base("P1", "NEVER-STARTED") });
    t.ingest(bash("P1", "npm test", "Exit code 1"));
    t.flush();
    const os = outcomes(out);
    const a1 = os.find((o) => o.agent === hashId("A1"));
    const a2 = os.find((o) => o.agent === hashId("A2"));
    assert.equal(os.length, 3, "two subagents + the turn; the unknown SubagentStop is ignored");
    assert.equal(a1?.decision_id, "DA1");
    assert.equal(a1?.agent_type, "general-purpose");
    assert.equal(a1?.signals.test_failure_after_edit.detected, true);
    assert.equal(a2?.counts.bash, 1);
    const main = os.find((o) => o.scope === "main");
    assert.equal(main?.signals.test_failure_after_edit.detected, true, "the turn contained its subagent's edit");
  });

  it("a subagent decision that arrives before SubagentStart is bound when the start arrives", () => {
    const { t, out } = tracker();
    t.ingest(prompt("P1", "x"));
    t.onDecision(decision({ id: "DA", kind: "subagent", agentId: "A9" }));
    t.ingest({ type: "SubagentStart", base: base("P1", "A9"), agentType: null });
    t.ingest({ type: "SubagentStop", base: base("P1", "A9") });
    assert.equal(outcomes(out)[0]?.decision_id, "DA");
  });

  it("a wire new main turn with no UserPromptSubmit is flagged harness_injected; one prompt binds only one turn", () => {
    const { t, out, now } = tracker();
    t.ingest(prompt("P1", "real prompt"));
    t.onDecision(decision({ id: "D1", at: now() }));
    t.onDecision(decision({ id: "D-injected", at: now() + 5000 }));
    t.onDecision(decision({ id: "D-side", at: now(), turn: "side" }));
    const flagged = out.filter((r) => r.record === "harness_injected");
    assert.deepEqual(flagged.map((r) => r.record === "harness_injected" && r.decision_id), ["D-injected"]);
  });

  it("no harness_injected flag in a session where no UserPromptSubmit ever arrived (hooks not delivered)", () => {
    const { t, out, now } = tracker();
    t.onDecision(decision({ id: "D1", at: now() }));
    t.onDecision(decision({ id: "D2", at: now() + 60_000 }));
    assert.equal(out.length, 0);
  });

  it("session 2 seq 5/6 replay: injected messages keep the user's turn open and are never scored as its correction", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P4", "real prompt"));
    t.onDecision(decision({ id: "D4", at: now() }));
    tick(10_000);
    // UserPromptSubmit fires for a message from another session and for a task notification (seq 5 and 6).
    t.ingest(prompt("P5", "Another Claude session sent a message:\n<message>no, that's wrong</message>"));
    t.onDecision(decision({ id: "W1", at: now() + 100, turn: "side", sideKind: "cross_session" }));
    t.ingest(bash("P5", "npm test", "Exit code 1")); // work done in response to the injected message joins the open turn
    tick(12_000);
    t.ingest(prompt("P6", "<task-notification>\n<task-id>x</task-id>\nrevert it"));
    t.onDecision(decision({ id: "W3", at: now() - 300, turn: "side", sideKind: "notification" }));
    assert.equal(outcomes(out).length, 0, "neither injected message closed P4 or opened a window");
    tick(3_000);
    t.ingest(prompt("P7", "thanks, looks good"));
    const os = outcomes(out);
    assert.equal(os.length, 1);
    assert.equal(os[0]?.decision_id, "D4");
    assert.equal(os[0]?.counts.injected_prompts, 2);
    assert.equal(os[0]?.counts.test_runs, 1, "the injected turn's tool events were attributed to the open user turn");
    assert.deepEqual(os[0]?.signals.correction, { score: 0, matched: [], prompt_chars: "thanks, looks good".length }, "scored on the next TYPED prompt, not on the injected text");
    assert.equal(out.filter((r) => r.record === "harness_injected").length, 0);
  });

  it("a subagent hand-back keeps the user's turn open, is never scored as its correction, and is counted as injected", () => {
    // The prompt text is the real one Claude Code delivered, taken from the captured hook fixture.
    const handback = events("interactive.hooks.jsonl").find((e) => e.type === "UserPromptSubmit" && e.prompt.startsWith("<agent-message "));
    assert.ok(handback && handback.type === "UserPromptSubmit", "the fixture must contain a hand-back UserPromptSubmit");

    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "find out why the parser drops empty input"));
    t.onDecision(decision({ id: "D1", at: now() }));
    tick(5_000);
    t.ingest(prompt("P2", handback.prompt)); // the fixture's own session id would open a second session
    t.ingest(bash("P2", "npm test")); // work done after the hand-back belongs to the user's still-open turn
    assert.equal(outcomes(out).length, 0, "the hand-back must not close P1 or open a window of its own");
    tick(3_000);
    t.ingest(prompt("P3", "thanks, that explains it"));

    const os = outcomes(out);
    assert.equal(os.length, 1, "only the user's own turn produced a record");
    assert.equal(os[0]?.decision_id, "D1");
    assert.equal(os[0]?.counts.injected_prompts, 1, "the hand-back is counted as an injected prompt");
    assert.equal(os[0]?.counts.test_runs, 1, "tool events after the hand-back joined the open user turn");
    assert.equal(os[0]?.signals.correction?.prompt_chars, "thanks, that explains it".length, "scored on the next TYPED prompt, not on the hand-back");
    assert.equal(os[0]?.signals.correction?.score, 0);
    assert.equal(out.filter((r) => r.record === "harness_injected").length, 0);
    assert.doesNotMatch(JSON.stringify(out), /agent-message|Subagent hand-back/, "no hand-back text reaches the records");
  });

  it("a hand-back whose report quotes a correction does not score the user's turn as corrected", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "investigate the failure"));
    t.onDecision(decision({ id: "D1", at: now() }));
    tick(1_000);
    t.ingest(prompt("P2", '<agent-message from="AGENT-1">\n[Subagent hand-back] no, that\'s wrong — the fix broke it'));
    tick(1_000);
    t.ingest(prompt("P3", "ok"));
    const [o] = outcomes(out);
    assert.deepEqual(o?.signals.correction?.matched, [], "the subagent's words are not the user's correction");
    assert.equal(o?.counts.injected_prompts, 1);
  });

  it("a typed prompt without a wire new turn: no_wire_turn with the nearest main-chat wire classification", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "continue"));
    t.onDecision(decision({ id: "W1", at: now() + 100, turn: "continuation" }));
    t.onDecision(decision({ id: "W2", at: now() + 900, turn: "side", sideKind: "suggestion" }));
    tick(2000);
    t.ingest(prompt("P2", "next"));
    assert.deepEqual(outcomes(out)[0]?.no_decision, { reason: "no_wire_turn", nearest_wire: "continuation" });
  });

  it("an interjection joins the pinned conversation's own decision, so the next correction attaches to it", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "make the parser accept empty input"));
    t.onDecision(decision({ id: "D1", at: now() + 50, turn: "new", conv: "c" }));
    tick(1000);
    // The user types into the running tool loop: a continuation on the wire, but a real prompt through the hook.
    t.ingest(prompt("P2", "no, that's wrong"));
    t.onDecision(decision({ id: "Dx", at: now() + 50, turn: "continuation", interjection: true, conv: "c" }));
    tick(1000);
    t.ingest(prompt("P3", "still broken"));
    const [w1, w2] = outcomes(out);
    assert.equal(w1?.decision_id, "D1");
    assert.equal(w2?.decision_id, "D1", "the interjection's window joins the turn's decision");
    assert.equal(w2?.attribution, "interjection");
    assert.equal(w2?.no_decision, null);
    assert.deepEqual(w2?.models, { requested: "claude-opus-5", sent: "claude-sonnet-5" }, "the pin held, so the turn's models apply");
    assert.ok((w2?.signals.correction?.score ?? 0) > 0, "the next prompt's correction lands on a joined window");
  });

  it("an interjection on a conversation with no earlier decision stays no_wire_turn", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "continue"));
    t.onDecision(decision({ id: "Dx", at: now() + 50, turn: "continuation", interjection: true, conv: "c" }));
    tick(1000);
    t.ingest(prompt("P2", "next"));
    assert.deepEqual(outcomes(out)[0]?.no_decision, { reason: "no_wire_turn", nearest_wire: "continuation:interjection" });
  });

  it("a plain continuation is never joined, even on a conversation with a decision", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "do the thing"));
    t.onDecision(decision({ id: "D1", at: now() + 50, turn: "new", conv: "c" }));
    tick(1000);
    t.ingest(prompt("P2", "and this"));
    t.onDecision(decision({ id: "Dy", at: now() + 50, turn: "continuation", conv: "c" }));
    tick(1000);
    t.ingest(prompt("P3", "done"));
    const w2 = outcomes(out)[1];
    assert.equal(w2?.decision_id, null);
    assert.equal(w2?.attribution, "prompt_id");
    assert.equal(w2?.no_decision?.reason, "no_wire_turn");
  });

  it("no wire request at all in the window: nearest_wire is null", () => {
    const { t, out, tick } = tracker();
    t.ingest(prompt("P1", "a"));
    tick(1000);
    t.ingest(prompt("P2", "b"));
    assert.deepEqual(outcomes(out)[0]?.no_decision, { reason: "no_wire_turn", nearest_wire: null });
  });

  it("a slash-command prompt opens no window and leaves the current turn open; its expansion is not flagged injected", () => {
    const { t, out, tick, now } = tracker();
    t.ingest(prompt("P1", "fix the bug"));
    t.onDecision(decision({ id: "D1", at: now() }));
    tick(5000);
    t.ingest(prompt("P2", "/model sonnet"));
    t.ingest(prompt("P3", "  /review-pr 12"));
    t.onDecision(decision({ id: "D-slash", at: now() + 500 })); // a custom command that expands into a model turn
    assert.equal(outcomes(out).length, 0, "P1 is still open: the slash commands closed nothing");
    assert.equal(out.filter((r) => r.record === "harness_injected").length, 0);
    tick(5000);
    t.ingest(prompt("P4", "no, that's wrong"));
    const [o] = outcomes(out);
    assert.equal(o?.decision_id, "D1");
    assert.ok((o?.signals.correction?.score ?? 0) >= 1, "the correction comes from the next real prompt, not the slash command");
    assert.equal(outcomes(out).length, 1, "no windows for the slash commands");
  });

  it("replays the captured sdk-cli hook stream: subagent window, then the main turn", () => {
    const { t, out } = tracker();
    for (const e of events("sonnet-agent-run.hooks.jsonl")) t.ingest(e);
    t.flush();
    const os = outcomes(out);
    assert.deepEqual(os.map((o) => o.scope), ["subagent", "main"]);
    const main = os[1]!;
    assert.deepEqual(main.counts, { edits: 1, bash: 2, bash_failures: 1, test_runs: 0, test_failures: 0, injected_prompts: 0 });
    assert.equal(main.signals.test_failure_after_edit.detected, false, "`node -e process.exit(1)` is not a test run");
  });

  it("replays the captured interactive hook stream: SubagentStop for never-started agents is ignored", () => {
    const { t, out } = tracker();
    for (const e of events("interactive.hooks.jsonl")) t.ingest(e);
    t.flush();
    const subs = outcomes(out).filter((o) => o.scope === "subagent");
    assert.equal(subs.length, 1, "only the Explore agent had a SubagentStart");
    assert.equal(subs[0]?.agent_type, "Explore");
  });

  it("never throws on odd sequences", () => {
    const { t } = tracker();
    t.ingest({ type: "SubagentStop", base: base("X", "nobody") });
    t.ingest(edit("unknown-prompt", "/r/a", "a", "b"));
    t.onDecision(decision({ sessionId: null }));
    t.flush();
    t.flush();
  });
});
