// Where the tier question sends a labelled task corpus, under the policy text of the checkout it runs in: run it on
// two checkouts (the current TIER_OPTIONS and a proposed one) and compare. Each task is built into the product's
// decision state (same budget, same redaction), put to Jev with the product's questions, and planned the way route
// mode plans a subagent that asked for Opus (src/policy.ts judge + plan). NUMBERS ONLY are written: the tier sent,
// Jev's tier probabilities and reasoning score, and the item's own label; the task text is never written.
//
//   node --import tsx scripts/calibrate/tier-ab.ts <corpus.jsonl> <out.jsonl>
//
// A corpus line: {"task": string, "kind": "main"|"subagent", "previous": string|null, "label"?: {...}}. `label` is
// copied to the output as is and must hold no text; `label.sonnet_ok` (boolean: a Sonnet run did the task as well as
// an Opus run) is summarised. Needs TYPESAFE_API_KEY (environment or ~/.reflex/env).
import { readFileSync, writeFileSync } from "node:fs";
import { JevBackend } from "../../src/backend/jev.js";
import { loadConfig } from "../../src/config.js";
import { mergeEnvFile } from "../../src/env-file.js";
import { buildQuestions, judge, plan } from "../../src/policy.js";
import { buildState } from "../../src/privacy/state.js";

const [corpus, out] = process.argv.slice(2);
if (!corpus || !out) throw new Error("usage: tier-ab.ts <corpus.jsonl> <out.jsonl>");
const env = mergeEnvFile(process.env).env;
const loaded = loadConfig({ ...env, REFLEX_MODE: "route" });
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const cfg = loaded.config;
const key = env["TYPESAFE_API_KEY"]?.trim();
if (!key) throw new Error("TYPESAFE_API_KEY is needed");

type Item = { task: string; kind: "main" | "subagent"; previous: string | null; label?: Record<string, unknown> };
const items = readFileSync(corpus, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Item);
const jev = new JevBackend({ baseUrl: cfg.jevBaseUrl, apiKey: key, deadlineMs: 15_000 });
const questions = buildQuestions(cfg);
const signal = { signal: new AbortController().signal };
const rows: Record<string, unknown>[] = [];
for (const it of items) {
  const { state } = buildState({ kind: it.kind, task: it.task, previousAssistantText: it.previous, requestedModel: cfg.models.opus }, cfg);
  const row: Record<string, unknown> = { kind: it.kind, label: it.label ?? null };
  try {
    const d = await jev.decide(state, questions, signal);
    const j = judge(d, cfg);
    if (!j.ok) throw new Error(j.error);
    const p = plan({ kind: it.kind, requestedModel: cfg.models.opus }, j.judgement, cfg);
    row["sent"] = p.target?.tier ?? "opus";
    row["reasons"] = p.reasons;
    row["p"] = j.judgement.tier.probabilities;
    row["demand"] = j.judgement.vetoes["reasoning_demand"] ?? null;
    row["jev_version"] = d.backendModel;
  } catch (e) {
    row["error"] = e instanceof Error ? e.message : String(e);
  }
  rows.push(row);
}
jev.close?.();
writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");

const ok = rows.filter((r) => !r["error"]);
const below = (r: Record<string, unknown>): boolean => r["sent"] === "sonnet" || r["sent"] === "haiku";
const lab = (r: Record<string, unknown>): boolean | undefined => (r["label"] as { sonnet_ok?: boolean } | null)?.sonnet_ok;
const count = (f: (r: Record<string, unknown>) => boolean): number => ok.filter(f).length;
console.log(JSON.stringify({
  items: rows.length,
  errors: rows.length - ok.length,
  sent: { haiku: count((r) => r["sent"] === "haiku"), sonnet: count((r) => r["sent"] === "sonnet"), opus: count((r) => r["sent"] === "opus") },
  sonnet_ok: { labelled: count((r) => lab(r) === true), moved_down: count((r) => lab(r) === true && below(r)) },
  sonnet_not_ok: { labelled: count((r) => lab(r) === false), moved_down: count((r) => lab(r) === false && below(r)) },
}));
