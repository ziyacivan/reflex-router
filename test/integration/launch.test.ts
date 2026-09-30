import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { launch } from "../../src/launcher/launch.js";
import { startFakeUpstream, type FakeUpstream } from "../support/fake-upstream.js";
import { sleep, waitFor } from "../support/http.js";
import { FAST_TIMINGS } from "../support/stack.js";

const FAKE_CLAUDE = fileURLToPath(new URL("../support/fake-claude.mjs", import.meta.url));

interface Report {
  argv: string[];
  cwd: string;
  baseUrl: string | null;
  hasTypesafeKey: boolean;
  hasTypellmKey: boolean;
  reflexVars: string[];
  passthroughVars: Record<string, string | null>;
  settings: unknown[];
  settingsFiles: string[];
  signals: string[];
  response: { status: number; body: string } | null;
}

interface Outcome {
  code: number;
  report: Report;
  stderr: string;
  home: string;
}

describe("launcher end to end (fake claude)", () => {
  let upstream: FakeUpstream;
  before(async () => {
    fs.chmodSync(FAKE_CLAUDE, 0o755);
    upstream = await startFakeUpstream();
  });
  after(async () => {
    await upstream.close();
  });

  const setup = (env: NodeJS.ProcessEnv = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflex-launch-"));
    const reportFile = path.join(dir, "report.json");
    const fullEnv: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"],
      HOME: dir,
      REFLEX_CLAUDE_BIN: FAKE_CLAUDE,
      REFLEX_HOME: path.join(dir, "reflex-home"),
      TYPESAFE_API_KEY: "apikey_test_key",
      ANTHROPIC_BASE_URL: upstream.url,
      ANTHROPIC_API_KEY: "sk-ant-user-key",
      CLAUDE_CODE_TEST_MARKER: "kept",
      FAKE_CLAUDE_REPORT: reportFile,
      ...env,
    };
    const stderr: string[] = [];
    const io = { env: fullEnv, cwd: dir, stderr: (t: string) => void stderr.push(t), timings: FAST_TIMINGS };
    const readReport = (): Report => JSON.parse(fs.readFileSync(reportFile, "utf8")) as Report;
    return { dir, io, stderr, reportFile, readReport, home: fullEnv["REFLEX_HOME"] as string };
  };

  const run = async (argv: string[], env: NodeJS.ProcessEnv = {}): Promise<Outcome> => {
    const s = setup(env);
    const code = await launch(argv, s.io);
    return { code, report: s.readReport(), stderr: s.stderr.join(""), home: s.home };
  };

  const isProxied = (o: Outcome): boolean => o.report.baseUrl !== null && o.report.baseUrl !== upstream.url && /^http:\/\/127\.0\.0\.1:\d+$/.test(o.report.baseUrl);

  describe("~/.reflex/env", () => {
    const withEnvFile = async (text: string, mode: number, env: NodeJS.ProcessEnv = {}): Promise<Outcome> => {
      const s = setup({ TYPESAFE_API_KEY: undefined, ...env });
      fs.mkdirSync(s.home, { recursive: true });
      const file = path.join(s.home, "env");
      fs.writeFileSync(file, text, { mode });
      fs.chmodSync(file, mode);
      const code = await launch(["-p", "x"], s.io);
      return { code, report: s.readReport(), stderr: s.stderr.join(""), home: s.home };
    };

    it("supplies the key: with no key in the process environment the session is proxied, and claude sees no reflex value", async () => {
      const o = await withEnvFile("TYPESAFE_API_KEY=apikey_from_file\nREFLEX_MODE=shadow\n", 0o600);
      assert.ok(isProxied(o), o.stderr);
      assert.equal(o.report.hasTypesafeKey, false);
      assert.deepEqual(o.report.reflexVars, []);
    });
    it("is merged under the process environment: REFLEX_MODE=off in the file loses to REFLEX_MODE=shadow in the environment", async () => {
      const o = await withEnvFile("TYPESAFE_API_KEY=apikey_from_file\nREFLEX_MODE=off\n", 0o600, { REFLEX_MODE: "shadow" });
      assert.ok(isProxied(o), o.stderr);
    });
    it("applies file settings the environment does not set (REFLEX_MODE=off gives plain claude)", async () => {
      const o = await withEnvFile("REFLEX_MODE=off\n", 0o600);
      assert.equal(o.report.baseUrl, upstream.url);
      assert.deepEqual(o.report.settings, []);
    });
    it("a key file readable by group/others is refused: plain claude, a warning that says how to fix it, key never leaked", async () => {
      const o = await withEnvFile("TYPESAFE_API_KEY=apikey_from_file\n", 0o644);
      assert.equal(o.code, 0);
      assert.equal(o.report.baseUrl, upstream.url);
      assert.match(o.stderr, /refusing .*readable by group\/others.*chmod 600/);
      assert.match(o.stderr, /no decision backend available \(no_backend_key\)/);
      assert.ok(!o.stderr.includes("apikey_from_file"));
    });
    it("a file that is not a file is skipped with a warning and the session still runs", async () => {
      const s = setup({ TYPESAFE_API_KEY: "apikey_test_key" });
      fs.mkdirSync(path.join(s.home, "env"), { recursive: true });
      const code = await launch(["-p", "x"], s.io);
      assert.equal(code, 0);
      assert.match(s.stderr.join(""), /cannot read .*EISDIR/);
      assert.ok(s.readReport().baseUrl?.startsWith("http://127.0.0.1"));
    });
  });

  it("forwards every argument to claude verbatim (flags, quotes, unicode, a -- terminator)", async () => {
    const args = ["-p", 'say "hi" & ünïcode ✓', "--model", "sonnet", "--allowedTools", "Bash(node *)", "Read", "--", "--not-a-flag", "x y"];
    const o = await run(args);
    assert.equal(o.code, 0);
    const argv = o.report.argv;
    const i = argv.indexOf("--settings");
    assert.ok(i >= 0 && i < argv.indexOf("--"), "our --settings goes before the -- terminator");
    assert.deepEqual([...argv.slice(0, i), ...argv.slice(i + 2)], args);
  });

  it("points claude at the loopback proxy and gives it a settings file with the same base URL", async () => {
    const o = await run(["-p", "x"]);
    assert.ok(isProxied(o), `baseUrl ${String(o.report.baseUrl)}`);
    assert.equal(o.report.settings.length, 1);
    assert.deepEqual((o.report.settings[0] as { env: unknown }).env, { ANTHROPIC_BASE_URL: o.report.baseUrl });
    const hooks = (o.report.settings[0] as { hooks: Record<string, { hooks: { url: string }[] }[]> }).hooks;
    assert.deepEqual(Object.keys(hooks).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"]);
    for (const groups of Object.values(hooks)) assert.equal(groups[0]?.hooks[0]?.url, `${o.report.baseUrl}/__reflex/hook`, "outcome hooks go to the front door");
  });

  it("strips every REFLEX_*, TYPESAFE_* and TYPELLM_* variable from claude's environment and leaves the rest alone", async () => {
    const o = await run(["-p", "x"], { REFLEX_MODE: "shadow", REFLEX_SOMETHING: "1", TYPESAFE_BASE_URL: "http://x", TYPELLM_API_KEY: "tl-sk-test_key_value", TYPELLM_OTHER: "1" });
    assert.equal(o.report.hasTypesafeKey, false);
    assert.equal(o.report.hasTypellmKey, false);
    assert.deepEqual(o.report.reflexVars, []);
    assert.equal(o.report.passthroughVars["ANTHROPIC_API_KEY"], "sk-ant-user-key", "the user's Anthropic credentials must pass through untouched");
    assert.equal(o.report.passthroughVars["CLAUDE_CODE_TEST_MARKER"], "kept");
  });

  it("turns MCP tool search back on behind the proxy, and never overrides a value the user set", async () => {
    const o = await run(["-p", "x"]);
    assert.equal(o.report.passthroughVars["ENABLE_TOOL_SEARCH"], "true");
    assert.equal(o.stderr, "");
    for (const v of ["false", "auto:5", ""]) assert.equal((await run(["-p", "x"], { ENABLE_TOOL_SEARCH: v })).report.passthroughVars["ENABLE_TOOL_SEARCH"], v);
    const off = await run(["-p", "x"], { REFLEX_MODE: "off" });
    assert.equal(off.report.passthroughVars["ENABLE_TOOL_SEARCH"], null, "plain claude talks to its own base URL and gets nothing");
    const betasOff = await run(["-p", "x"], { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1" });
    assert.match(betasOff.stderr, /CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set: MCP tool search stays off/);
  });

  it("merges the user's own --settings into one file instead of adding a second flag", async () => {
    const o = await run(["--settings", '{"model":"opus","env":{"MINE":"1"}}', "-p", "x"]);
    assert.equal(o.report.argv.filter((a) => a === "--settings").length, 1);
    const merged = o.report.settings[0] as { model: string; env: Record<string, string> };
    assert.equal(merged.model, "opus");
    assert.equal(merged.env["MINE"], "1");
    assert.equal(merged.env["ANTHROPIC_BASE_URL"], o.report.baseUrl);
  });

  it("removes the temporary settings file when claude exits", async () => {
    const o = await run(["-p", "x"]);
    const file = o.report.settingsFiles[0];
    assert.ok(file);
    assert.equal(fs.existsSync(file), false);
    assert.equal(fs.existsSync(path.dirname(file)), false);
  });

  it("a request made by claude reaches the upstream unchanged, through the proxy", async () => {
    upstream.seen.length = 0;
    const o = await run(["-p", "x"], { FAKE_CLAUDE_ACTION: "request" });
    assert.equal(o.code, 0);
    assert.equal(o.report.response?.status, 200);
    const seen = upstream.seen.find((s) => s.url === "/v1/messages?beta=true");
    assert.ok(seen);
    assert.equal(seen.headers["authorization"], "Bearer fake-oauth-token");
    assert.equal(seen.headers["x-claude-code-session-id"], "s-1");
    assert.equal(seen.body.toString(), '{"hello":"world"}');
  });

  it("uses the user's own ANTHROPIC_BASE_URL as the upstream (corporate gateways keep working)", async () => {
    const gw = await startFakeUpstream();
    try {
      const o = await run(["-p", "x"], { ANTHROPIC_BASE_URL: `${gw.url}/gateway`, FAKE_CLAUDE_ACTION: "request" });
      assert.equal(o.report.response?.status, 200);
      assert.equal(gw.seen.at(-1)?.url, "/gateway/v1/messages?beta=true");
    } finally {
      await gw.close();
    }
  });

  it("still serves requests when the worker cannot start at all", async () => {
    const s = setup({ FAKE_CLAUDE_ACTION: "request" });
    const code = await launch(["-p", "x"], { ...s.io, timings: { ...FAST_TIMINGS, readyTimeoutMs: 1 } });
    assert.equal(code, 0);
    assert.equal(s.readReport().response?.status, 200);
  });

  it("writes the worker log under the state directory", async () => {
    const o = await run(["-p", "x"]);
    assert.ok(fs.existsSync(path.join(o.home, "worker.log")));
  });

  describe("exit codes and signals", () => {
    it("propagates claude's exit code", async () => {
      for (const n of [0, 1, 3, 42]) assert.equal((await run(["-p", "x"], { FAKE_CLAUDE_ACTION: `exit:${n}` })).code, n, `exit ${n}`);
    });

    it("reports 128+signal when claude is killed by a signal", async () => {
      assert.equal((await run(["-p", "x"], { FAKE_CLAUDE_ACTION: "die:SIGKILL" })).code, 137);
      assert.equal((await run(["-p", "x"], { FAKE_CLAUDE_ACTION: "die:SIGTERM" })).code, 143);
    });

    it("forwards SIGTERM to claude, then exits with claude's code; SIGINT does not end the launcher", async () => {
      const s = setup({ FAKE_CLAUDE_ACTION: "wait" });
      let done: number | null = null;
      const p = launch(["-p", "x"], s.io).then((c) => (done = c));
      await waitFor(() => fs.existsSync(s.reportFile), { what: "claude to start" });
      await sleep(100);
      process.kill(process.pid, "SIGINT"); // Ctrl-C normally reaches claude through the terminal, not through us
      await sleep(200);
      assert.equal(done, null, "the launcher must survive SIGINT while claude runs");
      assert.deepEqual(s.readReport().signals, [], "SIGINT must not be forwarded (claude gets it from the tty)");
      process.kill(process.pid, "SIGTERM");
      await p;
      assert.equal(done, 7, "fake claude exits 7 on SIGTERM");
      assert.deepEqual(s.readReport().signals, ["SIGTERM"]);
    });

    it("reports a missing claude with 127 and a helpful message", async () => {
      const s = setup({ REFLEX_CLAUDE_BIN: "/nonexistent/claude" });
      assert.equal(await launch(["-p", "x"], s.io), 127);
      assert.match(s.stderr.join(""), /cannot find `claude`/);
    });
  });

  describe("modes", () => {
    it("off is literally plain claude: no proxy, no settings, untouched argv and base URL", async () => {
      const args = ["-p", "x", "--model", "sonnet"];
      const o = await run(args, { REFLEX_MODE: "off" });
      assert.deepEqual(o.report.argv, args);
      assert.equal(o.report.baseUrl, upstream.url);
      assert.deepEqual(o.report.settings, []);
      assert.equal(o.report.hasTypesafeKey, false, "even in off mode the backend key is not handed to claude");
      assert.equal(o.stderr, "");
    });

    it("without a TypeSafe key there is nothing to decide with: plain claude, and it says so", async () => {
      const o = await run(["-p", "x"], { TYPESAFE_API_KEY: "" });
      assert.equal(o.report.baseUrl, upstream.url);
      assert.deepEqual(o.report.argv, ["-p", "x"]);
      assert.match(o.stderr, /no decision backend available \(no_backend_key\)/);
    });

    it("a malformed key is ignored with a warning that never contains the key", async () => {
      const o = await run(["-p", "x"], { TYPESAFE_API_KEY: "sk-ant-not-a-typesafe-key" });
      assert.match(o.stderr, /does not start with "apikey_"/);
      assert.doesNotMatch(o.stderr, /sk-ant-not-a-typesafe-key/);
    });

    it("an invalid configuration fails open: warn and run plain claude", async () => {
      const o = await run(["-p", "x"], { REFLEX_MODE: "bogus" });
      assert.equal(o.code, 0);
      assert.equal(o.report.baseUrl, upstream.url);
      assert.deepEqual(o.report.argv, ["-p", "x"]);
      assert.match(o.stderr, /invalid configuration: REFLEX_MODE/);
      assert.match(o.stderr, /running plain claude/);
    });

    it("laya without a laya-serve to start: plain claude, and how to install it", async () => {
      const o = await run(["-p", "x"], { REFLEX_BACKEND: "laya", REFLEX_LAYA_BIN: "/nonexistent/laya-serve", TYPESAFE_API_KEY: undefined });
      assert.equal(o.report.baseUrl, upstream.url);
      assert.match(o.stderr, /cannot find `laya-serve`.*uv tool install "laya\[serve\]"/);
    });

    it("laya: proxied without a TypeSafe key, and laya-serve is gone when claude is", async () => {
      const layaReport = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reflex-laya-")), "report.json");
      const fake = fileURLToPath(new URL("../support/fake-laya-serve.mjs", import.meta.url));
      fs.chmodSync(fake, 0o755);
      const o = await run(["-p", "x"], { REFLEX_BACKEND: "laya", REFLEX_LAYA_BIN: fake, TYPESAFE_API_KEY: undefined, FAKE_LAYA_REPORT: layaReport, FAKE_CLAUDE_ACTION: "sleep:1000" });
      assert.ok(isProxied(o), o.stderr);
      assert.equal(o.report.hasTypesafeKey, false);
      assert.deepEqual(o.report.reflexVars, []);
      const pid = (JSON.parse(fs.readFileSync(layaReport, "utf8")) as { pid: number }).pid; // written on listen, well inside claude's 1 s
      await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, { timeoutMs: 5000, what: "laya-serve to exit with the session" });
    });

    it("the removed `local` backend is a configuration error: plain claude with an explanation", async () => {
      const o = await run(["-p", "x"], { REFLEX_BACKEND: "local" });
      assert.match(o.stderr, /invalid configuration: REFLEX_BACKEND/);
      assert.equal(o.report.baseUrl, upstream.url);
    });
  });

  describe("version check (a hint, never a gate on its own)", () => {
    it("exact match: proxied and silent", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "2.1.277 (Claude Code)", REFLEX_MODE: "route" });
      assert.ok(isProxied(o));
      assert.equal(o.stderr, "");
    });

    it("a minor/patch mismatch warns but changes nothing", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "2.1.999 (Claude Code)", REFLEX_MODE: "route" });
      assert.ok(isProxied(o));
      assert.match(o.stderr, /2\.1\.999 differs from the tested version\(s\) 2\.1\.277/);
      assert.doesNotMatch(o.stderr, /runs as shadow/);
    });

    it("a major mismatch degrades route to shadow, and says so", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "3.0.0 (Claude Code)", REFLEX_MODE: "route" });
      assert.ok(isProxied(o), "still proxied (shadow records decisions)");
      assert.match(o.stderr, /different major version/);
      assert.match(o.stderr, /mode route runs as shadow \(claude_version:major_mismatch\)/);
    });

    it("a major mismatch in shadow mode only warns", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "3.0.0 (Claude Code)", REFLEX_MODE: "shadow" });
      assert.match(o.stderr, /different major version/);
      assert.doesNotMatch(o.stderr, /runs as/);
    });

    it("REFLEX_IGNORE_VERSION_CHECK keeps route as route (the warning stays)", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "3.0.0 (Claude Code)", REFLEX_MODE: "route", REFLEX_IGNORE_VERSION_CHECK: "1" });
      assert.match(o.stderr, /different major version/);
      assert.doesNotMatch(o.stderr, /runs as shadow/);
    });

    it("an unreadable version warns and continues (the runtime shape checks decide, not the version)", async () => {
      const o = await run(["-p", "x"], { FAKE_CLAUDE_VERSION: "no version here", REFLEX_MODE: "route" });
      assert.ok(isProxied(o));
      assert.match(o.stderr, /could not determine the Claude Code version/);
      assert.doesNotMatch(o.stderr, /runs as shadow/);
    });

    it("a `claude --version` that hangs does not hang the launch", async () => {
      const t0 = Date.now();
      const s = setup({ FAKE_CLAUDE_HANG_VERSION: "1" });
      assert.equal(await launch(["-p", "x"], s.io), 0);
      assert.ok(Date.now() - t0 < 10_000);
      assert.match(s.stderr.join(""), /could not determine the Claude Code version/);
    });
  });
});
