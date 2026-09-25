import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { injectSettings, loadSettingsValue, mergeSettings, readSettingsFile, realInjectIO, sandboxEnabled, splitSettingsArgs, userSettingsFromArgv, type InjectedSettings } from "../../src/launcher/settings-inject.js";

const injected: InjectedSettings = { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } };
const withHooks: InjectedSettings = { ...injected, hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:9/__reflex/hook" }] }] } };

describe("splitSettingsArgs", () => {
  it("removes --settings X and --settings=X and reports the values in order", () => {
    const s = splitSettingsArgs(["-p", "hi", "--settings", "a.json", "--model", "sonnet", "--settings={\"x\":1}"]);
    assert.deepEqual(s.rest, ["-p", "hi", "--model", "sonnet"]);
    assert.deepEqual(s.values, ["a.json", '{"x":1}']);
    assert.equal(s.insertAt, s.rest.length);
    assert.equal(s.dangling, false);
  });
  it("treats everything after a -- terminator as literal", () => {
    const s = splitSettingsArgs(["--model", "x", "--", "--settings", "not-a-flag"]);
    assert.deepEqual(s.rest, ["--model", "x", "--", "--settings", "not-a-flag"]);
    assert.deepEqual(s.values, []);
    assert.equal(s.insertAt, 2);
  });
  it("leaves a value-less trailing --settings for claude to complain about", () => {
    const s = splitSettingsArgs(["-p", "--settings"]);
    assert.equal(s.dangling, true);
    assert.deepEqual(s.rest, ["-p", "--settings"]);
  });
  it("passes an empty argv through", () => {
    assert.deepEqual(splitSettingsArgs([]), { rest: [], values: [], insertAt: 0, dangling: false });
  });
});

describe("loadSettingsValue", () => {
  const read = (files: Record<string, string>) => (p: string): string => {
    const v = files[p];
    if (v === undefined) throw Object.assign(new Error("nope"), { code: "ENOENT" });
    return v;
  };
  it("parses inline JSON", () => {
    assert.deepEqual(loadSettingsValue('  {"a":1}', "/w", read({})), { ok: true, settings: { a: 1 } });
  });
  it("reads a file, resolving relative paths against cwd", () => {
    assert.deepEqual(loadSettingsValue("s.json", "/w", read({ "/w/s.json": '{"b":2}' })), { ok: true, settings: { b: 2 } });
  });
  it("fails with a reason for missing files, bad JSON, and non-objects", () => {
    assert.deepEqual(loadSettingsValue("x.json", "/w", read({})), { ok: false, reason: "cannot read x.json: ENOENT" });
    assert.deepEqual(loadSettingsValue("{oops", "/w", read({})), { ok: false, reason: "not valid JSON" });
    assert.deepEqual(loadSettingsValue("f", "/w", read({ "/w/f": "[1]" })), { ok: false, reason: "not a JSON object" });
    assert.deepEqual(loadSettingsValue("f", "/w", read({ "/w/f": "null" })), { ok: false, reason: "not a JSON object" });
  });
});

describe("mergeSettings", () => {
  it("with no user settings, yields ours", () => {
    assert.deepEqual(mergeSettings(null, injected), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } });
  });
  it("keeps every user key, and lets our env keys win while keeping theirs", () => {
    const merged = mergeSettings({ model: "opus", env: { FOO: "1", ANTHROPIC_BASE_URL: "http://theirs" } }, injected);
    assert.deepEqual(merged, { model: "opus", env: { FOO: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } });
  });
  it("appends our hook groups after the user's for the same event, and adds new events", () => {
    const user = { hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }], Stop: [] } };
    const merged = mergeSettings(user, withHooks) as { hooks: Record<string, { matcher?: string }[]> };
    assert.deepEqual(merged.hooks["PostToolUse"]?.map((g) => g.matcher), ["Bash", "*"]);
    assert.deepEqual(merged.hooks["Stop"], []);
  });
  it("does not mutate its inputs", () => {
    const user = { env: { A: "1" }, hooks: { PostToolUse: [] as unknown[] } };
    const snapshot = JSON.stringify(user);
    mergeSettings(user, withHooks);
    assert.equal(JSON.stringify(user), snapshot);
  });
});

