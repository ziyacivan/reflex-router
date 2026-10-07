// Contract tests: every captured, redacted request under test/fixtures/claude-code/<version>/ that carries a
// hand-assigned `expect` label in its manifest must parse to exactly that classification, and every tool-loop request
// must pass the runtime shape assertions. Adding a fixture directory for a new Claude Code version adds its cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RequestView } from "../../src/wire/claude-code.js";
import { assertShape, shapeCheckApplies } from "../../src/wire/shape.js";
import { loadFixtures, viewOf } from "../support/fixtures.js";

const fixtures = loadFixtures();

describe("wire contract: fixtures parse to their labelled classification", () => {
  it("there are labelled fixtures for both entrypoints", () => {
    const eps = new Set(fixtures.map((fx) => viewOf(fx).entrypoint));
    assert.ok(eps.has("cli") && eps.has("sdk-cli"), [...eps].join());
    assert.ok(fixtures.length >= 15);
  });

  for (const fx of fixtures) {
    it(`${fx.version}/${fx.file}`, () => {
      const v = viewOf(fx);
      const got = { kind: v.kind, signal: v.signal, turn: v.turn, ...(v.sideKind !== null ? { side_kind: v.sideKind } : {}), ...(v.unclassifiedReason !== null ? { unclassified_reason: v.unclassifiedReason } : {}) };
      const { decided: _decided, ...classification } = fx.expect; // `decided` is about the router, not the wire
      assert.deepEqual(got, classification);
      if (v.turn === "new") assert.ok(v.task && v.task.length > 0, "a new turn has task text");
      else assert.equal(v.task, null);
      if (v.kind !== "unknown") assert.ok(v.convKey, "classified requests have a conversation key");
      if (v.kind === "subagent") assert.ok(v.signals.s1, "cc_is_subagent is present on every captured subagent request");
      assert.equal(v.clientVersion, fx.version, "user-agent carries the client version");
    });
  }
});

describe("wire contract: runtime shape assertions hold on every tool-loop fixture", () => {
  for (const fx of fixtures) {
    it(`${fx.version}/${fx.file}`, () => {
      const v = viewOf(fx);
      if (!shapeCheckApplies(v)) return;
      assert.deepEqual(assertShape(v), []);
    });
  }
});

describe("wire contract: stable facts across a session", () => {
  const byLabel = (prefix: string): RequestView[] => fixtures.filter((f) => f.file.startsWith(prefix)).map(viewOf);

  it("main-chat requests of one conversation share a conversation key; /compact starts a new one", () => {
    const main = fixtures.filter((f) => f.file.startsWith("interactive.main-")).map((f) => ({ f: f.file, v: viewOf(f) }));
    const before = main.filter((x) => !x.f.includes("after-compact")).map((x) => x.v.convKey);
    assert.equal(new Set(before).size, 1, "one key before /compact (side calls share it, which is why they never touch a pin)");
    const after = main.find((x) => x.f.includes("after-compact"))?.v.convKey;
    assert.ok(after && after !== before[0]);
  });

  it("a subagent's requests share one key derived from the agent-id header, distinct from the main chat", () => {
    const sub = byLabel("interactive.subagent-");
    assert.equal(new Set(sub.map((v) => v.convKey)).size, 1);
    assert.match(sub[0]?.convKey ?? "", /:a:/);
  });

  it("the agent-prompt marker is optional: absent on the interactive Explore subagent, present on sdk-cli general-purpose", () => {
    assert.ok(byLabel("interactive.subagent-").every((v) => !v.signals.s2));
    assert.ok(byLabel("sonnet-agent-run.subagent-").every((v) => v.signals.s2));
  });

  it("the main chat's cache breakpoints are 1-hour ones; a subagent's carry no ttl, the 5-minute default", () => {
    const views = fixtures.map(viewOf);
    const main = views.filter((v) => v.kind === "main" && v.turn !== "side");
    const sub = views.filter((v) => v.kind === "subagent");
    assert.ok(main.length >= 5 && sub.length >= 5);
    assert.deepEqual(new Set(main.map((v) => v.facts.cacheTtl)), new Set(["1h"]));
    assert.deepEqual(new Set(sub.map((v) => v.facts.cacheTtl)), new Set(["5m"]));
  });

  it("side markers are matched on the last message only: a later user turn is not side because of history", () => {
    const later = byLabel("interactive.main-new-turn-plain")[0];
    assert.equal(later?.turn, "new");
  });

  it("the task text excludes harness reminders, local-command wrappers and pasted-content tags", () => {
    for (const v of fixtures.map(viewOf).filter((x) => x.turn === "new")) {
      assert.doesNotMatch(v.task ?? "", /<system-reminder>|<local-command-|<command-name>|<\/?pasted_content/);
    }
  });

  it("a pasted prompt (interactive.main-new-turn) keeps its text but loses the <pasted_content id=…> wrapper", () => {
    const raw = fixtures.find((f) => f.file === "interactive.main-new-turn.request.json")!.body.toString();
    assert.match(raw, /<pasted_content id=\\"ec1f\\">/, "the fixture really carries the wrapper");
    const task = byLabel("interactive.main-new-turn.request")[0]?.task ?? "";
    assert.ok(task.length > 20);
    assert.doesNotMatch(task, /pasted_content/);
    assert.match(task, /use a subage/, "the pasted text itself is kept");
  });
});
