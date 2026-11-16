import {
  GOAL_EXERCISE,
  GOAL_METRICS,
  isGoalTest,
  isUsefulGoalEffort,
  LOGGED_FLAG,
  METRIC_PLURAL,
  prescribedValue,
  prescriptionEffort,
  topBlock,
  type GoalMetric
} from "./goal-metrics";
import type { EffortLabel, PlannedExercisePrescription, TrainingLog } from "./types";

/**
 * Delivered work against the plan. A coach judges a session by what the
 * athlete actually did, not only by what was planned: 38 push-ups on a day
 * that asked for 10, rated hard, is an athlete who wanted and could do more,
 * not an athlete who is overreaching. The same numbers on the plan's own
 * targets are what the effort, progression and decline rules compare with.
 */
export const DELIVERED_WORK = {
  /** More than planned starts at this many extra reps (or seconds) and at least this share of the plan. */
  minExtraReps: 2,
  minExtraSeconds: 5,
  minExtraRatio: 0.1
} as const;

export type DeliveredVsPlanned = {
  metric: GoalMetric;
  planned: number;
  delivered: number;
  delta: number;
  /** Clearly more than planned: the athlete chose to do more. */
  overDelivered: boolean;
  /** Fewer than planned: the athlete fell short of the plan. */
  shortfall: boolean;
};

/** Extra reps (or seconds) that count as clearly more than planned. */
export function overDeliveryMargin(metric: GoalMetric, planned: number): number {
  const minimum = metric === "plankSeconds" ? DELIVERED_WORK.minExtraSeconds : DELIVERED_WORK.minExtraReps;
  return Math.max(minimum, Math.ceil(planned * DELIVERED_WORK.minExtraRatio));
}

/**
 * The session's planned target for a metric: the highest target of that
 * exercise in the session with any effort label (light and technique work
 * included). Null when the session planned none, or when it tests that
 * exercise: the logged best set is then the test result, not extra work.
 */
export function plannedTargetFor(metric: GoalMetric, exercises: PlannedExercisePrescription[] | undefined): number | null {
  const ofMetric = (exercises ?? []).filter((exercise) => exercise.exercise === GOAL_EXERCISE[metric]);
  if (ofMetric.some((exercise) => isGoalTest(prescriptionEffort(exercise)))) return null;
  const targets = ofMetric.map((exercise) => prescribedValue(metric, exercise)).filter((target) => target > 0);
  return targets.length > 0 ? Math.max(...targets) : null;
}

export type PlannedBlock = { target: number; sets: number; label: EffortLabel | undefined };

/**
 * The block of a session a log of `metric` is judged against: the top
 * working block (highest target, then most sets; not light, technique or
 * recovery work); without one, and unless `workingSetsOnly`, the top block
 * of any label. Null when the session tests the exercise (the logged best is
 * then the test result) or planned none of it.
 */
export function plannedBlockFor(
  metric: GoalMetric,
  exercises: PlannedExercisePrescription[] | undefined,
  options: { workingSetsOnly?: boolean } = {}
): PlannedBlock | null {
  const ofMetric = (exercises ?? []).filter((exercise) => exercise.exercise === GOAL_EXERCISE[metric]);
  if (ofMetric.some((exercise) => isGoalTest(prescriptionEffort(exercise)))) return null;
  const blocks = ofMetric
    .map((exercise) => ({
      target: prescribedValue(metric, exercise),
      sets: exercise.sets,
      label: exercise.plannedEffortLabel,
      working: isUsefulGoalEffort(prescriptionEffort(exercise))
    }))
    .filter((block) => block.target > 0 && block.sets > 0);
  const top = topBlock(blocks.filter((block) => block.working)) ?? (options.workingSetsOnly ? null : topBlock(blocks));
  return top ? { target: top.target, sets: top.sets, label: top.label } : null;
}

/** Each logged goal metric of a session against that session's planned target. */
export function deliveredVsPlanned(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): DeliveredVsPlanned[] {
  return GOAL_METRICS.flatMap((metric) => {
    if (!log[LOGGED_FLAG[metric]]) return [];
    const planned = plannedTargetFor(metric, exercises);
    const delivered = log[metric];
    if (planned === null || typeof delivered !== "number" || !Number.isFinite(delivered)) return [];
    const delta = delivered - planned;
    return [{ metric, planned, delivered, delta, overDelivered: delta >= overDeliveryMargin(metric, planned), shortfall: delta < 0 }];
  });
}

/** "38 push-ups against 10 planned", "45 s plank against 30 s planned". */
export function describeDelivered(entry: DeliveredVsPlanned): string {
  return entry.metric === "plankSeconds"
    ? `${entry.delivered} s plank against ${entry.planned} s planned`
    : `${entry.delivered} ${METRIC_PLURAL[entry.metric]} against ${entry.planned} planned`;
}

/** The athlete did more than planned: one goal metric clearly above the plan, none below it. */
export function didMoreThanPlanned(entries: DeliveredVsPlanned[]): boolean {
  return entries.some((entry) => entry.overDelivered) && !entries.some((entry) => entry.shortfall);
}

/** "more than planned: 38 push-ups against 10 planned", the shortfall, or null when the plan was met. */
export function describeDeliveredVsPlan(entries: DeliveredVsPlanned[]): string | null {
  if (didMoreThanPlanned(entries)) return `more than planned: ${entries.filter((entry) => entry.overDelivered).map(describeDelivered).join(", ")}`;
  const short = entries.filter((entry) => entry.shortfall);
  return short.length > 0 ? `less than planned: ${short.map(describeDelivered).join(", ")}` : null;
}
