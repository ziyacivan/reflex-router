// `reflex statusline`: the `statusLine` command reflex injects into the claude it launches (unless the user has their
// own). Claude Code shows the model it asked for; this line shows the one reflex actually sent. It asks the session's
// own front door (ANTHROPIC_BASE_URL, loopback only) and prints one line; any failure prints an empty line. The dollar
// figures are estimates at list prices, computed as `reflex report` section 8 does (src/worker/session-status.ts). The
// quota is the account's, as the API reports it (src/worker/quota-watch.ts).
import http from "node:http";
import { tierOfModel, tierRank } from "./tiers.js";
import { EFFORTS } from "./wire/effort.js";
import { parseStatusInput } from "./wire/statusline.js";

export const STATUS_PATH = "/__reflex/status";
const TIMEOUT_MS = 300;

interface Pair {
  readonly requested: string | null;
  readonly sent: string;
}
export interface StatusBody {
  readonly worker: "up" | "down";
  readonly main?: Pair | null;
  /** Each subagent in the order first seen: its model pair and the level applied to it. */
  readonly subagents?: readonly { readonly title?: string | null; readonly model: Pair | null; readonly effort: EffortPair | null }[];
  /** Estimated $ this session cost (list prices, every recorded request at the model sent). */
  readonly cost?: number;
  /** REFLEX_EFFORT: the level last applied to the main chat, with the client's own. */
  readonly effort?: { readonly main: EffortPair | null };
  /** The main chat's prompt cache: seconds left and the estimated $ a lapse adds to the next request. */
  readonly cache?: { readonly leftS: number; readonly lapseUsd: number } | null;
  /** The main chat's context shrank a turn or two ago: tokens before and after. */
  readonly context?: { readonly from: number; readonly to: number; readonly compacted: boolean } | null;
  /** The subscription quota (account-wide): per window, whole percent used and, at the recent rate, seconds to 100%. */
  readonly quota?: readonly QuotaWindow[];
}
interface QuotaWindow {
  readonly name: string;
  readonly pct: number;
  readonly status: string | null;
  readonly resetInS: number | null;
  readonly limitInS: number | null;
}
interface EffortPair {
  readonly requested: string | null;
  readonly level: string;
}

/** `claude-opus-5-5[1m]` -> `Opus 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`; anything else unchanged. */
export function shortModel(id: string): string {
  const m = /^claude-([a-z]+)((?:-\d{1,2})+)(?:-\d{8})?(?:\[1m\])?$/.exec(id.toLowerCase());
  if (!m) return id;
  const family = m[1] as string;
  return `${family[0]?.toUpperCase()}${family.slice(1)} ${(m[2] as string).slice(1).replaceAll("-", ".")}`;
}

const routed = (p: Pair): boolean => p.requested !== null && p.requested !== p.sent;
const arrow = (p: Pair): string => {
  const a = tierOfModel(p.requested);
  const b = tierOfModel(p.sent);
  return a === null || b === null || a === b ? "⇄" : tierRank(b) < tierRank(a) ? "⇣" : "⇡";
};
const rank = (e: string | null): number => (EFFORTS as readonly string[]).indexOf(e ?? "");
/** An applied level that differs from the client's (both known). */
const moved = (p: EffortPair): boolean => rank(p.level) >= 0 && rank(p.requested) >= 0 && p.level !== p.requested;
const effortArrow = (p: EffortPair): string => (rank(p.level) < rank(p.requested) ? "⇣" : "⇡");
/** `$0.42`, `−$0.20`: cents, a real minus sign. */
export const money = (usd: number): string => `${usd < -0.005 ? "−" : ""}$${Math.abs(usd).toFixed(2)}`;
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** A subagent title is model-written text: no control characters (no terminal escapes), one line, at most 40 chars. */
export function cleanTitle(t: string): string {
  // eslint-disable-next-line no-control-regex
  const one = t.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
  return one.length > 40 ? `${one.slice(0, 39)}…` : one;
}

/** `⇣ Haiku 4.5 (asked Opus 5.5)` when reflex changed the model, `Opus 5.5` when it did not. */
const modelText = (p: Pair): string =>
  routed(p) ? `${YELLOW}${arrow(p)} ${shortModel(p.sent)}${RESET} ${DIM}(asked ${shortModel(p.requested as string)})${RESET}` : shortModel(p.sent);
const effortText = (p: EffortPair): string => `${DIM}Effort:${RESET} ${YELLOW}${effortArrow(p)} ${p.level}${RESET} ${DIM}(asked ${p.requested as string})${RESET}`;
const SEP = ` ${DIM}·${RESET} `;
/** Yellow from here on: time to decide whether to send something or let it lapse. */
const CACHE_WARN_S = 5 * 60;

