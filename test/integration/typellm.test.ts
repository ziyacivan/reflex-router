// REFLEX_BACKEND=typellm end to end: real front door + supervisor + worker process built from the config (no injected
// backend), fake upstream, fake TypeLLM. The upstream sees the original bytes, a `new` turn reaches TypeLLM with the
// TypeLLM key and never the TypeSafe one, and the decision record names the backend and the model that answered.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { startFakeTypeLLM, type FakeTypeLLM } from "../support/fake-typellm.js";
import { loadFixtures } from "../support/fixtures.js";
import { replay, sseHandler } from "../support/replay.js";
import { startStack, type Stack } from "../support/stack.js";

describe("typellm backend, end to end (shadow)", () => {
  let tl: FakeTypeLLM;
  let stack: Stack;
  before(async () => {
    tl = await startFakeTypeLLM({ kind: "answer", tier: "haiku", p: 0.95 });
    stack = await startStack({ config: { backend: "typellm", typellmApiKey: "tl-sk-test", typellmBaseUrl: tl.url, typellmDeadlineMs: 800 } });
    stack.upstream.setHandler(sseHandler);
  });
  after(async () => {
    await stack.close();
    await tl.close();
  });

  it("decides a new turn with TypeLLM and forwards the request unchanged", async () => {
    const fx = loadFixtures().find((f) => f.expect.turn === "new" && f.expect.kind !== "unknown");
    assert.ok(fx);
    const { status, rec } = await replay(stack, fx);
    assert.equal(status, 200);
    assert.ok(stack.upstream.seen.at(-1)?.body.equals(fx.body), "upstream must receive the original bytes");
    assert.equal(tl.calls.length, 1);
    assert.equal(tl.calls[0]!.headers.authorization, "Bearer tl-sk-test");
    assert.doesNotMatch(JSON.stringify(tl.calls[0]!.headers), /apikey_/, "the TypeSafe key never reaches TypeLLM");
    assert.equal(rec.error, null);
    assert.equal(rec["backend"], "typellm");
    assert.equal(rec["backend_version"], "typellm-test");
    const d = rec.decision as { pick_mass: { value: string } };
    assert.equal(d.pick_mass.value, "haiku");
  });
});
