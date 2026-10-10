#!/usr/bin/env node
// Milestone 0 spike — NOT product code. Throwaway tooling for observing what Claude Code
// actually sends. Dump-only passthrough proxy + hook receiver + `claude` launcher.
//
//   node scripts/spike/capture.mjs [--out DIR] [--no-hooks] [--cap-usd N] [--] <claude args...>
//
// Guarantees:
//   * request/response bytes are forwarded untouched (except accept-encoding is dropped so the
//     response is readable identity-encoded; the real proxy will not do this)
//   * credential headers (authorization, x-api-key, cookie, ...) are never written to disk
//   * raw dumps contain prompts and identifiers; they live under _dumps/ (gitignored) and are
//     turned into redacted fixtures by redact-fixtures.mjs
//   * without REFLEX_CLAUDE_BIN, a `claude` on PATH that is a script (a wrapper that may start reflex) is refused
//   * --cap-usd refuses to FORWARD a request once the running list-price total would cross the cap, and logs the
//     refusal to cap-refusals.jsonl. A cap polled from outside cannot hold against a parallel fan-out.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, accessSync, statSync, openSync, readSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
// The product's own list prices, so a cap here means the same thing a cap in a report does. Imported as .ts: needs
// Node's type stripping (>= 22.18) or `node --import tsx`.
import { usageCostUsd } from "../../src/pricing.ts";
import { estimateTokens } from "../../src/tiers.ts";

const argv = process.argv.slice(2);
let out = join("_dumps", new Date().toISOString().replace(/[:.]/g, "-"));
let hooks = true;
let capUsd = Infinity;
const claudeArgs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--out") out = argv[++i];
  else if (a === "--no-hooks") hooks = false;
  else if (a === "--cap-usd") capUsd = Number(argv[++i]);
  else if (a === "--") { claudeArgs.push(...argv.slice(i + 1)); break; }
  else claudeArgs.push(a);
}

// A `claude` on PATH may be a wrapper that starts reflex (a shim, or another app's wrapper in front of one): the dumps
// would then hold reflex-rewritten requests, and the session would ask the decision backend and land in
// ~/.reflex/decisions.jsonl (2026-10-10: model setting `opus`, dumps showed `claude-haiku-5-5`). Without an explicit
// REFLEX_CLAUDE_BIN, refuse a `claude` that is a script; the real Claude Code is a native binary.
if (process.env.REFLEX_CLAUDE_BIN === undefined && process.platform !== "win32") {
  const first = (process.env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, "claude")).find((f) => {
    try { accessSync(f, constants.X_OK); return statSync(f).isFile(); } catch { return false; }
  });
  if (first === undefined) {
    process.stderr.write("[spike] no `claude` on PATH; set REFLEX_CLAUDE_BIN to the Claude Code binary\n");
    process.exit(2);
  }
  const fd = openSync(first, "r");
  const head = Buffer.alloc(2);
  readSync(fd, head, 0, 2, 0);
  closeSync(fd);
  if (head.toString("latin1") === "#!") {
    process.stderr.write(
      `[spike] refusing: \`claude\` on PATH is a script (${first}), which may start reflex or another proxy in front of ` +
        "Claude Code. Set REFLEX_CLAUDE_BIN to the real binary, e.g. REFLEX_CLAUDE_BIN=$HOME/.local/bin/claude\n",
    );
    process.exit(2);
  }
}
mkdirSync(out, { recursive: true, mode: 0o700 });

const upstream = new URL(process.env.REFLEX_SPIKE_UPSTREAM ?? "https://api.anthropic.com");
const SECRET_HEADERS = new Set(["authorization", "x-api-key", "cookie", "proxy-authorization", "set-cookie"]);
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"]);
let seq = 0;

const scrubHeaders = (h) => {
  const o = {};
  for (const [k, v] of Object.entries(h)) o[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[omitted]" : v;
  return o;
};
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };
const slug = (p) => p.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "root";