describe("injectSettings (real filesystem)", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });
  const run = (argv: string[], inj: InjectedSettings = injected, cwd = process.cwd()) => {
    const r = injectSettings(argv, inj, realInjectIO(cwd));
    cleanups.push(r.cleanup);
    return r;
  };
  const settingsArg = (args: readonly string[]): string => {
    const i = args.indexOf("--settings");
    assert.ok(i >= 0, "no --settings in args");
    return args[i + 1] as string;
  };

  it("adds exactly one --settings pointing at a private file", () => {
    const r = run(["-p", "hello"]);
    assert.equal(r.injected, true);
    assert.equal(r.args.filter((a) => a === "--settings").length, 1);
    const file = settingsArg(r.args);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" } });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  });

  it("keeps the user's other arguments in order, inserting ours before a -- terminator", () => {
    const r = run(["-p", "hi", "--model", "sonnet", "--", "x"]);
    assert.deepEqual([...r.args.slice(0, 4), r.args[4], r.args[6], r.args[7]], ["-p", "hi", "--model", "sonnet", "--settings", "--", "x"]);
  });

  it("merges the user's inline --settings and passes a single flag (last flag wins, as observed in claude)", () => {
    const r = run(["--settings", '{"model":"first"}', "-p", "x", "--settings", '{"model":"second","effortLevel":"high"}']);
    assert.equal(r.args.filter((a) => a === "--settings").length, 1);
    const merged = JSON.parse(fs.readFileSync(settingsArg(r.args), "utf8")) as Record<string, unknown>;
    assert.equal(merged["model"], "second");
    assert.equal(merged["effortLevel"], "high");
    assert.deepEqual(merged["env"], { ANTHROPIC_BASE_URL: "http://127.0.0.1:9" });
  });

  it("merges a user --settings FILE, resolved against cwd, without touching the original", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-test-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const userFile = path.join(dir, "mine.json");
    const original = '{"permissions":{"allow":["Bash(ls)"]}}';
    fs.writeFileSync(userFile, original);
    const r = run(["--settings", "mine.json"], withHooks, dir);
    const merged = JSON.parse(fs.readFileSync(settingsArg(r.args), "utf8")) as { permissions: unknown; hooks: unknown };
    assert.deepEqual(merged.permissions, { allow: ["Bash(ls)"] });
    assert.ok(merged.hooks);
    assert.equal(fs.readFileSync(userFile, "utf8"), original);
  });

  it("falls back to the untouched argv, with a warning, when the user's value cannot be merged", () => {
    const argv = ["--settings", "/definitely/missing.json", "-p", "x"];
    const r = run(argv);
    assert.equal(r.injected, false);
    assert.deepEqual(r.args, argv);
    assert.match(r.warning ?? "", /could not merge your --settings/);
  });

  it("does nothing for a dangling --settings", () => {
    const r = run(["-p", "--settings"]);
    assert.equal(r.injected, false);
    assert.equal(r.warning, null);
  });

  it("cleanup removes the temp directory", () => {
    const r = run(["-p", "x"]);
    const dir = path.dirname(settingsArg(r.args));
    assert.ok(fs.existsSync(dir));
    r.cleanup();
    assert.equal(fs.existsSync(dir), false);
  });
});

describe("sandboxEnabled (REFLEX_HOOKS=auto relays the outcome hooks through a command hook under Claude Code's sandbox)", () => {
  it("reads sandbox.enabled from the sources in increasing precedence; the last one that sets it wins", () => {
    const on = { sandbox: { enabled: true } };
    const off = { sandbox: { enabled: false } };
    assert.equal(sandboxEnabled([]), false);
    assert.equal(sandboxEnabled([null, { statusLine: {} }, null]), false);
    assert.equal(sandboxEnabled([null, null, on]), true); // a project's .claude/settings.local.json
    assert.equal(sandboxEnabled([on, off]), false); // the project turns off what the user turned on
    assert.equal(sandboxEnabled([null, null, on, off, null]), false); // the user's --settings wins over the project
    assert.equal(sandboxEnabled([null, null, null, off, on]), true); // managed settings win over everything
    assert.equal(sandboxEnabled([{ sandbox: { enabled: "yes" } }, { sandbox: true }]), false); // only a boolean counts
  });

  it("finds the user's --settings value, inline or a file, and nothing when it is absent or unreadable", () => {
    const read = (p: string): string => {
      if (p === "/w/s.json") return JSON.stringify({ sandbox: { enabled: true } });
      throw new Error("ENOENT");
    };
    assert.deepEqual(userSettingsFromArgv(["-p", "x", "--settings", '{"sandbox":{"enabled":false}}'], "/w", read), { sandbox: { enabled: false } });
    assert.deepEqual(userSettingsFromArgv(["--settings=/w/s.json"], "/w", read), { sandbox: { enabled: true } });
    assert.equal(userSettingsFromArgv(["-p", "x"], "/w", read), null);
    assert.equal(userSettingsFromArgv(["--settings", "/w/missing.json"], "/w", read), null);
    assert.equal(readSettingsFile("/w/missing.json", read), null);
    assert.equal(readSettingsFile("/w/s.json", () => "[1]"), null); // not an object
  });
});
