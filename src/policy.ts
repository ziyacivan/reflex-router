// ALL routing policy: the questions asked, how answers become a Judgement, and how a Judgement becomes a RoutePlan.
// Pure (no I/O). Organised as tables so a new dimension (effort) is new rows, not a restructure. The backend's answers
// decide; reflex's own constants (the downgrade margin, the reasoning_demand limits, the confidence floors) only say how
// an answer is read, and every one is logged next to the raw answers.
import type { Config, Tier } from "./config.js";
import { fitsContext, tierRank, tierOfModel } from "./tiers.js";
import type { Answer, Decision, Dimension, Effort, EffortReason, Judgement, Picked, QuestionSet, ReasonCode, RoutePlan, Target } from "./types.js";
import { EFFORTS, isEffort } from "./wire/effort.js";

/**
 * `argmax` rule only: a downgrade needs at least this choice confidence (a spread statistic, not the top
 * probability). The `mass` rule carries its own certainty requirement (eps) and does not use it.
 */
export const DOWNGRADE_MIN_CONFIDENCE = 0.7;
/** Upgrades under REFLEX_UPGRADES=confident need at least this. */
export const UPGRADE_MIN_CONFIDENCE = 0.7;
/** Composite veto: the highest reasoning_demand score (0..4) that still allows a downgrade TO this tier. */
export const MAX_REASONING_DEMAND_FOR: Readonly<Partial<Record<Tier, number>>> = { haiku: 1.0, sonnet: 2.5 };

const STATE_GUIDE =
  "`task` is the work to be done. `previous_assistant_reply`, when present, is the end of the assistant's previous message, for context only. " +
  "`context.is_subagent` says whether another agent delegated this task; `context.requesting_tier` is the tier the client asked for.";

const TIER_OPTIONS: Readonly<Record<Tier, { what: string; not_for: string; examples: readonly string[] }>> = {
  haiku: {
    what: "Mechanical or tightly specified work where the approach is obvious and a mistake is easy to spot.",
    not_for: "Anything that needs a diagnosis, a design choice, or understanding how several parts interact.",
    examples: ["list the files in a directory", "rename a variable across one file", "run the tests and report the result", "find where a function is defined"],
  },
  sonnet: {
    what: "Ordinary software work: a well-understood change or investigation that takes some judgement about the approach.",
    not_for: "Problems whose cause is unknown across systems, or decisions where a subtle mistake is costly.",
    examples: ["add a flag to a CLI command and its tests", "fix a failing test with a clear error message", "summarise how a module works"],
  },
  opus: {
    what: "Hard reasoning: unknown-cause debugging, cross-module design, security-sensitive or subtle correctness work.",
    not_for: "Routine changes whose approach is already clear.",
    examples: ["find why a race condition corrupts data intermittently", "design the module boundaries for a new subsystem", "review an auth flow for vulnerabilities"],
  },
  fable: {
    what: "The most demanding open-ended research and reasoning, beyond what opus handles well.",
    not_for: "Any task opus can do well.",
    examples: ["invent and prove a new algorithm for an open problem"],
  },
};

const REASONING_LEVELS = [
  { what: "Mechanical: rename, reformat, run one command, look something up, list files." },
  { what: "Routine: a small, well-specified change or search with an obvious approach." },
  { what: "Moderate: a multi-step change within one area that needs some judgement about the approach." },
  { what: "Hard: debugging with an unclear cause, a change spanning several modules, or non-trivial design choices." },
  { what: "Open-ended: unknown-cause debugging across systems, architecture decisions, security-sensitive changes, novel algorithms." },
] as const;

/** Tiers offered to the backend: Fable only when explicitly allowed. */
export const offeredTiers = (cfg: Pick<Config, "allowFable">): Tier[] => (cfg.allowFable ? ["haiku", "sonnet", "opus", "fable"] : ["haiku", "sonnet", "opus"]);

/**
 * The `mass` rule. Tiers are ordered, and the question that matters is "is anything above T needed?". Walking from
 * the cheapest offered tier upwards, pick the first T whose more expensive tiers together get at most `eps`. So a
 * tier Jev gives more than eps to is never undercut, and a split like sonnet 0.55 / haiku 0.45 / opus 0 picks
 * sonnet (Jev is sure opus is not needed) where argmax-with-confidence would keep the request on opus. Pure.
 */
export function massPick(probabilities: Readonly<Record<string, number>>, offered: readonly Tier[], eps: number): { value: Tier; aboveMass: number } {
  const ordered = [...offered].sort((a, b) => tierRank(a) - tierRank(b));
  for (let i = 0; i < ordered.length; i++) {
    const above = ordered.slice(i + 1).reduce((sum, t) => sum + (probabilities[t] ?? 0), 0);
    if (above <= eps + 1e-9) return { value: ordered[i]!, aboveMass: Math.round(above * 1e6) / 1e6 };
  }
  return { value: ordered.at(-1)!, aboveMass: 0 };
}

