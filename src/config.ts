// The ONLY module that reads process.env for configuration. Everything else takes a Config.
import os from "node:os";
import path from "node:path";
import { CORRECTION_SCORE_CAP } from "./outcome/heuristics.js";

export const MODES = ["route", "shadow", "off"] as const;
/** REFLEX_HOOKS: whether the outcome hooks are injected, and how they reach the door (see `hooks` below). */
export const HOOKS_MODES = ["auto", "http", "command", "off"] as const;
export type HooksMode = (typeof HOOKS_MODES)[number];
export type Mode = (typeof MODES)[number];

export const BACKENDS = ["jev", "laya"] as const;
export type BackendId = (typeof BACKENDS)[number];

/**
 * Defaults for the REFLEX_ESCALATE_* settings: chosen starting values, not tuned ones. The threshold is the lowest
 * correction score ever recorded organically (1.0, `en:thats_wrong`); the lookback matches REVERT_WINDOW_TURNS and is
 * deliberately short, so one complaint cannot read as "reflex is off for this session". Nothing here is tuned: that
 * needs outcome windows this log does not have yet (docs/observations.md).
 */
export const DEFAULT_ESCALATE_THRESHOLD = 1;
export const DEFAULT_ESCALATE_WINDOW_TURNS = 3;

/** REFLEX_ESCALATE. `shadow` records what it would have done and changes nothing. */
export const ESCALATE_MODES = ["off", "on", "shadow"] as const;
export type EscalateMode = (typeof ESCALATE_MODES)[number];
/** REFLEX_ESCALATE_TARGET: where an escalation sends the turn (src/worker/escalation.ts explains the measurement). */
export const ESCALATE_TARGETS = ["requested", "next"] as const;
export type EscalateTarget = (typeof ESCALATE_TARGETS)[number];

/** Laya checkpoints `laya-serve` can preload and answer with (REFLEX_LAYA_MODEL). */
export const LAYA_MODELS = ["english", "multilingual", "typed-decisions"] as const;
export type LayaModel = (typeof LAYA_MODELS)[number];

/** REFLEX_COMPARE: a second backend asked alongside the first, recorded only (calibration data). */
export const COMPARE_BACKENDS = ["off", "laya"] as const;
export type CompareBackend = (typeof COMPARE_BACKENDS)[number];

export const TIERS = ["haiku", "sonnet", "opus", "fable"] as const;
export type Tier = (typeof TIERS)[number];

export const MAIN_CHAT_POLICIES = ["guarded", "never"] as const;
export type MainChatPolicy = (typeof MAIN_CHAT_POLICIES)[number];

export const DECISION_RULES = ["mass", "argmax"] as const;
/** How the tier is read from the backend's probability vector (src/policy.ts). */
export type DecisionRule = (typeof DECISION_RULES)[number];

export const UPGRADE_POLICIES = ["off", "confident", "on"] as const;
export type UpgradePolicy = (typeof UPGRADE_POLICIES)[number];

/** Built-in tier -> model id defaults; overridden by REFLEX_MODEL_<TIER>, then ANTHROPIC_DEFAULT_<TIER>_MODEL. */
export const DEFAULT_MODELS: Readonly<Record<Tier, string>> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

