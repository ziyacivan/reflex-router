#!/usr/bin/env node
// A stand-in for `claude` used by launcher tests. Behaviour is driven by env vars so tests never touch the real CLI.
//   FAKE_CLAUDE_REPORT   file the report JSON is written to (at start, and again when the action finishes)
//   FAKE_CLAUDE_VERSION  text printed for `--version` (default "2.1.277 (Claude Code)")
//   FAKE_CLAUDE_HANG_VERSION=1   never answer `--version`
//   FAKE_CLAUDE_ACTION   exit:N | sleep:MS | request | wait | die:SIGKILL     (default exit:0)
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  if (process.env.FAKE_CLAUDE_HANG_VERSION) setInterval(() => undefined, 1000);
  else {
    console.log(process.env.FAKE_CLAUDE_VERSION ?? "2.1.277 (Claude Code)");
    process.exit(0);
  }
} else {
  const report = {
    argv,
    cwd: process.cwd(),
    baseUrl: process.env.ANTHROPIC_BASE_URL ?? null,
    hasTypesafeKey: Object.keys(process.env).some((k) => k.startsWith("TYPESAFE_")),
    hasTypellmKey: Object.keys(process.env).some((k) => k.startsWith("TYPELLM_")),
    reflexVars: Object.keys(process.env).filter((k) => k.startsWith("REFLEX_")),
    passthroughVars: Object.fromEntries(["ANTHROPIC_API_KEY", "CLAUDE_CODE_TEST_MARKER", "HOME", "ENABLE_TOOL_SEARCH"].map((k) => [k, process.env[k] ?? null])),
    settings: argv.flatMap((a, i) => (a === "--settings" ? [argv[i + 1]] : a.startsWith("--settings=") ? [a.slice(11)] : []))
      .map((v) => { try { return JSON.parse(v.trim().startsWith("{") ? v : readFileSync(v, "utf8")); } catch { return "unreadable"; } }),
    settingsFiles: argv.flatMap((a, i) => (a === "--settings" ? [argv[i + 1]] : [])).filter((v) => !v.trim().startsWith("{")),
    signals: [],
    response: null,
  };
  const save = () => { if (process.env.FAKE_CLAUDE_REPORT) writeFileSync(process.env.FAKE_CLAUDE_REPORT, JSON.stringify(report)); };
  save();

  const action = process.env.FAKE_CLAUDE_ACTION ?? "exit:0";
  if (action.startsWith("exit:")) {
    process.exit(Number(action.slice(5)));
  } else if (action.startsWith("sleep:")) {
    setTimeout(() => process.exit(0), Number(action.slice(6)));
  } else if (action.startsWith("die:")) {
    process.kill(process.pid, action.slice(4));
  } else if (action === "request") {
    const res = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer fake-oauth-token", "x-claude-code-session-id": "s-1" },
      body: JSON.stringify({ hello: "world" }),
    });
    report.response = { status: res.status, body: await res.text() };
    save();
    process.exit(0);
  } else if (action === "wait") {
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => { report.signals.push(sig); save(); if (sig !== "SIGINT") process.exit(7); });
    setInterval(() => undefined, 1000);
  }
}
