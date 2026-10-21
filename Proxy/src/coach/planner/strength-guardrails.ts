import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import type { CoachContext, EffortLabel, EffortStimulus, WeeklyPlan } from "./types";

/**
 * Computed strength limits shared by the planner prompt, the clamp step and
 * the validator: working caps from the athlete's best, set bounds, the weekly
 * hard-session cap, and per-metric progression bands (earned step, hold band,
 * or maintenance hold).
 */

export type GoalMetric = "pullUps" | "pushUps" | "plankSeconds";

export const GOAL_METRICS: GoalMetric[] = ["pullUps", "pushUps", "plankSeconds"];
export const METRIC_LABEL: Record<GoalMetric, string> = { pullUps: "pull-up", pushUps: "push-up", plankSeconds: "plank" };
const METRIC_UNIT: Record<GoalMetric, string> = { pullUps: "reps", pushUps: "reps", plankSeconds: "seconds" };

export const STRENGTH_LIMITS = {
  workingCapRatio: { pullUps: 0.85, pushUps: 0.75, plankSeconds: 0.8 } as Record<GoalMetric, number>,
  goalSets: { min: 2, max: 6 },
  maxHardSessions: { withRunning: 2, strengthOnly: 3 },
  maxConsecutiveHardDays: 2,
  /** A previous prescription older than this no longer anchors continuity. */
  continuityWindowDays: 21,
  usefulFloorRatio: 0.45
} as const;

