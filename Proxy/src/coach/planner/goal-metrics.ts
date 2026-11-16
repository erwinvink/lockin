import type { EffortLabel, EffortStimulus, PlannedEffort, PlannedExercisePrescription, WeeklyPlan } from "./types";

/**
 * The goal metrics and the effort vocabulary every strength rule shares:
 * metric and exercise lookups, names, what a goal test is, what counts as
 * useful goal work, the effort order and the top block. This module imports
 * no other planner module (types only), so any of them can use it.
 */

export type GoalMetric = "pullUps" | "pushUps" | "plankSeconds";
export type GoalExercise = "pullUp" | "pushUp" | "plank";

export const GOAL_METRICS: readonly GoalMetric[] = ["pullUps", "pushUps", "plankSeconds"];

export const GOAL_EXERCISE: Readonly<Record<GoalMetric, GoalExercise>> = { pullUps: "pullUp", pushUps: "pushUp", plankSeconds: "plank" };
const METRIC_OF_EXERCISE: Readonly<Record<GoalExercise, GoalMetric>> = { pullUp: "pullUps", pushUp: "pushUps", plank: "plankSeconds" };

/** The log field that says the metric was logged. */
export const LOGGED_FLAG: Readonly<Record<GoalMetric, "loggedPullUps" | "loggedPushUps" | "loggedPlankSeconds">> = {
  pullUps: "loggedPullUps",
  pushUps: "loggedPushUps",
  plankSeconds: "loggedPlankSeconds"
};

/** Before a noun: "push-up work", "a plank test". */
export const METRIC_LABEL: Readonly<Record<GoalMetric, string>> = { pullUps: "pull-up", pushUps: "push-up", plankSeconds: "plank" };
/** The exercise inside a sentence: "push-ups hold". */
export const METRIC_PLURAL: Readonly<Record<GoalMetric, string>> = { pullUps: "pull-ups", pushUps: "push-ups", plankSeconds: "plank" };
/** The exercise at the start of a sentence or an athlete-facing note. */
export const METRIC_NAME: Readonly<Record<GoalMetric, string>> = { pullUps: "Pull-ups", pushUps: "Push-ups", plankSeconds: "Plank" };
export const METRIC_UNIT: Readonly<Record<GoalMetric, "reps" | "seconds">> = { pullUps: "reps", pushUps: "reps", plankSeconds: "seconds" };

export function metricForExercise(exercise: unknown): GoalMetric | null {
  return typeof exercise === "string" && Object.hasOwn(METRIC_OF_EXERCISE, exercise) ? METRIC_OF_EXERCISE[exercise as GoalExercise] : null;
}

/** The planned exercise field that holds the metric's value: seconds for the plank, reps otherwise. */
export function goalField(metric: GoalMetric): "reps" | "seconds" {
  return metric === "plankSeconds" ? "seconds" : "reps";
}