type Part = Partial<Pick<Judgement, "tier" | "rule" | "readings">> & { vetoes?: Record<string, number> };

interface QuestionSpec {
  build(cfg: Config): QuestionSet[string];
  /** Reads this question's answer into part of a Judgement; returns an error string for a malformed answer. */
  read(a: Answer, cfg: Config): Part | string;
}

/** 1. Questions, all asked in one backend call. */
export const QUESTIONS: Readonly<Record<string, QuestionSpec>> = {
  tier: {
    build: (cfg) => ({
      type: "choice",
      instructions: {
        question: "Which is the least capable Claude model tier that will still do this task well?",
        focus:
          "Judge the reasoning the task demands: ambiguity, how many interacting parts must be understood at once, and how costly a subtle mistake would be. " +
          "The length of the message, the length of the expected reply and the number of files mentioned are NOT the measure.",
        state: STATE_GUIDE,
      },
      criteria: Object.fromEntries(offeredTiers(cfg).map((t) => [t, TIER_OPTIONS[t]])),
    }),
    read: (a, cfg) => {
      if (a.type !== "choice") return "tier: not a choice answer";
      const offered = offeredTiers(cfg) as string[];
      if (!offered.includes(a.choice)) return "tier: choice is not an offered tier";
      const readings = { mass: massPick(a.probabilities, offeredTiers(cfg), cfg.massEps), argmax: { value: a.choice as Tier, confidence: a.confidence } };
      const applied = cfg.decisionRule === "mass" ? readings.mass.value : readings.argmax.value;
      const tier: Picked<Tier> = { value: applied, confidence: a.confidence, probabilities: a.probabilities };
      return { tier, rule: cfg.decisionRule, readings };
    },
  },
  reasoning_demand: {
    build: () => ({
      type: "score",
      instructions: { question: "How much reasoning does this task demand?", focus: "Judge the thinking required, not the amount of text or the number of steps.", state: STATE_GUIDE },
      criteria: REASONING_LEVELS,
    }),
    read: (a) => (a.type === "score" ? { vetoes: { reasoning_demand: a.score } } : "reasoning_demand: not a score answer"),
  },
};

export const buildQuestions = (cfg: Config): QuestionSet => Object.fromEntries(Object.entries(QUESTIONS).map(([id, q]) => [id, q.build(cfg)]));

/** 3a. Merges every question's reading. A missing or malformed answer is an error (the caller fails open). */
export function judge(decision: Decision, cfg: Config): { ok: true; judgement: Judgement } | { ok: false; error: string } {
  let tier: Picked<Tier> | undefined;
  let rule: Judgement["rule"] = cfg.decisionRule;
  let readings: Judgement["readings"] | undefined;
  const vetoes: Record<string, number> = {};
  for (const [id, spec] of Object.entries(QUESTIONS)) {
    const a = decision.answers[id];
    if (!a) return { ok: false, error: `${id}: missing answer` };
    const part = spec.read(a, cfg);
    if (typeof part === "string") return { ok: false, error: part };
    if (part.tier) tier = part.tier;
    if (part.rule) rule = part.rule;
    if (part.readings) readings = part.readings;
    Object.assign(vetoes, part.vetoes ?? {});
  }
  if (!tier || !readings) return { ok: false, error: "no tier answer" };
  return { ok: true, judgement: { tier, rule, readings, vetoes } };
}

/** What the plan needs to know about the request (no body access). */
export interface PlanInput {
  readonly kind: "main" | "subagent";
  readonly requestedModel: string | null;
  /** Estimated context in tokens (src/tiers.ts); tiers whose ceiling it exceeds are not candidates. Null = unknown. */
  readonly contextTokens?: number | null;
}

interface DimensionRules {
  apply(input: PlanInput, j: Judgement, cfg: Config): { target: Partial<Target> | null; reasons: ReasonCode[]; wouldUpgrade: boolean };
}

/**
 * Lowest enabled tier at or above `from` (and below `below`, when given) whose context ceiling fits `ctx`. Never
 * steps down. Null when none qualifies.
 */
export function clampUp(from: Tier, cfg: Pick<Config, "tiers">, below?: Tier, ctx: number | null = null): Tier | null {
  return cfg.tiers.find((t) => tierRank(t) >= tierRank(from) && (below === undefined || tierRank(t) < tierRank(below)) && fitsContext(t, ctx)) ?? null;
}

