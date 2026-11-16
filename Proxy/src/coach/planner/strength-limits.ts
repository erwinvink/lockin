import type { GoalMetric } from "./goal-metrics";
import type { CoachContext } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The strength planner's fixed limits and the per-metric progression entry
 * every rule reads (the prompt, the clamp, the validator and the assessment).
 */
export const STRENGTH_LIMITS = {
  workingCapRatio: { pullUps: 0.85, pushUps: 0.75, plankSeconds: 0.8 } as Record<GoalMetric, number>,
  /** The smallest working value per set (the working cap never goes below it). */
  minWorkingValue: { pullUps: 1, pushUps: 1, plankSeconds: 10 } as Record<GoalMetric, number>,
  goalSets: { min: 2, max: 6 },
  /** A normal training week: useful goal work uses at least this many sets. */
  normalWeekGoalSets: 3,
  /**
   * Strength sessions a normal week plans when that many days are free. Running
   * load (a heavy week, hard runs, the race calendar) never lowers it: upper-body
   * goal work has no maintenance week.
   */
  minSessions: { normalWeek: 3 },
  /** Repeated misses (this many in the last 14 days) lower the session minimum by one. */
  missedSessionsLowerMinimum: 2,
  maxHardSessions: { withRunning: 2, strengthOnly: 3 },
  maxConsecutiveHardDays: 2,
  /** A previous prescription older than this no longer anchors continuity. */
  continuityWindowDays: 21,
  usefulFloorRatio: 0.45,
  /**
   * The useful floor applies from a best of this many reps (2: a best of 8
   * pull-ups never starts at 1) or seconds (the plank from 10 s, its working
   * minimum; a floor of a few seconds would mean nothing).
   */
  usefulFloorFromBest: { pullUps: 2, pushUps: 2, plankSeconds: 10 } as Record<GoalMetric, number>,
  /**
   * Session budget per goal exercise: useful working sets x reps (or seconds)
   * in one session stay at or below this multiple of the best. Six sets at the
   * per-set cap reached 4.5-4.8x the best; a hard pull-up day is about 3x.
   */
  sessionBudgetRatio: { pullUps: 3.0, pushUps: 3.5, plankSeconds: 3.5 } as Record<GoalMetric, number>,
  /** A normal week trains each goal exercise in at least this many sessions (every session when fewer are planned). */
  minSessionsPerGoalExercise: 2
} as const;

/** Working reps (or seconds) per set: 85% / 75% / 80% of the best recent value. */
export function workingCap(metric: GoalMetric, best: number | null | undefined): number | null {
  if (typeof best !== "number" || best <= 0) return null;
  const raw = Math.floor(best * STRENGTH_LIMITS.workingCapRatio[metric] + 1e-9);
  return Math.max(STRENGTH_LIMITS.minWorkingValue[metric], raw);
}

/** 45% of the best, rounded up, from a best of 2 reps (plank: 10 s); null below it. Never above the working cap. */
export function usefulFloor(metric: GoalMetric, best: number | null | undefined): number | null {
  if (typeof best !== "number" || best < STRENGTH_LIMITS.usefulFloorFromBest[metric]) return null;
  return Math.ceil(best * STRENGTH_LIMITS.usefulFloorRatio);
}

/**
 * Earned progression step, scaled to the metric: pull-ups +1 rep; push-ups
 * +1 below 15 reps, +1-2 below 30, +1-3 from 30; plank +5-10 s below 60 s,
 * +5-15 s from 60 s.
 */
export function progressionStep(metric: GoalMetric, previous: number): { min: number; max: number } {
  if (metric === "pullUps") return { min: 1, max: 1 };
  if (metric === "pushUps") return { min: 1, max: previous < 15 ? 1 : previous < 30 ? 2 : 3 };
  return { min: 5, max: previous < 60 ? 10 : 15 };
}

export function describeStep(metric: GoalMetric, previous: number): string {
  const step = progressionStep(metric, previous);
  if (metric === "pullUps") return "exactly 1 repetition";
  if (metric === "pushUps") return step.max === 1 ? "+1 repetition" : `+1 to +${step.max} repetitions`;
  return `+5 to +${step.max} seconds`;
}

