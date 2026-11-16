import { ASSESSMENT_LIMITS, assessmentFor, hasPullUpBar, type Assessment, type AssessmentRun } from "./assessment";
import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import { EFFORT_LIMITS } from "./effort-flags";
import { exerciseLadder, plainExerciseName } from "./exercise-catalog";
import {
  EFFORT_WORD,
  GOAL_METRICS,
  goalField,
  goalValue,
  isGoalTest,
  isHardLabel,
  isNearLimitLabel,
  isUsefulGoalEffort,
  loweredEffort,
  METRIC_LABEL,
  METRIC_NAME,
  METRIC_UNIT,
  metricForExercise,
  type GoalMetric
} from "./goal-metrics";
import {
  clampOverreachingBlock,
  clampOverreachingWeek,
  convertOverreachingTests,
  overreachingForPrompt,
  overreachingLimits,
  overreachingProgression
} from "./overreaching";
import { NORMAL_READINESS_STATES } from "./readiness-state";
import { clampSessionBudget, sessionBudget, sessionBudgetForPrompt, setsWithinBudget } from "./session-budget";
import {
  hasStrengthDayRules,
  isAllowedPhaseTest,
  lighterPhaseText,
  limitHardSessions,
  testAsWorkingSets,
  phaseMaxGoalSets,
  phaseMaxHardSessions,
  STRENGTH_PHASE_LIMITS,
  strengthPhase,
  strengthPhaseActive,
  strengthPhaseForPrompt,
  strengthSessionRule,
  syncSessionEffort,
  trimHardSets,
  type StrengthPhase,
  type StrengthRuleSource
} from "./strength-phase";
import {
  assertNever,
  isBlocked,
  isCalibrationHold,
  previousWorkingPrescription,
  progressionStep,
  span,
  STRENGTH_LIMITS,
  usefulFloor,
  workingCap,
  type Band,
  type MetricProgression
} from "./strength-limits";
import { RECOVERY_CYCLE } from "./periodization";
import { POST_RACE_STRENGTH_TEXT, SEASON_LIMITS } from "./season";
import type { CoachContext, PlannedEffort, WeeklyPlan } from "./types";
import { freeOffsets, PLANNED_OFFSETS } from "./week-schedule";

/**
 * Computed strength limits shared by the planner prompt, the clamp step and
 * the validator: working caps from the athlete's best, set bounds, the weekly
 * hard-session cap, and per-metric progression bands (earned step or hold
 * band). Running load never holds upper-body progression: a heavy running
 * week, hard runs and the race calendar put no goal exercise in maintenance
 * (leg dosing, Part 2, reads legMaintenanceReason). The overreaching
 * response lives in overreaching.ts, the session budget in
 * session-budget.ts, the phase rules (recovery week, race taper, the days
 * after a race) in strength-phase.ts.
 */

/**
 * Appends what a clamp changed to the session's progression rationale (the
 * text the app shows with the session), like the running clamps add notes.
 */
export function annotateSession(session: { progressionRationale?: unknown }, notes: string[]) {
  if (notes.length === 0) return;
  const base = typeof session.progressionRationale === "string" ? session.progressionRationale.trim() : "";
  const note = `Adjusted to the plan limits: ${notes.join("; ")}.`;
  session.progressionRationale = base ? `${base} ${note}` : note;
}

/** A normal training week: normal readiness, no planned recovery week, not the race taper. */
function isNormalTrainingWeek(context: CoachContext): boolean {
  return NORMAL_READINESS_STATES.has(context.readiness.state) && !strengthPhaseActive(strengthPhase(context));
}

/**
 * Goal exercises a normal week trains in at least 2 sessions (useful work or
 * a test): pull-ups only with a pull-up bar, and only exercises the current
 * max allows (a known best above 0; below that the ladder's variants lead).
 */
export function exposureMetrics(context: CoachContext): GoalMetric[] {
  if (!isNormalTrainingWeek(context)) return [];
  return GOAL_METRICS.filter((metric) => {
    if (metric === "pullUps" && !hasPullUpBar(context)) return false;
    const best = context.history.bestRecentTests[metric];
    return typeof best === "number" && best > 0;
  });
}

/**
 * Fewest sets of useful goal work: 3 in a normal training week, 2 in a
 * planned recovery week, the race taper, an overreaching week or a computed
 * recovery need.
 */
export function minGoalSets(context: CoachContext): number {
  return isNormalTrainingWeek(context) ? STRENGTH_LIMITS.normalWeekGoalSets : STRENGTH_LIMITS.goalSets.min;
}

/**
 * Most sets of goal work per exercise: 6, or the phase maximum (3) in a
 * planned recovery week or the race taper. Overreaching holds each metric
 * to its own maximum (progression.<metric>.maxSetsOnTopTarget).
 */
export function maxGoalSets(context: CoachContext): number {
  return phaseMaxGoalSets(strengthPhase(context)) ?? STRENGTH_LIMITS.goalSets.max;
}

export type StrengthSessionOptions = {
  /** This week's run offsets: one of offsets 1-6 must stay a full rest day. */
  runOffsets?: number[];
};

/**
 * Fewest strength sessions this week: 3 in a normal week, whatever the
 * running week (a heavy week, hard runs, the post-race window), and never
 * more than the free training days allow (one of offsets 1-6 stays a full
 * rest day). A planned recovery week, the race taper, an overreaching week
 * or a computed recovery need (logged pain of 4 or more) has no minimum: the
 * coach plans what is safe. The free-text profile note never lowers it; it
 * shapes the exercise choice.
 */