export interface Config {
  /** What the user asked for. The mode actually used is decided by resolveEffectiveMode(). */
  readonly mode: Mode;
  readonly backend: BackendId;
  /** Where Anthropic-bound traffic goes: REFLEX_UPSTREAM_URL, else the user's own ANTHROPIC_BASE_URL, else api.anthropic.com. */
  readonly upstreamUrl: string;
  /** REFLEX_CLAUDE_BIN override; undefined means "find `claude` on PATH". */
  readonly claudeBin: string | undefined;
  /** State directory (logs, decision journal). Default ~/.reflex. */
  readonly home: string;
  /** REFLEX_IGNORE_VERSION_CHECK=1: never degrade because of the Claude Code version (the warning stays). */
  readonly ignoreVersionCheck: boolean;
  /** TypeSafe key. Only ever held by the launcher/worker; never forwarded, logged, or given to the claude child. */
  readonly typesafeApiKey: string | undefined;
  /** Jev endpoint origin (REFLEX_JEV_BASE_URL); the path /v1/systemone is appended. */
  readonly jevBaseUrl: string;
  /** Hard deadline for one Jev decision, connection setup included (REFLEX_JEV_DEADLINE_MS). Expiry fails open. */
  readonly jevDeadlineMs: number;
  /** Interval of the decision backend's keep-alive ping; 0 disables it. */
  readonly warmIntervalMs: number;
  /** REFLEX_LAYA_BIN override; undefined means "find `laya-serve` on PATH". */
  readonly layaBin: string | undefined;
  /** Checkpoint `laya-serve` preloads and every decision asks for (REFLEX_LAYA_MODEL). */
  readonly layaModel: LayaModel;
  /** Hard deadline for one Laya decision (REFLEX_LAYA_DEADLINE_MS). Expiry fails open. */
  readonly layaDeadlineMs: number;
  /** REFLEX_LAYA_CALIBRATION (default on): apply the fitted calibration head to Laya's answers when one exists. */
  readonly layaCalibration: boolean;
  /**
   * REFLEX_COMPARE=laya: with the Jev backend, also start laya-serve and put every decided state to Laya too, off the
   * request's path, recording only numbers (the feature vector) in the decision record's `compare` block. It never
   * changes a decision. This is how calibration data is collected (scripts/calibrate/fit.ts).
   */
  readonly compare: CompareBackend;
  /** How long the launcher waits for `laya-serve` to report its model loaded before stopping it (REFLEX_LAYA_READY_TIMEOUT_MS). */
  readonly layaReadyTimeoutMs: number;
  /**
   * Where the `laya-serve` this session started listens, and the per-session key it requires. Never read from the
   * environment: only the launcher fills them in, after starting the server, in the config it hands the worker.
   */
  readonly layaBaseUrl: string | undefined;
  readonly layaApiKey: string | undefined;
  /** Tiers a request may be routed to (REFLEX_TIERS). Fable is only present when REFLEX_ALLOW_FABLE=1. */
  readonly tiers: readonly Tier[];
  readonly allowFable: boolean;
  readonly upgrades: UpgradePolicy;
  readonly mainChat: MainChatPolicy;
  /** Tier -> model id used when a request is (or would be) routed to that tier. */
  readonly models: Readonly<Record<Tier, string>>;
  /** Shape assertions run on the first N classified requests of a session (REFLEX_SHAPE_CHECK_N). */
  readonly shapeCheckN: number;
  /** Privacy budget for what is sent to the decision backend. */
  readonly maxUserChars: number;
  readonly maxAssistantChars: number;
  /**
   * REFLEX_LOG_PROMPTS=1 adds a redacted, 300-character preview of each decided prompt to the decision log.
   * **Off by default.** It was on through the pre-release versions so decisions could be reviewed while the routing
   * rules were being written, with a stated promise to revisit that before a public release; this is that revisit.
   * The preview is the only field in the log that can hold the user's own words, redaction removes secrets and
   * home-directory prefixes but not project-relative paths or the words themselves, and an alpha nobody has read the
   * source of should not write a user's prompts to disk because its author found it convenient.
   */
  readonly logPrompts: boolean;
  /** REFLEX_DECISION_RULE: `mass` (ordered, default) or `argmax` (Jev's own choice + confidence floor). */
  readonly decisionRule: DecisionRule;
  /** REFLEX_MASS_EPS: the most probability the mass rule leaves on tiers above its pick. */
  readonly massEps: number;
  /** Main-chat cost guard: largest one-time cache penalty ($) a model switch may cost (REFLEX_MAX_SWITCH_PENALTY_USD). */
  readonly maxSwitchPenaltyUsd: number;
  /** Main-chat cost guard: requests within which a switch's cache penalty must be recovered (REFLEX_SWITCH_BREAKEVEN_REQUESTS; 0 = off). */
  readonly switchBreakevenRequests: number;
  /** REFLEX_DELEGATE=1: add the delegation hint (src/delegate/hint.ts) to user-typed prompts via the UserPromptSubmit hook. Off by default. */
  readonly delegate: boolean;
  /** REFLEX_STATUSLINE (default on): give claude a status line showing the model reflex sent, unless the user has their own. */
  readonly statusline: boolean;
  /**
   * REFLEX_HOOKS (default `auto`): how the outcome hooks (src/outcome/hooks-config.ts) reach the door. `http` hooks,
   * except under Claude Code's sandbox (`sandbox.enabled` in the session's settings), where Claude Code answers every
   * http hook to 127.0.0.1 with "HTTP 403" and `auto` injects `command` hooks running `reflex hook-relay` instead
   * (docs/observations.md, 2026-09-24). Routing depends on them too: the UserPromptSubmit hook is what lets a plain-string
   * prompt count as a new turn, so without hooks only a session's first prompt is judged. `http` and `command` force a
   * transport; `off` injects nothing.
   */
  readonly hooks: HooksMode;
  /**
   * REFLEX_ESCALATE=1: let an outcome signal raise the tier of a conversation's next new turn (src/worker/escalation.ts).
   * Off by default, and the only setting that lets a past event change a future request. It may only raise, never
   * above the tier the client asked for, and never for pinned continuations or side calls.
   */
  readonly escalate: EscalateMode;
  /** Where an escalation sends the turn: `requested` (the measured cheaper move, default) or `next` (one tier up). */
  readonly escalateTarget: EscalateTarget;
  /**
   * REFLEX_AB: the fraction (0..1) of turns the backend would route BELOW the requested tier that are left on the
   * requested model at random instead, and tagged `ab: "control"`. The rest are tagged `ab: "routed"`. 0 disables it.
   *
   * This is the only way to get a causal read on routing. Without it, "routed" and "unchanged" differ in the
   * difficulty of their work before any outcome is measured - a turn is routed because the backend judged it easy -
   * so no rate in section 7 is a causal estimate. Randomising which of the eligible turns are actually routed makes
   * the two arms comparable.
   */
  readonly abFraction: number;
  /**
   * REFLEX_EFFORT=1 (route mode): set each new turn's effort level from the decision (src/policy.ts effortPlan), on
   * the models where that is verified (src/wire/effort.ts). Off by default. On Opus 5.5 this adds messages to the
   * conversation, which reflex must keep re-adding (src/worker/effort-store.ts).
   */
  readonly effort: boolean;
  /** REFLEX_EFFORT_UP=1: let REFLEX_EFFORT go above the client's level (costs more). Off by default. */
  readonly effortUp: boolean;
  /**
   * REFLEX_EFFORT_MIDTURN=1: also change the level on turns that need an inserted effort message (a main chat's later
   * turns). Off by default: an inserted message ties the conversation to reflex (src/wire/effort.ts explains why).
   */
  readonly effortMidturn: boolean;
  /**
   * REFLEX_EFFORT_AB: the fraction (0..1) of turns whose effort target differs from the client's level that are held at
   * the client's level at random instead (`effort.ab: "control"`; the rest `"treated"`), so report section 14 can
   * compare outcomes causally. 0 disables it.
   */
  readonly effortAbFraction: number;
  /** Correction score (0..CORRECTION_SCORE_CAP) at or above which a closed window escalates the conversation. */
  readonly escalateThreshold: number;
  /** How many of the conversation's later new turns one escalation signal covers before it decays. */
  readonly escalateWindowTurns: number;
}

