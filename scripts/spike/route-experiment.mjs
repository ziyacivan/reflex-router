#!/usr/bin/env node
// Spike (not product code): does the API accept Claude Code requests retargeted by src/wire/rewrite.ts in the shapes
// route mode will actually produce? One real `claude -p` session (source model: --from, sonnet or opus) is routed
// through this proxy the way route mode would route it, and at each interesting point extra PROBES are sent to every
// cheaper target tier (or to the tiers named by --to, e.g. `--from haiku --to sonnet,opus` for upgrades):
//
//   main-new:<t>          the main chat's first request (no history), rewritten to <t>; not routed, only probed
//   subagent-first:<t>    each subagent's first request, rewritten to <t>; subagent #1 is then pinned to the
//                         cheapest target, subagent #2 to the next one (so each target gets a pinned continuation)
//   subagent-pinned:<t>   later subagent requests, rewritten (target-made history, client still asks for --from)
//   main-cont1:<t>:*      first main-chat continuation: source-model thinking + tool_use in history, system messages
//                         mid-list and trailing. Variants: keep history thinking / drop it / no `display`
//                         (interactive shape) / + redact-thinking beta (interactive header)
//   main-pinned           later main continuations rewritten to the main target (history now holds its turns)
//   unpin-to-source       the same later request sent UNCHANGED to the source model (the retry-with-original / pin
//                         release case: target-made thinking in a source-model request)
//
//   node --import tsx scripts/spike/route-experiment.mjs --from opus --out DIR --cap-usd 0.40 -- <claude args>
//
// Options: --to a,b (targets instead of the cheaper tiers) · --main <tier> (the main chat's pin) · --no-main-new ·
// --probe-1m (first request + context-1m beta) · --probe-efforts (first request at each effort) · --probe-ceiling
// (first request padded to the Haiku ceiling, sent to Haiku) · --delay-pin (decide a subagent at its second request) ·
// --interactive <exit-s> (TUI in a pseudo-terminal via pty-run.py) · --lean (main-cont1: only the product's own
// keep-history variant) · --probe-message-oc (first request to each target that drops a system message's
// output_config, sent with it kept) · --probe-effort-switch (main chat stays on its model; its effort is switched
// mid-conversation the way Claude Code's own /effort does it, see below) · --probe-effort-apply (does the level take
// effect? full answers, see below) · --probe-effort-verify (the preserved-thinking check with effort messages; Sonnet's
// top-level effort; Opus 5 and Fable 5.1 per-message effort; see below). Probes and routed requests carry the product's header rewrite (STRIP_BETAS).
// Target model ids and prices are the product's own (DEFAULT_MODELS, src/pricing.ts); `--model sonnet=claude-sonnet-5-5`
// probes a model that is not yet its tier's default.
//
// The cap is ENFORCED: every probe and every forwarded request is pre-charged from its own bytes (estimateTokens: 2.5 bytes/token,
// priced as a 1-hour cache write on its model, the worst case) and refused if that would cross the cap; the reservation
// is replaced by the billed usage once the response is read. A refused forward answers the client 429.
//
// Headers of the live request (auth included) are held in memory only and never written. Probes stop reading at
// `message_start` (enough for status and input usage) and are aborted. Recorded per probe: status, API error
// message, shape facts, rewritten fields, usage and an estimated cost. No prompt text is recorded.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRequest } from "../../src/wire/claude-code.ts";
import { retarget, retargetBetas } from "../../src/wire/rewrite.ts";
import { CONTEXT_CEILING, estimateTokens, tierOfModel } from "../../src/tiers.ts";
import { DEFAULT_MODELS } from "../../src/config.ts";
import { priceOf } from "../../src/pricing.ts";

const argv = process.argv.slice(2);
let out = join("_dumps", "route-exp-" + Date.now());
let capUsd = 0.45;
let cwd = process.cwd();
let from = "sonnet";
let to = null;
let mainTarget = null;
let noMainNew = false;
/** Also probe each main-new target with the long-context beta added (a `<model>[1m]` setting sends it). */
let probe1m = false;
/** Also probe each main-new target that takes `effort` with low / medium / high / xhigh / max. */
let probeEfforts = false;
/** Also send the main-new request, padded to route mode's Haiku context ceiling (estimated tokens), to Haiku. */
let probeCeiling = false;
/** Let each subagent's first request through unchanged, so its second request holds a source-model turn; decide there. */
let delayPin = false;
/** Run the TUI in a pseudo-terminal (scripts/spike/pty-run.py), type the -p prompt, and /exit after this many seconds. */
let interactiveExitS = null;
let lean = false;
let probeMessageOc = false;
/**
 * --source-model <id>: every request of the source tier goes out as this model instead (forwarded and probed alike), so
 * the live session runs on a model Claude Code's aliases no longer name (e.g. claude-opus-5, now that `opus` is Opus 5.5).
 */
let sourceModel = null;
/** --interactive in a folder never trusted: its trust dialog defaults to "No, exit", so Down comes before the Enter. */
let newFolder = false;
/** --model <tier>=<id>: the target model of a tier instead of DEFAULT_MODELS (a model not yet the tier default). */
const modelOverrides = {};
/**
 * Main chat only, no model change. Claude Code's own /effort appends `{role:"system",content:[],output_config:{effort}}`
 * after the new user message and sets the top-level effort too (2.1.281 capture). The live session does the same at its
 * first continuation (-> low) and third (-> max), and re-inserts every earlier effort message on later requests, as
 * reflex would have to. Probes at the first continuation: each level (message + top-level), top-level only, message
 * only, and Sonnet (previous request, then this one at the same and at another top-level effort). At the second: the
 * request with the effort message forgotten (a history edit).
 */
let probeEffortSwitch = false;
/**
 * Main chat only, no model change: does a changed effort actually change how much the model thinks, when the system
 * message at index 1 still carries the client's effort? At the first continuation a fixed synthetic puzzle (never user
 * text) is appended to the last user message and the request is sent to the END (full answer, max_tokens clamped to
 * EFFORT_APPLY_MAX_TOKENS, reserved against the cap) at: the client's effort, top-level only low / max, effort message
 * + top-level low / max, effort message only low. Output tokens (thinking included) are the measure.
 */
