// `reflex statusline`: the `statusLine` command reflex injects into the claude it launches (unless the user has their
// own). Claude Code shows the model it asked for; this line shows the one reflex actually sent. It asks the session's
// own front door (ANTHROPIC_BASE_URL, loopback only) and prints one line; any failure prints an empty line. The dollar
// figures are estimates at list prices, computed as `reflex report` section 8 does (src/worker/session-status.ts).
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

/**
 * Pure. The lines for one session; null prints nothing (not behind reflex, or nothing to say yet).
 *   Reflex: ⇣ Sonnet 5 (asked Opus 5.5) · Effort: ⇣ low (asked high) · Est. Cost: $1.80
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