export function minStrengthSessions(context: CoachContext, options: StrengthSessionOptions = {}): number {
  if (!isNormalTrainingWeek(context)) return 0;
  // Repeated misses in the last 14 days may reduce frequency by one session.
  const missedRecently = (context.adherence.missedLast14Days ?? 0) >= STRENGTH_LIMITS.missedSessionsLowerMinimum ? 1 : 0;
  const wanted = STRENGTH_LIMITS.minSessions.normalWeek - missedRecently;
  return Math.max(0, Math.min(wanted, maxStrengthSessions(context, options)));
}

/**
 * Most strength sessions this week: the weekly target and the free training
 * days, and with the week's runs known one of offsets 1-6 stays a full rest
 * day (when every run-free day is a training day, strength leaves one empty).
 * 0 when no session can be scheduled: earned progression then carries over.
 */
export function maxStrengthSessions(context: CoachContext, options: Pick<StrengthSessionOptions, "runOffsets"> = {}): number {
  const hasSelectedTrainingDays = context.profile.trainingDays.length > 0;
  const allowed = new Set(hasSelectedTrainingDays ? context.profile.trainingDayOffsets : PLANNED_OFFSETS);
  let capacity = Math.min(context.profile.weeklySessions, allowed.size);
  if (options.runOffsets) {
    // Every run-free day is a training day: strength must leave one of them empty.
    const runFree = freeOffsets(options.runOffsets);
    if (runFree.length > 0 && runFree.every((offset) => allowed.has(offset))) capacity = Math.min(capacity, allowed.size - 1);
  }
  return Math.max(0, capacity);
}

export function maxHardStrengthSessions(context: CoachContext): number {
  const normal = context.running ? STRENGTH_LIMITS.maxHardSessions.withRunning : STRENGTH_LIMITS.maxHardSessions.strengthOnly;
  const limits = [normal, phaseMaxHardSessions(strengthPhase(context)), overreachingLimits(context)?.maxHardSessions ?? null];
  return Math.min(...limits.filter((limit): limit is number => limit !== null));
}