let probeEffortApply = false;
const EFFORT_APPLY_MAX_TOKENS = 16000;
/**
 * --probe-effort-verify. At the main chat's first request: Opus 5 and Fable 5.1 (model swapped / retargeted) get a
 * cache write, then the same request + an effort message (accepted? cache kept?), then the PUZZLE as an extra user
 * message answered in full at the client's effort and with message + top-level low / max; Sonnet (retargeted) the same
 * with the top-level value only. The live main chat then does what reflex does (effort message -> low at the first
 * continuation, re-inserted after), and with `prefix_mismatch_behavior` (which opts any account into the
 * preserved-thinking check, beta thinking-binding-controls-2026-08-01) probes: adding the message at the first
 * continuation, and at the second the re-inserted request, the request with it forgotten ("error"), and forgotten with
 * "drop_block". The session's prompt must make the model think between tool calls, or there is nothing to check.
 */
let probeEffortVerify = false;
/** --effort-verify-parts opus-5,fable-5.1,sonnet-5.5,sonnet,binding | binding-set (alone): run only these parts (each Opus 5 / Fable part costs a cache write). */
let verifyParts = new Set(["opus-5", "fable-5.1", "sonnet", "binding"]);
/** Part binding-set only: run the live main chat (and its probes) on this tier instead (e.g. fable: the product's retarget). */
let bindingTier = null;
// Not memorisable (2026-09-24: a known-answer puzzle got ~150 output tokens at every level); needs step-by-step work.
const PUZZLE = "Set the file task aside for this one reply and use no tools. Let f(0)=1 and, for n>0, f(n) = f(n-1) + f(n-3) + f(n-4) + 2*f(n-7), where f of a negative number is 0. What is f(37) mod 1009? Reply with only the number.";
/** Each apply variant is sent this many times (the output length of one answer is noisy). */
const APPLY_REPEATS = 2;
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") out = argv[++i];
  else if (argv[i] === "--cap-usd") capUsd = Number(argv[++i]);
  else if (argv[i] === "--cwd") cwd = argv[++i];
  else if (argv[i] === "--from") from = argv[++i];
  else if (argv[i] === "--to") to = argv[++i].split(",");
  else if (argv[i] === "--main") mainTarget = argv[++i];
  else if (argv[i] === "--no-main-new") noMainNew = true;
  else if (argv[i] === "--probe-1m") probe1m = true;
  else if (argv[i] === "--probe-efforts") probeEfforts = true;
  else if (argv[i] === "--probe-ceiling") probeCeiling = true;
  else if (argv[i] === "--delay-pin") delayPin = true;
  else if (argv[i] === "--interactive") interactiveExitS = Number(argv[++i]);
  else if (argv[i] === "--lean") lean = true;
  else if (argv[i] === "--probe-message-oc") probeMessageOc = true;
  else if (argv[i] === "--probe-effort-switch") probeEffortSwitch = true;
  else if (argv[i] === "--probe-effort-apply") probeEffortApply = true;
  else if (argv[i] === "--probe-effort-verify") probeEffortVerify = true;
  else if (argv[i] === "--effort-verify-parts") verifyParts = new Set(argv[++i].split(","));
  else if (argv[i] === "--binding-tier") bindingTier = argv[++i];
  else if (argv[i] === "--new-folder") newFolder = true;
  else if (argv[i] === "--source-model") sourceModel = argv[++i];
  else if (argv[i] === "--model") { const [t, id] = argv[++i].split("="); modelOverrides[t] = id; }
  else if (argv[i] === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const MODELS = { ...DEFAULT_MODELS, ...modelOverrides };
const ORDER = ["haiku", "sonnet", "opus", "fable"];
/** --to, or else the cheaper tiers than the source; cheapest first. */
const TARGETS = to ?? ORDER.slice(0, ORDER.indexOf(from));
const MAIN_TARGET = mainTarget ?? TARGETS[0];
const upstream = new URL("https://api.anthropic.com");
const SKIP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding", "proxy-authorization", "te", "trailer"]);
// The product's list prices (src/pricing.ts), per model: Opus 5.5 is not priced like Opus 5.
const price = (model) => priceOf(tierOfModel(String(model)) ?? "opus", String(model));
function costUsd(model, u) {
  if (!u) return 0;
  const p = price(model);
  const c = u.cache_creation ?? {};
  const w1h = c.ephemeral_1h_input_tokens ?? 0;
  const w5m = c.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1h);
  return ((u.input_tokens ?? 0) * p.input + w5m * p.input * 1.25 + w1h * p.input * 2 + (u.cache_read_input_tokens ?? 0) * p.input * p.cacheReadMult + (u.output_tokens ?? 0) * p.output) / 1e6;
}
/**
 * Cost of sending `body` if every input token is a 1-hour cache write, reserved before it is sent. Output is not
 * reserved: a long answer can still overshoot. (At 4 bytes/token the first capped run, 2026-09-23, overshot $0.50 by
 * $0.02: real requests run 2.5-2.8 bytes/token.)
 */
const preUsd = (body) => { let model = null; try { model = JSON.parse(body.toString("utf8")).model; } catch { /* not json */ } return model ? (estimateTokens(body.length) * price(model).input * 2) / 1e6 : 0; };

let spent = 0;
let refused = 0;
const probes = [];
const forwarded = [];
const log = (s) => process.stderr.write(`[exp] ${s}\n`);

