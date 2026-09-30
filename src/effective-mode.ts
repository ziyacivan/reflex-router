import type { Config, Mode } from "./config.js";
import type { VersionVerdict } from "./launcher/version.js";

/** `passthrough` = proxy present but no decisions are made (nothing to decide with). */
export type EffectiveMode = Mode | "passthrough";

export interface EffectiveModeResult {
  readonly mode: EffectiveMode;
  /** Why the effective mode differs from the requested one; null when it does not. */
  readonly degradedReason: string | null;
}

/**
 * Pure. The requested mode can only be weakened, never strengthened:
 *   off                                  -> off (no proxy at all: literally plain `claude`)
 *   no usable decision backend           -> passthrough
 *   Claude Code major-version mismatch   -> route becomes shadow
 */
export function resolveEffectiveMode(config: Config, verdict: VersionVerdict | null): EffectiveModeResult {
  if (config.mode === "off") return { mode: "off", degradedReason: null };
  if (config.backend === "jev" && config.typesafeApiKey === undefined) return { mode: "passthrough", degradedReason: "no_backend_key" };
  if (config.backend === "typellm" && config.typellmApiKey === undefined) return { mode: "passthrough", degradedReason: "no_backend_key" };
  if (config.mode === "route" && verdict?.level === "degrade" && !config.ignoreVersionCheck) {
    return { mode: "shadow", degradedReason: `claude_version:${verdict.reason}` };
  }
  return { mode: config.mode, degradedReason: null };
}