export function strengthProgressionPlan(context: CoachContext): Record<GoalMetric, MetricProgression> {
  const earned = new Map(flatGoalMetricsRequiringProgression(context).map((entry) => [entry.metric, entry]));
  const normal = NORMAL_READINESS_STATES.has(context.readiness.state);
  const missedRecently = (context.adherence.missedLast14Days ?? 0) >= STRENGTH_LIMITS.missedSessionsLowerMinimum;
  const minSets = minGoalSets(context);
  const calibrated = new Set(normal ? context.readiness.calibration?.metrics ?? [] : []);
  const phase = strengthPhase(context);
  const result = {} as Record<GoalMetric, MetricProgression>;

  for (const metric of GOAL_METRICS) {
    const label = METRIC_LABEL[metric];
    const unit = METRIC_UNIT[metric];
    const best = context.history.bestRecentTests[metric];
    const cap = workingCap(metric, best);
    const floor = usefulFloor(metric, best);
    const capOr = (value: number) => (cap === null ? value : Math.min(value, cap));
    const budget = sessionBudget(metric, best);
    // Most sets at `target` the session budget holds: never above `limit`, never below the week's minimum.
    const withinBudget = (limit: number, target: number) => Math.min(limit, Math.max(minSets, setsWithinBudget(budget, target)));
    const base = { metric, label, cap, floor, budget };
    const budgetText = `the session budget of ${budget} ${unit} (${STRENGTH_LIMITS.sessionBudgetRatio[metric]} x the best of ${best})`;
    // The budget binds when it lowers the most sets below `limit` at `target`.
    const binds = (limit: number, target: number) => (withinBudget(limit, target) < limit ? { budgetBinds: true as const } : {});

    if (context.readiness.state === "overreaching") {
      result[metric] = overreachingProgression(context, phase, metric, base, capOr, withinBudget);
      continue;
    }

    if (!normal) {
      result[metric] = {
        ...base,
        status: "free",
        reason: "recovery_needed",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: 1, max: cap },
        maxSets: STRENGTH_LIMITS.goalSets.max,
        setRoute: null,
        note: `Computed readiness is ${context.readiness.state}: no progression; reduce as needed within the cap.`
      };
      continue;
    }

    const lighter = lighterPhaseText(phase);
    if (lighter !== null) {
      const previous = previousWorkingPrescription(context, metric);
      // Lighter by sets and effort: the cap never sits below the useful level
      // the athlete has shown, even when the last plan asked for less.
      const useful = floor === null ? 0 : capOr(floor);
      const upper = previous ? capOr(Math.max(previous.target, useful)) : cap;
      const maxGoalSets = phaseMaxGoalSets(phase) ?? STRENGTH_LIMITS.goalSets.max;
      result[metric] = {
        ...base,
        status: "offload",
        previousTarget: previous?.target ?? null,
        previousSets: previous ? Math.max(previous.sets, STRENGTH_LIMITS.goalSets.min) : null,
        target: upper === null ? null : { min: 1, max: upper },
        maxSets: maxGoalSets,
        setRoute: null,
        note: `${lighter}. No progression is required: keep the top working target at or below ${upper ?? "the cap"} ${unit} with at most ${maxGoalSets} sets. Fewer sets or a lighter effort is the point.`
      };
      continue;
    }

    // Calibrate: effort ran above plan in sessions that trained this metric.
    // It holds (no progression, no extra set) while every other metric goes on.
    const calibrationPrevious = calibrated.has(metric) ? previousWorkingPrescription(context, metric) : null;
    if (calibrationPrevious) {
      const band = holdBand(metric, calibrationPrevious.target, floor, capOr, missedRecently);
      const previousSets = Math.max(calibrationPrevious.sets, minSets);
      const maxSets = withinBudget(previousSets, band.min);
      result[metric] = {
        ...base,
        ...binds(previousSets, band.min),
        status: "hold",
        reason: "calibration",
        previousTarget: calibrationPrevious.target,
        previousSets,
        target: band,
        maxSets,
        setRoute: null,
        note: `Recent ${label} sessions done as planned were rated ${EFFORT_LIMITS.abovePlanBy} or more above plan: hold the top working target between ${band.min} and ${band.max} ${unit} with at most ${maxSets} sets (previous ${calibrationPrevious.target} x ${previousSets}); no progression and no extra set until a later ${label} session is clearly more than planned (light or technique work included), or its ${label} working sets are done as planned.`
      };
      continue;
    }

    const earnedEntry = calibrated.has(metric) ? undefined : earned.get(metric);
    const performance = context.plannedWork.recentGoalPerformance?.[metric];
    if (earnedEntry && performance?.prescribedSets !== null && performance?.prescribedSets !== undefined) {
      // Progress from the real working level: an easy day matched as evidence
      // never pulls the anchor below the previous working prescription.
      const working = previousWorkingPrescription(context, metric);
      const anchoredToWorking = working !== null && working.target > earnedEntry.latestTarget;
      const previous = anchoredToWorking ? working.target : earnedEntry.latestTarget;
      // Fewer sets than the week's minimum (3 in a normal week) continue at that minimum.
      const previousSets = Math.max(anchoredToWorking ? working.sets : performance.prescribedSets, minSets);
      const step = progressionStep(metric, previous);
      // Plan from the level the athlete showed, not only from the last plan:
      // clearly more than planned opens the band up to the working cap, and a
      // previous prescription below the useful floor restarts at that floor.
      const useful = floor === null ? 0 : capOr(floor);
      const belowFloor = previous < useful;
      const moreThanPlanned = performance.overDelivered === true;
      const rebased = belowFloor || (moreThanPlanned && cap !== null && cap > previous + step.max);
      const repMin = Math.max(previous + step.min, useful);
      // Clearly more than planned opens the band as far as what was delivered (within the cap).
      const repMax = moreThanPlanned
        ? capOr(Math.max(previous + step.max, performance.latestLoggedBest ?? 0))
        : capOr(belowFloor ? useful + progressionStep(metric, useful).max : previous + step.max);
      const repsPossible = repMin <= repMax;
      const heldTarget = capOr(Math.max(previous, useful));
      // The set route stops at 6 sets and at the session budget.
      const setRouteFitsBudget = budget === null || (previousSets + 1) * heldTarget <= budget;
      const setsPossible = previousSets < STRENGTH_LIMITS.goalSets.max && setRouteFitsBudget;
      const setRoute = setsPossible && !rebased ? { target: heldTarget, sets: previousSets + 1 } : null;
      const repSets = withinBudget(previousSets, repMin);
      const budgetStopsSets = previousSets < STRENGTH_LIMITS.goalSets.max && !setRouteFitsBudget;
      const earnedBinds = budgetStopsSets || (repsPossible && repSets < previousSets) ? { budgetBinds: true as const } : {};
      const repSetsText = repSets < previousSets ? `${repSets} sets (${budgetText})` : `${previousSets} sets`;
      const shown = moreThanPlanned
        ? `The latest ${label} result was ${performance.latestLoggedBest} ${unit} against ${previous} planned, clearly more than planned: plan from the level shown`
        : belowFloor
          ? `Progression was earned from ${previous} ${unit}, below the useful level for the current best of ${best}: plan from that level`
          : null;

      if (repsPossible || setsPossible) {
        result[metric] = {
          ...base,
          ...earnedBinds,
          status: "earned",
          previousTarget: previous,
          previousSets,
          target: repsPossible ? { min: repMin, max: repMax } : { min: heldTarget, max: heldTarget },
          maxSets: repsPossible ? repSets : previousSets + 1,
          setRoute,
          note: repsPossible && shown
            ? `${shown}: prescribe ${span(repMin, repMax)} ${unit} with at most ${repSetsText}.`
            : repsPossible
              ? `Clean matched performance earned progression from ${previous} ${unit} x ${previousSets} sets: prescribe ${span(repMin, repMax)} ${unit} with at most ${repSetsText}${setRoute ? `, or keep ${setRoute.target} ${unit} and use ${setRoute.sets} sets` : budgetStopsSets ? ` (one more set would pass ${budgetText})` : ""}.`
              : `Clean matched performance earned progression, but ${previous + step.min} ${unit} would exceed the working cap of ${cap}: keep ${heldTarget} ${unit} and use ${previousSets + 1} sets.`
        };
      } else {
        const maxSets = withinBudget(previousSets, heldTarget);
        const setLimit = previousSets >= STRENGTH_LIMITS.goalSets.max || budget === null
          ? `the ${STRENGTH_LIMITS.goalSets.max}-set limit`
          : budgetText;
        result[metric] = {
          ...base,
          ...(budgetStopsSets ? { budgetBinds: true as const } : {}),
          status: "hold",
          reason: "blocked",
          previousTarget: previous,
          previousSets,
          target: { min: heldTarget, max: heldTarget },
          maxSets,
          setRoute: null,
          note: `Progression was earned, but the working cap (${cap} ${unit}) and ${setLimit} block it: hold ${heldTarget} ${unit} with at most ${maxSets} sets until a test sets a new level (a test is due sooner while progression is blocked).`
        };
      }
      continue;
    }

    const previous = previousWorkingPrescription(context, metric);
    if (!previous) {
      const start = cap === null ? 1 : Math.min(floor ?? 1, cap);
      result[metric] = {
        ...base,
        ...binds(STRENGTH_LIMITS.goalSets.max, start),
        status: "free",
        reason: "no_prescription",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: start, max: cap },
        maxSets: withinBudget(STRENGTH_LIMITS.goalSets.max, start),
        setRoute: null,
        note: "No recent prescription to continue from: start inside the working cap and the useful floor."
      };
      continue;
    }

    const previousSets = Math.max(previous.sets, minSets);
    const { min: lower, max: upper } = holdBand(metric, previous.target, floor, capOr, missedRecently);
    const raisedToFloor = lower > previous.target ? `, which is below the useful level for the current best of ${best}` : "";
    const setLimit = Math.min(STRENGTH_LIMITS.goalSets.max, previousSets + 1);
    result[metric] = {
      ...base,
      ...binds(setLimit, lower),
      status: "hold",
      reason: "not_earned",
      previousTarget: previous.target,
      previousSets,
      target: { min: lower, max: upper },
      maxSets: withinBudget(setLimit, lower),
      setRoute: null,
      note: `Progression is not earned: keep the top working target between ${lower} and ${upper} ${unit} (previous ${previous.target} x ${previousSets} sets${raisedToFloor}); sets may rise by at most one.`
    };
  }

  return result;
}

