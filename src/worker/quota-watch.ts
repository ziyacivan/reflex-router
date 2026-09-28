// The subscription quota for `reflex statusline`: the latest used share of each window the responses reported
// (src/wire/ratelimit.ts) and, at the rate it has been climbing, when it would run out. Worker-global, not per session:
// the quota is the account's, so every session's requests (and usage outside reflex) move the same number. Numbers
// only, in memory only; a worker restart forgets the climb and the projection waits for new steps.
import type { Quota } from "../wire/ratelimit.js";

export interface QuotaWindowStatus {
  readonly name: string;
  /** Whole percent used. */
  readonly pct: number;
  readonly status: string | null;
  /** Seconds until the window resets; null when not reported. */
  readonly resetInS: number | null;
  /** Seconds until 100% at the recent rate; null when the climb is too short to tell or the window resets first. */
  readonly limitInS: number | null;
}

/** How far back the rate looks: long enough for a few 1% steps, short enough to be the current pace. */
const LOOKBACK_MS: Readonly<Record<string, number>> = { "5h": 60 * 60_000 };
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;
/** A projection needs the share to have risen at least this much within the lookback (utilisation comes in 1% steps). */
const MIN_RISE = 0.02;

interface Win {
  util: number;
  reset: number | null;
  status: string | null;
  atMs: number;
  /** When each higher value was first reported, oldest first. The first value seen is not one: it may be hours old. */
  steps: { atMs: number; util: number }[];
}

export class QuotaWatch {
  readonly #w = new Map<string, Win>();

  observe(q: Quota, atMs: number): void {
    for (const [name, x] of Object.entries(q)) {
      const prev = this.#w.get(name);
      if (prev === undefined || x.reset !== prev.reset) {
        this.#w.set(name, { util: x.util, reset: x.reset, status: x.status, atMs, steps: [] }); // a new window
        continue;
      }
      if (atMs < prev.atMs) continue;
      prev.status = x.status;
      prev.atMs = atMs;
      // Concurrent requests can report the previous value after a newer one: a fall within a window is noise.
      if (x.util <= prev.util) continue;
      prev.util = x.util;
      const keep = atMs - (LOOKBACK_MS[name] ?? DEFAULT_LOOKBACK_MS);
      prev.steps = [...prev.steps.filter((s) => s.atMs >= keep), { atMs, util: x.util }];
    }
  }

  /** `5h` first, then `7d`, then any other window; windows whose reset has passed are gone (their value is stale). */
  get(now = Date.now()): QuotaWindowStatus[] {
    const order = (n: string): number => (n === "5h" ? 0 : n === "7d" ? 1 : 2);
    return [...this.#w.entries()]
      .filter(([, w]) => w.reset === null || w.reset * 1000 > now)
      .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
      .map(([name, w]) => {
        const resetInS = w.reset === null ? null : Math.floor(w.reset - now / 1000);
        return { name, pct: Math.round(w.util * 100), status: w.status, resetInS, limitInS: projection(name, w, now, resetInS) };
      });
  }
}

/** Seconds to 100% at the rate since the oldest step in the lookback (idle time since the last step slows it). */
function projection(name: string, w: Win, now: number, resetInS: number | null): number | null {
  const first = w.steps.find((s) => s.atMs >= now - (LOOKBACK_MS[name] ?? DEFAULT_LOOKBACK_MS));
  if (first === undefined || w.util >= 1 || w.util - first.util < MIN_RISE - 1e-9 || now <= first.atMs) return null;
  const perS = (w.util - first.util) / ((now - first.atMs) / 1000);
  const s = Math.round((1 - w.util) / perS);
  return resetInS !== null && s >= resetInS ? null : s;
}
