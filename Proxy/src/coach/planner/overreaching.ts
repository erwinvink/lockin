import {
  GOAL_METRICS,
  goalField,
  goalValue,
  isGoalTest,
  isRecord,
  METRIC_LABEL,
  METRIC_NAME,
  METRIC_UNIT,
  metricForExercise,
  topBlock,
  type GoalMetric
} from "./goal-metrics";
import {
  limitHardSessions,
  phaseHardSetCount,
  phaseMaxGoalSets,
  STRENGTH_PHASE_LIMITS,
  strengthPhase,
  syncSessionEffort,
  testAsWorkingSets,
  trimHardSets,
  type StrengthPhase
} from "./strength-phase";
import { percent, previousWorkingPrescription, progressionStep, STRENGTH_LIMITS, type MetricProgression } from "./strength-limits";
import type { CoachContext, WeeklyPlan } from "./types";

/**
 * The overreaching response (computed readiness overreaching, for the next
 * 3-7 days): the top block of each goal exercise (its highest target in the
 * week, whatever its effort label) holds or steps back one step from the
 * previous working target, no block goes above that, each block keeps one
 * set fewer (at least 2), a goal exercise without a recent prescription
 * keeps at most 3 sets, hard sets stay at most 70% of the last loading
 * week's (or one hard session without one), and there are no tests. An
 * all-light week, or no session, is allowed. The phase rules (recovery week,
 * race taper) hold as well.
 */

export type OverreachingLimits = {
  /** Hard sets prescribed in the last loading week (periodization), or null. */
  referenceHardSets: number | null;
  /** At most this many hard sets this week (70% of the reference), or null without a reference. */
  hardSetCap: number | null;
  /** At most this many hard sessions when there is no reference, else null. */
  maxHardSessions: number | null;
};

const { responseDays, hardSetRatio, hardSetCutUpTo } = STRENGTH_PHASE_LIMITS.overreaching;
/** "the next 3-7 days". */
const NEXT_DAYS = `the next ${responseDays.min}-${responseDays.max} days`;
/** "about 30-50% fewer". */
const FEWER_HARD_SETS = `about ${percent(1 - hardSetRatio)}-${percent(hardSetCutUpTo)}% fewer`;

/** The hard limits of an overreaching week (the recovery week's machinery at 70%), or null. */
export function overreachingLimits(context: CoachContext): OverreachingLimits | null {
  if (context.readiness.state !== "overreaching") return null;
  const reference = context.periodization?.lastLoadingWeekHardSets ?? null;
  const limits = STRENGTH_PHASE_LIMITS.overreaching;
  return reference === null
    ? { referenceHardSets: null, hardSetCap: null, maxHardSessions: limits.maxHardSessionsWithoutReference }
    : { referenceHardSets: reference, hardSetCap: Math.floor(reference * limits.hardSetRatio + 1e-9), maxHardSessions: null };
}

/**
 * A goal metric's overreaching band: hold or step back one step from the
 * previous working target, with one set fewer (at least 2, and inside the
 * phase's set limit); without a recent prescription at most 3 sets.
 */
export function overreachingProgression(
  context: CoachContext,
  phase: StrengthPhase,
  metric: GoalMetric,
  base: Pick<MetricProgression, "metric" | "label" | "cap" | "floor" | "budget">,
  capOr: (value: number) => number,
  withinBudget: (limit: number, target: number) => number
): MetricProgression {
  const unit = METRIC_UNIT[metric];
  const previous = previousWorkingPrescription(context, metric);
  const phaseSets = phaseMaxGoalSets(phase) ?? Number.POSITIVE_INFINITY;
  if (!previous) {
    const sets = Math.min(STRENGTH_PHASE_LIMITS.overreaching.maxFreeGoalSets, phaseSets);
    return {
      ...base,
      status: "free",
      reason: "overreaching",
      previousTarget: null,
      previousSets: null,
      target: base.cap === null ? null : { min: Math.min(base.floor ?? 1, base.cap), max: base.cap },
      maxSets: sets,
      setRoute: null,
      note: `Computed readiness is overreaching and there is no recent ${base.label} prescription to step back from: for ${NEXT_DAYS} keep ${base.label} work inside the working cap with at most ${sets} sets.`
    };
  }
  const step = progressionStep(metric, previous.target).max;
  const previousSets = Math.max(previous.sets, STRENGTH_LIMITS.goalSets.min);
  const upper = capOr(previous.target);
  const lower = Math.max(1, Math.min(previous.target - step, upper));
  const setLimit = Math.min(Math.max(STRENGTH_LIMITS.goalSets.min, previousSets - 1), phaseSets);
  const maxSets = withinBudget(setLimit, lower);
  return {
    ...base,
    ...(maxSets < setLimit ? { budgetBinds: true as const } : {}),
    status: "reduce",
    previousTarget: previous.target,
    previousSets,
    target: { min: lower, max: upper },
    maxSets,
    setRoute: null,
    note: `Computed readiness is overreaching: for ${NEXT_DAYS} the top ${base.label} block, whatever its effort label, holds or steps back one step, between ${lower} and ${upper} ${unit} (previous ${previous.target} x ${previousSets} sets); no block above ${upper} ${unit}, lighter technique blocks may sit below, at most ${maxSets} sets per block; hard sets stay inside strengthGuardrails.overreaching (${FEWER_HARD_SETS}), and no test.`
  };
}

