import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { doctorCommand } from "../../src/commands.js";
import { mergeEnvFile, parseEnvFile, type EnvFileIO } from "../../src/env-file.js";

const KEY = "apikey_secret_value_123";
const memIO = (files: Record<string, { text: string; mode: number }>, platform: NodeJS.Platform = "linux"): EnvFileIO => ({
  stat: (f) => (files[f] ? { mode: files[f].mode } : null),
  read: (f) => files[f]!.text,
  platform,
});
const FILE = "/h/.reflex/env";
const merge = (env: NodeJS.ProcessEnv, text: string, mode = 0o100600) => mergeEnvFile(env, memIO({ [FILE]: { text, mode } }), "/h");

describe("parseEnvFile", () => {
  it("reads KEY=value lines, comments, export, quotes and trailing comments", () => {
    const p = parseEnvFile(`# comment\n\nREFLEX_MODE=route\nexport REFLEX_TIERS = "haiku,sonnet"\nREFLEX_UPGRADES='on'\nREFLEX_MASS_EPS=0.2 # inline\nREFLEX_LOG_PROMPTS="a # b"\n`);
    assert.deepEqual(p.values, { REFLEX_MODE: "route", REFLEX_TIERS: "haiku,sonnet", REFLEX_UPGRADES: "on", REFLEX_MASS_EPS: "0.2", REFLEX_LOG_PROMPTS: "a # b" });
    assert.deepEqual(p.malformedLines, []);
  });
  it("ignores names outside REFLEX_* / TYPESAFE_API_KEY and reports malformed lines by number, never by text", () => {
    const p = parseEnvFile(`ANTHROPIC_API_KEY=sk-ant-x\nPATH=/bin\nTYPESAFE_OTHER=1\nnot a pair ${KEY}\nTYPESAFE_API_KEY=${KEY}\n`);
    assert.deepEqual(p.values, { TYPESAFE_API_KEY: KEY });
    assert.deepEqual(p.ignored, ["ANTHROPIC_API_KEY", "PATH", "TYPESAFE_OTHER"]);
    assert.deepEqual(p.malformedLines, [4]);
  });
  it("handles CRLF line endings", () => {
    assert.deepEqual(parseEnvFile("REFLEX_MODE=off\r\nREFLEX_TIERS=haiku\r\n").values, { REFLEX_MODE: "off", REFLEX_TIERS: "haiku" });
  });
});

