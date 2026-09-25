import { spawn } from "node:child_process";
import { outcomeHooks, type HookTransport } from "../outcome/hooks-config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isReflexEnvName, loadConfig, type Config } from "../config.js";
import { resolveEffectiveMode } from "../effective-mode.js";
import { mergeEnvFile, type EnvFileIO } from "../env-file.js";
import type { InitMessage } from "../ipc.js";
import { forward } from "../net/forward.js";
import { TESTED_CLAUDE_VERSIONS } from "../wire/tested-versions.generated.js";
import { resolveBin, resolveClaude, realResolveIO, type ResolvedBin } from "./claude-bin.js";
import { startLaya, type LayaServer } from "./laya.js";
import { startFrontDoor } from "./front-door.js";
import { hasOwnStatusLine, injectSettings, readSettingsFile, realInjectIO, sandboxEnabled, userSettingsFromArgv } from "./settings-inject.js";
import { Supervisor, type Timings } from "./supervisor.js";
import { assessVersion, describeVerdict, probeClaudeVersion } from "./version.js";
import { openWorkerLog, spawnWorkerProcess } from "./worker-process.js";

/**
 * Claude Code's managed settings file, the highest-precedence source of `sandbox.enabled`.
 * ponytail: only this one path is checked, not an MDM/plist source or a drop-in directory; a miss there leaves
 * `sandboxed` at whatever the other sources say, and `REFLEX_HOOKS=command` covers that case regardless.
 */
const MANAGED_SETTINGS = process.platform === "darwin" ? "/Library/Application Support/ClaudeCode/managed-settings.json" : "/etc/claude-code/managed-settings.json";

export interface LaunchIO {
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stderr: (text: string) => void;
  /** Tests shrink these. */
  readonly timings?: Partial<Timings>;
  /** Tests: where ~/.reflex/env is read from (default: the real file system). */
  readonly envFile?: EnvFileIO;
  readonly homedir?: string;
}

export const realLaunchIO = (): LaunchIO => ({
  env: process.env,
  cwd: process.cwd(),
  stderr: (t) => void process.stderr.write(t),
});

/** The environment claude gets: ours, minus everything of reflex's and every decision-backend credential. */
export function sanitizedEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!isReflexEnvName(k)) out[k] = v;
  return { ...out, ...extra };
}

/**
 * Claude Code turns MCP tool search off when ANTHROPIC_BASE_URL is not first-party, because many proxies drop
 * `tool_reference` blocks; every MCP tool schema is then sent up front on every request. reflex forwards bodies and
 * the anthropic-beta header as they are (rewrites parse and re-serialise, keeping every unknown field), so it turns
 * tool search back on. Any value the user set, including `false`, is left alone; Claude Code's settings `env` wins too.
 */
export function proxyEnv(env: NodeJS.ProcessEnv, baseUrl: string): Record<string, string> {
  return { ANTHROPIC_BASE_URL: baseUrl, ...(env["ENABLE_TOOL_SEARCH"] === undefined ? { ENABLE_TOOL_SEARCH: "true" } : {}) };
}

const signalNumber = (signal: NodeJS.Signals): number => os.constants.signals[signal] ?? 0;

/** Runs claude with the terminal attached and resolves with the exit code a shell would report. */
export function runClaude(bin: ResolvedBin, args: readonly string[], env: NodeJS.ProcessEnv, io: LaunchIO): Promise<number> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin.path, [...args], { stdio: "inherit", env, shell: bin.needsShell });
    } catch (e) {
      io.stderr(`reflex: cannot start claude: ${e instanceof Error ? e.message : String(e)}\n`);
      resolve(126);
      return;
    }
    // Ctrl-C reaches claude through the terminal's process group; we must survive it until claude has exited.
    // SIGTERM/SIGHUP are forwarded so `kill <reflex>` and closing the terminal end the session cleanly.
    const handlers = new Map<NodeJS.Signals, () => void>([
      ["SIGINT", () => undefined],
      ["SIGTERM", () => void child.kill("SIGTERM")],
      ["SIGHUP", () => void child.kill("SIGHUP")],
    ]);
    for (const [sig, fn] of handlers) process.on(sig, fn);
    const detach = (): void => {
      for (const [sig, fn] of handlers) process.off(sig, fn);
    };
    child.once("error", (e: NodeJS.ErrnoException) => {
      detach();
      io.stderr(`reflex: cannot start claude (${e.code ?? e.message})\n`);
      resolve(e.code === "ENOENT" ? 127 : 126);
    });
    child.once("exit", (code, signal) => {
      detach();
      resolve(code ?? (signal ? 128 + signalNumber(signal) : 1));
    });
  });
}