/** Structure only: where system messages sit, whether the history holds thinking blocks, which betas. */
function shapeFacts(body, headers) {
  const msgs = body.messages ?? [];
  const nonSysIdx = msgs.map((m, i) => (m.role === "system" ? -1 : i)).filter((i) => i >= 0);
  const lastNonSys = nonSysIdx.at(-1) ?? -1;
  const sys = msgs.map((m, i) => (m.role === "system" ? i : -1)).filter((i) => i >= 0);
  const thinking = msgs.filter((m) => m.role === "assistant" && Array.isArray(m.content)).flatMap((m) => m.content).filter((c) => c.type === "thinking" || c.type === "redacted_thinking").length;
  return {
    model: body.model,
    roles: msgs.map((m) => m.role[0]).join(""),
    system_positions: sys,
    system_mid_list: sys.some((i) => i < lastNonSys),
    history_thinking_blocks: thinking,
    thinking: body.thinking ?? null,
    effort: body.output_config?.effort ?? null,
    max_tokens: body.max_tokens ?? null,
    betas: String(headers["anthropic-beta"] ?? "").split(",").map((x) => x.trim()).filter(Boolean),
  };
}

/** Sends one request; for probes reads only up to message_start, then aborts. */
function send(path, headers, body, { probe, full = false }) {
  return new Promise((resolve) => {
    const h = { ...headers, host: upstream.host, "content-length": String(body.length), "accept-encoding": "identity" };
    const req = https.request({ hostname: upstream.hostname, method: "POST", path, headers: h }, (res) => {
      let buf = "";
      res.on("data", (c) => {
        buf += c.toString("utf8");
        if (probe && !full && res.statusCode < 400) {
          const m = /data: (\{"type":"message_start".*)\n/.exec(buf);
          if (m) { let usage = null; let transformations; try { const o = JSON.parse(m[1]).message; usage = o.usage; transformations = o.input_transformations; } catch { /* partial */ } res.destroy(); req.destroy(); resolve({ status: res.statusCode, usage, transformations }); }
        }
      });
      res.on("end", () => {
        if (res.statusCode >= 400) { let error = buf.slice(0, 300); try { error = JSON.parse(buf).error.message; } catch { /* raw */ } resolve({ status: res.statusCode, error }); }
        else if (full) {
          let usage = null;
          for (const m of buf.matchAll(/data: (\{"type":"message_(?:start|delta)".*)\n/g)) { try { const o = JSON.parse(m[1]); usage = { ...usage, ...(o.message?.usage ?? o.usage) }; } catch { /* partial */ } }
          const text = [...buf.matchAll(/"type":"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1])).join("");
          const stop = /"stop_reason":"([a-z_]+)"/.exec(buf)?.[1] ?? null;
          const tm = /"input_transformations":(\[[^\]]*\])/.exec(buf);
          resolve({ status: res.statusCode, usage, answer: text.slice(0, 40), stop, transformations: tm ? JSON.parse(tm[1]) : undefined });
        } else resolve({ status: res.statusCode, text: buf });
      });
      res.on("error", () => resolve({ status: res.statusCode ?? 0, error: "stream error" }));
    });
    req.on("error", (e) => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

/** The headers route mode would send with `body`: the product's per-target beta removals (STRIP_BETAS) when retargeted. */
function productHeaders(headers, body) {
  let model = null;
  try { model = JSON.parse(body.toString("utf8")).model; } catch { return { headers, stripped: [] }; }
  const tier = Object.keys(MODELS).find((k) => MODELS[k] === model);
  if (!tier || tier === from) return { headers, stripped: [] };
  const b = retargetBetas(headers["anthropic-beta"], tier);
  return b.stripped.length === 0 ? { headers, stripped: [] } : { headers: { ...headers, "anthropic-beta": b.value }, stripped: b.stripped };
}

async function probe(label, path, rawHeaders, bodyBuf, rawFields, facts, { keepHeaders = false, full = false } = {}) {
  const pre = preUsd(bodyBuf) + (full ? (JSON.parse(bodyBuf.toString("utf8")).max_tokens * price(JSON.parse(bodyBuf.toString("utf8")).model).output) / 1e6 : 0);
  if (spent + pre > capUsd) { refused++; probes.push({ label, skipped: "cap reached", pre_usd: Number(pre.toFixed(4)) }); log(`skip ${label} (cap)`); return null; }
  spent += pre;
  const { headers, stripped } = keepHeaders ? { headers: rawHeaders, stripped: [] } : productHeaders(rawHeaders, bodyBuf);
  const fields = [...rawFields, ...stripped.map((x) => `anthropic-beta:-${x}`)];
  const r = await send(path, headers, bodyBuf, { probe: true, full });
  const model = JSON.parse(bodyBuf.toString("utf8")).model;
  const usd = costUsd(model, r.usage);
  spent += usd - pre;
  probes.push({ label, status: r.status, accepted: r.status === 200, error: r.error ?? null, fields, facts, usage: r.usage ?? null, ...(full ? { answer: r.answer ?? null, stop_reason: r.stop ?? null } : {}), ...(r.transformations !== undefined ? { input_transformations: r.transformations } : {}), est_usd: Number(usd.toFixed(5)) });
  log(`${r.status === 200 ? "ACCEPT" : "reject"} ${r.status} ${label}${r.error ? " :: " + String(r.error).slice(0, 160) : ""}  (spent ~$${spent.toFixed(3)})`);
  return r.status === 200;
}

const variantBody = (parsed, mutate) => { const b = structuredClone(parsed); mutate?.(b); return Buffer.from(JSON.stringify(b)); };
const rt = (buf, to, extra = {}) => retarget(buf, { from, to, model: MODELS[to], ...extra });

/**
 * Pads the last user text block with synthetic filler (never user text) until the body is estimated at exactly the Haiku
 * ceiling, then sends it to Haiku: does the byte-based estimate keep a request inside Haiku's real 200k window? Three
 * fillers with different bytes-per-token: English prose, code, and dense digits/punctuation (the worst case).
 */
const FILLERS = {
  prose: "The quarterly report describes how the team moved the service to a new region, what broke, and what they changed afterwards. ",
  code: "export function f(a: number, b: string[]): Record<string, number> { return Object.fromEntries(b.map((x, i) => [x, a + i])); }\n",
  dense: "7,3;9.1|4-8=2+6*0/5^1%3#9@2!4?8~6&0 ",
  // A realistic dense case: this repository's own lockfile (public, no user text), as a Read tool result would carry it.
  lockfile: readFileSync(join(import.meta.dirname, "..", "..", "package-lock.json"), "utf8"),
};
async function ceilingProbes(req, raw, headers, facts) {
  const ceiling = CONTEXT_CEILING.haiku;
  for (const [kind, unit] of Object.entries(FILLERS)) {
    const b = JSON.parse(raw.toString("utf8"));
    const last = [...b.messages].reverse().find((m) => m.role === "user");
    if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
    const block = { type: "text", text: "" };
    last.content.push(block);
    const base = Buffer.byteLength(JSON.stringify(b));
    const need = ceiling * 2.5 - base;
    block.text = unit.repeat(Math.ceil(need / Buffer.byteLength(JSON.stringify(unit)) + 1));
    let body = Buffer.from(JSON.stringify(b));
    while (estimateTokens(body.length) > ceiling) { block.text = block.text.slice(0, -50); body = Buffer.from(JSON.stringify(b)); }
    let send = body;
    let fields = [];
    if (from !== "haiku") { const r = rt(body, "haiku"); if (!r.ok) continue; send = r.body; fields = r.fields; }
    await probe(`ceiling:${kind} (est ${estimateTokens(send.length)} tokens, ${send.length} bytes) -> haiku`, req.url, headers, send, fields, { ...facts, body_bytes: send.length, est_tokens: estimateTokens(send.length), filler: kind });
  }
}

const state = { subTarget: new Map(), subCount: 0, mainPinned: null, unpinProbed: false, crossProbed: false, mainNewProbed: false, subUnpinProbed: new Set(), subDelayed: new Set() };
/** What the run was made under (CLAUDE.md: real-API experiments record their settings). */
const seen = { requested_models: new Set(), entrypoints: new Set(), betas: new Set() };

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const effortMsg = (effort) => ({ role: "system", content: [], output_config: { effort } });
const es = { prev: null, n: 0, inserts: [] };
/** Re-inserts every effort message at the index it was first placed at (indices of the already-extended list). */
function withInserts(parsed) {
  const b = structuredClone(parsed);
  for (const ins of es.inserts) b.messages.splice(ins.index, 0, effortMsg(ins.effort));
  if (es.inserts.length) b.output_config = { ...b.output_config, effort: es.inserts.at(-1).effort };
  return b;
}
async function effortSwitch(req, raw, headers, parsed, facts, view) {
  const cur = parsed.output_config?.effort ?? null;
  if (view.turn !== "continuation") { es.prev = raw; return { body: raw, headers, note: "main-new passthrough (effort-switch)", facts }; }
  es.n++;
  const f = { ...facts, client_effort: cur };
  if (es.n === 1) {
    for (const e of LEVELS) {
      const b = structuredClone(parsed); b.messages.push(effortMsg(e)); b.output_config = { ...b.output_config, effort: e };
      await probe(`switch:${cur}->${e} (message + top-level)`, req.url, headers, Buffer.from(JSON.stringify(b)), ["messages.+effort", "output_config.effort"], f, { keepHeaders: true });
    }
    const other = cur === "low" ? "high" : "low";
    await probe(`switch:${cur}->${other} (top-level only)`, req.url, headers, variantBody(parsed, (b) => { b.output_config = { ...b.output_config, effort: other }; }), ["output_config.effort"], f, { keepHeaders: true });
    await probe(`switch:${cur}->${other} (message only)`, req.url, headers, variantBody(parsed, (b) => { b.messages.push(effortMsg(other)); }), ["messages.+effort"], f, { keepHeaders: true });
    if (es.prev) {
      const p = rt(es.prev, "sonnet");
      if (p.ok) await probe("sonnet:previous request (cache write)", req.url, headers, p.body, p.fields, f);
      const r = rt(raw, "sonnet");
      if (r.ok) {
        await probe(`sonnet:this request, effort ${cur}`, req.url, headers, r.body, r.fields, f);
        const b = JSON.parse(r.body.toString("utf8")); b.output_config = { ...b.output_config, effort: other };
        await probe(`sonnet:this request, effort ${other} (top-level)`, req.url, headers, Buffer.from(JSON.stringify(b)), [...r.fields, "output_config.effort"], f);
      }
    }
    es.inserts.push({ index: parsed.messages.length, effort: "low" });
  } else if (es.n === 2) {
    await probe("forgot the effort message (raw bytes, history edit)", req.url, headers, raw, [], f, { keepHeaders: true });
  } else if (es.n === 3) {
    es.inserts.push({ index: withInserts(parsed).messages.length, effort: "max" });
  }
  const body = Buffer.from(JSON.stringify(withInserts(parsed)));
  return { body, headers, note: `main effort-switch #${es.n} (${es.inserts.map((x) => x.effort).join(",")})`, fields: ["messages.+effort", "output_config.effort"], facts: f };
}

const BINDING_BETA = "thinking-binding-controls-2026-08-01";
const bound = (headers, b, behavior) => {
  b.thinking = { ...(b.thinking ?? { type: "adaptive" }), block_binding: { prefix_mismatch_behavior: behavior } };
  return { headers: { ...headers, "anthropic-beta": `${headers["anthropic-beta"]},${BINDING_BETA}` }, body: Buffer.from(JSON.stringify(b)) };
};
// Onto the last user message: a user message after Claude Code's trailing system text message is a 400 (first run,
// 2026-09-24: "role 'system' must precede an 'assistant' message or end the array").
const withPuzzle = (b) => {
  const last = [...b.messages].reverse().find((m) => m.role === "user");
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content.push({ type: "text", text: PUZZLE });
  return b;
};
const vs = { n: 0, prev: null, inserts: [] };
async function effortVerify(req, raw, headers, parsed, facts, view) {
  const cur = parsed.output_config?.effort ?? null;
  const f = { ...facts, client_effort: cur };
  if (verifyParts.has("binding-set")) return bindingSet(req, raw, headers, parsed, f, view);
  if (view.turn !== "continuation") {
    if (vs.prev) return { body: raw, headers, note: "main-new passthrough (effort-verify, later)" };
    vs.prev = raw;
    for (const [label, make] of [["opus-5", () => variantBody(parsed, (b) => { b.model = "claude-opus-5"; })], ["fable-5.1", () => { const r = rt(raw, "fable"); return r.ok ? r.body : null; }], ["sonnet-5.5", () => { const r = rt(raw, "sonnet"); return r.ok ? r.body : null; }]]) {
      if (!verifyParts.has(label)) continue;
      const base = make();
      if (!base) continue;
      const pb = JSON.parse(base.toString("utf8"));
      await probe(`${label}: first request (cache write)`, req.url, headers, base, ["model"], f, { keepHeaders: true });
      await probe(`${label}: + effort message low (accepted? cache kept?)`, req.url, headers, variantBody(pb, (b) => { b.messages.push(effortMsg("low")); b.output_config = { ...b.output_config, effort: "low" }; }), ["model", "messages.effort_added"], f, { keepHeaders: true });
      await probe(`${label}: + effort message low, top-level unchanged (cache kept?)`, req.url, headers, variantBody(pb, (b) => { b.messages.push(effortMsg("low")); }), ["model", "messages.effort_added"], f, { keepHeaders: true });
      if (label === "sonnet-5.5") await probe(`${label}: top-level low only, no message (cache kept?)`, req.url, headers, variantBody(pb, (b) => { b.output_config = { ...b.output_config, effort: "low" }; }), ["model", "output_config.effort"], f, { keepHeaders: true });
      const topOnly = label === "sonnet-5.5" ? [["top-level only low", (b) => { b.output_config = { ...b.output_config, effort: "low" }; }], ["top-level only max", (b) => { b.output_config = { ...b.output_config, effort: "max" }; }]] : [];
      for (const [v, mut] of [[`client effort (${pb.output_config?.effort})`, () => {}], ["message only low", (b) => { b.messages.push(effortMsg("low")); }], ["message only max", (b) => { b.messages.push(effortMsg("max")); }], ...topOnly]) {
        await probe(`${label}: puzzle, ${v}`, req.url, headers, variantBody(pb, (b) => { b.max_tokens = EFFORT_APPLY_MAX_TOKENS; withPuzzle(b); mut(b); }), ["model", "puzzle"], f, { keepHeaders: true, full: true });
      }
    }
    const s = rt(raw, "sonnet");
    if (s.ok && verifyParts.has("sonnet")) {
      const sb = JSON.parse(s.body.toString("utf8"));
      for (const [v, e] of [[`client effort (${sb.output_config?.effort})`, null], ["top-level low", "low"], ["top-level max", "max"]]) {
        await probe(`sonnet: puzzle, ${v}`, req.url, headers, variantBody(sb, (b) => { b.max_tokens = EFFORT_APPLY_MAX_TOKENS; withPuzzle(b); if (e) b.output_config = { ...b.output_config, effort: e }; }), [...s.fields, "puzzle"], f, { full: true });
      }
    }
    return { body: raw, headers, note: "main-new passthrough (effort-verify)", facts: f };
  }
  vs.n++;
  if (!verifyParts.has("binding")) return { body: raw, headers, note: "passthrough (binding part off)" };
  if (vs.n === 1) {
    const added = structuredClone(parsed); added.messages.push(effortMsg("low")); added.output_config = { ...added.output_config, effort: "low" };
    const e = onTierBound(headers, structuredClone(added), "error");
    await probe("binding error: effort message added at the end", req.url, e.headers, e.body, ["messages.effort_added", "block_binding"], f, { keepHeaders: true });
    vs.inserts.push({ index: parsed.messages.length, effort: "low" });
  } else if (vs.n === 2) {
    const re = onTierBound(headers, withInsertsOf(parsed, vs.inserts), "error");
    await probe("binding error: effort message re-inserted (what reflex sends)", req.url, re.headers, re.body, ["messages.effort_reinserted", "block_binding"], f, { keepHeaders: true });
    const fe = onTierBound(headers, structuredClone(parsed), "error");
    await probe("binding error: effort message forgotten (continued without reflex)", req.url, fe.headers, fe.body, ["block_binding"], f, { keepHeaders: true });
    const fd = onTierBound(headers, structuredClone(parsed), "drop_block");
    await probe("binding drop_block: effort message forgotten", req.url, fd.headers, fd.body, ["block_binding"], f, { keepHeaders: true });
    // Positive control: a real edit before the thinking block (one character added to the first tool result). If the
    // check is on, this must be a 400; if it is not, "forgotten" above proves nothing.
    const edited = structuredClone(parsed);
    const tr = edited.messages.find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
    const block = tr?.content.find((c) => c.type === "tool_result");
    if (block) {
      if (typeof block.content === "string") block.content += " ";
      else if (Array.isArray(block.content)) { const t = block.content.find((c) => c.type === "text"); if (t) t.text += " "; }
      const pe = onTierBound(headers, withInsertsOf(edited, vs.inserts), "error");
      await probe("binding error: POSITIVE CONTROL, first tool result edited (effort message kept)", req.url, pe.headers, pe.body, ["tool_result edited", "block_binding"], f, { keepHeaders: true });
      const pd = onTierBound(headers, withInsertsOf(edited, vs.inserts), "drop_block");
      await probe("binding drop_block: POSITIVE CONTROL, first tool result edited", req.url, pd.headers, pd.body, ["tool_result edited", "block_binding"], f, { keepHeaders: true });
    }
    const fn = structuredClone(parsed);
    await probe("no binding controls: effort message forgotten (this account's default)", req.url, headers, onTier(fn), [], f, { keepHeaders: true });
  }
  return { body: onTier(withInsertsOf(parsed, vs.inserts)), headers, note: `main effort-verify #${vs.n}`, fields: ["messages.+effort"], facts: { ...f, history_thinking_blocks: facts.history_thinking_blocks } };
}
/**
 * Part `binding-set`: the first request's own trailing system message gets the new level (what src/wire/effort.ts does
 * as op "set"), the model thinks after it, and at the next request the check is run with it re-applied and forgotten.
 */
const bs = { index: null, n: 0, probed: false };
const setLevel = (b) => { const m = b.messages[bs.index]; m.output_config = { ...m.output_config, effort: "low" }; if (!bindingTier) b.output_config = { ...b.output_config, effort: "low" }; return b; };
/** The live body on --binding-tier (the product's retarget), else as is. */
const onTier = (obj) => { const buf = Buffer.from(JSON.stringify(obj)); if (!bindingTier) return buf; const r = rt(buf, bindingTier); if (!r.ok) throw new Error(`retarget: ${r.reason}`); return r.body; };
const onTierBound = (headers, obj, behavior) => { const b = JSON.parse(onTier(obj).toString("utf8")); return bound(headers, b, behavior); };
async function bindingSet(req, raw, headers, parsed, f, view) {
  if (view.turn !== "continuation") {
    if (bs.index !== null) return { body: raw, headers, note: "passthrough (binding-set, later new turn)" };
    const last = parsed.messages.length - 1;
    if (parsed.messages[last]?.role !== "system" || !parsed.messages[last].output_config) return { body: raw, headers, note: "passthrough (binding-set: no effort-bearing trailing system message)" };
    bs.index = last;
    return { body: onTier(setLevel(structuredClone(parsed))), headers, note: `main binding-set: first request, level set in place${bindingTier ? ` (on ${bindingTier})` : ""}`, fields: ["messages.effort_set"], facts: f };
  }
  if (bs.index === null) return { body: raw, headers, note: "passthrough" };
  bs.n++;
  // At the first continuation whose history holds a thinking block made after the level was set (none: nothing to check).
  if (!bs.probed && f.history_thinking_blocks > 0) {
    bs.probed = true;
    const re = onTierBound(headers, setLevel(structuredClone(parsed)), "error");
    await probe("binding-set error: level re-applied in place (what reflex sends)", req.url, re.headers, re.body, ["messages.effort_set", "block_binding"], { ...f, history_thinking_blocks: f.history_thinking_blocks }, { keepHeaders: true });
    const fe = onTierBound(headers, structuredClone(parsed), "error");
    await probe("binding-set error: level forgotten (continued without reflex)", req.url, fe.headers, fe.body, ["block_binding"], f, { keepHeaders: true });
    const fd = onTierBound(headers, structuredClone(parsed), "drop_block");
    await probe("binding-set drop_block: level forgotten", req.url, fd.headers, fd.body, ["block_binding"], f, { keepHeaders: true });
    // Positive control: the last tool result (before the newest thinking block) edited, level kept. With the check on this is a 400.
    const edited = setLevel(structuredClone(parsed));
    const tr = [...edited.messages].reverse().find((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
    const trs = edited.messages.filter((m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "tool_result"));
    const block = (trs.at(-2) ?? tr)?.content.find((c) => c.type === "tool_result");
    if (block) {
      if (typeof block.content === "string") block.content += " ";
      else if (Array.isArray(block.content)) { const t = block.content.find((c) => c.type === "text"); if (t) t.text += " "; }
      const pe = onTierBound(headers, edited, "error");
      await probe("binding-set error: POSITIVE CONTROL, a tool result before the thinking block edited", req.url, pe.headers, pe.body, ["tool_result edited", "block_binding"], f, { keepHeaders: true });
    }
  }
  return { body: onTier(setLevel(structuredClone(parsed))), headers, note: `main binding-set #${bs.n}`, fields: ["messages.effort_set"], facts: f };
}

function withInsertsOf(parsed, inserts) {
  const b = structuredClone(parsed);
  for (const ins of inserts) b.messages.splice(ins.index, 0, effortMsg(ins.effort));
  if (inserts.length) b.output_config = { ...b.output_config, effort: inserts.at(-1).effort };
  return b;
}

let applyDone = false;
async function effortApply(req, headers, parsed, facts, view) {
  if (applyDone || view.turn !== "continuation") return;
  applyDone = true;
  const cur = parsed.output_config?.effort ?? null;
  const f = { ...facts, client_effort: cur, puzzle: true, max_tokens: EFFORT_APPLY_MAX_TOKENS };
  const base = structuredClone(parsed);
  base.max_tokens = EFFORT_APPLY_MAX_TOKENS;
  const last = [...base.messages].reverse().find((m) => m.role === "user");
  if (typeof last.content === "string") last.content = [{ type: "text", text: last.content }];
  last.content.push({ type: "text", text: PUZZLE });
  const variants = [
    [`client effort (${cur})`, () => {}],
    ["top-level low", (b) => { b.output_config = { ...b.output_config, effort: "low" }; }],
    ["top-level max", (b) => { b.output_config = { ...b.output_config, effort: "max" }; }],
    ["message + top-level low", (b) => { b.messages.push(effortMsg("low")); b.output_config = { ...b.output_config, effort: "low" }; }],
    ["message + top-level max", (b) => { b.messages.push(effortMsg("max")); b.output_config = { ...b.output_config, effort: "max" }; }],
  ];
  for (let i = 1; i <= APPLY_REPEATS; i++) for (const [label, mutate] of variants) await probe(`apply:${label} #${i}`, req.url, headers, variantBody(base, mutate), ["puzzle", "max_tokens"], f, { keepHeaders: true, full: true });
}

async function route(req, rawIn, headers) {
  let raw = rawIn;
  if (sourceModel) {
    try { const b = JSON.parse(rawIn.toString("utf8")); if (String(b.model).includes(from)) { b.model = sourceModel; raw = Buffer.from(JSON.stringify(b)); } } catch { /* not json */ }
  }
  const view = (() => { const r = parseRequest(req.headers, raw); return r.ok ? r.view : null; })();
  if (!view || !String(view.requestedModel).includes(from) || view.toolCount === 0) return { body: raw, headers, note: "passthrough" };
  const parsed = JSON.parse(raw.toString("utf8"));
  const facts = shapeFacts(parsed, headers);
  seen.requested_models.add(view.requestedModel);
  seen.entrypoints.add(view.entrypoint);
  for (const b of facts.betas) seen.betas.add(b);
  if (probeEffortVerify) return view.kind === "main" ? effortVerify(req, raw, headers, parsed, facts, view) : { body: raw, headers, note: "passthrough" };
  if (probeEffortApply) { if (view.kind === "main") await effortApply(req, headers, parsed, facts, view); return { body: raw, headers, note: "passthrough" }; }
  if (probeEffortSwitch) return view.kind === "main" ? effortSwitch(req, raw, headers, parsed, facts, view) : { body: raw, headers, note: "passthrough" };

  if (view.kind === "main" && view.turn === "new" && !state.mainNewProbed && !noMainNew) {
    state.mainNewProbed = true;
    for (const t of TARGETS) {
      const r = rt(raw, t);
      if (r.ok) await probe(`main-new:${t}`, req.url, headers, r.body, r.fields, facts);
      if (r.ok && probeMessageOc) {
        // The product drops a system message's output_config for this target; send it kept, to show whether it must go.
        const orig = JSON.parse(raw.toString("utf8"));
        const b = JSON.parse(r.body.toString("utf8"));
        let kept = 0;
        b.messages.forEach((m, i) => { const o = orig.messages[i]; if (m.role === "system" && o?.role === "system" && "output_config" in o && !("output_config" in m)) { m.output_config = o.output_config; kept++; } });
        if (kept > 0) await probe(`main-new:${t}:message-output_config kept (${kept})`, req.url, headers, Buffer.from(JSON.stringify(b)), r.fields.filter((f) => !f.startsWith("messages.output_config_dropped")), facts);
      }
      if (r.ok && productHeaders(headers, r.body).stripped.length > 0) await probe(`main-new:${t}:betas untouched`, req.url, headers, r.body, r.fields, facts, { keepHeaders: true });
      if (r.ok && probeEfforts && t !== "haiku") {
        for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
          const b = JSON.parse(r.body.toString("utf8"));
          b.output_config = { ...b.output_config, effort };
          await probe(`main-new:${t}:effort=${effort}`, req.url, headers, Buffer.from(JSON.stringify(b)), [...r.fields, `output_config.effort=${effort}`], { ...facts, effort });
        }
      }
      const beta = String(headers["anthropic-beta"] ?? "");
      if (r.ok && probe1m && !beta.includes("context-1m-")) {
        await probe(`main-new:${t}:+context-1m beta`, req.url, { ...headers, "anthropic-beta": `${beta},context-1m-2025-08-07` }, r.body, r.fields, { ...facts, betas: [...facts.betas, "context-1m-2025-08-07"] });
      }
    }
    if (probeCeiling) await ceilingProbes(req, raw, headers, facts);
    return { body: raw, headers, note: "main-new passthrough" };
  }

  if (view.kind === "subagent" && view.agentId) {
    let target = state.subTarget.get(view.agentId);
    if (target === undefined && delayPin && !state.subDelayed.has(view.agentId)) {
      state.subDelayed.add(view.agentId);
      for (const t of TARGETS) {
        const r = rt(raw, t);
        if (r.ok) await probe(`subagent-first-no-history:${t}`, req.url, headers, r.body, r.fields, facts);
      }
      return { body: raw, headers, note: "subagent-first passthrough (delay-pin)", facts };
    }
    if (target === undefined) {
      // Probe every target on the first request; pin this subagent to the next target in turn.
      for (const t of TARGETS) {
        const r = rt(raw, t);
        if (r.ok) await probe(`subagent-first:${t}`, req.url, headers, r.body, r.fields, facts);
      }
      target = TARGETS[Math.min(state.subCount++, TARGETS.length - 1)];
      state.subTarget.set(view.agentId, target);
      const r = rt(raw, target);
      return r.ok ? { body: r.body, headers, note: `subagent-first routed:${target}`, fields: r.fields, facts } : { body: raw, headers, note: `rewrite_failed:${r.reason}` };
    }
    if (!state.subUnpinProbed.has(view.agentId)) {
      // The retry-with-original / pin release case for a subagent: its original bytes, now with target-made turns.
      state.subUnpinProbed.add(view.agentId);
      await probe(`subagent-unpin-to-${from} (original bytes, ${target}-made turns in history)`, req.url, headers, raw, [], facts);
    }
    const r = rt(raw, target);
    return r.ok ? { body: r.body, headers, note: `subagent-pinned:${target}`, fields: r.fields, facts } : { body: raw, headers, note: `rewrite_failed:${r.reason}` };
  }

  if (view.kind === "main" && view.turn === "continuation") {
    if (state.mainPinned === null && facts.history_thinking_blocks > 0) {
      for (const t of TARGETS) {
        const keep = rt(raw, t);
        if (keep.ok) await probe(`main-cont1:${t}:keep-history-thinking`, req.url, headers, keep.body, keep.fields, facts);
        if (lean) continue;
        const drop = rt(raw, t, { dropHistoryThinking: true });
        if (drop.ok) await probe(`main-cont1:${t}:drop-history-thinking`, req.url, headers, drop.body, drop.fields, facts);
        const noDisplay = rt(variantBody(parsed, (b) => { if (b.thinking) delete b.thinking.display; }), t);
        if (noDisplay.ok) await probe(`main-cont1:${t}:no-display (interactive shape)`, req.url, headers, noDisplay.body, noDisplay.fields, { ...facts, thinking: { type: parsed.thinking?.type } });
        if (keep.ok) await probe(`main-cont1:${t}:+redact-thinking beta (interactive header)`, req.url, { ...headers, "anthropic-beta": `${headers["anthropic-beta"]},redact-thinking-2026-02-12` }, keep.body, keep.fields, facts);
      }
      const chosen = rt(raw, MAIN_TARGET);
      if (!chosen.ok) return { body: raw, headers, note: "main not routed" };
      state.mainPinned = MAIN_TARGET;
      return { body: chosen.body, headers, note: `main-cont1 routed:${MAIN_TARGET}`, fields: chosen.fields, facts };
    }
    if (state.mainPinned !== null) {
      if (!state.unpinProbed) {
        state.unpinProbed = true;
        await probe(`unpin-to-${from} (original bytes, ${state.mainPinned}-made turns in history)`, req.url, headers, raw, [], facts);
        // A pinned loop whose tier is later changed (another target, e.g. after a tier is disabled mid-loop).
        for (const t of TARGETS.filter((x) => x !== state.mainPinned)) {
          const r = rt(raw, t);
          if (r.ok) await probe(`cross-target:${t} (history made by ${from} and ${state.mainPinned})`, req.url, headers, r.body, r.fields, facts);
        }
      }
      const r = rt(raw, state.mainPinned);
      if (!r.ok) return { body: raw, headers, note: `rewrite_failed:${r.reason}` };
      return { body: r.body, headers, note: `main-pinned:${state.mainPinned}`, fields: r.fields, facts };
    }
  }
  return { body: raw, headers, note: "passthrough" };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SKIP.has(k)) headers[k] = v;
    let plan = { body: raw, headers, note: "passthrough" };
    if (req.method === "POST" && req.url.startsWith("/v1/messages") && !req.url.includes("count_tokens")) {
      try { plan = await route(req, raw, headers); } catch (e) { log(`route error ${e.message}; passthrough`); }
    }
    if (plan.note !== "passthrough") { const ph = productHeaders(plan.headers, plan.body); plan = { ...plan, headers: ph.headers, fields: [...(plan.fields ?? []), ...ph.stripped.map((x) => `anthropic-beta:-${x}`)] }; }
    const pre = req.url.startsWith("/v1/messages") ? preUsd(plan.body) : 0;
    if (spent + pre > capUsd) {
      refused++;
      forwarded.push({ note: plan.note, refused: "cap reached", pre_usd: Number(pre.toFixed(4)) });
      log(`REFUSED ${plan.note} (cap: spent ~$${spent.toFixed(3)}, this request ~$${pre.toFixed(3)})`);
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: `experiment cap $${capUsd} reached; not forwarded` } }));
      return;
    }
    spent += pre;
    const up = https.request({ hostname: upstream.hostname, method: req.method, path: req.url, headers: { ...plan.headers, host: upstream.host, ...(plan.body.length ? { "content-length": String(plan.body.length) } : {}), "accept-encoding": "identity" } }, (ur) => {
      const oh = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!SKIP.has(k)) oh[k] = v;
      res.writeHead(ur.statusCode, oh);
      let text = "";
      ur.on("data", (c) => { text += c.toString("utf8"); res.write(c); });
      ur.on("end", () => {
        res.end();
        if (!req.url.startsWith("/v1/messages")) return;
        let usage = null;
        let stop = null;
        for (const m of text.matchAll(/data: (\{"type":"message_(?:start|delta)".*)\n/g)) { try { const o = JSON.parse(m[1]); usage = { ...usage, ...(o.message?.usage ?? o.usage) }; if (o.delta?.stop_reason) stop = { reason: o.delta.stop_reason, category: o.delta.stop_details?.category ?? null }; } catch { /* partial */ } }
        const streamError = /event: error\ndata: (.*)\n/.exec(text)?.[1]?.slice(0, 200) ?? null;
        let model = null; try { model = JSON.parse(plan.body.toString("utf8")).model ?? null; } catch { /* not json */ }
        let error = null; if (ur.statusCode >= 400) { try { error = JSON.parse(text).error.message; } catch { error = text.slice(0, 200); } }
        const usd = costUsd(model, usage);
        spent += usd - pre;
        forwarded.push({ note: plan.note, model, status: ur.statusCode, error, stop, stream_error: streamError, fields: plan.fields ?? [], facts: plan.facts ?? null, usage, est_usd: Number(usd.toFixed(5)) });
        log(`forward ${ur.statusCode} ${plan.note} -> ${model}${error ? " :: " + error : ""}${stop ? ` [${stop.reason}${stop.category ? "/" + stop.category : ""}]` : ""}${streamError ? " STREAM ERROR " + streamError : ""}  (spent ~$${spent.toFixed(3)})`);
      });
    });
    up.on("error", (e) => { if (!res.headersSent) res.writeHead(502); res.end(String(e.message)); });
    up.end(plan.body);
  });
});