const HARD_LABELS = new Set<string>(["hard", "very_hard", "max_output"]);
const NORMAL_PROGRESSION_STATES = new Set(["building", "plateau", "insufficient_history"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export type EffortLike = { label: EffortLabel; stimulus: EffortStimulus };

export type MetricProgression = {
  metric: GoalMetric;
  label: string;
  /**
   * earned: progression is required (rep step, or +1 set at the same target).
   * maintenance: progression was earned but heavy running allows a hold; no regression.
   * hold: not earned; the target stays in the hold band, sets may rise by one.
   * free: no recent prescription or an offload state; only caps apply.
   */
  status: "earned" | "maintenance" | "hold" | "free";
  previousTarget: number | null;
  previousSets: number | null;
  /** Allowed range for the week's top working target (useful goal work). */
  target: { min: number; max: number } | null;
  /** Most sets allowed on the top working prescription. */
  maxSets: number | null;
  /** The +1 set alternative for earned progression: same target, these sets. */
  setRoute: { target: number; sets: number } | null;
  cap: number | null;
  floor: number | null;
  note: string;
};

export type StrengthProgressionOptions = {
  /** Heavy running week: earned progression may hold instead of rising. */
  maintenance?: boolean;
};

export function metricForExercise(exercise: unknown): GoalMetric | null {
  if (exercise === "pullUp") return "pullUps";
  if (exercise === "pushUp") return "pushUps";
  if (exercise === "plank") return "plankSeconds";
  return null;
}

export function goalValue(metric: GoalMetric, exercise: { reps?: unknown; seconds?: unknown }): number {
  const value = metric === "plankSeconds" ? exercise.seconds : exercise.reps;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Working reps (or seconds) per set: 85% / 75% / 80% of the best recent value. */
export function workingCap(metric: GoalMetric, best: number | null | undefined): number | null {
  if (typeof best !== "number" || best <= 0) return null;
  const raw = Math.floor(best * STRENGTH_LIMITS.workingCapRatio[metric] + 1e-9);
  return metric === "plankSeconds" ? Math.max(10, raw) : Math.max(1, raw);
}

export function usefulFloor(best: number | null | undefined): number | null {
  return typeof best === "number" && best >= 10 ? Math.ceil(best * STRENGTH_LIMITS.usefulFloorRatio) : null;
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

/** Goal work that counts for progression: not light, not technique/recovery, not a test. */
export function isUsefulGoalEffort(effort: EffortLike | null | undefined): boolean {
  if (!effort) return false;
  return effort.label !== "light" && effort.stimulus !== "recovery" && effort.stimulus !== "technique" && effort.stimulus !== "test";
}

export function isHardStrengthSession(session: WeeklyPlan["sessions"][number]): boolean {
  return hardestLabel(session) !== null;
}

export function hardestLabel(session: WeeklyPlan["sessions"][number]): EffortLabel | null {
  const labels = [session.plannedEffort?.label, ...(session.exercises ?? []).map((exercise) => exercise.plannedEffort?.label)];
  for (const label of ["max_output", "very_hard", "hard"] as const) {
    if (labels.includes(label)) return label;
  }
  return null;
}

export function maxHardStrengthSessions(context: CoachContext): number {
  return context.running ? STRENGTH_LIMITS.maxHardSessions.withRunning : STRENGTH_LIMITS.maxHardSessions.strengthOnly;
}

export function strengthProgressionPlan(
  context: CoachContext,
  options: StrengthProgressionOptions = {}
): Record<GoalMetric, MetricProgression> {
  const earned = new Map(flatGoalMetricsRequiringProgression(context).map((entry) => [entry.metric, entry]));
  const normal = NORMAL_PROGRESSION_STATES.has(context.readiness.state);
  const missedRecently = (context.adherence.missedLast14Days ?? 0) >= 2;
  const result = {} as Record<GoalMetric, MetricProgression>;

  for (const metric of GOAL_METRICS) {
    const label = METRIC_LABEL[metric];
    const unit = METRIC_UNIT[metric];
    const best = context.history.bestRecentTests[metric];
    const cap = workingCap(metric, best);
    const floor = usefulFloor(best);
    const capOr = (value: number) => (cap === null ? value : Math.min(value, cap));
    const base: Omit<MetricProgression, "status" | "previousTarget" | "previousSets" | "target" | "maxSets" | "setRoute" | "note"> = {
      metric,
      label,
      cap,
      floor
    };

    if (!normal) {
      result[metric] = {
        ...base,
        status: "free",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: 1, max: cap },
        maxSets: STRENGTH_LIMITS.goalSets.max,
        setRoute: null,
        note: `Computed readiness is ${context.readiness.state}: no progression; reduce as needed within the cap.`
      };
      continue;
    }

    const earnedEntry = earned.get(metric);
    const performance = context.plannedWork.recentGoalPerformance?.[metric];
    if (earnedEntry && performance?.prescribedSets !== null && performance?.prescribedSets !== undefined) {
      const previous = earnedEntry.latestTarget;
      const previousSets = performance.prescribedSets;
      const step = progressionStep(metric, previous);
      const repMin = previous + step.min;
      const repMax = capOr(previous + step.max);
      const repsPossible = repMin <= repMax;
      const setsPossible = previousSets < STRENGTH_LIMITS.goalSets.max;
      const heldTarget = capOr(previous);
      const setRoute = setsPossible ? { target: heldTarget, sets: previousSets + 1 } : null;

      if (options.maintenance) {
        result[metric] = {
          ...base,
          status: "maintenance",
          previousTarget: previous,
          previousSets,
          target: { min: heldTarget, max: repsPossible ? repMax : heldTarget },
          maxSets: previousSets + (setsPossible ? 1 : 0),
          setRoute,
          note: `Progression was earned, but this week's running load allows a maintenance hold: keep at least ${heldTarget} ${unit} (no regression); progressing is still allowed.`
        };
      } else if (repsPossible || setsPossible) {
        result[metric] = {
          ...base,
          status: "earned",
          previousTarget: previous,
          previousSets,
          target: repsPossible ? { min: repMin, max: repMax } : { min: heldTarget, max: heldTarget },
          maxSets: repsPossible ? previousSets : previousSets + 1,
          setRoute,
          note: repsPossible
            ? `Clean matched performance earned progression from ${previous} ${unit} x ${previousSets} sets: prescribe ${span(repMin, repMax)} ${unit} with at most ${previousSets} sets${setRoute ? `, or keep ${setRoute.target} ${unit} and use ${setRoute.sets} sets` : ""}.`
            : `Clean matched performance earned progression, but ${previous + step.min} ${unit} would exceed the working cap of ${cap}: keep ${heldTarget} ${unit} and use ${previousSets + 1} sets.`
        };
      } else {
        result[metric] = {
          ...base,
          status: "hold",
          previousTarget: previous,
          previousSets,
          target: { min: heldTarget, max: heldTarget },
          maxSets: previousSets,
          setRoute: null,
          note: `Progression was earned but the working cap (${cap}) and the ${STRENGTH_LIMITS.goalSets.max}-set limit block it: hold ${heldTarget} ${unit} and schedule an Assessment when readiness allows.`
        };
      }
      continue;
    }

    const previous = previousWorkingPrescription(context, metric);
    if (!previous) {
      result[metric] = {
        ...base,
        status: "free",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: Math.min(floor ?? 1, cap), max: cap },
        maxSets: STRENGTH_LIMITS.goalSets.max,
        setRoute: null,
        note: "No recent prescription to continue from: start inside the working cap and the useful floor."
      };
      continue;
    }

    const step = progressionStep(metric, previous.target);
    const upper = capOr(Math.max(previous.target, floor ?? 0));
    const lower = missedRecently ? 1 : Math.max(1, Math.min(previous.target - step.max, upper));
    result[metric] = {
      ...base,
      status: "hold",
      previousTarget: previous.target,
      previousSets: previous.sets,
      target: { min: lower, max: upper },
      maxSets: Math.min(STRENGTH_LIMITS.goalSets.max, previous.sets + 1),
      setRoute: null,
      note: `Progression is not earned: keep the top working target between ${lower} and ${upper} ${unit} (previous ${previous.target} x ${previous.sets} sets); sets may rise by at most one.`
    };
  }

  return result;
}

export function strengthGuardrailsForPrompt(
  context: CoachContext,
  options: StrengthProgressionOptions & { maintenanceReason?: string | null } = {}
): Record<string, unknown> {
  const progression = strengthProgressionPlan(context, options);
  return {
    workingCaps: Object.fromEntries(
      GOAL_METRICS.map((metric) => [
        metric,
        {
          maxPerSet: progression[metric].cap,
          basedOnBest: context.history.bestRecentTests[metric],
          ratio: STRENGTH_LIMITS.workingCapRatio[metric],
          ...(context.history.bestBeforeBlock?.[metric] ? { olderBestBeforeThisBlock: context.history.bestBeforeBlock[metric] } : {})
        }
      ])
    ),
    workingCapRule:
      "Working reps or hold seconds per set must not exceed maxPerSet, except stimulus test. Over-cap values are lowered to the cap. basedOnBest is the current level: the baseline set at the plan block start plus logs since then. olderBestBeforeThisBlock is context only; never plan from it.",
    goalSetsPerExercise: STRENGTH_LIMITS.goalSets,
    maxHardSessionsThisWeek: maxHardStrengthSessions(context),
    hardSessionRule:
      "A session is hard when it or any exercise is hard, very_hard, or max_output. No hard strength on more than two consecutive days, and no very_hard or max_output strength (tests included) on the day before a long run or the race.",
    maintenance: options.maintenance
      ? { allowed: true, reason: options.maintenanceReason ?? "Heavy running week." }
      : { allowed: false },
    progression: Object.fromEntries(
      GOAL_METRICS.map((metric) => {
        const entry = progression[metric];
        return [
          metric,
          {
            status: entry.status,
            previousTarget: entry.previousTarget,
            previousSets: entry.previousSets,
            allowedTopTarget: entry.target,
            maxSetsOnTopTarget: entry.maxSets,
            setRoute: entry.setRoute,
            usefulFloor: entry.floor,
            rule: entry.note
          }
        ];
      })
    )
  };
}

function span(min: number, max: number): string {
  return min === max ? `${min}` : `${min}-${max}`;
}

function previousWorkingPrescription(context: CoachContext, metric: GoalMetric): { target: number; sets: number } | null {
  const trend = context.plannedWork.recentGoalTargets[metric];
  const target = trend?.latestWorkingTarget;
  const sets = trend?.latestWorkingSets;
  const date = trend?.latestWorkingDate;
  if (typeof target !== "number" || target <= 0 || typeof sets !== "number" || sets <= 0 || !date) return null;
  const age = Date.parse(context.profile.weekStart) - Date.parse(date);
  if (!Number.isFinite(age) || age > STRENGTH_LIMITS.continuityWindowDays * DAY_MS) return null;
  return { target, sets };
}

/**
 * Deterministic, downward-only fixes: over-cap reps or seconds go to the cap
 * (tests excluded), useful goal work gets 2-6 sets, and the top working
 * target is lowered into its progression band (with the set increase dropped
 * when the target already rose). Raising an under-progressed target is left
 * to the repair step, because the plan's rationale text must match it.
 */
export function clampWeeklyPlan(
  plan: WeeklyPlan,
  context: CoachContext,
  options: StrengthProgressionOptions = {}
): { plan: WeeklyPlan; adjustments: string[] } {
  if (!plan || !Array.isArray(plan.sessions)) return { plan, adjustments: [] };
  const adjustments: string[] = [];
  const progression = strengthProgressionPlan(context, options);
  const normal = NORMAL_PROGRESSION_STATES.has(context.readiness.state);
  const sessions = plan.sessions.map((session) => ({
    ...session,
    exercises: Array.isArray(session.exercises) ? session.exercises.map((exercise) => ({ ...exercise })) : session.exercises
  }));

  sessions.forEach((session, sessionIndex) => {
    if (!Array.isArray(session.exercises)) return;
    for (const exercise of session.exercises) {
      const metric = metricForExercise(exercise.exercise);
      if (!metric) continue;
      const where = `Session ${sessionIndex + 1} (${session.title}) ${exercise.exercise}`;
      const effort = exercise.plannedEffort as EffortLike | undefined;
      const field = metric === "plankSeconds" ? "seconds" : "reps";
      const entry = progression[metric];

      if (effort?.stimulus !== "test" && entry.cap !== null && goalValue(metric, exercise) > entry.cap) {
        adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to the working cap of ${entry.cap} ${METRIC_UNIT[metric]}.`);
        exercise[field] = entry.cap;
      }

      if (!isUsefulGoalEffort(effort) || typeof exercise.sets !== "number") continue;
      if (exercise.sets > STRENGTH_LIMITS.goalSets.max) {
        adjustments.push(`${where}: ${exercise.sets} sets lowered to ${STRENGTH_LIMITS.goalSets.max}.`);
        exercise.sets = STRENGTH_LIMITS.goalSets.max;
      } else if (exercise.sets >= 1 && exercise.sets < STRENGTH_LIMITS.goalSets.min) {
        adjustments.push(`${where}: ${exercise.sets} working set raised to ${STRENGTH_LIMITS.goalSets.min}.`);
        exercise.sets = STRENGTH_LIMITS.goalSets.min;
      }

      if (!normal || entry.status === "free" || !entry.target) continue;
      if (goalValue(metric, exercise) > entry.target.max) {
        adjustments.push(
          `${where}: ${goalValue(metric, exercise)} lowered to ${entry.target.max} ${METRIC_UNIT[metric]} (${entry.status === "hold" ? "progression not earned" : "largest allowed progression step"}).`
        );
        exercise[field] = entry.target.max;
      }
      const previousTarget = entry.previousTarget;
      const previousSets = entry.previousSets;
      if (previousTarget === null || previousSets === null) continue;
      const maxSetsAtHeldTarget = Math.min(STRENGTH_LIMITS.goalSets.max, previousSets + 1);
      if (goalValue(metric, exercise) > previousTarget && exercise.sets > previousSets) {
        adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${previousSets} so the target and the sets do not rise together.`);
        exercise.sets = previousSets;
      } else if (exercise.sets > maxSetsAtHeldTarget) {
        adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${maxSetsAtHeldTarget} (at most one more set than ${previousSets}).`);
        exercise.sets = maxSetsAtHeldTarget;
      }
    }
  });

  return { plan: { ...plan, sessions }, adjustments };
}
