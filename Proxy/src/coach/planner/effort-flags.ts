import { deliveredVsPlanned, describeDelivered, didMoreThanPlanned, overDeliveryMargin, plannedBlockFor, type PlannedBlock } from "./delivered-work";
import {
  GOAL_METRICS,
  isGoalTest,
  LOGGED_FLAG,
  METRIC_PLURAL,
  metricForExercise,
  prescriptionEffort,
  type GoalMetric
} from "./goal-metrics";
import type { EffortLabel, PlannedExercisePrescription, TrainingLog } from "./types";

/**
 * Effort judged against the plan, and the readiness ladder it feeds:
 * - calibrate: 2 of the last 5 sessions done as planned were rated 2 or more
 *   RPE above plan. The goal exercises those sessions trained hold (no
 *   progression, no extra set); readiness stays normal. Delivered work ends
 *   the hold: a later session of the exercise that was clearly more than
 *   planned, on any block (light or technique work included: the athlete
 *   who does more than the plan wants more), or a clean completion of its
 *   working sets as planned (RPE at most 1 above plan). Light technique work
 *   merely done as planned does not end it.
 * - overreaching: an effort flag plus a second marker within 14 days: a
 *   shortfall on a working target the athlete completed cleanly before (a
 *   test's max set does not count), the effort
 *   flag persisting (3 of the last 5), or 2 of the last 5 sessions rated Weak
 *   or Very weak. (A rolling decline with 2 or more results below plan is the
 *   other route; see summarize-training-history.ts.)
 * - recovery_needed: pain 4+ or Very weak feedback (readiness-flags.ts).
 *
 * Planned near-max work is the plan, not a warning: RPE 9+ counts only on
 * work planned below very_hard, and a session that tested a goal exercise or
 * did clearly more than planned (delivered-work.ts) never counts.
 */
export const EFFORT_LIMITS = {
  /** The effort flags read the last 5 logs. */
  window: 5,
  /** Near-max effort: RPE 9 or more ... */
  highEffortRPE: 9,
  /** ... on work planned at RPE 8 or less (below very_hard). */
  plannedBelowVeryHardRPE: 8,
  /** repeated_high_perceived_effort: 3 of the last 5. */
  highEffortLogs: 3,
  /** recent_effort_above_plan: 2 of the last 5 rated 2 or more above plan. */
  abovePlanBy: 2,
  abovePlanLogs: 2,
  /** The effort flag persists: 3 of the last 5. */
  persistentLogs: 3,
  /** The second marker falls within this many days. */
  coSignalDays: 14,
  /** Weak (8) or Very weak (10) how-you-felt feedback. */
  weakFatigueLevel: 7,
  weakLogs: 2
} as const;

/**
 * Planned RPE assumed when a log carries none (manually logged or legacy
 * sessions): the planned effort label's RPE when known, else 7 (a normal
 * hard working set).
 */