/**
 * The hold band: from one step below the previous working target up to it,
 * never below the useful floor of the current best (the band is raised to
 * it), inside the cap. Repeated misses in the last 14 days open it down to
 * the useful floor, never below it (the validator's floor check agrees).
 */
function holdBand(
  metric: GoalMetric,
  previousTarget: number,
  floor: number | null,
  capOr: (value: number) => number,
  missedRecently: boolean
): Band {
  const step = progressionStep(metric, previousTarget);
  const upper = capOr(Math.max(previousTarget, floor ?? 0));
  const useful = floor === null ? 0 : capOr(floor);
  const lower = missedRecently
    ? Math.max(1, Math.min(useful, upper))
    : Math.max(1, Math.min(Math.max(previousTarget - step.max, useful), upper));
  return { min: lower, max: upper };
}

/** What a pipeline knows about the week before planning strength. */
export type StrengthWeekOptions = {
  /** The week's fixed runs (combined week): the rest day, the session count and the test days follow them. */
  plannedRuns?: AssessmentRun[];
};

/**
 * The week's strength facts, computed once (strengthWeek) and passed to the
 * prompt, the clamp, the validator and the continuity check, so each reads
 * the same progression, due tests and test days.
 */
export type StrengthWeek = {
  plannedRuns: AssessmentRun[] | undefined;
  /** The offsets of plannedRuns. */
  runOffsets: number[] | undefined;
  progression: Record<GoalMetric, MetricProgression>;
  assessment: Assessment;
};

/** The week's facts from what the pipeline knows; facts already computed are passed through. */
export function strengthWeek(context: CoachContext, week: StrengthWeekOptions | StrengthWeek = {}): StrengthWeek {
  if ("progression" in week && "assessment" in week) return week;
  const progression = strengthProgressionPlan(context);
  return {
    plannedRuns: week.plannedRuns,
    runOffsets: week.plannedRuns?.map((run) => run.dayOffset),
    progression,
    assessment: assessmentFor(context, progression, { runs: week.plannedRuns })
  };
}