/** `183k`, `1.2M`, `950`: context sizes at a glance. */
export const tokensShort = (n: number): string => (n >= 999_500 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** `Context: compacted 183k→41k`; `dropped` when no compaction call came in between (/clear, cleared tool results). */
const contextText = (c: { readonly from: number; readonly to: number; readonly compacted: boolean }): string =>
  `${DIM}Context:${RESET} ${YELLOW}${c.compacted ? "compacted" : "dropped"} ${tokensShort(c.from)}→${tokensShort(c.to)}${RESET}`;

/** `Cache: 42m left (lapse Est. +$0.61)`, `Cache: lapsed (next turn Est. +$0.61)`; a lapse under a cent is not priced. */
function cacheText(c: { readonly leftS: number; readonly lapseUsd: number }): string {
  const usd = c.lapseUsd >= 0.005 ? money(c.lapseUsd) : null;
  if (c.leftS <= 0) return `${DIM}Cache:${RESET} ${YELLOW}lapsed${RESET}${usd === null ? "" : ` ${DIM}(next turn Est. +${usd})${RESET}`}`;
  const left = c.leftS >= 60 ? `${Math.floor(c.leftS / 60)}m` : `${c.leftS}s`;
  const time = c.leftS < CACHE_WARN_S ? `${YELLOW}${left} left${RESET}` : `${left} left`;
  return `${DIM}Cache:${RESET} ${time}${usd === null ? "" : ` ${DIM}(lapse Est. +${usd})${RESET}`}`;
}

/** `40m`, `2h 10m`, `3d`: a coarse duration. */
export function dur(s: number): string {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m}m`;
  if (m < 48 * 60) return m % 60 === 0 ? `${m / 60}h` : `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.round(m / 1440)}d`;
}

/** Yellow from here on, or when the recent rate reaches 100% before the window resets. */
const QUOTA_WARN_PCT = 80;
/** Windows other than these show only when they are the ones worth a look. */
const QUOTA_ALWAYS = new Set(["5h", "7d"]);

/** `Quota: 5h 31% (limit in ~40m), 7d 48%`; `5h 100% (limited, resets in 1h 20m)` once the API refuses. */
function quotaText(ws: readonly QuotaWindow[]): string | null {
  const bits = ws.flatMap((w) => {
    const limited = w.status === "rejected";
    const warn = limited || w.status === "allowed_warning" || w.pct >= QUOTA_WARN_PCT || w.limitInS !== null;
    if (!QUOTA_ALWAYS.has(w.name) && !warn) return [];
    const note = limited ? ` (limited${w.resetInS === null ? "" : `, resets in ${dur(w.resetInS)}`})` : w.limitInS !== null ? ` (limit in ~${dur(w.limitInS)})` : "";
    const text = `${w.name} ${w.pct}%${note}`;
    return [warn ? `${YELLOW}${text}${RESET}` : text];
  });
  return bits.length === 0 ? null : `${DIM}Quota:${RESET} ${bits.join(", ")}`;
}

/**
 * Pure. The lines for one session; null prints nothing (not behind reflex, or nothing to say yet).
 *   Reflex: ⇣ Sonnet 5 (asked Opus 5.5) · Effort: ⇣ low (asked high) · Est. Cost: $1.80 · Cache: 42m left (lapse Est. +$0.61) · Quota: 5h 31%, 7d 48%
 *   ↳ List docs directory files: ⇣ Haiku 4.5 (asked Opus 5.5) · Effort: ⇣ low (asked high)
 * One line per running subagent (changed or not), titled as Claude Code shows it (else `subagent N`, by start order).
 */
export function formatStatus(s: StatusBody | null): string | null {
  if (s === null) return null;
  if (s.worker === "down") return `${DIM}Reflex: passthrough${RESET}`;
  const main = s.main ?? null;
  const parts = [main === null ? `${DIM}Reflex${RESET}` : `${DIM}Reflex:${RESET} ${modelText(main)}`]; // nothing decided yet: still say whose line this is
  const me = s.effort?.main ?? null;
  if (me !== null && moved(me)) parts.push(effortText(me));
  if (s.cost !== undefined && s.cost >= 0.005) parts.push(`${DIM}Est. Cost:${RESET} ${money(s.cost)}`);
  if (s.cache) parts.push(cacheText(s.cache));
  if (s.context) parts.push(contextText(s.context));
  const q = quotaText(s.quota ?? []);
  if (q !== null) parts.push(q);
  const subs = (s.subagents ?? []).map((x, i) => {
    const bits = [...(x.model !== null ? [modelText(x.model)] : []), ...(x.effort !== null && moved(x.effort) ? [effortText(x.effort)] : [])];
    const title = cleanTitle(x.title ?? "");
    return `${DIM}↳ ${title === "" ? `subagent ${i + 1}` : title}:${RESET} ${bits.length ? bits.join(SEP) : `${DIM}…${RESET}`}`;
  });
  return [parts.join(SEP), ...subs].join("\n");
}

/** GET the status from a loopback base URL; null on anything unexpected. */
export function fetchStatus(base: string | undefined, sessionId: string, timeoutMs = TIMEOUT_MS): Promise<StatusBody | null> {
  let url: URL;
  try {
    url = new URL(`${STATUS_PATH}?session=${encodeURIComponent(sessionId)}`, base);
  } catch {
    return Promise.resolve(null);
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return Promise.resolve(null); // loopback only
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => {
        try {
          const o = JSON.parse(text) as StatusBody;
          resolve(res.statusCode === 200 && (o.worker === "up" || o.worker === "down") ? o : null);
        } catch {
          resolve(null);
        }
      });
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

const readStdin = (): Promise<string> =>
  new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c: string) => (text += c));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(text));
  });

export async function statuslineCommand(io: { stdout: (t: string) => void; env: NodeJS.ProcessEnv }): Promise<number> {
  try {
    const input = parseStatusInput(await readStdin());
    const line = input.sessionId === null ? null : formatStatus(await fetchStatus(io.env["ANTHROPIC_BASE_URL"], input.sessionId));
    io.stdout(`${line ?? ""}\n`);
  } catch {
    io.stdout("\n");
  }
  return 0;
}