export const DEFAULT_PLANNED_RPE = 7;
export const PLANNED_RPE_FOR_LABEL: Record<EffortLabel, number> = {
  light: 4,
  medium: 6,
  hard: 7,
  very_hard: 9,
  max_output: 10
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The planned exercises of a log's session (undefined when the session is unknown). */
export type SessionPlanOf = (log: TrainingLog) => PlannedExercisePrescription[] | undefined;

export function rpeForLabel(label: unknown): number | undefined {
  return typeof label === "string" && Object.hasOwn(PLANNED_RPE_FOR_LABEL, label) ? PLANNED_RPE_FOR_LABEL[label as EffortLabel] : undefined;
}

export function validRPE(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 10 ? rounded : undefined;
}

/** The rating the athlete gave: actualRPE, else rpe (as stored when out of range). */
export function actualRPE(log: TrainingLog): number {
  return validRPE(log.actualRPE) ?? validRPE(log.rpe) ?? log.rpe;
}

/** The planned RPE a log is judged against: its own, else its planned label's, else its session's hardest label, else 7. */
export function plannedRPEOf(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): number {
  const sessionRPEs = (exercises ?? []).map((exercise) => rpeForLabel(exercise.plannedEffortLabel)).filter((rpe): rpe is number => rpe !== undefined);
  return validRPE(log.plannedRPE) ??
    rpeForLabel(log.plannedEffortLabel) ??
    (sessionRPEs.length > 0 ? Math.max(...sessionRPEs) : undefined) ??
    DEFAULT_PLANNED_RPE;
}

/**
 * A clean completion of `metric` in a logged session, judged against one
 * block (plannedBlockFor): the logged best met its target, without pain of 4
 * or more or very weak feedback, and the effort was at most 1 above the
 * planned RPE unless the athlete did clearly more than planned (that explains
 * a higher rating). The planned RPE is the log's own, else its planned label,
 * else that block's label (the exercise's own, not the session's hardest),
 * else 7. A session without a valid rating (actualRPE or rpe from 1 to 10) is
 * no clean completion: its effort is unknown. `workingSetsOnly`: only a working block counts (light, technique
 * and recovery work say nothing about working effort). Returns the block the
 * log completed cleanly, or null.
 */
export function cleanCompletion(
  log: TrainingLog,
  exercises: PlannedExercisePrescription[] | undefined,
  metric: GoalMetric,
  options: { workingSetsOnly?: boolean } = {}
): PlannedBlock | null {
  const block = plannedBlockFor(metric, exercises, options);
  const delivered = log[metric];
  if (!block || !log[LOGGED_FLAG[metric]] || typeof delivered !== "number" || delivered < block.target) return null;
  if (log.painLevel >= 4 || log.fatigueLevel >= 9) return null;
  // Unrated (no valid 1-10 rating): the effort is unknown, so it is no clean completion.
  const rated = validRPE(log.actualRPE) ?? validRPE(log.rpe);
  if (rated === undefined) return null;
  const planned = validRPE(log.plannedRPE) ?? rpeForLabel(log.plannedEffortLabel) ?? rpeForLabel(block.label) ?? DEFAULT_PLANNED_RPE;
  const overDelivered = delivered - block.target >= overDeliveryMargin(metric, block.target);
  return rated <= planned + 1 || overDelivered ? block : null;
}

/** The session tested a goal exercise (one max set): its high rating is the plan. */
export function testsAGoal(exercises: PlannedExercisePrescription[] | undefined): boolean {
  return (exercises ?? []).some((exercise) => metricForExercise(exercise.exercise) !== null && isGoalTest(prescriptionEffort(exercise)));
}

/** Effort counts as a signal only on work done as planned: no test, nothing clearly more than planned. */
function judgedAgainstPlan(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): boolean {
  return !testsAGoal(exercises) && !didMoreThanPlanned(deliveredVsPlanned(log, exercises));
}

/** RPE 9 or more on work planned below very_hard (not a test, not more than planned). */
export function highEffortOffPlan(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): boolean {
  return actualRPE(log) >= EFFORT_LIMITS.highEffortRPE &&
    plannedRPEOf(log, exercises) <= EFFORT_LIMITS.plannedBelowVeryHardRPE &&
    judgedAgainstPlan(log, exercises);
}

/** Planned work rated 2 or more above its planned RPE (not a test, not more than planned). */
export function effortAbovePlan(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): boolean {
  const planned = validRPE(log.plannedRPE);
  return planned !== undefined && actualRPE(log) - planned >= EFFORT_LIMITS.abovePlanBy && judgedAgainstPlan(log, exercises);
}

/** The goal exercises a session trained: what was logged, else what the session planned. */
export function goalMetricsTrained(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined): GoalMetric[] {
  const logged = GOAL_METRICS.filter((metric) => log[LOGGED_FLAG[metric]]);
  if (logged.length > 0) return logged;
  return GOAL_METRICS.filter((metric) => (exercises ?? []).some((exercise) => metricForExercise(exercise.exercise) === metric));
}

export type EffortReadiness = {
  /** repeated_high_perceived_effort and recent_effort_above_plan, as they apply. */
  flags: string[];
  /** Why readiness is overreaching (an effort flag and a second marker within 14 days), or null. */
  overreaching: string | null;
  /** Effort above plan without a second marker: these goal exercises hold. */
  calibration: { metrics: GoalMetric[]; reason: string } | null;
};

/**
 * The effort flags of the last 5 logs and what they mean for readiness.
 * `sinceMs` (the plan block start) limits which earlier logs count as a
 * target completed cleanly before.
 */
export function effortReadiness(sortedLogs: TrainingLog[], planOf: SessionPlanOf, now: Date, sinceMs: number | null = null): EffortReadiness {
  const nowMs = now.getTime();
  const last = sortedLogs.slice(-EFFORT_LIMITS.window);
  const high = last.filter((log) => highEffortOffPlan(log, planOf(log)));
  const above = last.filter((log) => effortAbovePlan(log, planOf(log)));
  const flags: string[] = [];
  if (high.length >= EFFORT_LIMITS.highEffortLogs) flags.push("repeated_high_perceived_effort");
  if (above.length >= EFFORT_LIMITS.abovePlanLogs) flags.push("recent_effort_above_plan");

  const fromMs = nowMs - EFFORT_LIMITS.coSignalDays * DAY_MS;
  const recent = (log: TrainingLog) => {
    const at = Date.parse(log.completedAt);
    return at >= fromMs && at <= nowMs;
  };
  const recentHigh = high.filter(recent).length;
  const recentAbove = above.filter(recent).length;
  let overreaching: string | null = null;
  if (recentAbove >= EFFORT_LIMITS.abovePlanLogs || recentHigh >= EFFORT_LIMITS.highEffortLogs) {
    const effort = recentAbove >= recentHigh
      ? `${sessions(recentAbove, "recent session")} done as planned ${were(recentAbove)} rated ${EFFORT_LIMITS.abovePlanBy} or more above plan`
      : `${sessions(recentHigh, "recent session")} planned below very hard ${were(recentHigh)} rated ${EFFORT_LIMITS.highEffortRPE} or more`;
    const within = `within the last ${EFFORT_LIMITS.coSignalDays} days`;
    const weak = last.filter(recent).filter((log) => log.fatigueLevel >= EFFORT_LIMITS.weakFatigueLevel).length;
    const shortfall = shortfallOnCompletedTarget(sortedLogs, planOf, fromMs, nowMs, sinceMs);
    // repeated_high_perceived_effort already needs 3 of the last 5 (highEffortLogs
    // equals persistentLogs), so on its own it carries the "it persists" marker.
    const persists = Math.max(recentAbove, recentHigh) >= EFFORT_LIMITS.persistentLogs;
    if (shortfall) {
      overreaching = `${effort}, and a target completed cleanly before fell short (${shortfall}), ${within}.`;
    } else if (persists) {
      overreaching = `${effort} ${within}: ${Math.max(recentAbove, recentHigh)} of the last ${EFFORT_LIMITS.window}, so it persists.`;
    } else if (weak >= EFFORT_LIMITS.weakLogs) {
      overreaching = `${effort}, and ${sessions(weak, "recent session")} ${were(weak)} rated weak or very weak, ${within}.`;
    }
  }

  const calibration = overreaching === null && above.length >= EFFORT_LIMITS.abovePlanLogs
    ? calibrationOf(above, sortedLogs, planOf)
    : null;
  return { flags, overreaching, calibration };
}

/**
 * Delivered work that answers a calibration hold on `metric`: clearly more
 * than planned on any block of the session (light or technique work
 * included), or a clean completion of its working sets as planned (light
 * technique work merely done as planned says nothing about working effort).
 */
function endsCalibration(log: TrainingLog, exercises: PlannedExercisePrescription[] | undefined, metric: GoalMetric): boolean {
  return deliveredVsPlanned(log, exercises).some((entry) => entry.metric === metric && entry.overDelivered) ||
    cleanCompletion(log, exercises, metric, { workingSetsOnly: true }) !== null;
}

/** The goal exercises the above-plan sessions trained hold, unless a later log of one ends its hold (endsCalibration). */
function calibrationOf(above: TrainingLog[], sortedLogs: TrainingLog[], planOf: SessionPlanOf): EffortReadiness["calibration"] {
  const metrics = GOAL_METRICS.filter((metric) => {
    const trained = above.filter((log) => goalMetricsTrained(log, planOf(log)).includes(metric));
    if (trained.length === 0) return false;
    const lastAbove = Math.max(...trained.map((log) => Date.parse(log.completedAt)));
    return !sortedLogs.some((log) => Date.parse(log.completedAt) > lastAbove && endsCalibration(log, planOf(log), metric));
  });
  if (metrics.length === 0) return null;
  const names = andList(metrics.map((metric) => METRIC_PLURAL[metric]));
  const holds = metrics.length === 1 && metrics[0] === "plankSeconds" ? "holds" : "hold";
  return {
    metrics,
    reason: `${above.length} of the last ${EFFORT_LIMITS.window} sessions done as planned ${were(above.length)} rated ${EFFORT_LIMITS.abovePlanBy} or more above plan: ${names} ${holds} (no progression, no extra set)${metrics.length === 1 ? "" : ", each"} until a later session of it is clearly more than planned, or its working sets are done as planned.`
  };
}

/** "1 recent session", "3 recent sessions". */
function sessions(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function were(count: number): string {
  return count === 1 ? "was" : "were";
}

/** "push-ups", "push-ups and plank", "pull-ups, push-ups and plank". */
function andList(values: string[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/**
 * A result below plan in the window on a target the athlete completed
 * cleanly before (a performance drop, not a hard plan): "21 push-ups against
 * 24 planned", or null.
 */
function shortfallOnCompletedTarget(
  sortedLogs: TrainingLog[],
  planOf: SessionPlanOf,
  fromMs: number,
  nowMs: number,
  sinceMs: number | null
): string | null {
  for (const log of [...sortedLogs].reverse()) {
    const at = Date.parse(log.completedAt);
    if (!(at >= fromMs && at <= nowMs)) continue;
    for (const entry of deliveredVsPlanned(log, planOf(log))) {
      if (!entry.shortfall) continue;
      const completedBefore = sortedLogs.some((earlier) => {
        const earlierAt = Date.parse(earlier.completedAt);
        const completed = cleanCompletion(earlier, planOf(earlier), entry.metric, { workingSetsOnly: true });
        return earlierAt < at && (sinceMs === null || earlierAt >= sinceMs) && completed !== null && completed.target >= entry.planned;
      });
      if (completedBefore) return describeDelivered(entry);
    }
  }
  return null;
}
