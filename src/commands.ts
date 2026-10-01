import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_JEV_MODEL, loadConfig, SETTING_NAMES, unknownReflexEnvNames } from "./config.js";
import { resolveEffectiveMode } from "./effective-mode.js";
import { HINT_VERSION } from "./delegate/hint.js";
import { mergeEnvFile, type MergedEnv } from "./env-file.js";
import { resolveBin, resolveClaude, realResolveIO } from "./launcher/claude-bin.js";
import { assessVersion, describeVerdict, probeClaudeVersion } from "./launcher/version.js";
import { sanitizedEnv, type LaunchIO } from "./launcher/launch.js";
import { TESTED_CLAUDE_VERSIONS } from "./wire/tested-versions.generated.js";

export function packageVersion(): string {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function versionCommand(io: Pick<LaunchIO, "stderr"> & { stdout: (t: string) => void }): number {
  io.stdout(`reflex ${packageVersion()}\n`);
  return 0;
}

/** A setting's value as doctor shows it: never the key, and URLs without credentials or query. */
function shownValue(name: string, value: string): string {
  if (name === "TYPESAFE_API_KEY" || name === "TYPELLM_API_KEY") return "(set, not shown)";
  if (name.endsWith("_URL")) {
    try {
      const u = new URL(value);
      return `${u.origin}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "(not a URL)";
    }
  }
  return value;
}

/** One line per setting that is set, with where its value came from; everything else is a built-in default. */
export function describeSettingSources(m: MergedEnv): string[] {
  const lines: string[] = [];
  for (const name of SETTING_NAMES) {
    const value = m.env[name];
    if (value === undefined || value.trim() === "") continue;
    lines.push(`  ${name.padEnd(30)} ${shownValue(name, value.trim()).padEnd(28)} from ${m.fromFile.has(name) ? m.file : "process environment"}`);
  }
  for (const name of m.overridden) lines.push(`  ${name.padEnd(30)} also in ${m.file}; the process environment wins`);
  return lines.length > 0 ? lines : ["  (none set: built-in defaults)"];
}

/** Prints what reflex would do with the current environment. Never prints secret values. */
export async function doctorCommand(io: LaunchIO & { stdout: (t: string) => void }): Promise<number> {
  const out = (line: string): void => io.stdout(`${line}\n`);
  out(`reflex ${packageVersion()} on node ${process.version} (${process.platform})`);

  const merged = mergeEnvFile(io.env, io.envFile, io.homedir);
  const fileLine =
    merged.state === "absent" ? "not present"
    : merged.state === "loaded" ? `loaded (${merged.fromFile.size} value${merged.fromFile.size === 1 ? "" : "s"} used)`
    : `NOT USED: ${merged.reason ?? merged.state}`;
  out(`env file:        ${merged.file} - ${fileLine}`);
  for (const w of merged.warnings) if (merged.reason === null || !w.includes(merged.reason)) out(`env file warning: ${w}`);
  out("settings (process environment over env file):");
  for (const line of describeSettingSources(merged)) out(line);
  // A REFLEX_*/TYPESAFE_* name nothing reads is dropped without a word, and then stripped from the child's
  // environment too, so a typo looks exactly like a setting that had no effect. Name it.
  for (const name of unknownReflexEnvNames(merged.env)) out(`unknown setting:  ${name} is set but nothing reads it (not one of the ${String(SETTING_NAMES.length)} known settings); it is ignored, and stripped from the environment given to claude`);
  const envProblem = merged.state === "refused" || merged.state === "unreadable";

  const loaded = loadConfig(merged.env, io.homedir);
  if (!loaded.ok) {
    for (const e of loaded.errors) out(`config error: ${e}`);
    return 1;
  }
  const c = loaded.config;
  for (const w of loaded.warnings) out(`config warning: ${w}`);
  out(`mode requested:  ${c.mode}`);
  let layaMissing = false;
  if (c.backend === "laya") {
    // laya-serve reads the Hugging Face cache only (HF_HUB_OFFLINE): without the checkpoint there, it cannot load.
    const hub = io.env["HF_HUB_CACHE"] ?? path.join(io.env["HF_HOME"] ?? path.join(io.homedir ?? os.homedir(), ".cache", "huggingface"), "hub");
    const cached = fs.existsSync(path.join(hub, "models--convaiinnovations--laya", "snapshots"));
    const layaBin = resolveBin("laya-serve", c.layaBin, realResolveIO(io.env));
    layaMissing = layaBin === null;
    out(`backend:         laya, started by reflex on 127.0.0.1, offline (model ${c.layaModel}; no TypeSafe key used)`);
    out(`laya-serve:      ${layaBin ? layaBin.path : 'NOT FOUND - install it with `uv tool install "laya[serve]"` or set REFLEX_LAYA_BIN; sessions run plain claude until then'}`);
    out(`laya weights:    ${cached ? `in ${hub}` : `NOT in ${hub} - fetch them once with \`hf download convaiinnovations/laya\` (reflex runs laya-serve offline)`}`);
  } else if (c.backend === "typellm") {
    out(`backend:         typellm (key ${c.typellmApiKey ? "present" : merged.state === "refused" ? "missing: the env file was refused (see above)" : "missing"}; TYPELLM_API_KEY)`);
    out(`typellm:         ${new URL(c.typellmBaseUrl).origin}, model ${c.typellmModel}. The model that answered is recorded per decision (backend_version)`);
  } else {
    out(`backend:         ${c.backend} (key ${c.typesafeApiKey ? "present" : merged.state === "refused" ? "missing: the env file was refused (see above)" : "missing"})`);
    const pinned = c.jevModel === DEFAULT_JEV_MODEL;
    out(`jev model:       ${c.jevModel} (${pinned ? "pinned; REFLEX_JEV_MODEL=jev-latest follows TypeSafe's alias instead" : `REFLEX_JEV_MODEL; reflex pins ${DEFAULT_JEV_MODEL}`}). The version that answered is recorded per decision (backend_version)`);
  }
  out(`upstream:        ${new URL(c.upstreamUrl).origin}${new URL(c.upstreamUrl).pathname === "/" ? "" : new URL(c.upstreamUrl).pathname}`);
  out(`state directory: ${c.home}`);
  out(`prompt preview:  ${c.logPrompts ? "on (REFLEX_LOG_PROMPTS) - decisions.jsonl includes a redacted, 300-char preview of each decided prompt" : "off (REFLEX_LOG_PROMPTS=1 to add a redacted prompt preview to decisions.jsonl)"}`);
  out(`delegation hint: ${c.delegate ? `on (${HINT_VERSION}; REFLEX_DELEGATE)` : "off"}`);
  // Escalation is the only setting that lets a past event change a future request, so doctor spells out what it does.
  const escWhat = `a routed turn whose outcome window closes with a correction >= ${c.escalateThreshold}, a test failure after an edit, or a reverted edit raises that conversation's next ${c.escalateWindowTurns} new turn(s) to ${c.escalateTarget === "requested" ? "the requested tier" : "one tier up"}, never above the requested tier`;
  out(
    `escalation:      ${
      c.escalate === "off" ? "off (REFLEX_ESCALATE=1 to turn on, or =shadow to record without changing anything)"
      : c.escalate === "shadow" ? `SHADOW (REFLEX_ESCALATE=shadow) - records would_escalate and changes nothing; ${escWhat}`
      : `on (REFLEX_ESCALATE) - ${escWhat}${c.mode === "route" ? "" : ` - BUT REFLEX_MODE=${c.mode} changes no request, so nothing will move`}`
    }`,
  );

  const bin = resolveClaude(c.claudeBin, realResolveIO(io.env));
  if (!bin) {
    out("claude:          NOT FOUND on PATH (set REFLEX_CLAUDE_BIN)");
    return 1;
  }
  const version = await probeClaudeVersion(bin, sanitizedEnv(io.env));
  const verdict = assessVersion(version, TESTED_CLAUDE_VERSIONS);
  out(`claude:          ${bin.path} (version ${version ?? "unknown"})`);
  out(`tested versions: ${TESTED_CLAUDE_VERSIONS.join(", ") || "none"}`);
  out(`version check:   ${verdict.level} (${verdict.reason})${describeVerdict(verdict) ? ` - ${describeVerdict(verdict)}` : ""}`);
  const eff = resolveEffectiveMode(c, verdict);
  out(`mode effective:  ${eff.mode}${eff.degradedReason ? ` (${eff.degradedReason})` : ""}`);

  // REFLEX_DELEGATE=1 is silent when it cannot work: the hint travels through reflex's own UserPromptSubmit hook, and
  // both paths below run `claude` with no settings file at all, so no hook is ever installed and nothing reports it.
  // Say so loudly and fail, rather than let a session run believing the hint is on.
  let hintBroken = false;
  if (c.delegate) {
    const why =
      c.mode === "off" ? "REFLEX_MODE=off runs claude directly: no settings file, no hooks"
      // The remaining effective modes are shadow and route, and the worker answers hooks in both (Router.active).
      : eff.mode === "passthrough" ? `mode effective is passthrough (${eff.degradedReason ?? "unknown"}): claude runs directly, no hooks are injected`
      : null;
    hintBroken = why !== null;
    out(`hint injection:  ${why === null ? `ok (${HINT_VERSION} via reflex's UserPromptSubmit hook)` : `CANNOT INJECT - ${why}`}`);
    if (hintBroken) out("                 the hint will NOT reach Claude Code; unset REFLEX_DELEGATE or fix the above");
  }
  return envProblem || hintBroken || layaMissing ? 1 : 0;
}
