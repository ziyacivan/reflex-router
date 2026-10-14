// Runtime shape assertions (docs/wire-format.md §10). The Claude Code version is only a hint; these checks verify
// that the traffic still looks like what the fixtures show. Any violation degrades the session to shadow.
import type { RequestView, Signals } from "./claude-code.js";

export type ShapeCheck = "session_id" | "client_identity" | "subagent_signals" | "turn_structure";

export interface Violation {
  readonly check: ShapeCheck;
  /** Signal booleans only; never request content. */
  readonly signals: Signals;
}

/** Only tool-loop requests are checked: side calls legitimately differ (compaction drops the cache-TTL beta, etc.). */
export const shapeCheckApplies = (v: RequestView): boolean => v.turn === "new" || v.turn === "continuation";

/** Pure. Returns every failed check; an empty list means the request looks as expected. */
export function assertShape(v: RequestView): Violation[] {
  const f = v.facts;
  const failed: ShapeCheck[] = [];
  const sessionOk = v.sessionId !== null && (f.headerSessionId === null || f.metadataSessionId === null || f.headerSessionId === f.metadataSessionId);
  if (!sessionOk) failed.push("session_id");
  if (!v.signals.s3) failed.push("client_identity");
  // Header <=> cc_is_subagent. The agent-prompt marker is optional, but if it shows up the request must be a subagent.
  const { header, s1, s2 } = v.signals;
  if (header !== s1 || (s2 && !header && !s1)) failed.push("subagent_signals");
  if (f.nonSystemMessages === 0 || f.lastNonSystemRole !== "user") failed.push("turn_structure");
  return failed.map((check) => ({ check, signals: v.signals }));
}

export type ShapeStatus = "checking" | "verified" | "degraded";

/** Per-session state machine: first N applicable requests are checked; one violation degrades for good. */
export class ShapeTracker {
  #checked = 0;
  #status: ShapeStatus = "checking";
  #reason: string | null = null;

  constructor(private readonly n: number) {}

  get status(): ShapeStatus {
    return this.#status;
  }
  /** `shape:<check>` once degraded, else null. */
  get reason(): string | null {
    return this.#reason;
  }

  /** Returns the violations found on this request (empty when not checked). */
  observe(v: RequestView): Violation[] {
    if (this.#status !== "checking" || !shapeCheckApplies(v)) return [];
    const violations = assertShape(v);
    if (violations.length > 0) {
      this.#status = "degraded";
      this.#reason = `shape:${violations.map((x) => x.check).join(",")}`;
      return violations;
    }
    if (++this.#checked >= this.n) this.#status = "verified";
    return [];
  }
}
