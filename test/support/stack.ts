import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../../src/config.js";
import type { InitMessage } from "../../src/ipc.js";
import { startFrontDoor, type FrontDoor, type FrontDoorOptions } from "../../src/launcher/front-door.js";
import { Supervisor, type SpawnWorker, type Timings } from "../../src/launcher/supervisor.js";
import { spawnWorkerProcess } from "../../src/launcher/worker-process.js";
import { forward } from "../../src/net/forward.js";
import { startFakeUpstream, type FakeUpstream } from "./fake-upstream.js";

export const FAST_TIMINGS: Partial<Timings> = {
  probeIntervalMs: 100, probeTimeoutMs: 200, probeMissLimit: 2, backoffInitialMs: 50, backoffMaxMs: 200, crashWindowMs: 60_000, crashLimit: 3, passthroughMs: 500, readyTimeoutMs: 15_000,
};

/**
 * Defaults as loadConfig produces them, plus a fake key and a fresh temp home, except the Haiku model: most route tests
 * were written for Haiku 4.5's full rewrite (budget thinking, folded system messages, a stripped beta), which is still a
 * supported target, so they keep it. The built-in default, Haiku 5.5, is covered where `over.models` leaves it alone
 * (`testConfig(url, { models: DEFAULT_MODELS })`).
 */
export const HAIKU_45 = "claude-haiku-4-5-20251001";
export const testConfig = (upstreamUrl: string, over: Partial<Config> = {}): Config => {
  const loaded = loadConfig({ REFLEX_UPSTREAM_URL: upstreamUrl, REFLEX_MODEL_HAIKU: HAIKU_45 });
  if (!loaded.ok) throw new Error(loaded.errors.join("; "));
  return { ...loaded.config, home: fs.mkdtempSync(path.join(os.tmpdir(), "reflex-home-")), typesafeApiKey: "apikey_test", ...over };
};

export interface Stack {
  readonly upstream: FakeUpstream;
  readonly door: FrontDoor;
  readonly supervisor: Supervisor;
  /** Base URL of the front door, i.e. what ANTHROPIC_BASE_URL points at. */
  readonly url: string;
  /** The configuration the worker runs with (its `home` holds decisions.jsonl). */
  readonly config: Config;
  workerPid(): Promise<number | null>;
  close(): Promise<void>;
}

export interface StackOptions {
  readonly upstreamPath?: string;
  readonly timings?: Partial<Timings>;
  readonly spawnWorker?: SpawnWorker;
  readonly doorOptions?: Partial<FrontDoorOptions>;
  /** Do not start a worker at all (the door must still work). */
  readonly noWorker?: boolean;
  readonly upstream?: FakeUpstream;
  /** Worker configuration overrides (e.g. jevBaseUrl pointing at a fake Jev). */
  readonly config?: Partial<Config>;
  readonly effectiveMode?: InitMessage["effectiveMode"];
}

/** The real front door + supervisor + worker process, in front of a fake upstream. */
export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  const upstream = opts.upstream ?? (await startFakeUpstream());
  const upstreamUrl = upstream.url + (opts.upstreamPath ?? "");
  const config = testConfig(upstreamUrl, opts.config);
  const init: InitMessage = { type: "init", config, effectiveMode: opts.effectiveMode ?? "shadow", degradedReason: null, claudeVersion: "2.1.277" };
  const spawnWorker: SpawnWorker = opts.spawnWorker ?? (() => spawnWorkerProcess({ init, readyTimeoutMs: 15_000, logFile: null, log: () => undefined }));
  const supervisor = new Supervisor({
    spawnWorker: opts.noWorker ? () => Promise.reject(new Error("no worker in this test")) : spawnWorker,
    probe: async (port) => {
      try {
        const res = await forward(new URL(`http://127.0.0.1:${port}`), { method: "GET", url: "/__reflex/health", headers: {}, body: Buffer.alloc(0) }, { connectTimeoutMs: 200 });
        res.resume();
        return res.statusCode === 200;
      } catch {
        return false;
      }
    },
    timings: { ...FAST_TIMINGS, ...(opts.noWorker ? { backoffInitialMs: 60_000, backoffMaxMs: 60_000 } : {}), ...opts.timings },
  });
  await supervisor.start();
  const door = await startFrontDoor({ upstream: new URL(upstreamUrl), workerOrigin: () => supervisor.workerOrigin(), ...opts.doorOptions });
  return {
    upstream,
    door,
    supervisor,
    config,
    url: `http://127.0.0.1:${door.port}`,
    workerPid: async () => {
      const origin = supervisor.workerOrigin();
      if (!origin) return null;
      try {
        const res = await forward(origin, { method: "GET", url: "/__reflex/health", headers: {}, body: Buffer.alloc(0) }, { connectTimeoutMs: 500 });
        const chunks: Buffer[] = [];
        for await (const c of res) chunks.push(c as Buffer);
        return (JSON.parse(Buffer.concat(chunks).toString()) as { pid: number }).pid;
      } catch {
        return null;
      }
    },
    close: async () => {
      await door.close();
      await supervisor.stop();
      if (!opts.upstream) await upstream.close();
    },
  };
}