/** The overreaching week's limits for the prompt, with their numbers; null when readiness is not overreaching. */
export function overreachingForPrompt(context: CoachContext): Record<string, unknown> | null {
  const limits = overreachingLimits(context);
  if (!limits) return null;
  const { maxFreeGoalSets } = STRENGTH_PHASE_LIMITS.overreaching;
  const hard = limits.hardSetCap !== null
    ? `hard, very_hard and max_output sets at most hardSetCap (${limits.hardSetCap}, ${percent(hardSetRatio)}% of the ${limits.referenceHardSets} hard sets in the last loading week; ${FEWER_HARD_SETS})`
    : `at most ${limits.maxHardSessions} hard session (no loading week to compare with)`;
  return {
    hardSetCap: limits.hardSetCap,
    referenceHardSets: limits.referenceHardSets,
    maxHardSessions: limits.maxHardSessions,
    rule: `Readiness is overreaching (enforced) for ${NEXT_DAYS}: the top block of each goal exercise (its highest target this week), whatever its effort label, stays inside progression.<metric>.allowedTopTarget (hold or one step back); no block goes above it, lighter technique or support blocks may sit below it, and each block has at most maxSetsOnTopTarget sets; a goal exercise without a recent prescription keeps at most ${maxFreeGoalSets} sets inside the cap; ${hard}; no tests. Values above it are lowered. An all-light week, or no session, is allowed.`
  };
}

type ClampSession = WeeklyPlan["sessions"][number];
type ClampExercise = ClampSession["exercises"][number];

