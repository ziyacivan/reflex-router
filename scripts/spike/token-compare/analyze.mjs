// Spike (not product code): paired summary of token-compare runs. Per task, each arm's mean over its reps; then, against
// the base arm, the ratio of the task-summed totals with a 95% bootstrap interval over tasks (resampled with
// replacement, 4000 times). Dollar figures are list-price estimates over recorded token counts (src/pricing.ts).
//   node scripts/spike/token-compare/analyze.mjs <runs.jsonl>... [--base opus55]
import fs from "node:fs";

const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "opus55";
const files = argv.filter((a, i) => a !== "--base" && argv[i - 1] !== "--base");
const rows = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

const total = (r) => r.input + r.output + r.cache_read + r.cache_create;
const METRICS = { output: (r) => r.output, total_tokens: total, usd: (r) => r.usd, requests: (r) => r.requests };
const byTask = new Map();
for (const r of rows) {
  if (!byTask.has(r.task)) byTask.set(r.task, new Map());
  const t = byTask.get(r.task);
  if (!t.has(r.arm)) t.set(r.arm, []);
  t.get(r.arm).push(r);
}
const arms = [...new Set(rows.map((r) => r.arm))];
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Deterministic PRNG so the interval is reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const out = { base, tasks: byTask.size, runs: rows.length, arms: {} };
for (const arm of arms) {
  const tasks = [...byTask.entries()].filter(([, m]) => m.has(arm) && m.has(base));
  const a = { tasks: tasks.length, reps: mean(tasks.map(([, m]) => m.get(arm).length)), checks: null, metrics: {} };
  const checked = rows.filter((r) => r.arm === arm && r.check !== null);
  a.checks = `${checked.filter((r) => r.check).length}/${checked.length}`;
  a.failed_exit = rows.filter((r) => r.arm === arm && r.exit !== 0).length;
  for (const [name, f] of Object.entries(METRICS)) {
    const pairs = tasks.map(([, m]) => [mean(m.get(arm).map(f)), mean(m.get(base).map(f))]);
    const ratio = (ps) => ps.reduce((s, p) => s + p[0], 0) / ps.reduce((s, p) => s + p[1], 0);
    const boots = [];
    for (let i = 0; i < 4000; i++) boots.push(ratio(pairs.map(() => pairs[Math.floor(rand() * pairs.length)])));
    boots.sort((x, y) => x - y);
    const perTask = pairs.map(([x, y]) => x / y).sort((x, y) => x - y);
    a.metrics[name] = {
      mean_per_task: Number(mean(pairs.map((p) => p[0])).toFixed(name === "usd" ? 4 : 0)),
      ratio_vs_base: Number(ratio(pairs).toFixed(3)),
      ci95: [Number(boots[100].toFixed(3)), Number(boots[3899].toFixed(3))],
      median_task_ratio: Number(perTask[Math.floor(perTask.length / 2)].toFixed(3)),
      tasks_above_base: pairs.filter(([x, y]) => x > y).length,
    };
  }
  out.arms[arm] = a;
}
console.log(JSON.stringify(out, null, 1));
