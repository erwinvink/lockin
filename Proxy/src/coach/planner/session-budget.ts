import {
  GOAL_EXERCISE,
  GOAL_METRICS,
  goalValue,
  isUsefulGoalEffort,
  loweredEffort,
  METRIC_NAME,
  METRIC_PLURAL,
  METRIC_UNIT,
  metricForExercise,
  topBlock,
  type GoalMetric
} from "./goal-metrics";
import { STRENGTH_LIMITS, type MetricProgression } from "./strength-limits";
import type { CoachContext, WeeklyPlan } from "./types";

/**
 * The session budget: in one session a goal exercise's useful working sets x
 * reps (seconds for the plank) stay at or below 3.0x the best for pull-ups
 * and 3.5x for push-ups and the plank. Six sets at the per-set cap reached
 * 4.5-4.8x the best; a hard pull-up day is about 3x. A test and light work
 * are not counted.
 */

/** Most useful working reps (or seconds) of a goal exercise in one session, or null without a known best. */
export function sessionBudget(metric: GoalMetric, best: number | null | undefined): number | null {
  if (typeof best !== "number" || best <= 0) return null;
  return Math.floor(best * STRENGTH_LIMITS.sessionBudgetRatio[metric] + 1e-9);
}

/** Most sets of `target` the session budget holds (the set limit without a budget). */
export function setsWithinBudget(budget: number | null, target: number): number {
  return budget === null || target <= 0 ? STRENGTH_LIMITS.goalSets.max : Math.floor(budget / target);
}

/** "3.0x the best for pull-ups, 3.5x for push-ups and plank". */
export function budgetRatioText(): string {
  const groups = new Map<number, GoalMetric[]>();
  for (const metric of GOAL_METRICS) {
    const ratio = STRENGTH_LIMITS.sessionBudgetRatio[metric];
    groups.set(ratio, [...(groups.get(ratio) ?? []), metric]);
  }
  return [...groups].map(([ratio, metrics], index) =>
    `${ratio.toFixed(1)}x ${index === 0 ? "the best " : ""}for ${andList(metrics.map((metric) => METRIC_PLURAL[metric]))}`
  ).join(", ");
}

function andList(values: string[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

/** The budget for the planner prompt: per metric the most per session, and the rule. */
export function sessionBudgetForPrompt(context: CoachContext): { sessionBudget: Record<string, unknown>; sessionBudgetRule: string } {
  return {
    sessionBudget: Object.fromEntries(
      GOAL_METRICS.map((metric) => [
        metric,
        {
          maxPerSession: sessionBudget(metric, context.history.bestRecentTests[metric]),
          ratio: STRENGTH_LIMITS.sessionBudgetRatio[metric],
          basedOnBest: context.history.bestRecentTests[metric]
        }
      ])
    ),
    sessionBudgetRule:
      `In one session, a goal exercise's useful working sets x reps (seconds for the plank) stay at or below maxPerSession: ${budgetRatioText()} (a test and light work are not counted). Over it, a second block of the exercise in that session gives way first (fewer sets, or light technique work when it would drop below the week's minimum sets), so the main block and its earned progression stay; then the main block's sets are lowered, never below the minimum. The set route (setRoute) stops at it. progression.<metric>.maxSetsOnTopTarget is counted at allowedTopTarget.min: a higher target fits fewer sets, because sets x reps (seconds) stay at or below maxPerSession (shown next to it).`
  };
}

/**
 * The budget clause the validator adds to a progression message when the
 * budget limits these sets, so a repair does not plan a route the budget
 * clamp would cut again; null when it does not apply.
 */
export function budgetClause(entry: MetricProgression, prescribed: { target: number; sets: number } | undefined): string | null {
  if (entry.budget === null) return null;
  const applies = entry.budgetBinds === true || (prescribed !== undefined && prescribed.sets * prescribed.target > entry.budget);
  if (!applies) return null;
  const unit = METRIC_UNIT[entry.metric];
  return `The session budget of ${entry.budget} ${unit} applies: sets x ${unit} of all useful ${entry.label} work in one session stay at or below it.`;
}

type ClampSession = WeeklyPlan["sessions"][number];
type ClampExercise = ClampSession["exercises"][number];

/**
 * Keeps one session's useful work on a goal exercise inside the session
 * budget. The top block (highest target, then most sets) is the session's
 * main work and holds the earned progression (rep step or set route), so the
 * other blocks give way first: their sets are lowered, and a block that would
 * drop below the week's minimum sets becomes light technique work (light work
 * is not counted). Only then are the top block's sets lowered, never below
 * the minimum.
 */
export function clampSessionBudget(
  session: ClampSession,
  sessionIndex: number,
  metric: GoalMetric,
  budget: number | null,
  minSets: number,
  notes: string[],
  adjustments: string[]
) {
  if (budget === null || !Array.isArray(session.exercises)) return;
  const blocks = session.exercises
    .filter((exercise) =>
      metricForExercise(exercise.exercise) === metric &&
      isUsefulGoalEffort(exercise.plannedEffort) &&
      typeof exercise.sets === "number" &&
      goalValue(metric, exercise) > 0
    )
    .map((exercise) => ({ exercise, target: goalValue(metric, exercise), sets: exercise.sets }));
  let total = blocks.reduce((sum, block) => sum + block.sets * block.target, 0);
  if (total <= budget) return;
  const where = `Session ${sessionIndex + 1} (${session.title}) ${GOAL_EXERCISE[metric]}`;
  const why = `session budget of ${budget} ${METRIC_UNIT[metric]}`;
  const top = topBlock(blocks)!.exercise;
  const others: ClampExercise[] = blocks
    .filter((block) => block.exercise !== top)
    .sort((a, b) => a.target - b.target)
    .map((block) => block.exercise);
  for (const exercise of others) {
    if (total <= budget) return;
    const value = goalValue(metric, exercise);
    const rest = total - exercise.sets * value;
    const fit = Math.floor((budget - rest) / value);
    if (fit >= minSets) {
      adjustments.push(`${where}: a second block's ${exercise.sets} sets lowered to ${fit} (${why}).`);
      notes.push(`${METRIC_NAME[metric]} ${exercise.sets} x ${value} -> ${fit} x ${value} (session budget)`);
      exercise.sets = fit;
      total = rest + fit * value;
      continue;
    }
    // Below the week's minimum sets: easy technique work instead (not counted).
    adjustments.push(`${where}: a second block of ${exercise.sets} x ${value} became light technique work (${why}).`);
    notes.push(`${METRIC_NAME[metric]} ${exercise.sets} x ${value} -> light technique sets (session budget)`);
    exercise.plannedEffort = { ...loweredEffort(exercise.plannedEffort, "light", `the ${why}`), stimulus: "technique" };
    exercise.intensity = "Light";
    total = rest;
  }
  if (total <= budget) return;
  const value = goalValue(metric, top);
  const sets = Math.max(minSets, Math.min(top.sets, Math.floor(budget / value)));
  if (sets >= top.sets) return;
  adjustments.push(`${where}: ${top.sets} sets lowered to ${sets} (${why}).`);
  notes.push(`${METRIC_NAME[metric]} ${top.sets} -> ${sets} sets (session budget)`);
  top.sets = sets;
}