/** A planned exercise's reps (or seconds for the plank); 0 when missing. */
export function goalValue(metric: GoalMetric, exercise: { reps?: unknown; seconds?: unknown }): number {
  const value = exercise[goalField(metric)];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A logged session's planned target for the metric (target seconds for the plank). */
export function prescribedValue(metric: GoalMetric, exercise: Pick<PlannedExercisePrescription, "targetReps" | "targetSeconds">): number {
  const value = metric === "plankSeconds" ? exercise.targetSeconds : exercise.targetReps;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Effort labels from easiest to hardest. */
export const EFFORT_ORDER: readonly EffortLabel[] = ["light", "medium", "hard", "very_hard", "max_output"];
/** How an effort label reads in athlete-facing text. */
export const EFFORT_WORD: Readonly<Record<EffortLabel, string>> = {
  light: "light",
  medium: "medium",
  hard: "hard",
  very_hard: "very hard",
  max_output: "max effort"
};

const HARD_LABELS = new Set<string>(["hard", "very_hard", "max_output"]);
const NEAR_LIMIT_LABELS = new Set<string>(["very_hard", "max_output"]);

export function isEffortLabel(label: unknown): label is EffortLabel {
  return typeof label === "string" && (EFFORT_ORDER as readonly string[]).includes(label);
}

/** hard, very_hard or max_output. */
export function isHardLabel(label: unknown): boolean {
  return typeof label === "string" && HARD_LABELS.has(label);
}

/** very_hard or max_output. */
export function isNearLimitLabel(label: unknown): boolean {
  return typeof label === "string" && NEAR_LIMIT_LABELS.has(label);
}

/** The hardest known label of a list, or null when none is known. */
export function hardestOf(labels: readonly unknown[]): EffortLabel | null {
  let hardest: EffortLabel | null = null;
  for (const label of labels) {
    if (isEffortLabel(label) && (hardest === null || EFFORT_ORDER.indexOf(label) > EFFORT_ORDER.indexOf(hardest))) hardest = label;
  }
  return hardest;
}

type LooseEffort = { label?: unknown; stimulus?: unknown } | null | undefined;

/** The label an effort counts as: a test is one max set (max_output) whatever its label says. */
export function effortLabelOf(effort: LooseEffort): unknown {
  return isGoalTest(effort) ? "max_output" : effort?.label;
}

/** A session's hard label (hard, very_hard or max_output in the session or any exercise, a test included; the hardest), or null. */
export function hardestLabel(session: Pick<WeeklyPlan["sessions"][number], "plannedEffort" | "exercises">): EffortLabel | null {
  const labels = [session.plannedEffort, ...(Array.isArray(session.exercises) ? session.exercises : []).map((exercise) => exercise?.plannedEffort)].map(effortLabelOf);
  const hardest = hardestOf(labels);
  return hardest !== null && isHardLabel(hardest) ? hardest : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A goal test: a test stimulus or a max_output label (max_output is only for
 * a deliberate test, so a max set is a test whatever its stimulus says).
 */
export function isGoalTest(effort: LooseEffort): boolean {
  return effort?.stimulus === "test" || effort?.label === "max_output";
}

/** A logged plan's exercise effort, in the planned-effort shape. */
export function prescriptionEffort(exercise: Pick<PlannedExercisePrescription, "plannedEffortLabel" | "plannedEffortStimulus">): {
  label: EffortLabel | undefined;
  stimulus: EffortStimulus | undefined;
} {
  return { label: exercise.plannedEffortLabel, stimulus: exercise.plannedEffortStimulus };
}

/**
 * Goal work that counts for progression: not light, not technique or
 * recovery work, not a test (a past prescription without a label counts).
 */
export function isUsefulGoalEffort(effort: LooseEffort): boolean {
  if (!effort) return false;
  return effort.label !== "light" && effort.stimulus !== "recovery" && effort.stimulus !== "technique" && !isGoalTest(effort);
}

/**
 * The top block of a goal exercise: the highest target, then the most sets.
 * Which blocks take part is the caller's: useful work for progression and
 * the session budget, every block but a test for the overreaching band.
 */
export function topBlock<T extends { target: number; sets: number }>(blocks: readonly T[]): T | null {
  let top: T | null = null;
  for (const block of blocks) {
    if (top === null || block.target > top.target || (block.target === top.target && block.sets > top.sets)) top = block;
  }
  return top;
}

const LOWERED_RPE: Record<"light" | "medium" | "hard", { rpe: number; rir: number }> = {
  light: { rpe: 3, rir: 5 },
  medium: { rpe: 6, rir: 4 },
  hard: { rpe: 8, rir: 2 }
};

/** The text ending in a full stop. */
function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A planned effort lowered to `label`, with the matching RPE and RIR (a test becomes strength work). */
export function loweredEffort(effort: PlannedEffort, label: "light" | "medium" | "hard", why: string): PlannedEffort {
  return {
    ...effort,
    label,
    targetRPE: LOWERED_RPE[label].rpe,
    targetRIR: Math.max(effort.targetRIR, LOWERED_RPE[label].rir),
    stimulus: effort.stimulus === "test" ? "strength" : effort.stimulus,
    reason: `${sentence(effort.reason?.trim() || "Planned effort")} Lowered to ${label} effort (${why}).`
  };
}
