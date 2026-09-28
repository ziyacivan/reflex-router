// What `reflex statusline` shows: per session, the model the main chat asked for and the one reflex sent on its last
// request, the same for each subagent, the effort level REFLEX_EFFORT last applied against the client's (main chat and
// each subagent until its SubagentStop), each subagent's title (the Agent call's description, in memory only), the session's
// estimated cost (every recorded request, side calls too, at the model sent, list prices), and how long the main chat's
// prompt cache has left with what a lapse would add. No saving: the only honest one is section 8's REFLEX_AB comparison,
// which needs a whole log, not a session. Model ids, level names, subagent titles, times and dollar sums only, in memory
// only, served on loopback (GET /__reflex/status); never logged.
import type { DecisionRecord } from "../log/decision-log.js";
import type { DecisionInfo } from "../outcome/tracker.js";
import { cacheLapseUsd, type CacheTtl } from "../pricing.js";
import { toDec, type Dec, type J } from "../report/records.js";
import { costOf } from "../report/sections.js";

export interface ModelPair {
  readonly requested: string | null;
  readonly sent: string;
}

/** The level REFLEX_EFFORT applied to a conversation's latest decided turn, and the client's own. */
export interface EffortPair {
  readonly requested: string | null;
  readonly level: string;
}

/** One subagent, in the order first seen: its model pair and the level applied to it (either may be missing). */
export interface SubagentStatus {
  readonly title: string | null;
  readonly model: ModelPair | null;
  readonly effort: EffortPair | null;
}

/** The main chat's prompt cache, as of its last request that read or wrote it. */
export interface CacheStatus {
  readonly ttl: CacheTtl;
  /** Seconds until it lapses; 0 or less: lapsed. */
  readonly leftS: number;
  /** Estimated $ (list price) the next main-chat request pays more once it has lapsed: its prefix written, not read. */
  readonly lapseUsd: number;
}

const TTL_MS: Readonly<Record<CacheTtl, number>> = { "5m": 5 * 60_000, "1h": 60 * 60_000 };

export interface SessionStatusBody {
  readonly main: ModelPair | null;
  readonly subagents: readonly SubagentStatus[];
  readonly effort: { readonly main: EffortPair | null };
  /** Estimated $ this session cost at list prices: the recorded token counts at the model sent. */
  readonly cost: number;
  /** null: no main-chat request with a cache breakpoint answered yet (or none since the worker started). */
  readonly cache: CacheStatus | null;
}

type Sub = { -readonly [K in keyof SubagentStatus]: SubagentStatus[K] } & { agentId: string | null; done: boolean };

export class SessionStatus {
  readonly #main = new Map<string, ModelPair>();
  /** Per session, per subagent conversation key (the one decision records carry, so model and effort join). */
  readonly #subs = new Map<string, Map<string, Sub>>();
  /** Per session: Agent-call titles by the hash of the prompt they started, until a subagent's first request claims one. */
  readonly #titles = new Map<string, Map<string, string>>();
  readonly #cost = new Map<string, number>();
  readonly #mainEffort = new Map<string, EffortPair>();
  readonly #cache = new Map<string, { atMs: number; ttl: CacheTtl; lapseUsd: number }>();

  observe(d: DecisionInfo): void {
    if (d.sessionId === null || d.sentModel === null || d.turn === "side") return;
    const pair = { requested: d.requestedModel, sent: d.sentModel };
    if (d.kind === "main" && d.agentId === null) this.#main.set(d.sessionId, pair);
    else if (d.kind === "subagent" && d.conv !== null) {
      const sub = this.#sub(d.sessionId, d.conv);
      sub.model = pair;
      sub.agentId ??= d.agentId;
      const titles = this.#titles.get(d.sessionId);
      const t = d.taskHash ? titles?.get(d.taskHash) : undefined;
      if (t !== undefined && d.taskHash) {
        sub.title = t;
        titles?.delete(d.taskHash);
      }
    }
  }

  /** PreToolUse on the Agent tool: arrives before the subagent's first request, whose task text is this prompt. */
  title(sessionId: string, promptHash: string, title: string): void {
    const titles = this.#titles.get(sessionId) ?? new Map<string, string>();
    titles.set(promptHash, title);
    this.#titles.set(sessionId, titles);
  }

  /**
   * SubagentStop: the subagent's line goes. It stays marked rather than deleted, so a record of its last request that
   * lands after the hook cannot bring it back. ponytail: a subagent resumed after its stop stays hidden.
   */
  stop(sessionId: string, agentId: string): void {
    for (const sub of this.#subs.get(sessionId)?.values() ?? []) if (sub.agentId === agentId) sub.done = true;
  }

  #sub(sessionId: string, conv: string): Sub {
    const subs = this.#subs.get(sessionId) ?? new Map<string, Sub>();
    this.#subs.set(sessionId, subs);
    const sub = subs.get(conv) ?? { title: null, model: null, effort: null, agentId: null, done: false };
    subs.set(conv, sub);
    return sub;
  }

  addRecord(record: DecisionRecord, sessionId: string | null): void {
    const d = sessionId === null ? null : toDec(record as unknown as J);
    if (d === null || sessionId === null) return;
    this.#cost.set(sessionId, (this.#cost.get(sessionId) ?? 0) + costOf([d]).atSentUsd);
    this.#noteCache(record, d, sessionId);
    // An applied level holds for the conversation until a later decided turn applies another.
    const e = d.effort;
    if (e === null || e.via === null || e.target === null || d.fallback) return;
    const pair = { requested: d.requestedEffort, level: e.target };
    if (d.kind === "main") this.#mainEffort.set(sessionId, pair);
    else if (d.kind === "subagent" && d.conv !== null) this.#sub(sessionId, d.conv).effort = pair;
  }

  /**
   * The main chat's cache lives on the model its last request went to, and each answered main-chat request starts its
   * TTL again (from the request's arrival: the earlier, safer reading). Side calls are left out even when they share the
   * prefix: missing a refresh only shows less time than there is. Subagents have caches of their own.
   */
  #noteCache(record: DecisionRecord, d: Dec, sessionId: string): void {
    const ttl = record.cache_ttl ?? null;
    const u = d.usage;
    if (d.kind !== "main" || d.turn === "side" || ttl === null || u === null || d.sentTier === null || record.upstream.status !== 200) return;
    const prev = this.#cache.get(sessionId);
    if (prev !== undefined && prev.atMs > d.atMs) return; // an older request answered late
    // The next request's prefix is this one's whole context plus the reply it got.
    const tokens = u.input + u.cacheRead + u.cacheCreate + u.output;
    this.#cache.set(sessionId, { atMs: d.atMs, ttl, lapseUsd: cacheLapseUsd(d.sentTier, d.sentModel, tokens, ttl) });
  }

  get(sessionId: string, now = Date.now()): SessionStatusBody {
    const c = this.#cache.get(sessionId);
    return {
      main: this.#main.get(sessionId) ?? null,
      subagents: [...(this.#subs.get(sessionId)?.values() ?? [])].filter((x) => !x.done).map(({ title, model, effort }) => ({ title, model, effort })),
      effort: { main: this.#mainEffort.get(sessionId) ?? null },
      cost: this.#cost.get(sessionId) ?? 0,
      cache: c === undefined ? null : { ttl: c.ttl, leftS: Math.floor((c.atMs + TTL_MS[c.ttl] - now) / 1000), lapseUsd: c.lapseUsd },
    };
  }
}
