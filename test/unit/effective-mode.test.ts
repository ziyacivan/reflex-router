import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig, type Config, type Mode } from "../../src/config.js";
import { resolveEffectiveMode } from "../../src/effective-mode.js";
import type { VersionVerdict } from "../../src/launcher/version.js";

const base = loadConfig({ REFLEX_MODE: "route", TYPESAFE_API_KEY: "apikey_x" }, "/h");
const cfg = (over: Partial<Config> = {}): Config => {
  assert.ok(base.ok);
  return { ...base.config, ...over };
};
const verdict = (level: VersionVerdict["level"]): VersionVerdict => ({ level, reason: level === "degrade" ? "major_mismatch" : "exact_match", running: "3.0.0", tested: ["2.1.277"] });

describe("resolveEffectiveMode", () => {
  it("off stays off regardless of anything else", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ mode: "off", typesafeApiKey: undefined }), verdict("degrade")), { mode: "off", degradedReason: null });
  });

  it("without a backend key there is nothing to decide with: passthrough", () => {
    for (const mode of ["route", "shadow"] as Mode[]) {
      assert.deepEqual(resolveEffectiveMode(cfg({ mode, typesafeApiKey: undefined }), null), { mode: "passthrough", degradedReason: "no_backend_key" });
    }
  });

  it("typellm needs its own key, not the TypeSafe one", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ backend: "typellm", typellmApiKey: undefined }), null), { mode: "passthrough", degradedReason: "no_backend_key" });
    assert.deepEqual(resolveEffectiveMode(cfg({ backend: "typellm", typellmApiKey: "tl-sk-x", typesafeApiKey: undefined }), null), { mode: "route", degradedReason: null });
  });

  it("laya needs no TypeSafe key", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ backend: "laya", typesafeApiKey: undefined }), null), { mode: "route", degradedReason: null });
  });

  it("a major-version mismatch turns route into shadow, and says why", () => {
    assert.deepEqual(resolveEffectiveMode(cfg(), verdict("degrade")), { mode: "shadow", degradedReason: "claude_version:major_mismatch" });
  });

  it("a major-version mismatch does not touch shadow", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ mode: "shadow" }), verdict("degrade")), { mode: "shadow", degradedReason: null });
  });

  it("warn and ok verdicts never change the mode (the version is only a hint)", () => {
    assert.equal(resolveEffectiveMode(cfg(), verdict("warn")).mode, "route");
    assert.equal(resolveEffectiveMode(cfg(), verdict("ok")).mode, "route");
    assert.equal(resolveEffectiveMode(cfg(), null).mode, "route");
  });

  it("REFLEX_IGNORE_VERSION_CHECK suppresses the degrade", () => {
    assert.deepEqual(resolveEffectiveMode(cfg({ ignoreVersionCheck: true }), verdict("degrade")), { mode: "route", degradedReason: null });
  });
});