/** 2. Per-dimension rules. Phase 1 populates only "tier". */
export const DIMENSIONS: Readonly<Partial<Record<Dimension, DimensionRules>>> = {
  tier: {
    apply(input, j, cfg) {
      const requested = tierOfModel(input.requestedModel);
      if (requested === null) return { target: null, reasons: ["requested_tier_unknown"], wouldUpgrade: false };
      const chosen = j.tier.value;
      if (chosen === requested) return { target: null, reasons: ["same_tier"], wouldUpgrade: false };

      if (tierRank(chosen) < tierRank(requested)) {
        if (j.rule === "argmax" && j.tier.confidence < DOWNGRADE_MIN_CONFIDENCE) return { target: null, reasons: ["low_confidence"], wouldUpgrade: false };
        const limit = MAX_REASONING_DEMAND_FOR[chosen];
        const demand = j.vetoes["reasoning_demand"];
        if (limit !== undefined && (demand === undefined || demand > limit)) return { target: null, reasons: ["veto_reasoning_demand"], wouldUpgrade: false };
        const ctx = input.contextTokens ?? null;
        const to = clampUp(chosen, cfg, requested, ctx);
        const moved: ReasonCode[] = to === chosen ? [] : fitsContext(chosen, ctx) ? ["clamped_up"] : ["context_ceiling"];
        if (to === null) return { target: null, reasons: [...moved.filter((r) => r === "context_ceiling"), "no_enabled_tier"], wouldUpgrade: false };
        return { target: { tier: to }, reasons: ["downgrade", ...moved], wouldUpgrade: false };
      }

      // The applied reading wants a stronger tier than the client asked for. The `mass` rule's margin (eps) was measured
      // for moving DOWN; read the other way it turns any tail of probability on a stronger tier into a move up, even when
      // the backend's own answer is the tier already asked for (31 of 52 upgrades in the 2026-09 logs). A move up
      // therefore follows the backend's own answer (argmax); a mass-only tail raises effort instead.
      const jev = j.readings.argmax.value;
      if (cfg.upgrades === "off") return { target: null, reasons: ["upgrade_disabled"], wouldUpgrade: true };
      if (tierRank(jev) <= tierRank(requested)) return { target: null, reasons: ["upgrade_to_effort"], wouldUpgrade: false };
      if (cfg.upgrades === "confident" && j.readings.argmax.confidence < UPGRADE_MIN_CONFIDENCE) return { target: null, reasons: ["upgrade_low_confidence"], wouldUpgrade: true };
      const to = clampUp(jev, cfg);
      if (to === null) return { target: null, reasons: ["no_enabled_tier"], wouldUpgrade: true };
      return { target: { tier: to }, reasons: to === jev ? ["upgrade"] : ["upgrade", "clamped_up"], wouldUpgrade: true };
    },
  },
};

/**
 * 3b. Pure. The plan for one `new` turn: main-chat scope first, then every populated dimension. The main-chat cost
 * guard, disabled tiers and rewrite verification are applied afterwards by the router (they need session state).
 */
export function plan(input: PlanInput, j: Judgement, cfg: Config): RoutePlan {
  if (input.kind === "main" && cfg.mainChat === "never") return { target: null, reasons: ["main_chat_disabled"], wouldUpgrade: false };
  const tier = DIMENSIONS.tier?.apply(input, j, cfg);
  if (!tier) return { target: null, reasons: [], wouldUpgrade: false };
  const target: Target | null = tier.target?.tier ? { tier: tier.target.tier } : null;
  return { target, reasons: tier.reasons, wouldUpgrade: tier.wouldUpgrade };
}

/**
 * REFLEX_EFFORT: the level for a `new` turn, read from the reasoning_demand score (0..4) already asked for the tier,
 * one level per step of its scale: 0 mechanical -> low, 1 routine -> medium, 2 moderate -> high, 3 hard -> xhigh,
 * 4 open-ended -> max (rounded to the nearest step). The backend's score alone sets the level, and the raw score is logged.
 * The target is absolute (the level the turn should run at), so a later turn can undo an earlier one; it never goes above the client's level unless `up`.
 */
export function effortPlan(demand: number | undefined, requested: string | null, up: boolean): { pick: Effort; target: Effort | null; reasons: EffortReason[] } | null {
  if (demand === undefined || !Number.isFinite(demand)) return null;
  const pick = EFFORTS[Math.min(EFFORTS.length - 1, Math.max(0, Math.round(demand)))]!;
  if (!isEffort(requested)) return { pick, target: null, reasons: ["effort_requested_unknown"] };
  const d = EFFORTS.indexOf(pick) - EFFORTS.indexOf(requested);
  if (d > 0 && !up) return { pick, target: requested, reasons: ["effort_up_disabled"] };
  return { pick, target: pick, reasons: [d < 0 ? "effort_down" : d > 0 ? "effort_up" : "effort_same"] };
}