describe("mergeEnvFile", () => {
  it("is absent when there is no file, and leaves the environment as it was", () => {
    const env = { REFLEX_MODE: "route" };
    const m = mergeEnvFile(env, memIO({}), "/h");
    assert.equal(m.state, "absent");
    assert.equal(m.env, env);
    assert.equal(m.file, FILE);
  });
  it("puts the file UNDER the process environment: process values win, file fills the rest", () => {
    const m = merge({ REFLEX_MODE: "shadow", PATH: "/bin" }, `REFLEX_MODE=route\nREFLEX_TIERS=haiku\nTYPESAFE_API_KEY=${KEY}\n`);
    assert.equal(m.state, "loaded");
    assert.equal(m.env["REFLEX_MODE"], "shadow");
    assert.equal(m.env["REFLEX_TIERS"], "haiku");
    assert.equal(m.env["TYPESAFE_API_KEY"], KEY);
    assert.equal(m.env["PATH"], "/bin");
    assert.deepEqual([...m.fromFile].sort(), ["REFLEX_TIERS", "TYPESAFE_API_KEY"]);
    assert.deepEqual(m.overridden, ["REFLEX_MODE"]);
  });
  it("treats an empty process value as unset, like the config does", () => {
    const m = merge({ TYPESAFE_API_KEY: "  " }, `TYPESAFE_API_KEY=${KEY}\n`);
    assert.equal(m.env["TYPESAFE_API_KEY"], KEY);
  });
  it("does not modify the object it was given", () => {
    const env = { A: "1" };
    merge(env, "REFLEX_MODE=off\n");
    assert.deepEqual(env, { A: "1" });
  });
  it("refuses a file holding the key that group or others can read: no value of it is used, and the reason names the fix", () => {
    for (const mode of [0o100644, 0o100640, 0o100604, 0o100660]) {
      const m = merge({}, `REFLEX_MODE=route\nTYPESAFE_API_KEY=${KEY}\n`, mode);
      assert.equal(m.state, "refused");
      assert.equal(m.env["TYPESAFE_API_KEY"], undefined);
      assert.equal(m.env["REFLEX_MODE"], undefined);
      assert.match(m.reason ?? "", /group\/others/);
      assert.match(m.reason ?? "", /chmod 600 \/h\/\.reflex\/env/);
      assert.equal(m.fromFile.size, 0);
    }
  });
  it("reads TYPELLM_API_KEY, and refuses a group-readable file holding it like one holding the TypeSafe key", () => {
    const tl = "tl-sk-abcdefghijklmnop";
    assert.deepEqual(parseEnvFile(`TYPELLM_API_KEY=${tl}\nTYPELLM_OTHER=1\n`).values, { TYPELLM_API_KEY: tl });
    assert.equal(merge({}, `TYPELLM_API_KEY=${tl}\n`, 0o100600).env["TYPELLM_API_KEY"], tl);
    const m = merge({}, `REFLEX_MODE=route\nTYPELLM_API_KEY=${tl}\n`, 0o100644);
    assert.equal(m.state, "refused");
    assert.equal(m.env["TYPELLM_API_KEY"], undefined);
    assert.match(m.reason ?? "", /TYPELLM_API_KEY/);
  });
  it("accepts 0600 and 0400 key files", () => {
    for (const mode of [0o100600, 0o100400]) assert.equal(merge({}, `TYPESAFE_API_KEY=${KEY}\n`, mode).state, "loaded");
  });
  it("uses a group-readable file that holds no key", () => {
    const m = merge({}, "REFLEX_MODE=route\n", 0o100644);
    assert.equal(m.state, "loaded");
    assert.equal(m.env["REFLEX_MODE"], "route");
  });
  it("does not judge permission bits on Windows", () => {
    const m = mergeEnvFile({}, memIO({ [FILE]: { text: `TYPESAFE_API_KEY=${KEY}\n`, mode: 0o100666 } }, "win32"), "/h");
    assert.equal(m.state, "loaded");
  });
  it("cannot set REFLEX_HOME (it locates the file) and says so", () => {
    const m = merge({}, "REFLEX_HOME=/elsewhere\n");
    assert.equal(m.env["REFLEX_HOME"], undefined);
    assert.ok(m.warnings.some((w) => /REFLEX_HOME/.test(w)));
  });
  it("finds the file under REFLEX_HOME when that is set in the process environment", () => {
    assert.equal(mergeEnvFile({ REFLEX_HOME: "/custom" }, memIO({}), "/h").file, path.join("/custom", "env"));
  });
  it("an unreadable file is skipped with a warning, never thrown", () => {
    const io: EnvFileIO = { stat: () => ({ mode: 0o100600 }), read: () => { throw Object.assign(new Error("x"), { code: "EISDIR" }); }, platform: "linux" };
    const m = mergeEnvFile({ REFLEX_MODE: "route" }, io, "/h");
    assert.equal(m.state, "unreadable");
    assert.equal(m.env["REFLEX_MODE"], "route");
    assert.match(m.warnings.join(), /EISDIR/);
  });
  it("no warning or reason ever contains a value from the file", () => {
    const all = [merge({}, `not pair ${KEY}\nTYPESAFE_API_KEY=${KEY}\n`, 0o100644), merge({}, `oops ${KEY}\nANTHROPIC_API_KEY=${KEY}\n`)];
    for (const m of all) assert.ok(!JSON.stringify([m.warnings, m.reason]).includes(KEY));
  });
  it("reads a real file, following the permission bits on disk", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-envfile-"));
    const file = path.join(dir, "env");
    fs.writeFileSync(file, `TYPESAFE_API_KEY=${KEY}\n`, { mode: 0o600 });
    assert.equal(mergeEnvFile({ REFLEX_HOME: dir }).state, "loaded");
    fs.chmodSync(file, 0o644);
    assert.equal(mergeEnvFile({ REFLEX_HOME: dir }).state, "refused");
  });
});

