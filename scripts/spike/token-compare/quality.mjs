// Spike (not product code): pass/fail quality of token-compare arms. For every task with a `check`, each arm's pass
// rate over its reps (Wilson 95% interval), the failures by task, and the paired difference against the base arm
// (per-task means, 95% bootstrap interval over tasks, deterministic seed). Cost and size are list-price estimates over
// the recorded token counts. A check is pass/fail on the file system after the run (tasks.json), not a review of the
// answer; tasks with check null (explain-only) are not scored.
//   node scripts/spike/token-compare/quality.mjs <runs.jsonl>... [--base sonnet55]
import fs from "node:fs";

const argv = process.argv.slice(2);
const base = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "sonnet55";
const answersFile = argv.includes("--answers") ? argv[argv.indexOf("--answers") + 1] : null;
const files = argv.filter((a, i) => a !== "--base" && argv[i - 1] !== "--base" && a !== "--answers" && argv[i - 1] !== "--answers" && a !== "--json");
const read = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// --answers <runs.jsonl>: a second round that read the final answer of the read-only tasks (answer_ok / answer_ok_regrade). Those
// tasks replace the same tasks of the first round, whose check there is only "no file changed".
const answerRows = answersFile ? read(answersFile).map((r) => ({ ...r, check: r.check && (r.answer_ok_regrade ?? r.answer_ok) })) : [];
const answerTasks = new Set(answerRows.map((r) => r.task));
const rows = [...files.flatMap(read).filter((r) => !answerTasks.has(r.task)), ...answerRows];
const arms = [...new Set(rows.map((r) => r.arm))];
const scored = rows.filter((r) => r.check !== null);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const wilson = (k, n) => {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d, h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
};
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pct = (x) => `${(100 * x).toFixed(0)}%`;

const out = { base, arms: {}, failures: {}, paired: {} };
console.log(`quality: ${scored.length} scored runs over ${new Set(scored.map((r) => r.task)).size} tasks, arms ${arms.join(", ")}\n`);
console.log("arm".padEnd(15), "pass".padEnd(10), "rate (95% CI)".padEnd(18), "avg $/run".padEnd(11), "avg req".padEnd(8), "avg out tok".padEnd(12), "avg secs");
for (const a of arms) {
  const rs = scored.filter((r) => r.arm === a), all = rows.filter((r) => r.arm === a);
  const k = rs.filter((r) => r.check).length, [lo, hi] = wilson(k, rs.length);
  out.arms[a] = { pass: k, scored: rs.length, runs: all.length, rate: k / rs.length, ci: [lo, hi], usd: mean(all.map((r) => r.usd)), requests: mean(all.map((r) => r.requests)), output: mean(all.map((r) => r.output)), secs: mean(all.map((r) => r.secs)) };
  console.log(a.padEnd(15), `${k}/${rs.length}`.padEnd(10), `${pct(k / rs.length)} (${pct(lo)}-${pct(hi)})`.padEnd(18), `$${mean(all.map((r) => r.usd)).toFixed(3)}`.padEnd(11), mean(all.map((r) => r.requests)).toFixed(1).padEnd(8), mean(all.map((r) => r.output)).toFixed(0).padEnd(12), mean(all.map((r) => r.secs)).toFixed(0));
}
console.log("\nfailed checks by task (arm: failures/reps):");
const tasks = [...new Set(scored.map((r) => r.task))];
for (const t of tasks) {
  const cells = arms.map((a) => { const rs = scored.filter((r) => r.task === t && r.arm === a); return [a, rs.filter((r) => !r.check).length, rs.length]; });
  if (cells.some(([, f]) => f > 0)) { console.log(" ", t.padEnd(18), cells.map(([a, f, n]) => `${a} ${f}/${n}`).join("   ")); out.failures[t] = Object.fromEntries(cells.map(([a, f, n]) => [a, [f, n]])); }
}
console.log(`\npaired against ${base} (mean pass rate per task, difference arm - ${base}, 95% bootstrap over tasks):`);
for (const a of arms.filter((x) => x !== base)) {
  const per = tasks.map((t) => { const x = scored.filter((r) => r.task === t && r.arm === a), y = scored.filter((r) => r.task === t && r.arm === base); return x.length && y.length ? mean(x.map((r) => +r.check)) - mean(y.map((r) => +r.check)) : null; }).filter((v) => v !== null);
  const d = mean(per), bs = [];
  for (let i = 0; i < 4000; i++) bs.push(mean(per.map(() => per[Math.floor(rand() * per.length)])));
  bs.sort((p, q) => p - q);
  out.paired[a] = { diff: d, ci: [bs[100], bs[3899]], tasks: per.length };
  console.log(" ", a.padEnd(15), `${d >= 0 ? "+" : ""}${(100 * d).toFixed(1)} points`.padEnd(14), `[${(100 * bs[100]).toFixed(1)}, ${(100 * bs[3899]).toFixed(1)}]`, `over ${per.length} tasks`);
}
if (argv.includes("--json")) console.log(JSON.stringify(out));
