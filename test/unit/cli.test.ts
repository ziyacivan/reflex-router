import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { route } from "../../src/cli.js";

describe("route", () => {
  it("forwards everything that is not a reflex subcommand to claude, untouched", () => {
    for (const argv of [[], ["-p", "hello"], ["--model", "sonnet", "fix it"], ["mcp", "list"], ["--version"], ["--help"], ["--resume"], ["Report", "x"]]) {
      assert.deepEqual(route(argv), { kind: "claude", args: argv });
    }
  });
  it("owns doctor, version, report and share only when they are the first argument", () => {
    assert.deepEqual(route(["doctor"]), { kind: "reflex", command: "doctor", args: [] });
    assert.deepEqual(route(["report", "--since", "2h"]), { kind: "reflex", command: "report", args: ["--since", "2h"] });
    assert.deepEqual(route(["share", "--out", "x.jsonl"]), { kind: "reflex", command: "share", args: ["--out", "x.jsonl"] });
    assert.deepEqual(route(["version"]), { kind: "reflex", command: "version", args: [] });
    assert.deepEqual(route(["-p", "doctor"]), { kind: "claude", args: ["-p", "doctor"] });
  });
  it("`reflex --version` is claude's version, not ours", () => {
    assert.equal(route(["--version"]).kind, "claude");
  });
  it("`--` forces forwarding, even of reserved words", () => {
    assert.deepEqual(route(["--", "doctor"]), { kind: "claude", args: ["doctor"] });
    assert.deepEqual(route(["--"]), { kind: "claude", args: [] });
  });
});

describe("exit", () => {
  it("a large output piped to another process arrives whole before reflex exits, with its exit code", async () => {
    const cli = pathToFileURL("src/cli.ts").href;
    const code = `const { exitWhenFlushed } = await import(${JSON.stringify(cli)}); process.stdout.write("x".repeat(200000)); exitWhenFlushed(3);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let bytes = 0;
    child.stdout.on("data", (c: Buffer) => (bytes += c.length));
    const exit = await new Promise<number | null>((resolve) => child.on("close", resolve));
    assert.equal(bytes, 200000, "process.exit right after the write stopped at 65536");
    assert.equal(exit, 3);
  });
});