/** The hard deadline of the configured decision backend's one decision. */
export const decisionDeadlineMs = (c: Pick<Config, "backend" | "jevDeadlineMs" | "layaDeadlineMs">): number => (c.backend === "laya" ? c.layaDeadlineMs : c.jevDeadlineMs);

export type ConfigResult =
  | { readonly ok: true; readonly config: Config; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
export const TYPESAFE_KEY_PREFIX = "apikey_";
export const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai";
/** Above the first measured cold-connection p95 (1136 ms, docs/observations.md) with some headroom. */
export const DEFAULT_JEV_DEADLINE_MS = 1500;
/**
 * How often the worker pings the decision backend to keep its keep-alive connection open while nothing is being
 * decided. 0 disables it. The first decision after an idle gap otherwise pays a fresh TCP+TLS handshake
 * (docs/observations.md: p50 823 ms on a new connection vs 382 ms reused).
 */
/**
 * One calibrated Laya decision (the product's 2 questions + 7 feature questions) measured on an idle Apple M4, CPU:
 * `english` p95 754 ms on short tasks and 1,478 ms on long ones; `typed-decisions` p95 2,223 ms on long ones
 * (docs/observations.md, 2026-09-23). Above the long-task p95 with some headroom, as the Jev default is.
 */
export const DEFAULT_LAYA_DEADLINE_MS = 2500;
/** Importing torch and loading a checkpoint on CPU; generous, since the session runs unrouted meanwhile anyway. */
export const DEFAULT_LAYA_READY_TIMEOUT_MS = 60_000;
export const DEFAULT_WARM_INTERVAL_MS = 60_000;

/** A setting's trimmed value, or undefined when it is unset, empty or only whitespace: `export X=""` means "not set", never "set to nothing". */
const setting = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v === undefined || v === "" ? undefined : v;
};