server.listen(0, "127.0.0.1", () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) { if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue; env[k] = v; }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  let child;
  if (interactiveExitS === null) child = spawn("claude", claudeArgs, { cwd, stdio: ["ignore", "ignore", "inherit"], env });
  else {
    // The TUI: Enter at 5 s accepts a folder-trust dialog if one is shown (a no-op on an empty prompt otherwise).
    const i = claudeArgs.indexOf("-p");
    const prompt = claudeArgs[i + 1];
    const rest = claudeArgs.filter((_, k) => k !== i && k !== i + 1);
    const keys = [...(newFolder ? ["4", "\\x1b[B"] : []), "5", "\\r", "10", prompt, "12", "\\r", String(interactiveExitS), "/exit", String(interactiveExitS + 3), "\\r"];
    child = spawn("python3", [join(import.meta.dirname, "pty-run.py"), ...keys, "--", "claude", ...rest], { cwd, stdio: ["ignore", "ignore", "inherit"], env });
  }
  child.on("exit", (code) => {
    server.close();
    let modelSetting = null;
    try { modelSetting = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).model ?? null; } catch { /* none */ }
    const settings = { model_setting: modelSetting, target_models: MODELS, claude_args: claudeArgs.map((a, i) => (claudeArgs[i - 1] === "-p" ? "<prompt>" : a)), requested_models: [...seen.requested_models], entrypoints: [...seen.entrypoints], betas_seen: [...seen.betas].sort() };
    writeFileSync(join(out, "results.json"), JSON.stringify({ from, targets: TARGETS, settings, cap_usd: capUsd, est_total_usd: Number(spent.toFixed(4)), refused_for_cap: refused, claude_exit: code, probes, forwarded }, null, 1));
    log(`claude exited ${code}; estimated spend $${spent.toFixed(3)}; results in ${out}/results.json`);
    process.exit(0);
  });
});