/** The latest working prescription (top block of the latest past week) within the continuity window, or null. */
export function previousWorkingPrescription(context: CoachContext, metric: GoalMetric): { target: number; sets: number } | null {
  const trend = context.plannedWork.recentGoalTargets[metric];
  const target = trend?.latestWorkingTarget;
  const sets = trend?.latestWorkingSets;
  const date = trend?.latestWorkingDate;
  if (typeof target !== "number" || target <= 0 || typeof sets !== "number" || sets <= 0 || !date) return null;
  const age = Date.parse(context.profile.weekStart) - Date.parse(date);
  if (!Number.isFinite(age) || age > STRENGTH_LIMITS.continuityWindowDays * DAY_MS) return null;
  return { target, sets };
}

/** A ratio as a whole percentage: 0.7 -> 70. */
export function percent(ratio: number): number {
  return Math.round(ratio * 100);
}

/** "24" or "22-24". */
export function span(min: number, max: number): string {
  return min === max ? `${min}` : `${min}-${max}`;
}

export type Band = { min: number; max: number };
export type SetRoute = { target: number; sets: number };

type ProgressionBase = {
  metric: GoalMetric;
  label: string;
  /** The working cap per set, or null without a known best. */
  cap: number | null;
  /** The useful floor of the current best, or null below a best of 2 reps (plank: 10 s). */
  floor: number | null;
  /** The session budget (sets x reps or seconds per session), or null without a known best. */
  budget: number | null;
  /** The session budget lowers this week's sets or stops the set route. */
  budgetBinds?: true;
  /** The rule for the planner, with its numbers. */
  note: string;
};

/**
 * What the week's top working block of a goal metric may be (useful goal
 * work: not light, technique, recovery or a test). `target` is the allowed
 * range of the top working target and `maxSets` the most sets on it, counted
 * at `target.min` (a higher target fits fewer sets inside the session
 * budget). Per status:
 */
export type MetricProgression = ProgressionBase & (
  /**
   * earned: progression is required. `target` is the rep step (at most
   * `maxSets` sets, never more than before), or `setRoute` adds one set at
   * the held target. When the cap leaves no rep step, `target` is the held
   * target and `maxSets` one more set than before.
   */
  | { status: "earned"; previousTarget: number; previousSets: number; target: Band; maxSets: number; setRoute: SetRoute | null }
  /**
   * hold: no progression; `target` is the hold band. not_earned: sets may
   * rise by one (`maxSets`). calibration: effort ran above plan in sessions
   * of this exercise, so no extra set. blocked: earned, but the cap and the
   * set limit or budget block it; `target` is the held target and a test is
   * due sooner (assessment.ts).
   */
  | { status: "hold"; reason: "not_earned" | "calibration" | "blocked"; previousTarget: number; previousSets: number; target: Band; maxSets: number; setRoute: null }
  /**
   * free: only the caps apply. no_prescription: no recent prescription
   * (`target` from the useful floor to the cap); recovery_needed: a computed
   * recovery need (`target` 1 to the cap); overreaching: overreaching without
   * a recent prescription (at most `maxSets` sets per block). `target` is
   * null without a known best.
   */
  | { status: "free"; reason: "no_prescription" | "recovery_needed" | "overreaching"; previousTarget: null; previousSets: null; target: Band | null; maxSets: number; setRoute: null }
  /**
   * offload: a planned recovery week or the last 10 days before the race; no
   * progression is required, the top target may hold or drop (`target.max`)
   * with at most `maxSets` sets (the phase's limit). `target` is null without
   * a known best or previous prescription.
   */
  | { status: "offload"; previousTarget: number | null; previousSets: number | null; target: Band | null; maxSets: number; setRoute: null }
  /**
   * reduce: overreaching: the week's top block, whatever its label, holds or
   * steps back one step (`target`); every block stays at or below
   * `target.max` with at most `maxSets` sets (one fewer than before, at least 2).
   */
  | { status: "reduce"; previousTarget: number; previousSets: number; target: Band; maxSets: number; setRoute: null }
);

/** Earned, but the working cap and the set limit or session budget block it: a test is due sooner. */
export function isBlocked(entry: MetricProgression): boolean {
  return entry.status === "hold" && entry.reason === "blocked";
}

/** Effort ran above plan in sessions of this exercise: it holds with no extra set. */
export function isCalibrationHold(entry: MetricProgression): boolean {
  return entry.status === "hold" && entry.reason === "calibration";
}

/** The most a goal block may hold this week: the progression band's top, else the working cap (null without a known best). */
export function ceilingOf(entry: MetricProgression): number | null {
  return entry.target?.max ?? entry.cap;
}

/** Exhaustiveness check for switches over a union. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}