export function strengthGuardrailsForPrompt(context: CoachContext, week: StrengthWeekOptions | StrengthWeek = {}): Record<string, unknown> {
  const facts = strengthWeek(context, week);
  const { progression, assessment } = facts;
  const sessionOptions = { runOffsets: facts.runOffsets };
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
    phase: strengthPhaseForPrompt(strengthPhase(context)),
    exerciseLadder: exerciseLadder(context.history.bestRecentTests, context.profile.equipment, context.profile.supportedExercises),
    allowedExercises: context.profile.supportedExercises ?? null,
    exerciseLadderRule:
      "Pick goal and support exercises from the exerciseLadder step for the athlete's current max (selectionRules in exercise-library.json); use exact exercise names from the library. Equipment is enforced: an exercise whose equipment the athlete lacks is sent back for repair. Variants (negatives, band-assisted, rows, weighted, archer, decline, side or long-lever planks) are support work and do not log goal numbers; keep the goal exercise itself in the week whenever the current max allows it.",
    workingCapRule:
      "Working reps or hold seconds per set must not exceed maxPerSet, except stimulus test. Over-cap values are lowered to the cap. Every working set of a goal exercise has a number (enforced): one written without a number takes the bottom of progression.<metric>.allowedTopTarget when the metric holds a band (hold, earned, reduce), otherwise it is sent back. basedOnBest is the current level: the baseline set at the plan block start plus logs since then. olderBestBeforeThisBlock is context only; never plan from it.",
    ...sessionBudgetForPrompt(context),
    assessment: {
      due: assessment.due,
      testDayOffsets: assessment.testDayOffsets,
      protocol: assessment.protocol,
      reason: assessment.reason
    },
    assessmentRule:
      `A goal test is due (enforced) ${ASSESSMENT_LIMITS.dueAfterDays} days after the last test or the plan block's baseline, or ${ASSESSMENT_LIMITS.blockedDueAfterDays} days when progression.<metric>.blocked or readiness is plateau, in a normal-readiness week. Tests pause in the season's taper phase (the last ${SEASON_LIMITS.phaseUntilDays.taper} days before the race; the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper inside it is a separate rule), judged per planned day: a week that starts before the taper takes no test on its days inside it; no test sits on post-race days 1-${ASSESSMENT_LIMITS.postRaceNoTestDays} (judged per planned day); a recovery week takes it on its last ${ASSESSMENT_LIMITS.recoveryWeekTestDays} days only. When assessment.due lists a metric, plan one max set of it (stimulus test, max_output, 1 set) on one of assessment.testDayOffsets, and state assessment.protocol in the session in its plain words (strict form is the exercise's formStandard in exercise-library.json); those days do not follow a hard run, a long run or hard strength when the week has such a day (assessment.reason says when none is left), so plan no hard strength the day before the test. Due tests may share one session, the test counts as a hard session, and it resets that metric's standard (no progression band for it this week). Tests stay at least ${ASSESSMENT_LIMITS.spacingDays} days apart (enforced). When assessment.due is empty, plan no test unless the spacing allows it and a test is useful.`,
    goalSetsPerExercise: { min: minGoalSets(context), max: maxGoalSets(context) },
    goalExposures: {
      exercises: exposureMetrics(context),
      minSessionsEach: STRENGTH_LIMITS.minSessionsPerGoalExercise,
      rule: "In a normal week (normal readiness, no planned recovery week, not the race taper) each goal exercise listed in exercises appears as useful work (medium effort or harder, at progression.<metric>.usefulFloor or more; light, technique and recovery work, and work below the useful floor, do not count) or a test in at least minSessionsEach sessions, or in every session when fewer are planned (enforced). Pull-ups need a pull-up bar."
    },
    minSessionsThisWeek: minStrengthSessions(context, sessionOptions),
    maxSessionsThisWeek: maxStrengthSessions(context, sessionOptions),
    sessionCountRule:
      `Schedule at least minSessionsThisWeek and at most maxSessionsThisWeek strength sessions (enforced; the most is the free training days and the weekly target, leaving one of offsets 1-6 a full rest day with the runs). The minimum is ${STRENGTH_LIMITS.minSessions.normalWeek} in a normal week whatever the running week (a heavy week, hard runs or the weeks after a race never lower it), never more than the free training days allow, and 0 in a planned recovery week, the race taper, an overreaching week or a computed recovery need (logged pain of 4 or more puts readiness there): then plan what is safe. The profile note never lowers it: let the note shape the exercise choice within the limits. Sessions on hard-run days stay medium or light.`,
    maxHardSessionsThisWeek: maxHardStrengthSessions(context),
    overreaching: overreachingForPrompt(context),
    hardSessionRule:
      `A session is hard when it or any exercise is hard, very_hard, or max_output; a test is one max set, labelled max_output (enforced), so it is a hard session. No hard strength on more than ${STRENGTH_LIMITS.maxConsecutiveHardDays} consecutive days, and no very_hard or max_output strength (tests included) on the day before a long run or the race.`,
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
            maxPerSession: entry.budget,
            setRoute: entry.setRoute,
            usefulFloor: entry.floor,
            ...(isBlocked(entry) ? { blocked: true } : {}),
            ...(isCalibrationHold(entry) ? { calibration: true } : {}),
            rule: entry.note
          }
        ];
      })
    )
  };
}

type ClampSession = WeeklyPlan["sessions"][number];
type ClampExercise = ClampSession["exercises"][number];

/** A test effort as the max set it is: max_output, RPE 10, nothing in reserve. */
function asMaxSet(effort: PlannedEffort): PlannedEffort {
  return { ...effort, label: "max_output", targetRPE: 10, targetRIR: 0, stimulus: "test" };
}

/**
 * A test is one max set: a max_output goal set written with another stimulus
 * is marked a test, a test labelled below max_output is labelled max_output
 * (so it counts as the hard session it is), and so is the session label over
 * them. Every rule then reads the test it stands for.
 */
