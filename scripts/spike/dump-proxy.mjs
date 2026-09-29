#!/usr/bin/env node
// Spike (not product code): a loopback pass-through to https://api.anthropic.com that writes each POST /v1/messages
// request body (never headers) to DIR/NNN.json. Put it BEHIND reflex to see exactly what reflex sent (Claude Code's
// tool search stays on, unlike scripts/spike/capture.mjs, which sits in front of claude):
//   node scripts/spike/dump-proxy.mjs _dumps/<name> [port=47200]
//   REFLEX_UPSTREAM_URL=http://127.0.0.1:47200 reflex ...
// Bodies hold prompts: keep DIR under _dumps/ (gitignored).
import http from "node:http"; import https from "node:https"; import fs from "node:fs";
const out = process.argv[2]; fs.mkdirSync(out, { recursive: true, mode: 0o700 }); let n = 0;
const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "content-length"]);
http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks);
    const dump = req.method === "POST" && req.url.startsWith("/v1/messages") ? `${out}/${String(++n).padStart(3, "0")}` : null;
    if (dump) fs.writeFileSync(`${dump}.json`, body, { mode: 0o600 });
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP.has(k)));
    const up = https.request({ host: "api.anthropic.com", path: req.url, method: req.method, headers: { ...headers, "content-length": body.length } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      let text = "";
      r.on("data", (c) => { text += c.toString("utf8"); res.write(c); });
      r.on("end", () => {
        res.end();
        if (!dump) return;
        // Structure only: the beta header and the stop reason, never auth headers or the answer.
        const stop = /"stop_reason":"([a-z_]+)"(?:,"stop_sequence":[^,]*)?(?:,"stop_details":(\{[^}]*\}))?/.exec(text);
        fs.writeFileSync(`${dump}.meta.json`, JSON.stringify({ url: req.url, status: r.statusCode, beta: req.headers["anthropic-beta"] ?? null, stop_reason: stop?.[1] ?? null, stop_details: stop?.[2] ? JSON.parse(stop[2]) : null }), { mode: 0o600 });
      });
    });
    up.on("error", () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); }); up.end(body);
  });
}).listen(Number(process.argv[3] ?? 47200), "127.0.0.1", () => console.log("up"));