const workerProbe = async (port: number): Promise<boolean> => {
  try {
    const res = await forward(new URL(`http://127.0.0.1:${port}`), { method: "GET", url: "/__reflex/health", headers: {}, body: Buffer.alloc(0) }, { connectTimeoutMs: 500 });
    res.resume();
    return res.statusCode === 200;
  } catch {
    return false;
  }
};

/** bin/reflex.js, from src/launcher or dist/launcher alike: what the injected status line and hook relay run. */
const REFLEX_BIN = fileURLToPath(new URL("../../bin/reflex.js", import.meta.url));

/** Starts claude behind the reflex proxy (or plain, per mode) and resolves with claude's exit code. */
export async function launch(argv: readonly string[], io: LaunchIO = realLaunchIO()): Promise<number> {
  const warn = (msg: string): void => io.stderr(`reflex: ${msg}\n`);
  // Settings: the process environment, over ~/.reflex/env. A file that cannot be used only costs a warning.
  const merged = mergeEnvFile(io.env, io.envFile, io.homedir);
  for (const w of merged.warnings) warn(w);
  const settings = merged.env;
  const binOverride = settings["REFLEX_CLAUDE_BIN"]?.trim() || undefined;
  const bin = resolveClaude(binOverride, realResolveIO(io.env));
  if (!bin) {
    warn("cannot find `claude` on PATH (set REFLEX_CLAUDE_BIN to its location)");
    return 127;
  }
  const plain = (): Promise<number> => runClaude(bin, argv, sanitizedEnv(io.env), io);

  const loaded = loadConfig(settings, io.homedir);
  if (!loaded.ok) {
    for (const e of loaded.errors) warn(`invalid configuration: ${e}`);
    warn("running plain claude");
    return plain();
  }
  const config: Config = loaded.config;
  for (const w of loaded.warnings) warn(w);
  if (config.mode === "off") return plain();

  const version = await probeClaudeVersion(bin, sanitizedEnv(io.env));
  const verdict = assessVersion(version, TESTED_CLAUDE_VERSIONS);
  const verdictNote = describeVerdict(verdict);
  if (verdictNote) warn(verdictNote);

  const effective = resolveEffectiveMode(config, verdict);
  if (effective.mode === "passthrough") {
    warn(`no decision backend available (${effective.degradedReason ?? "unknown"}); running plain claude`);
    return plain();
  }
  if (effective.degradedReason) warn(`mode ${config.mode} runs as ${effective.mode} (${effective.degradedReason})`);

  const logFile = openWorkerLog(config.home);
  let workerConfig = config;
  let laya: LayaServer | null = null;
  const wantsLaya = config.backend === "laya" || config.compare === "laya";
  const layaBin = wantsLaya ? resolveBin("laya-serve", config.layaBin, realResolveIO(io.env)) : null;
  if (wantsLaya && !layaBin) {
    const missing = 'cannot find `laya-serve` (install it with `uv tool install "laya[serve]"`, or set REFLEX_LAYA_BIN)';
    if (config.backend === "laya") {
      warn(`${missing}; running plain claude`);
      logFile?.end();
      return plain();
    }
    warn(`${missing}; REFLEX_COMPARE=laya is off for this session`); // it only records: the session runs on Jev alone
  }
  if (layaBin) {
    laya = await startLaya({ bin: layaBin, env: sanitizedEnv(io.env), model: config.layaModel, readyTimeoutMs: config.layaReadyTimeoutMs, logFile });
    workerConfig = { ...config, layaBaseUrl: laya.baseUrl, layaApiKey: laya.apiKey };
  }
  const init: InitMessage = { type: "init", config: workerConfig, effectiveMode: effective.mode, degradedReason: effective.degradedReason, claudeVersion: version };
  const supervisor = new Supervisor({
    spawnWorker: () => spawnWorkerProcess({ init, readyTimeoutMs: io.timings?.readyTimeoutMs ?? 5000, logFile, log: () => undefined }),
    probe: workerProbe,
    ...(io.timings ? { timings: io.timings } : {}),
    log: (level, m) => logFile?.write(`${new Date().toISOString()} [${level}] supervisor: ${m}\n`),
  });
  await supervisor.start(); // failure is fine: the door forwards straight to the upstream until a worker is up

  const door = await startFrontDoor({
    upstream: new URL(config.upstreamUrl),
    workerOrigin: () => supervisor.workerOrigin(),
    status: () => ({ supervisor: supervisor.snapshot(), mode: effective.mode }),
  });

  // Hooks for outcome capture go to the front door, which answers 204 even when the worker is down.
  const claudeDir = io.env["CLAUDE_CONFIG_DIR"] || path.join(io.homedir ?? os.homedir(), ".claude");
  const read = (f: string): string => fs.readFileSync(f, "utf8");
  const settingsFiles = [path.join(claudeDir, "settings.json"), path.join(io.cwd, ".claude", "settings.json"), path.join(io.cwd, ".claude", "settings.local.json")];
  const ownStatusLine = hasOwnStatusLine(settingsFiles, read);
  const statusLine = config.statusline && !ownStatusLine ? { type: "command", command: `"${process.execPath}" "${REFLEX_BIN}" statusline`, padding: 0, refreshInterval: 2 } : undefined;
  // Under Claude Code's sandbox every http hook to 127.0.0.1 comes back "HTTP 403" and never reaches the door
  // (docs/observations.md); a command hook does. REFLEX_HOOKS=auto relays the hooks through `reflex hook-relay` there.
  // They are not optional: without the UserPromptSubmit hook a plain-string prompt is never a new turn, so it is not routed.
  const sandboxed = sandboxEnabled([...settingsFiles.map((f) => readSettingsFile(f, read)), userSettingsFromArgv(argv, io.cwd, read), readSettingsFile(MANAGED_SETTINGS, read)]);
  const transport: HookTransport | null =
    config.hooks === "off" ? null : config.hooks === "http" || (config.hooks === "auto" && !sandboxed) ? { kind: "http" } : { kind: "command", relay: `"${process.execPath}" "${REFLEX_BIN}" hook-relay` };
  if (transport === null) logFile?.write(`${new Date().toISOString()} [info] launcher: outcome hooks not injected (REFLEX_HOOKS=off)\n`);
  else if (transport.kind === "command") logFile?.write(`${new Date().toISOString()} [info] launcher: outcome hooks relayed through a command hook (${config.hooks === "command" ? "REFLEX_HOOKS=command" : "sandbox.enabled: Claude Code refuses http hooks to 127.0.0.1 under its sandbox"})\n`);
  const injection = injectSettings(argv, { env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${door.port}` }, ...(transport ? { hooks: outcomeHooks(door.port, transport) } : {}), ...(statusLine ? { statusLine } : {}) }, realInjectIO(io.cwd));
  if (injection.warning) warn(injection.warning);
  if (io.env["CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS"]) warn("CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS is set: MCP tool search stays off, so every MCP tool schema is sent on every request");
  try {
    return await runClaude(bin, injection.args, sanitizedEnv(io.env, proxyEnv(io.env, `http://127.0.0.1:${door.port}`)), io);
  } finally {
    injection.cleanup();
    await door.close();
    await supervisor.stop();
    await laya?.stop();
    logFile?.end();
  }
}