function markTestsAsMaxSets(sessions: ClampSession[], adjustments: string[]) {
  sessions.forEach((session, index) => {
    if (!Array.isArray(session.exercises)) return;
    for (const exercise of session.exercises) {
      const effort = exercise.plannedEffort;
      if (!effort || effort.label === "max_output" && effort.stimulus === "test") continue;
      const maxSetAsWork = metricForExercise(exercise.exercise) !== null && effort.label === "max_output";
      if (!maxSetAsWork && effort.stimulus !== "test") continue;
      exercise.plannedEffort = asMaxSet(effort);
      exercise.intensity = "Max";
      adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: a test is one max set; labelled max_output.`);
    }
    const sessionEffort = session.plannedEffort;
    const holdsTest = session.exercises.some((exercise) => isGoalTest(exercise.plannedEffort));
    if (sessionEffort && (sessionEffort.stimulus === "test" || (sessionEffort.label === "max_output" && holdsTest)) && !(sessionEffort.label === "max_output" && sessionEffort.stimulus === "test")) {
      session.plannedEffort = asMaxSet(sessionEffort);
    }
  });
}

/**
 * The value an empty working block (0 reps or seconds) takes: the bottom of
 * the band when the metric has one (hold, earned, reduce), never
 * more. Free and offload weeks have no band to read a safe number from (only
 * the caps, or "at or below"), so the block is left for the validator.
 */
function emptyBlockFill(entry: MetricProgression): number | null {
  switch (entry.status) {
    case "earned":
    case "hold":
    case "reduce":
      return entry.target.min;
    case "free":
    case "offload":
      return null;
    default:
      return assertNever(entry);
  }
}

/** Why a converted test went: "in a recovery week", "this close to the race", "in the first 7 days after a race". */
const NO_TESTS_WHEN: Record<StrengthRuleSource, string> = {
  recovery_week: "in a recovery week",
  race_taper: "this close to the race",
  post_race: `in the first ${STRENGTH_PHASE_LIMITS.postRace.atMostHardThroughDay} days after a race`
};

/**
 * Recovery-week, race-taper and post-race fixes, all downward: tests become
 * medium working sets inside the cap, very_hard and max_output become hard,
 * hard work within 4 days of the race or on post-race days 1-2 becomes
 * medium, hard sessions beyond the phase limit become medium, goal sets go to
 * at most 3, and hard sets above the recovery cap are trimmed (then lowered
 * to medium). Returns whether anything changed.
 */
function clampStrengthPhase(
  sessions: ClampSession[],
  phase: StrengthPhase,
  progression: Record<GoalMetric, MetricProgression>,
  adjustments: string[],
  sessionNotes: string[][]
): boolean {
  let changed = false;

  sessions.forEach((session, index) => {
    const rule = strengthSessionRule(session.dayOffset, phase);
    if (!rule.light || !Array.isArray(session.exercises)) return;
    const why = rule.reason;
    for (const exercise of session.exercises) {
      const effort = exercise.plannedEffort;
      if (!effort) continue;
      const metric = metricForExercise(exercise.exercise);
      // A test on the recovery week's last 2 days stays a test.
      if (isAllowedPhaseTest(phase, session.dayOffset, effort)) continue;
      if (isGoalTest(effort)) {
        const became = testAsWorkingSets(exercise, metric, metric ? progression[metric] : null, why);
        const work = became === "light" ? "light technique sets" : "medium working sets";
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: the test became ${work} (${why}).`);
        sessionNotes[index].push(`${plainExerciseName(exercise.exercise)} test -> ${work} (no tests ${NO_TESTS_WHEN[rule.source]})`);
        changed = true;
      } else if ((rule.noHard && isHardLabel(effort.label)) || isNearLimitLabel(effort.label)) {
        const target = rule.noHard ? "medium" : "hard";
        exercise.plannedEffort = loweredEffort(effort, target, why);
        exercise.intensity = target === "medium" ? "Medium" : "Hard";
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: ${effort.label} lowered to ${target} (${why}).`);
        sessionNotes[index].push(`${plainExerciseName(exercise.exercise)} ${EFFORT_WORD[effort.label]} -> ${target} effort`);
        changed = true;
      }
      // The set limit holds every goal block (light work included), as the validator counts it.
      if (metric && rule.maxGoalSets !== null && exercise.sets > rule.maxGoalSets) {
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: ${exercise.sets} sets lowered to ${rule.maxGoalSets} (${why}).`);
        sessionNotes[index].push(`${plainExerciseName(exercise.exercise)} ${exercise.sets} -> ${rule.maxGoalSets} sets`);
        exercise.sets = rule.maxGoalSets;
        changed = true;
      }
    }
    if (!isAllowedPhaseTest(phase, session.dayOffset, session.plannedEffort)) syncSessionEffort(session, rule.noHard ? "medium" : "hard", why);
  });

  const maxHard = phaseMaxHardSessions(phase);
  if (maxHard !== null && limitHardSessions(sessions, phase, maxHard, "in this lighter week", adjustments, sessionNotes)) changed = true;
  const cap = phase.recoveryWeek?.hardSetCap ?? null;
  if (cap !== null && trimHardSets(sessions, phase, cap, "the recovery week's", adjustments, sessionNotes)) changed = true;
  return changed;
}

/**
 * One useful goal block of a normal-readiness week kept inside its
 * progression entry: above the band's top it is lowered, and its sets follow
 * the entry (no target and set rise together, at most one set more than
 * before, none in a calibration hold).
 */
function clampToProgression(
  exercise: ClampExercise,
  entry: MetricProgression,
  minSets: number,
  where: string,
  adjustments: string[],
  notes: string[]
) {
  const metric = entry.metric;
  const field = goalField(metric);
  const name = METRIC_NAME[metric];
  const unit = METRIC_UNIT[metric];
  const lowerTo = (max: number, reason: string, note: string) => {
    if (goalValue(metric, exercise) <= max) return;
    adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to ${max} ${unit} (${reason}).`);
    notes.push(`${name} ${goalValue(metric, exercise)} -> ${max} ${unit} per set (${note})`);
    exercise[field] = max;
  };
  switch (entry.status) {
    case "free":
    case "reduce":
      // Only the caps apply (free); an overreaching block is clamped in overreaching.ts.
      return;
    case "offload":
      if (entry.target) lowerTo(entry.target.max, "no progression in this lighter week", "no progression this week");
      return;
    case "earned":
    case "hold": {
      const reason = entry.status === "hold" ? "progression not earned" : "largest allowed progression step";
      lowerTo(entry.target.max, reason, reason);
      const { previousTarget, previousSets } = entry;
      // A hold adds at most one set (none in a calibration hold, and no more than the budget allows).
      const maxSetsAtHeldTarget = Math.min(
        STRENGTH_LIMITS.goalSets.max,
        previousSets + 1,
        entry.status === "hold" ? entry.maxSets : Number.POSITIVE_INFINITY
      );
      const floorSets = Math.max(previousSets, minSets);
      if (goalValue(metric, exercise) > previousTarget && exercise.sets > floorSets) {
        adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${floorSets} so the target and the sets do not rise together.`);
        notes.push(`${name} ${exercise.sets} -> ${floorSets} sets (reps and sets do not rise together)`);
        exercise.sets = floorSets;
      } else if (exercise.sets > maxSetsAtHeldTarget) {
        const calibration = isCalibrationHold(entry);
        adjustments.push(calibration
          ? `${where}: sets lowered from ${exercise.sets} to ${maxSetsAtHeldTarget} (no extra set while the effort runs above plan).`
          : `${where}: sets lowered from ${exercise.sets} to ${maxSetsAtHeldTarget} (at most one more set than ${previousSets}).`);
        notes.push(calibration
          ? `${name} ${exercise.sets} -> ${maxSetsAtHeldTarget} sets (no extra set this week)`
          : `${name} ${exercise.sets} -> ${maxSetsAtHeldTarget} sets (at most one set more than last week)`);
        exercise.sets = maxSetsAtHeldTarget;
      }
      return;
    }
    default:
      assertNever(entry);
  }
}