/** State directory: REFLEX_HOME, else ~/.reflex. Shared with the env-file loader, which needs it before loadConfig runs. */
export const defaultHome = (env: NodeJS.ProcessEnv, homedir: string = os.homedir()): string => setting(env, "REFLEX_HOME") ?? path.join(homedir, ".reflex");

/**
 * Every environment variable loadConfig reads (test/unit/config.test.ts keeps this list and the code in step).
 * `reflex doctor` reports the source of each one; only REFLEX_* and TYPESAFE_API_KEY may come from ~/.reflex/env.
 */
export const SETTING_NAMES: readonly string[] = [
  "REFLEX_MODE", "REFLEX_BACKEND", "REFLEX_UPSTREAM_URL", "ANTHROPIC_BASE_URL", "TYPESAFE_API_KEY", "REFLEX_JEV_BASE_URL", "REFLEX_JEV_DEADLINE_MS", "REFLEX_WARM_INTERVAL_MS",
  "REFLEX_LAYA_BIN", "REFLEX_LAYA_MODEL", "REFLEX_LAYA_DEADLINE_MS", "REFLEX_LAYA_READY_TIMEOUT_MS", "REFLEX_LAYA_CALIBRATION", "REFLEX_COMPARE",
  "REFLEX_ALLOW_FABLE", "REFLEX_TIERS", "REFLEX_UPGRADES", "REFLEX_MAIN_CHAT", "REFLEX_CLAUDE_BIN", "REFLEX_HOME", "REFLEX_IGNORE_VERSION_CHECK",
  "REFLEX_SHAPE_CHECK_N", "REFLEX_MAX_USER_CHARS", "REFLEX_MAX_ASSISTANT_CHARS", "REFLEX_LOG_PROMPTS", "REFLEX_DECISION_RULE", "REFLEX_MASS_EPS",
  "REFLEX_MAX_SWITCH_PENALTY_USD", "REFLEX_SWITCH_BREAKEVEN_REQUESTS", "REFLEX_DELEGATE", "REFLEX_STATUSLINE", "REFLEX_HOOKS", "REFLEX_ESCALATE", "REFLEX_ESCALATE_TARGET", "REFLEX_ESCALATE_THRESHOLD", "REFLEX_ESCALATE_WINDOW_TURNS", "REFLEX_AB", "REFLEX_EFFORT", "REFLEX_EFFORT_UP", "REFLEX_EFFORT_MIDTURN", "REFLEX_EFFORT_AB", "REFLEX_MODEL_HAIKU", "REFLEX_MODEL_SONNET", "REFLEX_MODEL_OPUS", "REFLEX_MODEL_FABLE",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL",
];

/** Names the claude child must never inherit: our own settings and the decision-backend credentials. */
export const isReflexEnvName = (name: string): boolean => name.startsWith("REFLEX_") || name.startsWith("TYPESAFE_");

/**
 * Names that look like ours but that nothing reads: a typo, or a variable from a plan that was never built.
 * Neither loadConfig nor anything else looks at them, and the launcher strips them from the
 * environment it gives `claude` (every REFLEX_ and TYPESAFE_ name, via isReflexEnvName), so such a variable is
 * silently dropped twice over. `REFLEX_DUMP=1`
 * was set for a whole session on the strength of a note in docs/prior-art.md before anyone noticed nothing read it.
 */
export function unknownReflexEnvNames(env: NodeJS.ProcessEnv): string[] {
  const known = new Set(SETTING_NAMES);
  return Object.keys(env).filter((n) => isReflexEnvName(n) && !known.has(n) && (env[n] ?? "").trim() !== "").sort();
}

