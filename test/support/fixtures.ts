// Loads the labelled request fixtures (test/fixtures/claude-code/<version>/manifest.json entries with `expect`).
import assert from "node:assert/strict";
import fs from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { parseRequest, type RequestView } from "../../src/wire/claude-code.js";

const ROOT = path.join("test", "fixtures", "claude-code");

export interface Expect {
  readonly kind?: string;
  readonly signal?: string;
  readonly turn?: string;
  readonly side_kind?: string;
  /** Only on `side_kind: "unclassified"`: which shape test produced the residual. */
  readonly unclassified_reason?: string;
  readonly passthrough?: boolean;
  /** `false`: a new turn the router must not decide (a subagent whose model the Agent call chose: `model_explicit`). */
  readonly decided?: boolean;
}
interface ManifestFile {
  readonly file: string;
  readonly expect?: Expect;
}
export interface Fixture {
  readonly version: string;
  readonly file: string;
  readonly expect: Expect;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const version of fs.readdirSync(ROOT).filter((d) => /^\d+\.\d+\.\d+$/.test(d))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, version, "manifest.json"), "utf8")) as { files: ManifestFile[] };
    for (const f of manifest.files) {
      if (!f.expect || !f.file.endsWith(".request.json")) continue;
      const raw = JSON.parse(fs.readFileSync(path.join(ROOT, version, f.file), "utf8")) as { headers: IncomingHttpHeaders; body: unknown };
      out.push({ version, file: f.file, expect: f.expect, headers: raw.headers, body: Buffer.from(JSON.stringify(raw.body)) });
    }
  }
  return out;
}

export const viewOf = (fx: Fixture): RequestView => {
  const r = parseRequest(fx.headers, fx.body);
  assert.ok(r.ok, `${fx.file} did not parse`);
  return r.view;
};