/**
 * Deterministic, downward-only fixes: over-cap reps or seconds go to the cap
 * (tests excluded), useful goal work gets 2-6 sets, and the top working
 * target is lowered into its progression band (with the set increase dropped
 * when the target already rose). Raising an under-progressed target is left
 * to the repair step, because the plan's rationale text must match it.
 */
/**
 * A normal week: a session whose goal work of an exercise sits below the
 * useful floor at medium effort or harder (3 x 9 push-ups for a best of 40)
 * has its top block of it raised to the floor, when the week's top block of
 * that exercise reaches it. The label says useful work, so the numbers follow
 * it; lighter work is planned light or technique. A lighter finisher behind a
 * block at the floor stays (the session budget handles it), and a week whose
 * top block sits below the floor goes to the validator, which names the floor.
 * The session budget applies afterwards.
 */
function raiseToUsefulFloor(
  sessions: WeeklyPlan["sessions"],
  progression: Record<GoalMetric, MetricProgression>,
  adjustments: string[],
  sessionNotes: string[][]
) {
  for (const metric of GOAL_METRICS) {
    const entry = progression[metric];
    if (entry.floor === null) continue;
    const floor = entry.cap === null ? entry.floor : Math.min(entry.floor, entry.cap);
    const blocks = sessions.flatMap((session, sessionIndex) =>
      (Array.isArray(session.exercises) ? session.exercises : [])
        .filter((exercise) =>
          metricForExercise(exercise.exercise) === metric &&
          isUsefulGoalEffort(exercise.plannedEffort) &&
          typeof exercise.sets === "number" &&
          goalValue(metric, exercise) > 0
        )
        .map((exercise) => ({ session, sessionIndex, exercise }))
    );
    if (!blocks.some(({ exercise }) => goalValue(metric, exercise) >= floor)) continue;
    sessions.forEach((session, sessionIndex) => {
      // The session's top block of this exercise: the highest value, then the most sets.
      const exercise = blocks
        .filter((block) => block.sessionIndex === sessionIndex)
        .map((block) => block.exercise)
        .sort((a, b) => goalValue(metric, b) - goalValue(metric, a) || b.sets - a.sets)[0];
      if (!exercise) return;
      const value = goalValue(metric, exercise);
      if (value >= floor) return;
      const label = EFFORT_WORD[exercise.plannedEffort.label] ?? exercise.plannedEffort.label;
      adjustments.push(
        `Session ${sessionIndex + 1} (${session.title}) ${exercise.exercise}: ${value} raised to the useful floor of ${floor} ${METRIC_UNIT[metric]} (${label} work starts at ${Math.round(STRENGTH_LIMITS.usefulFloorRatio * 100)}% of the best; lighter work is planned light).`
      );
      sessionNotes[sessionIndex].push(`${METRIC_NAME[metric]} ${value} -> ${floor} ${METRIC_UNIT[metric]} per set (the useful level for your current best)`);
      exercise[goalField(metric)] = floor;
    });
  }
}