const truthy = (v: string | undefined): boolean => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());

function parseEnum<T extends string>(raw: string | undefined, allowed: readonly T[], fallback: T, name: string, errors: string[]): T {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  errors.push(`${name}=${JSON.stringify(raw)} is not one of: ${allowed.join(", ")}`);
  return fallback;
}

const falsy = (v: string | undefined): boolean => v !== undefined && ["0", "false", "no", "off"].includes(v.trim().toLowerCase());

/**
 * REFLEX_ESCALATE accepts the boolean spellings (`1`, `true`, `yes`, `on`) as `on`, plus `shadow` and `off`. A value
 * that is neither a boolean spelling nor a mode is a configuration error rather than a silent `off`: escalation being
 * quietly not on is exactly the failure this setting must not have.
 */
const parseEscalateMode = (raw: string | undefined, errors: string[]): EscalateMode => {
  if (raw === undefined || falsy(raw)) return "off";
  if (truthy(raw)) return "on";
  const v = raw.trim().toLowerCase();
  if ((ESCALATE_MODES as readonly string[]).includes(v)) return v as EscalateMode;
  errors.push(`REFLEX_ESCALATE must be one of ${ESCALATE_MODES.join(", ")} (or 1/true/yes/on for "on"), got ${JSON.stringify(raw)}`);
  return "off";
};

function parseBoundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (Number.isInteger(n) && n >= min && n <= max) return n;
  errors.push(`${name}=${JSON.stringify(raw)} must be an integer between ${min} and ${max}`);
  return fallback;
}

function parseBoundedNumber(raw: string | undefined, fallback: number, min: number, max: number, name: string, errors: string[]): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw.trim());
  if (Number.isFinite(n) && n >= min && n <= max) return n;
  errors.push(`${name}=${JSON.stringify(raw)} must be a number between ${min} and ${max}`);
  return fallback;
}

function parseTiers(raw: string | undefined, allowFable: boolean, errors: string[], warnings: string[]): Tier[] {
  const fallback: Tier[] = ["haiku", "sonnet", "opus"];
  if (raw === undefined || raw.trim() === "") return allowFable ? [...fallback, "fable"] : fallback;
  const out: Tier[] = [];
  for (const t of raw.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
    if (!(TIERS as readonly string[]).includes(t)) {
      errors.push(`REFLEX_TIERS contains unknown tier ${JSON.stringify(t)} (known: ${TIERS.join(", ")})`);
      continue;
    }
    if (t === "fable" && !allowFable) {
      warnings.push("REFLEX_TIERS lists fable but REFLEX_ALLOW_FABLE is not set; fable stays disabled");
      continue;
    }
    if (!out.includes(t as Tier)) out.push(t as Tier);
  }
  return TIERS.filter((t) => out.includes(t)); // canonical cheapest-first order
}

