// Spike (not product code): do Opus 5.5 and the Sonnet models spend the same tokens on the same coding tasks?
// Each task of tasks.json runs as one `claude -p` session through the BUILT reflex (dist/, route mode) in a fresh copy of
// sandbox/, once per arm. The user's own Claude Code settings apply (no --model); a loopback fake Jev fixes the
// decision, so every main-chat and subagent request of an arm goes where the arm says:
//   opus55    Jev says opus: the requested Opus 5.5 is kept (the control)
//   sonnet55  Jev says sonnet, REFLEX_MODEL_SONNET=claude-sonnet-5-5
//   sonnet5   Jev says sonnet, REFLEX_MODEL_SONNET=claude-sonnet-5 (the model of the 2026-09-26 token audit)
// Arms are interleaved per task, all in the same folder path, so each run sees the same system prompt. Recorded per run:
// the token counts and list-price estimate from reflex's own decision log, the models sent, and whether the task's check
// passed. No prompt or answer text is written. The cap is checked after every run (overshoot: at most one run).
//
//   node --import tsx scripts/spike/token-compare/run.mts --out _dumps/tc --cap-usd 25 [--arms a,b] [--tasks id,id] [--reps n]
//     [--tasks-file f.json] [--work <folder name>] (a second run at the same time needs its own --work)
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeJev } from "../../../test/support/fake-jev.ts";
import { usageCostUsd, type CacheTtl } from "../../../src/pricing.ts";
import { tierOfModel } from "../../../src/tiers.ts";

const here = import.meta.dirname;
const repo = path.resolve(here, "../../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string): string => (argv.includes(k) ? argv[argv.indexOf(k) + 1]! : d);
const out = path.resolve(opt("--out", path.join(repo, "_dumps", `tc-${Date.now()}`)));
const capUsd = Number(opt("--cap-usd", "25"));
const reps = Number(opt("--reps", "1"));
// Quality arms (Haiku 5.5 work, 2026-10-07): `haiku` sets REFLEX_MODEL_HAIKU (the target of "Jev says haiku"); `native`
// runs the model directly (`--model`, shadow mode: nothing is rewritten), so Claude Code builds the prompt for it itself.
// `--claude-bin` pins the Claude Code build (REFLEX_CLAUDE_BIN) so every arm sees the same client.
const ARMS: Record<string, { tier: string; sonnet?: string; haiku?: string; native?: string }> = {
  haiku45: { tier: "haiku", haiku: "claude-haiku-4-5-20251001" },
  haiku55: { tier: "haiku", haiku: "claude-haiku-5-5" },
  haiku55native: { tier: "sonnet", native: "claude-haiku-5-5" },
  haiku45native: { tier: "sonnet", native: "claude-haiku-4-5-20251001" },
  opus55: { tier: "opus" },
  sonnet55: { tier: "sonnet", sonnet: "claude-sonnet-5-5" },
  sonnet5: { tier: "sonnet", sonnet: "claude-sonnet-5" },
  // Jev says sonnet and the tier model is whatever the build defaults to.
  sonnetdefault: { tier: "sonnet" },
};
const arms = opt("--arms", "opus55,sonnet55,sonnet5").split(",");
const allTasks = JSON.parse(fs.readFileSync(path.resolve(opt("--tasks-file", path.join(here, "tasks.json"))), "utf8")) as { id: string; prompt: string; check: string | null; answer?: { all?: string[]; anyOf?: { min: number; of: string[] } } }[];
const only = argv.includes("--tasks") ? new Set(opt("--tasks", "").split(",")) : null;
const tasks = allTasks.filter((t) => !only || only.has(t.id));
const work = path.join(os.tmpdir(), "reflex-token-compare", opt("--work", "work"));
const ALLOWED = ["Read", "Edit", "Write", "Glob", "Grep", "Agent", "Bash(python3:*)", "Bash(ls:*)", "Bash(cat:*)", "Bash(grep:*)", "Bash(wc:*)", "Bash(find:*)", "Bash(git diff:*)", "Bash(git status:*)", "Bash(mkdir:*)", "Bash(PYTHONPATH=*)"];
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const resultsPath = path.join(out, "runs.jsonl");

function freshSandbox(): void {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  fs.cpSync(path.join(here, "sandbox"), work, { recursive: true });
  // Fixed dates: the same commit hash every time, so Claude Code's git status in the system prompt never differs.
  const env = { ...process.env, GIT_AUTHOR_DATE: "2026-09-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-09-01T12:00:00Z", GIT_AUTHOR_NAME: "sandbox", GIT_AUTHOR_EMAIL: "sandbox@example.invalid", GIT_COMMITTER_NAME: "sandbox", GIT_COMMITTER_EMAIL: "sandbox@example.invalid" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "sandbox"]]) spawnSync("git", args, { cwd: work, env });
}