/** Goal tests become medium working sets inside the hold-or-step-back band (no tests this week). */
export function convertOverreachingTests(
  sessions: ClampSession[],
  progression: Record<GoalMetric, MetricProgression>,
  adjustments: string[],
  sessionNotes: string[][]
) {
  const why = "readiness is overreaching";
  sessions.forEach((session, index) => {
    if (!Array.isArray(session.exercises)) return;
    let converted = false;
    for (const exercise of session.exercises) {
      const effort = exercise.plannedEffort;
      const metric = metricForExercise(exercise.exercise);
      if (!metric || !effort || !isGoalTest(effort)) continue;
      const work = testAsWorkingSets(exercise, metric, progression[metric], why) === "light" ? "light technique sets" : "medium working sets";
      adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: the test became ${work} (no tests while ${why}).`);
      sessionNotes[index].push(`${METRIC_NAME[metric]} test -> ${work} (no test this week)`);
      converted = true;
    }
    if (converted) syncSessionEffort(session, "hard", why);
  });
}

/** One goal block in an overreaching week: at most the band's top, and at most maxSets sets (tests are converted first). */
export function clampOverreachingBlock(
  exercise: ClampExercise,
  entry: MetricProgression,
  where: string,
  adjustments: string[],
  notes: string[]
) {
  if (isGoalTest(exercise.plannedEffort) || typeof exercise.sets !== "number") return;
  const metric = entry.metric;
  const value = goalValue(metric, exercise);
  const name = METRIC_NAME[metric];
  const unit = METRIC_UNIT[metric];
  if (entry.status === "reduce" && value > entry.target.max) {
    adjustments.push(`${where}: ${value} lowered to ${entry.target.max} ${unit} (readiness is overreaching: hold or one step back).`);
    notes.push(`${name} ${value} -> ${entry.target.max} ${unit} per set (hold or one step back this week)`);
    exercise[goalField(metric)] = entry.target.max;
  }
  if ((entry.status === "reduce" || entry.status === "free") && exercise.sets > entry.maxSets) {
    adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${entry.maxSets} (readiness is overreaching).`);
    notes.push(`${name} ${exercise.sets} -> ${entry.maxSets} sets (${entry.status === "reduce" ? "one set fewer this week" : `at most ${entry.maxSets} sets this week`})`);
    exercise.sets = entry.maxSets;
  }
}

/**
 * The week's hard limits while overreaching: the hard-session cap of the
 * week (maxHardStrengthSessions, passed in) and the lower of the overreaching
 * and recovery-week hard-set caps.
 */
export function clampOverreachingWeek(
  sessions: ClampSession[],
  context: CoachContext,
  phase: StrengthPhase,
  maxHardSessions: number,
  adjustments: string[],
  sessionNotes: string[][]
) {
  const limits = overreachingLimits(context);
  if (!limits) return;
  limitHardSessions(sessions, phase, maxHardSessions, "while readiness is overreaching", adjustments, sessionNotes);
  const caps = [limits.hardSetCap, phase.recoveryWeek?.hardSetCap ?? null].filter((cap): cap is number => cap !== null);
  if (caps.length > 0) trimHardSets(sessions, phase, Math.min(...caps), "the overreaching week's", adjustments, sessionNotes);
}

/**
 * The overreaching week checked: no goal tests; no goal block, whatever its
 * effort label, above the band (allowedTopTarget) and each with at most
 * maxSets sets; the week's top block of each goal exercise (its highest
 * target, every block but a test) at or above the band's lower limit, so the
 * main prescription cannot be relabelled light to drop to tiny numbers
 * (lighter technique or support blocks may sit below it); and hard sets at
 * most the overreaching cap, counted like the clamp (phaseHardSetCount).
 */
export function validateOverreachingWeek(
  sessions: unknown[],
  context: CoachContext,
  progression: Record<GoalMetric, MetricProgression>,
  messages: string[]
) {
  const limits = overreachingLimits(context);
  if (!limits) return;
  const blocks: Record<GoalMetric, Array<{ target: number; sets: number }>> = { pullUps: [], pushUps: [], plankSeconds: [] };
  sessions.forEach((session, index) => {
    if (!isRecord(session) || !Array.isArray(session.exercises)) return;
    const label = `Session ${index + 1}`;
    for (const exercise of session.exercises) {
      if (!isRecord(exercise)) continue;
      const metric = metricForExercise(exercise.exercise);
      if (!metric) continue;
      const effort = isRecord(exercise.plannedEffort) ? exercise.plannedEffort : null;
      if (isGoalTest(effort)) {
        messages.push(`${label} ${exercise.exercise} is a test, but there are no tests while readiness is overreaching: plan working sets inside allowedTopTarget instead.`);
        continue;
      }
      const value = goalValue(metric, exercise);
      const sets = typeof exercise.sets === "number" ? exercise.sets : 0;
      blocks[metric].push({ target: value, sets });
      validateOverreachingBlock(`${label} ${exercise.exercise}`, value, sets, progression[metric], messages);
    }
  });
  for (const metric of GOAL_METRICS) {
    const entry = progression[metric];
    const top = topBlock(blocks[metric]);
    if (entry.status !== "reduce" || top === null || top.target >= entry.target.min) continue;
    messages.push(
      `Readiness is overreaching: the week's top ${METRIC_LABEL[metric]} block, whatever its effort label, holds or steps back one step: between ${entry.target.min} and ${entry.target.max} ${METRIC_UNIT[metric]} (previous ${entry.previousTarget}); got ${top.target}. Lighter technique blocks may sit below it.`
    );
  }
  if (limits.hardSetCap !== null && Array.isArray(sessions)) {
    const hardSets = phaseHardSetCount({ sessions: sessions.filter(isRecord) as unknown as WeeklyPlan["sessions"] }, strengthPhase(context));
    if (hardSets > limits.hardSetCap) {
      messages.push(
        `Readiness is overreaching: the week has ${hardSets} hard strength sets (hard, very_hard, max_output); at most ${limits.hardSetCap}, ${percent(hardSetRatio)}% of the ${limits.referenceHardSets} hard sets in the last loading week. Cut ${hardSets - limits.hardSetCap} hard sets or lower them to medium.`
      );
    }
  }
}

/** One block: no higher than the band's top, at most maxSets sets. */
function validateOverreachingBlock(where: string, value: number, sets: number, entry: MetricProgression, messages: string[]) {
  const label = METRIC_LABEL[entry.metric];
  if (entry.status === "reduce" && value > entry.target.max) {
    messages.push(
      `${where}: readiness is overreaching, so no ${label} block goes above ${entry.target.max} ${METRIC_UNIT[entry.metric]} this week (hold or one step back from ${entry.previousTarget}); got ${value}.`
    );
  }
  if ((entry.status === "reduce" || entry.status === "free") && sets > entry.maxSets) {
    messages.push(
      `${where}: readiness is overreaching: at most ${entry.maxSets} sets of ${label} work per block this week${entry.previousSets !== null ? ` (previous ${entry.previousSets})` : ""}; got ${sets}.`
    );
  }
}