function parseHttpUrl(raw: string, name: string, errors: string[]): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
    return u.href.replace(/\/+$/, "");
  } catch {
    errors.push(`${name} must be an http(s) URL`);
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv, homedir: string = os.homedir()): ConfigResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const mode = parseEnum(setting(env, "REFLEX_MODE"), MODES, "shadow", "REFLEX_MODE", errors);
  const backend = parseEnum(setting(env, "REFLEX_BACKEND"), BACKENDS, "jev", "REFLEX_BACKEND", errors);

  const upstreamRaw = setting(env, "REFLEX_UPSTREAM_URL") ?? setting(env, "ANTHROPIC_BASE_URL") ?? DEFAULT_UPSTREAM;
  const upstreamName = setting(env, "REFLEX_UPSTREAM_URL") !== undefined ? "REFLEX_UPSTREAM_URL" : "ANTHROPIC_BASE_URL";
  const upstreamUrl = parseHttpUrl(upstreamRaw, upstreamName, errors);

  const keyRaw = setting(env, "TYPESAFE_API_KEY");
  let typesafeApiKey: string | undefined;
  if (keyRaw) {
    if (keyRaw.startsWith(TYPESAFE_KEY_PREFIX)) typesafeApiKey = keyRaw;
    else warnings.push(`TYPESAFE_API_KEY does not start with "${TYPESAFE_KEY_PREFIX}"; ignoring it`);
  }

  const jevRaw = setting(env, "REFLEX_JEV_BASE_URL");
  const jevBaseUrl = jevRaw ? parseHttpUrl(jevRaw, "REFLEX_JEV_BASE_URL", errors) : DEFAULT_JEV_BASE_URL;
  let compare = parseEnum(setting(env, "REFLEX_COMPARE"), COMPARE_BACKENDS, "off", "REFLEX_COMPARE", errors);
  if (compare === backend) {
    warnings.push(`REFLEX_COMPARE=${compare} compares against another backend, but it is already REFLEX_BACKEND; ignoring it`);
    compare = "off";
  }
  const allowFable = truthy(setting(env, "REFLEX_ALLOW_FABLE"));
  const tiers = parseTiers(setting(env, "REFLEX_TIERS"), allowFable, errors, warnings);
  const models = Object.fromEntries(
    TIERS.map((t) => [t, setting(env, `REFLEX_MODEL_${t.toUpperCase()}`) ?? setting(env, `ANTHROPIC_DEFAULT_${t.toUpperCase()}_MODEL`) ?? DEFAULT_MODELS[t]]),
  ) as Record<Tier, string>;

  if (errors.length > 0 || upstreamUrl === undefined || jevBaseUrl === undefined) return { ok: false, errors: errors.length > 0 ? errors : ["invalid upstream URL"] };

  const config: Config = {
    mode,
    backend,
    upstreamUrl,
    claudeBin: setting(env, "REFLEX_CLAUDE_BIN"),
    home: defaultHome(env, homedir),
    ignoreVersionCheck: truthy(setting(env, "REFLEX_IGNORE_VERSION_CHECK")),
    typesafeApiKey,
    jevBaseUrl,
    jevDeadlineMs: parseBoundedInt(setting(env, "REFLEX_JEV_DEADLINE_MS"), DEFAULT_JEV_DEADLINE_MS, 50, 60_000, "REFLEX_JEV_DEADLINE_MS", errors),
    warmIntervalMs: parseBoundedInt(setting(env, "REFLEX_WARM_INTERVAL_MS"), DEFAULT_WARM_INTERVAL_MS, 0, 3_600_000, "REFLEX_WARM_INTERVAL_MS", errors),
    layaBin: setting(env, "REFLEX_LAYA_BIN"),
    layaModel: parseEnum(setting(env, "REFLEX_LAYA_MODEL"), LAYA_MODELS, "english", "REFLEX_LAYA_MODEL", errors),
    layaDeadlineMs: parseBoundedInt(setting(env, "REFLEX_LAYA_DEADLINE_MS"), DEFAULT_LAYA_DEADLINE_MS, 50, 60_000, "REFLEX_LAYA_DEADLINE_MS", errors),
    layaReadyTimeoutMs: parseBoundedInt(setting(env, "REFLEX_LAYA_READY_TIMEOUT_MS"), DEFAULT_LAYA_READY_TIMEOUT_MS, 1000, 600_000, "REFLEX_LAYA_READY_TIMEOUT_MS", errors),
    layaCalibration: !falsy(setting(env, "REFLEX_LAYA_CALIBRATION")),
    compare,
    layaBaseUrl: undefined,
    layaApiKey: undefined,
    tiers,
    allowFable,
    upgrades: parseEnum(setting(env, "REFLEX_UPGRADES"), UPGRADE_POLICIES, "off", "REFLEX_UPGRADES", errors),
    mainChat: parseEnum(setting(env, "REFLEX_MAIN_CHAT"), MAIN_CHAT_POLICIES, "guarded", "REFLEX_MAIN_CHAT", errors),
    models,
    shapeCheckN: parseBoundedInt(setting(env, "REFLEX_SHAPE_CHECK_N"), 10, 1, 10_000, "REFLEX_SHAPE_CHECK_N", errors),
    maxUserChars: parseBoundedInt(setting(env, "REFLEX_MAX_USER_CHARS"), 4000, 200, 60_000, "REFLEX_MAX_USER_CHARS", errors),
    maxAssistantChars: parseBoundedInt(setting(env, "REFLEX_MAX_ASSISTANT_CHARS"), 1000, 0, 60_000, "REFLEX_MAX_ASSISTANT_CHARS", errors),
    logPrompts: truthy(setting(env, "REFLEX_LOG_PROMPTS")),
    decisionRule: parseEnum(setting(env, "REFLEX_DECISION_RULE"), DECISION_RULES, "mass", "REFLEX_DECISION_RULE", errors),
    massEps: parseBoundedNumber(setting(env, "REFLEX_MASS_EPS"), 0.1, 0, 0.5, "REFLEX_MASS_EPS", errors),
    maxSwitchPenaltyUsd: parseBoundedNumber(setting(env, "REFLEX_MAX_SWITCH_PENALTY_USD"), 0.01, 0, 100, "REFLEX_MAX_SWITCH_PENALTY_USD", errors),
    switchBreakevenRequests: parseBoundedInt(setting(env, "REFLEX_SWITCH_BREAKEVEN_REQUESTS"), 10, 0, 1000, "REFLEX_SWITCH_BREAKEVEN_REQUESTS", errors),
    delegate: truthy(setting(env, "REFLEX_DELEGATE")),
    statusline: !falsy(setting(env, "REFLEX_STATUSLINE")),
    hooks: parseEnum(setting(env, "REFLEX_HOOKS"), HOOKS_MODES, "auto", "REFLEX_HOOKS", errors),
    escalate: parseEscalateMode(setting(env, "REFLEX_ESCALATE"), errors),
    escalateTarget: parseEnum(setting(env, "REFLEX_ESCALATE_TARGET"), ESCALATE_TARGETS, "requested", "REFLEX_ESCALATE_TARGET", errors),
    abFraction: parseBoundedNumber(setting(env, "REFLEX_AB"), 0, 0, 1, "REFLEX_AB", errors),
    effort: truthy(setting(env, "REFLEX_EFFORT")),
    effortUp: truthy(setting(env, "REFLEX_EFFORT_UP")),
    effortMidturn: truthy(setting(env, "REFLEX_EFFORT_MIDTURN")),
    effortAbFraction: parseBoundedNumber(setting(env, "REFLEX_EFFORT_AB"), 0, 0, 1, "REFLEX_EFFORT_AB", errors),
    escalateThreshold: parseBoundedNumber(setting(env, "REFLEX_ESCALATE_THRESHOLD"), DEFAULT_ESCALATE_THRESHOLD, 0, CORRECTION_SCORE_CAP, "REFLEX_ESCALATE_THRESHOLD", errors),
    escalateWindowTurns: parseBoundedInt(setting(env, "REFLEX_ESCALATE_WINDOW_TURNS"), DEFAULT_ESCALATE_WINDOW_TURNS, 1, 20, "REFLEX_ESCALATE_WINDOW_TURNS", errors),
  };
  if (errors.length > 0) return { ok: false, errors };
  if (config.abFraction > 0 && mode !== "route") warnings.push(`REFLEX_AB has no effect with REFLEX_MODE=${mode} (nothing is routed, so there is nothing to hold back as a control)`);
  if (config.escalate === "on" && mode !== "route") warnings.push(`REFLEX_ESCALATE=on has no effect with REFLEX_MODE=${mode} (escalation only changes a request in route mode)`);
  if (config.effort && mode !== "route") warnings.push(`REFLEX_EFFORT has no effect with REFLEX_MODE=${mode} (effort is only changed in route mode)`);
  if (config.effortUp && !config.effort) warnings.push("REFLEX_EFFORT_UP has no effect without REFLEX_EFFORT=1");
  if (config.effortMidturn && !config.effort) warnings.push("REFLEX_EFFORT_MIDTURN has no effect without REFLEX_EFFORT=1");
  if (config.effortAbFraction > 0 && !config.effort) warnings.push("REFLEX_EFFORT_AB has no effect without REFLEX_EFFORT=1");
  if (config.delegate && mode === "off") warnings.push("REFLEX_DELEGATE has no effect with REFLEX_MODE=off (the hint travels through reflex's hooks)");
  if (config.delegate && config.hooks === "off") warnings.push("REFLEX_DELEGATE has no effect with REFLEX_HOOKS=off (the hint travels through reflex's hooks)");
  return { ok: true, config, warnings };
}