function childEnv(home: string, jevUrl: string, arm: { sonnet?: string; haiku?: string; native?: string }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE" || k === "CLAUDE_EFFORT" || k.startsWith("REFLEX_") || k.startsWith("TYPESAFE_") || k === "ANTHROPIC_BASE_URL") continue;
    env[k] = v;
  }
  return {
    ...env,
    REFLEX_HOME: home,
    REFLEX_MODE: arm.native ? "shadow" : "route",
    ...(argv.includes("--claude-bin") ? { REFLEX_CLAUDE_BIN: opt("--claude-bin", "") } : {}),
    REFLEX_JEV_BASE_URL: jevUrl,
    TYPESAFE_API_KEY: "apikey_fake-for-loopback-jev",
    REFLEX_UPSTREAM_URL: opt("--upstream", "https://api.anthropic.com"),
    REFLEX_TIERS: "haiku,sonnet,opus",
    REFLEX_STATUSLINE: "0",
    ...(arm.sonnet ? { REFLEX_MODEL_SONNET: arm.sonnet } : {}),
    ...(arm.haiku ? { REFLEX_MODEL_HAIKU: arm.haiku } : {}),
  };
}

const readRecords = (file: string): Record<string, any>[] =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>) : [];

function summarise(recs: Record<string, any>[]): Record<string, unknown> {
  const s = { requests: 0, input: 0, output: 0, cache_read: 0, cache_create: 0, usd: 0, models: {} as Record<string, number>, by_kind: {} as Record<string, number>, unknown_usage: 0 };
  for (const r of recs) {
    if (r["record"] !== undefined && r["record"] !== "decision") continue;
    const model = r["forwarded"]?.["model"] ?? r["requested"]?.["model"] ?? "?";
    const k = r["side_kind"] ? `side:${r["side_kind"]}` : String(r["kind"]);
    s.by_kind[k] = (s.by_kind[k] ?? 0) + 1;
    s.models[`${k}>${model}`] = (s.models[`${k}>${model}`] ?? 0) + 1;
    s.requests++;
    const u = r["usage"];
    if (!u) { s.unknown_usage++; continue; }
    s.input += u.input; s.output += u.output; s.cache_read += u.cache_read; s.cache_create += u.cache_create;
    const ttl: CacheTtl = r["cache_ttl"] === "1h" ? "1h" : "5m";
    s.usd += usageCostUsd(tierOfModel(model) ?? "opus", { input: u.input, output: u.output, cacheRead: u.cache_read, cacheCreate: u.cache_create }, ttl, model);
  }
  return { ...s, usd: Number(s.usd.toFixed(5)) };
}

const jev = await startFakeJev({ kind: "answer", tier: "opus", confidence: 0.95, reasoning: 1 });
let spent = readRecords(resultsPath).reduce((a, r) => a + (r["usd"] ?? 0), 0);
const log = (m: string): void => void process.stderr.write(`[tc] ${m}\n`);
outer: for (let rep = 1; rep <= reps; rep++) {
  for (const t of tasks) {
    for (const armName of arms) {
      if (spent >= capUsd) { log(`cap $${capUsd} reached (spent ~$${spent.toFixed(2)}); stopping`); break outer; }
      const arm = ARMS[armName]!;
      jev.set({ kind: "answer", tier: arm.tier, confidence: 0.95, reasoning: 1 });
      const home = path.join(out, `home-${armName}`);
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const logFile = path.join(home, "decisions.jsonl");
      const before = readRecords(logFile).length;
      freshSandbox();
      const started = Date.now();
      // The final answer of `claude -p` is read here and judged by the task's regexes; only the verdict is recorded, never the text.
      let answerText = "";
      const code = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [path.resolve(opt("--reflex-bin", path.join(repo, "bin", "reflex.js"))), "-p", t.prompt, "--allowedTools", ...ALLOWED, ...(arm.native ? ["--model", arm.native] : [])], { cwd: work, env: childEnv(home, jev.url, arm), stdio: ["ignore", "pipe", "ignore"] });
        child.stdout?.on("data", (d: Buffer) => { answerText += d.toString("utf8"); });
        const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
        child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
      });
      await new Promise((r) => setTimeout(r, 500));
      const recs = readRecords(logFile).slice(before);
      const check = t.check === null ? null : spawnSync("bash", ["-c", t.check], { cwd: work, stdio: "ignore", timeout: 60_000 }).status === 0;
      // --keep-answers: the answer texts go to <out>/answers (local, _dumps is gitignored) so a grader can be checked by eye.
      if (argv.includes("--keep-answers")) {
        fs.mkdirSync(path.join(out, "answers"), { recursive: true });
        fs.writeFileSync(path.join(out, "answers", `${t.id}-${armName}-${rep}.txt`), answerText);
      }
      const ans = t.answer;
      const answerOk = ans === undefined ? null
        : (ans.all ?? []).every((r) => new RegExp(r, "i").test(answerText)) && (ans.anyOf === undefined || ans.anyOf.of.filter((r) => new RegExp(r, "i").test(answerText)).length >= ans.anyOf.min);
      const row = { task: t.id, arm: armName, rep, exit: code, answer_ok: answerOk, answer_chars: answerText.length, secs: Math.round((Date.now() - started) / 1000), check, ...summarise(recs) };
      fs.appendFileSync(resultsPath, JSON.stringify(row) + "\n");
      spent += row.usd;
      log(`${t.id} ${armName}#${rep}: exit ${code}, check ${check}, ${row.requests} req, out ${row.output}, $${row.usd} (total ~$${spent.toFixed(2)})`);
    }
  }
}
await jev.close();
log(`done; results in ${resultsPath}`);