export function clampWeeklyPlan(
  plan: WeeklyPlan,
  context: CoachContext,
  week: StrengthWeekOptions | StrengthWeek = {}
): { plan: WeeklyPlan; adjustments: string[] } {
  if (!plan || !Array.isArray(plan.sessions)) return { plan, adjustments: [] };
  const adjustments: string[] = [];
  const { progression } = strengthWeek(context, week);
  const normal = NORMAL_READINESS_STATES.has(context.readiness.state);
  const minSets = minGoalSets(context);
  const sessions = plan.sessions.map((session) => ({
    ...session,
    plannedEffort: session.plannedEffort ? { ...session.plannedEffort } : session.plannedEffort,
    exercises: Array.isArray(session.exercises)
      ? session.exercises.map((exercise) => ({ ...exercise, plannedEffort: exercise.plannedEffort ? { ...exercise.plannedEffort } : exercise.plannedEffort }))
      : session.exercises
  }));
  // Athlete-facing notes per session, so the session text never quotes the old numbers.
  const sessionNotes: string[][] = sessions.map(() => []);
  let summary = plan.summary;
  let safetyFlags = plan.safetyFlags;
  markTestsAsMaxSets(sessions, adjustments);
  const phase = strengthPhase(context);
  // The phase rules (recovery week, race taper) and the post-race days hold whatever the readiness.
  const fixed = hasStrengthDayRules(phase) && clampStrengthPhase(sessions, phase, progression, adjustments, sessionNotes);
  // The old Maintenance phase is gone (running load never holds upper-body
  // work); a summary that still opens with it takes the week's phase instead
  // of spending the repair: Offload in a lighter phase (recovery week, race
  // taper) or a reactive state, else Build.
  if (typeof summary === "string" && /^Maintenance:/.test(summary.trim())) {
    const renamed = strengthPhaseActive(phase) || !normal ? "Offload" : "Build";
    summary = `${renamed}: ${summary.trim().replace(/^Maintenance:\s*/, "")}`;
    adjustments.push(`Summary phase Maintenance: renamed to ${renamed}: (there is no maintenance phase).`);
  }
  const lighter = lighterPhaseText(phase);
  if (lighter !== null) {
    if (phase.recoveryWeek && typeof summary === "string" && !summary.trim().startsWith("Offload:")) {
      const rest = summary.trim().replace(/^(?:Build|Restore|Assessment):\s*/, "");
      summary = `Offload: ${rest}`;
      adjustments.push("Summary phase set to Offload: for the planned recovery week.");
    }
    const flag = phase.recoveryWeek
      ? `${lighter}: lighter on purpose after ${RECOVERY_CYCLE.loadingWeeksBeforeRecovery} loading weeks.`
      : `${lighter}; strength stays light, and nothing hard within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race.`;
    if (Array.isArray(safetyFlags) && !safetyFlags.includes(flag) && (fixed || safetyFlags.length === 0)) {
      safetyFlags = [...safetyFlags, flag];
    }
  } else if (phase.postRace && fixed && Array.isArray(safetyFlags)) {
    const flag = `After ${phase.postRace.raceName}, ${POST_RACE_STRENGTH_TEXT}.`;
    if (!safetyFlags.includes(flag)) safetyFlags = [...safetyFlags, flag];
  }
  // Computed overreaching: no tests, every goal block holds or steps back one
  // step whatever its effort label, and the hard limits apply (below).
  const overreaching = overreachingLimits(context) !== null;
  if (overreaching) convertOverreachingTests(sessions, progression, adjustments, sessionNotes);

  sessions.forEach((session, sessionIndex) => {
    if (!Array.isArray(session.exercises)) return;
    const notes: string[] = sessionNotes[sessionIndex];
    for (const exercise of session.exercises) {
      const metric = metricForExercise(exercise.exercise);
      if (!metric) continue;
      const where = `Session ${sessionIndex + 1} (${session.title}) ${exercise.exercise}`;
      const effort = exercise.plannedEffort;
      const entry = progression[metric];
      const name = METRIC_NAME[metric];
      const unit = METRIC_UNIT[metric];

      if (isGoalTest(effort) && typeof exercise.sets === "number" && exercise.sets > 1) {
        adjustments.push(`${where}: a test is one max set; ${exercise.sets} sets lowered to 1.`);
        notes.push(`${name} test ${exercise.sets} -> 1 max set`);
        exercise.sets = 1;
      }
      if (!isGoalTest(effort) && entry.cap !== null && goalValue(metric, exercise) > entry.cap) {
        adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to the working cap of ${entry.cap} ${unit}.`);
        notes.push(`${name} ${goalValue(metric, exercise)} -> ${entry.cap} ${unit} per set (working cap)`);
        exercise[goalField(metric)] = entry.cap;
      }
      if (overreaching) clampOverreachingBlock(exercise, entry, where, adjustments, notes);
      // Working sets written without a number take the bottom of the band; with
      // no band (free: only the caps apply, as in a pain week) the validator sends them back.
      const fill = isUsefulGoalEffort(effort) && goalValue(metric, exercise) <= 0 ? emptyBlockFill(entry) : null;
      if (fill !== null) {
        exercise[goalField(metric)] = fill;
        adjustments.push(`${where}: no ${unit} given; set to ${fill} ${unit} (the bottom of the band).`);
        notes.push(`${name} 0 -> ${fill} ${unit} per set`);
      }

      if (!isUsefulGoalEffort(exercise.plannedEffort) || typeof exercise.sets !== "number") continue;
      if (exercise.sets > STRENGTH_LIMITS.goalSets.max) {
        adjustments.push(`${where}: ${exercise.sets} sets lowered to ${STRENGTH_LIMITS.goalSets.max}.`);
        notes.push(`${name} ${exercise.sets} -> ${STRENGTH_LIMITS.goalSets.max} sets`);
        exercise.sets = STRENGTH_LIMITS.goalSets.max;
      } else if (exercise.sets >= 1 && exercise.sets < minSets) {
        adjustments.push(`${where}: ${exercise.sets} working set${exercise.sets === 1 ? "" : "s"} raised to ${minSets}.`);
        notes.push(`${name} ${exercise.sets} -> ${minSets} sets`);
        exercise.sets = minSets;
      }

      if (overreaching || !normal) continue;
      clampToProgression(exercise, entry, minSets, where, adjustments, notes);
    }
  });
  if (normal && !overreaching && !strengthPhaseActive(phase)) raiseToUsefulFloor(sessions, progression, adjustments, sessionNotes);
  // The session budget comes last: a second block it cannot hold gives way.
  sessions.forEach((session, sessionIndex) => {
    for (const metric of GOAL_METRICS) {
      clampSessionBudget(session, sessionIndex, metric, sessionBudget(metric, context.history.bestRecentTests[metric]), minSets, sessionNotes[sessionIndex], adjustments);
    }
  });

  if (overreaching) clampOverreachingWeek(sessions, context, phase, maxHardStrengthSessions(context), adjustments, sessionNotes);
  sessions.forEach((session, sessionIndex) => annotateSession(session, sessionNotes[sessionIndex]));

  return { plan: { ...plan, summary, safetyFlags, sessions }, adjustments };
}