// ---- spend cap --------------------------------------------------------------------------------
// A cap checked by polling the dump cannot hold against a parallel fan-out: four workflow workers each write their
// whole context at once, and a sampling monitor is always one interval behind them (docs/observations.md,
// 2026-09-19, measured at ~$2.10 committed inside one 18-second gap). So the cap is enforced HERE, in the only place
// every request passes, and it is checked BEFORE a request is forwarded rather than after it is billed.
const TIER_OF = (m) => (/haiku/.test(m ?? "") ? "haiku" : /sonnet/.test(m ?? "") ? "sonnet" : /fable/.test(m ?? "") ? "fable" : "opus");
let spentUsd = 0;
let refusals = 0;
/** Adds one response's usage to the running total. `ttl` follows the request's cache_control, 1h being the worst case. */
const chargeResponse = (sseText, model) => {
  let u = null, out = 0;
  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let d;
    try { d = JSON.parse(line.slice(6)); } catch { continue; }
    if (d.type === "message_start") { u = d.message?.usage ?? null; model = d.message?.model ?? model; }
    if (d.type === "message_delta" && d.usage?.output_tokens) out = d.usage.output_tokens;
  }
  if (!u) return;
  spentUsd += usageCostUsd(TIER_OF(model), {
    input: u.input_tokens ?? 0, output: out,
    cacheRead: u.cache_read_input_tokens ?? 0, cacheCreate: u.cache_creation_input_tokens ?? 0,
  }, "1h");
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? "/", "http://x");

    if (url.pathname === "/__spike/hook") {
      appendFileSync(join(out, "hooks.jsonl"), JSON.stringify({ t: Date.now(), body: parse(raw.toString("utf8")) }) + "\n");
      res.writeHead(204).end();
      return;
    }

    const n = String(++seq).padStart(3, "0");
    const base = `${n}-${req.method}-${slug(url.pathname)}`;
    const started = Date.now();

    // Pre-charge from the request's own bytes (2.5 bytes/token as measured, not 4, priced as a 1-hour cache write, the worst case) so a
    // burst of parallel requests is counted the moment it is sent, not when it returns. Replaced by the real usage
    // once the response is read. A request that would cross the cap is REFUSED, never forwarded.
    const reqModel = raw.length ? (parse(raw.toString("utf8"))?.model ?? null) : null;
    const preUsd = url.pathname === "/v1/messages"
      ? usageCostUsd(TIER_OF(reqModel), { input: 0, output: 0, cacheRead: 0, cacheCreate: estimateTokens(raw.length) }, "1h")
      : 0;
    if (spentUsd + preUsd > capUsd) {
      refusals++;
      const msg = `spike cap: $${capUsd} reached (spent $${spentUsd.toFixed(4)}, this request ~$${preUsd.toFixed(4)}); not forwarded`;
      appendFileSync(join(out, "cap-refusals.jsonl"), JSON.stringify({ t: started, seq: n, url: req.url, model: reqModel, req_bytes: raw.length, pre_usd: Number(preUsd.toFixed(4)), spent_usd: Number(spentUsd.toFixed(4)), cap_usd: capUsd }) + "\n");
      process.stderr.write(`[spike] REFUSED #${n}: ${msg}\n`);
      res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: msg } }));
      return;
    }
    spentUsd += preUsd;
    writeFileSync(join(out, `${base}.req.json`), JSON.stringify({
      t: started, method: req.method, url: req.url, headers: scrubHeaders(req.headers),
      body_bytes: raw.length, body: raw.length ? parse(raw.toString("utf8")) : null,
    }, null, 1));
    process.stderr.write(`[spike] #${n} ${req.method} ${req.url} (${raw.length}B)\n`);

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
    headers.host = upstream.host;
    if (raw.length) headers["content-length"] = String(raw.length);
    const lib = upstream.protocol === "https:" ? https : http;
    const up = lib.request({
      protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined,
      method: req.method, path: req.url, headers,
    }, (ur) => {
      const rc = [];
      const outHeaders = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) outHeaders[k] = v;
      res.writeHead(ur.statusCode ?? 502, outHeaders);
      ur.on("data", (c) => { rc.push(c); res.write(c); });
      ur.on("end", () => {
        res.end();
        const text = Buffer.concat(rc).toString("utf8");
        spentUsd -= preUsd; // the estimate did its job; charge what was actually billed
        chargeResponse(text, reqModel);
        if (capUsd !== Infinity) process.stderr.write(`[spike] #${n} spent $${spentUsd.toFixed(4)} / $${capUsd}\n`);
        writeFileSync(join(out, `${base}.res.json`), JSON.stringify({
          ms: Date.now() - started, status: ur.statusCode, headers: scrubHeaders(ur.headers),
          body_bytes: text.length, body_head: text.slice(0, 200_000),
        }, null, 1));
      });
    });
    up.on("error", (e) => {
      spentUsd -= preUsd; // nothing was billed
      process.stderr.write(`[spike] upstream error: ${e.message}\n`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { message: `spike proxy: ${e.message}` } }));
    });
    if (raw.length) up.write(raw);
    up.end();
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // We may be running inside a Claude Code session: drop its markers so the child starts clean.
    if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") continue;
    env[k] = v;
  }
  env.ANTHROPIC_BASE_URL = base;

  const args = [...claudeArgs];
  if (hooks) {
    const hookEntry = (matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "http", url: `${base}/__spike/hook`, timeout: 5 }] });
    const settings = {
      env: { ANTHROPIC_BASE_URL: base },
      hooks: {
        SessionStart: [hookEntry()], UserPromptSubmit: [hookEntry()],
        PreToolUse: [hookEntry("*")], PostToolUse: [hookEntry("*")], PostToolUseFailure: [hookEntry("*")],
        SubagentStart: [hookEntry()], SubagentStop: [hookEntry()], Stop: [hookEntry()],
      },
    };
    const f = join(out, "spike-settings.json");
    writeFileSync(f, JSON.stringify(settings, null, 1));
    args.unshift("--settings", f);
  }
  writeFileSync(join(out, "meta.json"), JSON.stringify({ started: new Date().toISOString(), claudeArgs: args, upstream: upstream.href }, null, 1));
  process.stderr.write(`[spike] proxy ${base} -> ${upstream.href}; dumping to ${out}\n`);

  const child = spawn(process.env.REFLEX_CLAUDE_BIN ?? "claude", args, { stdio: "inherit", env });
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => child.kill(s));
  child.on("exit", (code, signal) => {
    server.close();
    process.stderr.write(`[spike] claude exited code=${code} signal=${signal}; ${seq} requests captured in ${out}; spent ~$${spentUsd.toFixed(4)}${capUsd === Infinity ? "" : ` of $${capUsd} cap, ${refusals} refused`}\n`);
    process.exit(signal ? 1 : (code ?? 0));
  });
  child.on("error", (e) => { process.stderr.write(`[spike] cannot start claude: ${e.message}\n`); process.exit(1); });
});
