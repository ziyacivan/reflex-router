import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import { DEFAULT_UPSTREAM, defaultHome, isReflexEnvName, loadConfig, SETTING_NAMES, unknownReflexEnvNames, type Config } from "../../src/config.js";

const load = (env: NodeJS.ProcessEnv): { config: Config; warnings: readonly string[] } => {
  const r = loadConfig(env, "/home/u");
  assert.ok(r.ok, r.ok ? "" : r.errors.join("; "));
  return r;
};
const errors = (env: NodeJS.ProcessEnv): readonly string[] => {
  const r = loadConfig(env, "/home/u");
  assert.ok(!r.ok);
  return r.errors;
};

describe("loadConfig", () => {
  it("has safe defaults: shadow mode, jev backend, api.anthropic.com, state under ~/.reflex", () => {
    const { config, warnings } = load({});
    assert.equal(config.mode, "shadow");
    assert.equal(config.backend, "jev");
    assert.equal(config.upstreamUrl, DEFAULT_UPSTREAM);
    assert.equal(config.home, "/home/u/.reflex");
    assert.equal(config.typesafeApiKey, undefined);
    assert.equal(config.ignoreVersionCheck, false);
    assert.deepEqual(warnings, []);
  });

  it("parses mode and backend case-insensitively", () => {
    assert.equal(load({ REFLEX_MODE: "ROUTE" }).config.mode, "route");
    assert.equal(load({ REFLEX_MODE: " off " }).config.mode, "off");
    assert.equal(load({ REFLEX_BACKEND: "Laya" }).config.backend, "laya");
  });

  it("rejects unknown mode/backend values with the offending name in the message", () => {
    assert.match(errors({ REFLEX_MODE: "turbo" }).join(), /REFLEX_MODE/);
    assert.match(errors({ REFLEX_BACKEND: "gpt" }).join(), /REFLEX_BACKEND/);
    assert.match(errors({ REFLEX_BACKEND: "local" }).join(), /REFLEX_BACKEND/); // the placeholder is gone
    assert.equal(errors({ REFLEX_MODE: "x", REFLEX_BACKEND: "y" }).length, 2);
  });

  it("treats an empty value as unset", () => {
    assert.equal(load({ REFLEX_MODE: "" }).config.mode, "shadow");
  });

  it("treats an empty or whitespace-only URL as unset and falls through to the next source", () => {
    assert.equal(load({ ANTHROPIC_BASE_URL: "" }).config.upstreamUrl, DEFAULT_UPSTREAM);
    assert.equal(load({ ANTHROPIC_BASE_URL: "   " }).config.upstreamUrl, DEFAULT_UPSTREAM);
    assert.equal(load({ REFLEX_UPSTREAM_URL: "", ANTHROPIC_BASE_URL: "https://gw.example.com" }).config.upstreamUrl, "https://gw.example.com");
    assert.equal(load({ REFLEX_UPSTREAM_URL: "", ANTHROPIC_BASE_URL: "" }).config.upstreamUrl, DEFAULT_UPSTREAM);
  });

  it("treats empty REFLEX_* values as unset: defaults, and the ANTHROPIC_DEFAULT_*_MODEL fallback", () => {
    const { config } = load({ REFLEX_JEV_DEADLINE_MS: "", REFLEX_TIERS: "", REFLEX_MODEL_HAIKU: "", ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-x" });
    assert.equal(config.jevDeadlineMs, load({}).config.jevDeadlineMs);
    assert.deepEqual(config.tiers, ["haiku", "sonnet", "opus"]);
    assert.equal(config.models.haiku, "claude-haiku-x");
  });

  it("every setting set to an empty string gives the same config as an empty environment", () => {
    assert.deepEqual(load(Object.fromEntries(SETTING_NAMES.map((n) => [n, ""]))), load({}));
    assert.deepEqual(load(Object.fromEntries(SETTING_NAMES.map((n) => [n, " \t"]))), load({}));
  });

  it("upstream precedence: REFLEX_UPSTREAM_URL, then the user's ANTHROPIC_BASE_URL, then the default", () => {
    assert.equal(load({ REFLEX_UPSTREAM_URL: "http://a.test", ANTHROPIC_BASE_URL: "http://b.test" }).config.upstreamUrl, "http://a.test");
    assert.equal(load({ ANTHROPIC_BASE_URL: "https://gw.example.com" }).config.upstreamUrl, "https://gw.example.com");
  });

  it("keeps a gateway path prefix but drops trailing slashes", () => {
    assert.equal(load({ ANTHROPIC_BASE_URL: "https://gw.example.com/anthropic/" }).config.upstreamUrl, "https://gw.example.com/anthropic");
  });

  it("rejects non-http(s) and malformed upstream URLs, naming the variable", () => {
    assert.match(errors({ REFLEX_UPSTREAM_URL: "ftp://x" }).join(), /REFLEX_UPSTREAM_URL/);
    assert.match(errors({ ANTHROPIC_BASE_URL: "not a url" }).join(), /ANTHROPIC_BASE_URL/);
  });

  it("accepts a well-formed TypeSafe key and trims it", () => {
    assert.equal(load({ TYPESAFE_API_KEY: "  apikey_abc123  " }).config.typesafeApiKey, "apikey_abc123");
  });

  it("ignores a key without the apikey_ prefix, warns, and never echoes the value", () => {
    const { config, warnings } = load({ TYPESAFE_API_KEY: "sk-ant-secret-value" });
    assert.equal(config.typesafeApiKey, undefined);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings.join(), /sk-ant-secret-value/);
  });

  it("reads REFLEX_HOME, REFLEX_CLAUDE_BIN and the version-check switch", () => {
    const { config } = load({ REFLEX_HOME: "/data/rf", REFLEX_CLAUDE_BIN: "/opt/claude", REFLEX_IGNORE_VERSION_CHECK: "1" });
    assert.equal(config.home, "/data/rf");
    assert.equal(config.claudeBin, "/opt/claude");
    assert.equal(config.ignoreVersionCheck, true);
  });

  it("only a truthy word enables REFLEX_IGNORE_VERSION_CHECK", () => {
    for (const v of ["1", "true", "YES", "on"]) assert.equal(load({ REFLEX_IGNORE_VERSION_CHECK: v }).config.ignoreVersionCheck, true, v);
    for (const v of ["0", "false", "", "no", "maybe"]) assert.equal(load({ REFLEX_IGNORE_VERSION_CHECK: v }).config.ignoreVersionCheck, false, v);
  });
});

describe("isReflexEnvName", () => {
  it("matches reflex settings and every TypeSafe credential, nothing else", () => {
    for (const n of ["REFLEX_MODE", "REFLEX_ANYTHING", "TYPESAFE_API_KEY", "TYPESAFE_BASE_URL"]) assert.equal(isReflexEnvName(n), true, n);
    for (const n of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_X", "PATH", "reflex_mode"]) assert.equal(isReflexEnvName(n), false, n);
  });
});

describe("SETTING_NAMES", () => {
  const source = fs.readFileSync("src/config.ts", "utf8");
  it("lists every variable loadConfig reads, and nothing it does not", () => {
    const read = new Set<string>();
    for (const m of source.matchAll(/(?:env\[|setting\(env, )"([A-Z_]+)"/g)) read.add(m[1]!);
    for (const t of ["HAIKU", "SONNET", "OPUS", "FABLE"]) {
      read.add(`REFLEX_MODEL_${t}`);
      read.add(`ANTHROPIC_DEFAULT_${t}_MODEL`);
    }
    assert.deepEqual([...SETTING_NAMES].sort(), [...read].sort());
  });
  it("unknownReflexEnvNames names what nothing reads, and stays quiet about what is read", () => {
    // A REFLEX_* name nothing reads is ignored by loadConfig and then stripped from the child's environment, so it
    // vanishes without a word: REFLEX_DUMP=1 ran for a whole session before anyone noticed. doctor now names it.
    assert.deepEqual(unknownReflexEnvNames({ REFLEX_DUMP: "1", REFLEX_MODE: "shadow", PATH: "/bin" }), ["REFLEX_DUMP"]);
    assert.deepEqual(unknownReflexEnvNames({ TYPESAFE_DEBUG: "1", TYPESAFE_API_KEY: "k" }), ["TYPESAFE_DEBUG"]);
    assert.deepEqual(unknownReflexEnvNames(Object.fromEntries(SETTING_NAMES.map((n) => [n, "x"]))), [], "no known setting is ever reported");
    assert.deepEqual(unknownReflexEnvNames({ REFLEX_DUMP: "  " }), [], "an empty value is not a setting anyone meant");
    assert.deepEqual(unknownReflexEnvNames({ ANTHROPIC_WHATEVER: "1", reflex_dump: "1" }), [], "only our own prefixes, case-sensitively");
    assert.deepEqual(unknownReflexEnvNames({ REFLEX_Z: "1", REFLEX_A: "1" }), ["REFLEX_A", "REFLEX_Z"], "sorted");
  });

  it("defaultHome is REFLEX_HOME, else ~/.reflex", () => {
    assert.equal(defaultHome({}, "/h"), "/h/.reflex");
    assert.equal(defaultHome({ REFLEX_HOME: " /x " }, "/h"), "/x");
  });
});

describe("REFLEX_HOOKS", () => {
  it("is auto by default, takes http, command and off, and refuses anything else", () => {
    assert.equal(load({}).config.hooks, "auto");
    assert.equal(load({ REFLEX_HOOKS: "off" }).config.hooks, "off");
    assert.equal(load({ REFLEX_HOOKS: "http" }).config.hooks, "http");
    assert.equal(load({ REFLEX_HOOKS: "command" }).config.hooks, "command");
    assert.equal(loadConfig({ REFLEX_HOOKS: "on" }, "/home/u").ok, false);
    assert.equal(loadConfig({ REFLEX_HOOKS: "maybe" }, "/home/u").ok, false);
    assert.ok(SETTING_NAMES.includes("REFLEX_HOOKS"));
  });

  it("says the delegation hint has no way through with the hooks off", () => {
    assert.ok(load({ REFLEX_HOOKS: "off", REFLEX_DELEGATE: "1" }).warnings.some((w) => w.includes("REFLEX_HOOKS=off")));
  });
});
