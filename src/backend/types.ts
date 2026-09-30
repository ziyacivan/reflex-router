import type { Decision, DecisionState, QuestionSet } from "../types.js";

/** A decision backend. It never sees a request, only the budgeted, redacted DecisionState. */
export interface DecisionBackend {
  readonly id: "jev" | "laya" | "typellm";
  /** Resolves with validated answers or rejects with a BackendError; never retries. */
  decide(state: DecisionState, questions: QuestionSet, opts: { readonly signal: AbortSignal }): Promise<Decision>;
  /** Opens a connection ahead of the first decision (best effort). */
  warm?(): Promise<void>;
  /** Releases pooled connections. */
  close?(): void;
}

export type BackendErrorKind = "timeout" | "aborted" | "http" | "network" | "invalid_response";

/** Carries a category and at most an HTTP status; never a response body or a credential. */
export class BackendError extends Error {
  constructor(
    readonly kind: BackendErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