describe("reflex doctor: env file and setting sources", () => {
  const FAKE_CLAUDE = fileURLToPath(new URL("../support/fake-claude.mjs", import.meta.url));
  const run = async (env: NodeJS.ProcessEnv, files: Record<string, { text: string; mode: number }>) => {
    fs.chmodSync(FAKE_CLAUDE, 0o755);
    const lines: string[] = [];
    const code = await doctorCommand({ env: { PATH: process.env["PATH"], REFLEX_CLAUDE_BIN: FAKE_CLAUDE, ...env }, cwd: "/", stderr: () => undefined, stdout: (t) => void lines.push(t), envFile: memIO(files), homedir: "/h" });
    return { code, text: lines.join("") };
  };

  it("shows each set value's source, hides the key, and reports the file as used", async () => {
    const { code, text } = await run({ REFLEX_MODE: "shadow" }, { [FILE]: { text: `REFLEX_MODE=route\nREFLEX_TIERS=haiku\nTYPESAFE_API_KEY=${KEY}\n`, mode: 0o100600 } });
    assert.equal(code, 0);
    assert.match(text, /env file:\s+\/h\/\.reflex\/env - loaded \(2 values used\)/);
    assert.match(text, /REFLEX_MODE\s+shadow\s+from process environment/);
    assert.match(text, /REFLEX_MODE\s+also in \/h\/\.reflex\/env; the process environment wins/);
    assert.match(text, /REFLEX_TIERS\s+haiku\s+from \/h\/\.reflex\/env/);
    assert.match(text, /TYPESAFE_API_KEY\s+\(set, not shown\)\s+from \/h\/\.reflex\/env/);
    assert.match(text, /backend:\s+jev \(key present\)/);
    assert.ok(!text.includes(KEY));
  });
  it("laya: names the laya-serve it would start and where the weights are; a missing laya-serve fails", async () => {
    const found = await run({ REFLEX_BACKEND: "laya", REFLEX_LAYA_BIN: FAKE_CLAUDE, HF_HUB_CACHE: "/nonexistent" }, {});
    assert.equal(found.code, 0);
    assert.match(found.text, /backend:\s+laya, started by reflex on 127\.0\.0\.1, offline \(model english/);
    assert.match(found.text, /laya weights:\s+NOT in \/nonexistent - fetch them once/);
    const missing = await run({ REFLEX_BACKEND: "laya", REFLEX_LAYA_BIN: "/nonexistent/laya-serve" }, {});
    assert.equal(missing.code, 1);
    assert.match(missing.text, /laya-serve:\s+NOT FOUND - install it with `uv tool install "laya\[serve\]"`/);
  });
  it("says why a group-readable key file is not used, exits 1, and shows the key as missing", async () => {
    const { code, text } = await run({}, { [FILE]: { text: `TYPESAFE_API_KEY=${KEY}\n`, mode: 0o100644 } });
    assert.equal(code, 1);
    assert.match(text, /NOT USED: .*readable by group\/others \(mode 0644\).*chmod 600/);
    assert.match(text, /key missing: the env file was refused/);
    assert.ok(!text.includes(KEY));
  });
  it("with no file, lists only what the process environment sets", async () => {
    const { code, text } = await run({}, {});
    assert.equal(code, 0);
    assert.match(text, /not present/);
    assert.match(text, /REFLEX_CLAUDE_BIN\s.*from process environment/);
    assert.ok(!/REFLEX_MODE/.test(text.split("mode requested")[0]!));
  });
  it("an exported-but-empty ANTHROPIC_BASE_URL is not an error and is not listed as set", async () => {
    const { code, text } = await run({ ANTHROPIC_BASE_URL: "", REFLEX_MODE: "" }, {});
    assert.equal(code, 0);
    assert.ok(!/config error/.test(text), text);
    assert.ok(!/ANTHROPIC_BASE_URL/.test(text), text);
  });
  it("prompt preview is off by default and on when REFLEX_LOG_PROMPTS is set", async () => {
    const off = await run({}, {});
    assert.match(off.text, /prompt preview:\s+off \(REFLEX_LOG_PROMPTS=1 to add/);
    const on = await run({ REFLEX_LOG_PROMPTS: "1" }, {});
    assert.match(on.text, /prompt preview:\s+on \(REFLEX_LOG_PROMPTS\) - decisions\.jsonl includes/);
  });
  it("REFLEX_DELEGATE=1 with no backend key: the hint cannot inject, said loudly, exit 1", async () => {
    // passthrough runs claude directly, so reflex's UserPromptSubmit hook is never installed and the hint is silently lost.
    const { code, text } = await run({ REFLEX_DELEGATE: "1", REFLEX_MODE: "route" }, {});
    assert.equal(code, 1);
    assert.match(text, /hint injection:\s+CANNOT INJECT - mode effective is passthrough \(no_backend_key\)/);
    assert.match(text, /the hint will NOT reach Claude Code/);
  });
  it("REFLEX_DELEGATE=1 with REFLEX_MODE=off: the hint cannot inject, exit 1", async () => {
    const { code, text } = await run({ REFLEX_DELEGATE: "1", REFLEX_MODE: "off", TYPESAFE_API_KEY: KEY }, {});
    assert.equal(code, 1);
    assert.match(text, /hint injection:\s+CANNOT INJECT - REFLEX_MODE=off runs claude directly/);
  });
  it("REFLEX_DELEGATE=1 with a usable backend: hint injection is ok, exit 0", async () => {
    const { code, text } = await run({ REFLEX_DELEGATE: "1", REFLEX_MODE: "shadow", TYPESAFE_API_KEY: KEY }, {});
    assert.equal(code, 0);
    assert.match(text, /hint injection:\s+ok \(delegate-1 via reflex's UserPromptSubmit hook\)/);
    assert.ok(!text.includes(KEY));
  });
  it("without REFLEX_DELEGATE there is no hint-injection line at all", async () => {
    const { text } = await run({ REFLEX_MODE: "route" }, {});
    assert.ok(!/hint injection/.test(text), text);
  });

  it("shows URL settings without credentials or query", async () => {
    const { text } = await run({ REFLEX_UPSTREAM_URL: "https://user:pw@gw.example.com/anthropic?token=abc" }, {});
    assert.match(text, /REFLEX_UPSTREAM_URL\s+https:\/\/gw\.example\.com\/anthropic/);
    assert.ok(!/pw@|token=abc/.test(text));
  });
});
