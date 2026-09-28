// The subscription quota as Anthropic reports it on every response to a Claude Code request (docs/wire-format.md §7.3):
// `anthropic-ratelimit-unified-<window>-utilization` (a fraction in 1% steps, e.g. "0.31") and `-<window>-reset` (epoch
// seconds) per window (`5h`, `7d`; `7d_oi` only on Fable requests), plus `-<window>-status` and an overall `-status`.
// Utilisation is account-wide: usage outside reflex moves it too. Only these numbers and status words are read; the
// header map itself is never kept (other headers on the same response identify the account).
import type { IncomingHttpHeaders } from "node:http";

export interface QuotaWindow {
  /** Fraction of the window used, 0..1 (above 1 is passed through: the API decides what it means). */
  readonly util: number;
  /** When the window resets, epoch seconds; null when not sent. */
  readonly reset: number | null;
  /** `allowed`, `allowed_warning`, `rejected`, …; null when not sent or not a plain word. */
  readonly status: string | null;
}

/** Windows by name (`5h`, `7d`, …); only windows that sent a utilisation. */
export type Quota = Readonly<Record<string, QuotaWindow>>;

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOW = /^[a-z0-9_]{1,16}$/;
const WORD = /^[a-z_]{1,32}$/;
/** More windows than this is not the header family this parser knows. */
const MAX_WINDOWS = 8;

const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v.trim() : null);
const fraction = (v: string | null): number | null => {
  if (v === null || !/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n <= 10 ? n : null;
};
const epoch = (v: string | null): number | null => (v !== null && /^\d{9,11}$/.test(v) ? Number(v) : null);

/** The quota windows a response reported; null when it carried none (API keys, gateways, errors before the limiter). */
export function parseQuota(headers: IncomingHttpHeaders): Quota | null {
  const out: Record<string, QuotaWindow> = {};
  let n = 0;
  for (const name of Object.keys(headers)) {
    const key = name.toLowerCase();
    if (!key.startsWith(PREFIX) || !key.endsWith("-utilization")) continue;
    const w = key.slice(PREFIX.length, -"-utilization".length);
    const util = fraction(one(headers[name]));
    if (!WINDOW.test(w) || util === null || ++n > MAX_WINDOWS) continue;
    const status = one(headers[`${PREFIX}${w}-status`]);
    out[w] = { util, reset: epoch(one(headers[`${PREFIX}${w}-reset`])), status: status !== null && WORD.test(status) ? status : null };
  }
  return Object.keys(out).length === 0 ? null : out;
}
