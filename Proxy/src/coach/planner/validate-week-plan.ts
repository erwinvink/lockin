import { ASSESSMENT_LIMITS, lastTestOf, orList, type Assessment } from "./assessment";
import { EFFORT_LIMITS } from "./effort-flags";
import { EXERCISE_KINDS, missingEquipment } from "./exercise-catalog";
import {
  EFFORT_ORDER,
  GOAL_METRICS,
  goalValue,
  hardestLabel,
  isGoalTest,
  isHardLabel,
  isNearLimitLabel,
  isRecord,
  isUsefulGoalEffort,
  METRIC_LABEL,
  METRIC_NAME,
  METRIC_UNIT,
  metricForExercise,
  topBlock,
  type GoalMetric
} from "./goal-metrics";
import { overreachingLimits, validateOverreachingWeek } from "./overreaching";
import { NORMAL_READINESS_STATES } from "./readiness-state";
import { budgetClause } from "./session-budget";
import {
  exposureMetrics,
  maxHardStrengthSessions,
  maxStrengthSessions,
  maxGoalSets,
  minGoalSets,
  minStrengthSessions,
  strengthWeek,
  type StrengthWeek,
  type StrengthWeekOptions
} from "./strength-guardrails";
import {
  hasStrengthDayRules,
  phaseHardestLabel,
  phaseHardSetCount,
  STRENGTH_PHASE_LIMITS,
  strengthPhase,
  strengthPhaseActive,
  strengthSessionRule,
  type StrengthPhase
} from "./strength-phase";
import { assertNever, describeStep, isCalibrationHold, percent, progressionStep, STRENGTH_LIMITS, usefulFloor, type MetricProgression } from "./strength-limits";
import type { CoachContext, ContextState, EffortLabel, EffortStimulus, ExerciseKind, SessionFocus, WeeklyPlan } from "./types";

type ValidationResult = {
  accepted: boolean;
  messages: string[];
};

type GoalWorkSummary = {
  target: number;
  sets: number;
  volume: number;
};

const ASSESSMENT_SPACING_DAYS = ASSESSMENT_LIMITS.spacingDays;

const contextStates = new Set<ContextState>([
  "building",
  "plateau",
  "overreaching",
  "recovery_needed",
  "insufficient_history"
]);
const sessionFocuses = new Set<SessionFocus>(["pull", "push", "core", "mixed", "recovery"]);
const effortLabels = new Set<EffortLabel>(EFFORT_ORDER);
const effortStimuli = new Set<EffortStimulus>(["recovery", "technique", "volume", "strength", "test"]);
const exerciseKinds = new Set<ExerciseKind>(EXERCISE_KINDS);
const loggingFields = new Set<string>(GOAL_METRICS);
const runningTitlePattern = /\b(?:easy|long|recovery|tempo|interval)\s+run\b|\brunning\b|\brun\b|\bjog(?:ging)?\b|\bintervals\b/i;
const phaseSummaryPattern = /^(?:Build|Offload|Restore|Assessment):/;

/** Recovery-week, race-taper and post-race rules, each with the limit and the value. */
function validatePhaseRules(plan: WeeklyPlan, phase: StrengthPhase, messages: string[]) {
  if (phase.recoveryWeek && typeof plan.summary === "string" && !plan.summary.trim().startsWith("Offload:")) {
    messages.push("This is a planned recovery week: the summary must start with Offload:.");
  }
  plan.sessions.forEach((session, index) => {
    if (!isRecord(session) || typeof session.dayOffset !== "number") return;
    const rule = strengthSessionRule(session.dayOffset, phase);
    if (!rule.light) return;
    const label = `Session ${index + 1} (${session.title})`;
    const efforts = [
      { owner: "session", effort: session.plannedEffort },
      ...(Array.isArray(session.exercises) ? session.exercises : []).map((exercise) => ({ owner: String(exercise.exercise), effort: exercise.plannedEffort, exercise }))
    ];
    const noTests = rule.source === "recovery_week" && phase.recoveryWeek && phase.recoveryWeek.testDayOffsets.length > 0
      ? ` before its last ${phase.recoveryWeek.testDayOffsets.length === 1 ? "day" : `${STRENGTH_PHASE_LIMITS.recovery.testDays} days`} (offset ${orList(phase.recoveryWeek.testDayOffsets)})`
      : "";
    for (const { owner, effort } of efforts) {
      if (!isRecord(effort)) continue;
      if (isGoalTest(effort)) {
        if (!rule.testsAllowed) messages.push(`${label} ${owner} is a test, but ${rule.reason}: no tests${noTests}. Use medium working sets.`);
      } else if (rule.noHard && isHardLabel(effort.label)) {
        messages.push(`${label} ${owner} is ${effort.label}; ${rule.reason}. Lower it to medium or light.`);
      } else if (isNearLimitLabel(effort.label)) {
        messages.push(`${label} ${owner} is ${effort.label}; ${rule.reason}: at most hard.`);
      }
    }
    for (const exercise of Array.isArray(session.exercises) ? session.exercises : []) {
      if (!isRecord(exercise) || metricForExercise(exercise.exercise) === null) continue;
      if (rule.maxGoalSets !== null && typeof exercise.sets === "number" && exercise.sets > rule.maxGoalSets) {
        messages.push(`${label} ${exercise.exercise} has ${exercise.sets} sets; ${rule.reason}: at most ${rule.maxGoalSets} sets per goal exercise.`);
      }
    }
  });
  const cap = phase.recoveryWeek?.hardSetCap ?? null;
  if (cap !== null) {
    // A test on the week's last 2 days is outside the cap.
    const hardSets = phaseHardSetCount(plan, phase);
    if (hardSets > cap) {
      messages.push(
        `The recovery week has ${hardSets} hard strength sets (hard, very_hard, max_output); the cap is ${cap}, ${percent(STRENGTH_PHASE_LIMITS.recovery.hardSetRatio)}% of the ${phase.recoveryWeek!.referenceHardSets} hard sets in the last loading week. Cut ${hardSets - cap} hard sets or lower them to medium.`
      );
    }
  }
}

/**
 * Checks a strength week against the week's facts (strengthWeek): the
 * pipeline passes the facts it gave the prompt and the clamp; options alone
 * compute them here. Earned progression is required whatever the running
 * week: a heavy week, hard runs and the post-race window never hold it.
 */
export function validateWeeklyPlan(
  plan: unknown,
  context: CoachContext,
  week: StrengthWeekOptions | StrengthWeek = {}
): ValidationResult {
  const messages: string[] = [];
  const facts = strengthWeek(context, week);

  if (!isRecord(plan)) {
    return { accepted: false, messages: ["Plan is not an object."] };
  }

  if (typeof plan.summary !== "string") {
    messages.push("Plan summary is missing or not a string.");
  } else if (!phaseSummaryPattern.test(plan.summary.trim())) {
    messages.push("Plan summary must start with Build:, Offload:, Restore:, or Assessment:.");
  }

  if (typeof plan.contextState !== "string" || !contextStates.has(plan.contextState as ContextState)) {
    messages.push("Plan contextState is missing or unknown.");
  } else if (plan.contextState !== context.readiness.state) {
    messages.push(`Plan contextState must match computed readiness ${context.readiness.state}.`);
  }

  if (!Array.isArray(plan.safetyFlags) || !plan.safetyFlags.every((flag) => typeof flag === "string")) {
    messages.push("Plan safetyFlags is missing or not a string array.");
  }

  if (!Array.isArray(plan.sessions)) {
    return { accepted: false, messages: ["Plan sessions is missing or not an array."] };
  }

  const hasSelectedTrainingDays = context.profile.trainingDays.length > 0;
  const allowedTrainingOffsets = new Set(context.profile.trainingDayOffsets);
  // With the runs known, one of offsets 1-6 stays a full rest day: when that
  // leaves no strength day, nothing can be scheduled and progression carries over.
  const maximumSessionCount = maxStrengthSessions(context, { runOffsets: facts.runOffsets });
  const hasSafetyFlags = Array.isArray(plan.safetyFlags) && plan.safetyFlags.length > 0;

  if (plan.sessions.length > maximumSessionCount) {
    messages.push(`Expected no more than ${maximumSessionCount} future sessions, got ${plan.sessions.length}.`);
  }

  const minimumSessionCount = minStrengthSessions(context, { runOffsets: facts.runOffsets });
  if (plan.sessions.length < minimumSessionCount) {
    // The whole requirement at once, so a repair cannot walk into the all-light rule.
    messages.push(
      `A normal training week plans at least ${minimumSessionCount} strength sessions; got ${plan.sessions.length}. Add sessions on free training days, at least one at medium effort or harder (sessions on hard-run days stay medium or light), and keep one full rest day.`
    );
  }

  if (maximumSessionCount > 0 && plan.sessions.length === 0 && !hasSafetyFlags) {
    messages.push("Plan includes no future strength sessions, so safetyFlags must explain why.");
  }

  let previousDayOffset = -1;
  const sessionEffortLabels: EffortLabel[] = [];
  const usefulGoalWork: Partial<Record<GoalMetric, GoalWorkSummary>> = {};
  const testedMetrics = new Set<GoalMetric>();
  const { progression } = facts;

  for (const [sessionIndex, session] of plan.sessions.entries()) {
    if (!isRecord(session)) {
      messages.push(`Session ${sessionIndex + 1} is not an object.`);
      continue;
    }

    if (typeof session.title !== "string") {
      messages.push(`Session ${sessionIndex + 1} title is missing or not a string.`);
    } else if (runningTitlePattern.test(session.title)) {
      messages.push(`Session ${sessionIndex + 1} title looks like a running session; strength sessions need strength-specific titles.`);
    }

    if (typeof session.purpose !== "string") {
      messages.push(`Session ${sessionIndex + 1} purpose is missing or not a string.`);
    }

    if (typeof session.progressionRationale !== "string") {
      messages.push(`Session ${sessionIndex + 1} progressionRationale is missing or not a string.`);
    }

    if (typeof session.focus !== "string" || !sessionFocuses.has(session.focus as SessionFocus)) {
      messages.push(`Session ${sessionIndex + 1} focus is missing or unknown.`);
    }

    const sessionEffort = validatePlannedEffort(session.plannedEffort, `Session ${sessionIndex + 1} plannedEffort`, messages);
    if (sessionEffort) {
      sessionEffortLabels.push(sessionEffort.label);
      validateEffortPolicy(sessionEffort, `Session ${sessionIndex + 1}`, context.readiness.state, messages);
    }

    const estimatedDurationMinutes = session.estimatedDurationMinutes;
    if (
      typeof estimatedDurationMinutes !== "number" ||
      !Number.isInteger(estimatedDurationMinutes) ||
      estimatedDurationMinutes < 0
    ) {
      messages.push(`Session ${sessionIndex + 1} estimated duration must be a non-negative integer.`);
    }

    if (!Array.isArray(session.exercises)) {
      messages.push(`Session ${sessionIndex + 1} exercises is missing or not an array.`);
      continue;
    }

    if (!Array.isArray(session.safetyNotes) || !session.safetyNotes.every((note) => typeof note === "string")) {
      messages.push(`Session ${sessionIndex + 1} safetyNotes is missing or not a string array.`);
    }

    if (!Array.isArray(session.loggingFieldsRequired)) {
      messages.push(`Session ${sessionIndex + 1} loggingFieldsRequired is missing or not an array.`);
    } else {
      for (const field of session.loggingFieldsRequired) {
        if (typeof field !== "string" || !loggingFields.has(field)) {
          messages.push(`Session ${sessionIndex + 1} has an unknown logging field.`);
        }
      }
    }

    const dayOffset = session.dayOffset;
    if (typeof dayOffset !== "number" || !Number.isInteger(dayOffset) || dayOffset < 1 || dayOffset > 6) {
      messages.push(`Session ${sessionIndex + 1} dayOffset must be an integer from 1 through 6; dayOffset 0 is today and cannot be planned during a refresh.`);
    }

    if (typeof dayOffset === "number" && Number.isInteger(dayOffset)) {
      if (hasSelectedTrainingDays && dayOffset >= 1 && dayOffset <= 6 && !allowedTrainingOffsets.has(dayOffset)) {
        messages.push(`Session ${sessionIndex + 1} dayOffset ${dayOffset} is not one of the selected future training days.`);
      }
      if (dayOffset <= previousDayOffset) {
        messages.push(`Session ${sessionIndex + 1} dayOffset must be strictly later than the previous session.`);
      }
      previousDayOffset = dayOffset;
    }

    for (const exercise of session.exercises) {
      if (!isRecord(exercise)) {
        messages.push(`Session ${sessionIndex + 1} contains an exercise that is not an object.`);
        continue;
      }

      const supported = context.profile.supportedExercises ?? EXERCISE_KINDS;
      if (typeof exercise.exercise !== "string" || !exerciseKinds.has(exercise.exercise as ExerciseKind)) {
        messages.push(
          `Session ${sessionIndex + 1} has an unknown exercise ${JSON.stringify(exercise.exercise)}; use an exact name from exercise-library.json (${supported.join(", ")}).`
        );
      } else if (!supported.includes(exercise.exercise as ExerciseKind)) {
        messages.push(
          `Session ${sessionIndex + 1} uses ${exercise.exercise}, which this app version cannot show; use one of ${supported.join(", ")}.`
        );
      } else {
        const missing = missingEquipment(exercise.exercise as ExerciseKind, context.profile.equipment);
        if (missing) {
          messages.push(`Session ${sessionIndex + 1} uses ${exercise.exercise}: ${missing}, which the athlete's equipment (${context.profile.equipment.join(", ")}) does not include. Pick an exercise from the same ladder that fits.`);
        }
      }

      const sets = exercise.sets;
      const reps = exercise.reps;
      const seconds = exercise.seconds;
      const restSeconds = exercise.restSeconds;

      if (typeof sets !== "number" || !Number.isInteger(sets) || sets < 1) {
        messages.push(`Session ${sessionIndex + 1} has a non-positive or non-integer set count.`);
      }

      if (typeof reps !== "number" || !Number.isInteger(reps) || reps < 0) {
        messages.push(`Session ${sessionIndex + 1} has invalid reps.`);
      }

      if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0) {
        messages.push(`Session ${sessionIndex + 1} has invalid seconds.`);
      }

      if (typeof restSeconds !== "number" || !Number.isInteger(restSeconds) || restSeconds < 0) {
        messages.push(`Session ${sessionIndex + 1} has invalid rest seconds.`);
      }

      if (typeof exercise.intensity !== "string") {
        messages.push(`Session ${sessionIndex + 1} has an exercise intensity that is not a string.`);
      }

      const exerciseEffort = validatePlannedEffort(
        exercise.plannedEffort,
        `Session ${sessionIndex + 1} ${typeof exercise.exercise === "string" ? exercise.exercise : "exercise"} plannedEffort`,
        messages
      );
      if (exerciseEffort) {
        validateEffortPolicy(exerciseEffort, `Session ${sessionIndex + 1} exercise`, context.readiness.state, messages);
        collectUsefulGoalWork(exercise, exerciseEffort, usefulGoalWork);
      }
      validateGoalPrescription(exercise, exerciseEffort, `Session ${sessionIndex + 1}`, context, progression, testedMetrics, messages);
    }
  }

  validateHardSessionLoad(plan.sessions, context, messages);
  const phase = strengthPhase(context);
  // The phase rules (recovery week, race taper) and the post-race days hold whatever the readiness.
  if (hasStrengthDayRules(phase)) {
    validatePhaseRules(plan as unknown as WeeklyPlan, phase, messages);
  }
  validateOverreachingWeek(plan.sessions, context, progression, messages);
  validateDueTests(plan.sessions, facts.assessment, messages);
  validateGoalExposures(plan.sessions, context, messages);

  validateWeekEffortPolicy(
    context,
    sessionEffortLabels,
    usefulGoalWork,
    progression,
    testedMetrics,
    maximumSessionCount,
    messages
  );

  return { accepted: messages.length === 0, messages };
}

function validatePlannedEffort(
  value: unknown,
  label: string,
  messages: string[]
): { label: EffortLabel; stimulus: EffortStimulus; targetRPE: number; targetRIR: number } | null {
  if (!isRecord(value)) {
    messages.push(`${label} is missing or not an object.`);
    return null;
  }

  const effortLabel = value.label;
  const stimulus = value.stimulus;
  const targetRPE = value.targetRPE;
  const targetRIR = value.targetRIR;

  if (typeof effortLabel !== "string" || !effortLabels.has(effortLabel as EffortLabel)) {
    messages.push(`${label} has an unknown label.`);
  }

  if (typeof stimulus !== "string" || !effortStimuli.has(stimulus as EffortStimulus)) {
    messages.push(`${label} has an unknown stimulus.`);
  }

  if (typeof targetRPE !== "number" || !Number.isInteger(targetRPE) || targetRPE < 1 || targetRPE > 10) {
    messages.push(`${label} targetRPE must be an integer from 1 through 10.`);
  }

  if (typeof targetRIR !== "number" || !Number.isInteger(targetRIR) || targetRIR < 0 || targetRIR > 10) {
    messages.push(`${label} targetRIR must be an integer from 0 through 10.`);
  }

  if (typeof value.reason !== "string" || !value.reason.trim()) {
    messages.push(`${label} reason is missing or not a string.`);
  }

  if (
    typeof effortLabel !== "string" ||
    !effortLabels.has(effortLabel as EffortLabel) ||
    typeof stimulus !== "string" ||
    !effortStimuli.has(stimulus as EffortStimulus) ||
    typeof targetRPE !== "number" ||
    !Number.isInteger(targetRPE) ||
    typeof targetRIR !== "number" ||
    !Number.isInteger(targetRIR)
  ) {
    return null;
  }

  return { label: effortLabel as EffortLabel, stimulus: stimulus as EffortStimulus, targetRPE, targetRIR };
}

function validateEffortPolicy(
  effort: { label: EffortLabel; stimulus: EffortStimulus; targetRPE: number; targetRIR: number },
  label: string,
  contextState: unknown,
  messages: string[]
) {
  const allowedRPERanges: Record<EffortLabel, [number, number]> = {
    light: [1, 4],
    medium: [5, 6],
    hard: [7, 8],
    very_hard: [9, 9],
    max_output: [10, 10]
  };
  const [minRPE, maxRPE] = allowedRPERanges[effort.label];
  if (effort.targetRPE < minRPE || effort.targetRPE > maxRPE) {
    messages.push(`${label} targetRPE does not match ${effort.label} effort.`);
  }

  if (effort.label === "max_output" && effort.stimulus !== "test") {
    messages.push(`${label} max_output effort is only allowed with test stimulus.`);
  }
  // A test is one max set: it is labelled max_output (and counts as a hard session).
  if (effort.stimulus === "test" && effort.label !== "max_output") {
    messages.push(`${label} is a test, so its effort is max_output (a test is one max set); got ${effort.label}.`);
  }

  if (contextState === "recovery_needed" && ["hard", "very_hard", "max_output"].includes(effort.label)) {
    messages.push(`${label} cannot be ${effort.label} during recovery_needed.`);
  }
}

function validateWeekEffortPolicy(
  context: CoachContext,
  sessionEffortLabels: EffortLabel[],
  usefulGoalWork: Partial<Record<GoalMetric, GoalWorkSummary>>,
  progression: Record<GoalMetric, MetricProgression>,
  testedMetrics: Set<GoalMetric>,
  maximumSessionCount: number,
  messages: string[]
) {
  // Overreaching: every goal block is checked on its own (overreaching.ts);
  // an all-light week, like an empty one, is allowed.
  if (context.readiness.state === "overreaching") return;
  if (!NORMAL_READINESS_STATES.has(context.readiness.state)) return;
  // A planned recovery week or the race taper: lighter on purpose, so no
  // all-light, useful-floor or progression requirement (offload band below).
  if (strengthPhaseActive(strengthPhase(context))) {
    for (const metric of GOAL_METRICS) validateMetricProgression(progression[metric], usefulGoalWork[metric], messages);
    return;
  }

  if (sessionEffortLabels.length > 0 && sessionEffortLabels.every((label) => label === "light")) {
    messages.push("Normal progression weeks cannot be all light without computed recovery evidence.");
  }

  for (const metric of GOAL_METRICS) {
    const minimum = usefulFloor(metric, context.history.bestRecentTests[metric]);
    const prescribed = usefulGoalWork[metric]?.target;
    if (minimum === null || prescribed === undefined) continue;
    if (prescribed < minimum) {
      messages.push(`Normal progression ${METRIC_LABEL[metric]} goal work is below the useful stimulus floor (${prescribed} < ${minimum}). Mark it light/technique or progress it.`);
    }
  }

  // No session can be scheduled this week (e.g. the only training day is
  // today), so there is nowhere to put the earned progression: it carries
  // over to the next week instead of failing the plan.
  if (maximumSessionCount === 0) return;

  for (const metric of GOAL_METRICS) {
    // A deliberate test resets the standard; progression continues from it.
    if (testedMetrics.has(metric)) continue;
    validateMetricProgression(progression[metric], usefulGoalWork[metric], messages);
  }
}

/** A band re-based to the athlete's level (more than planned, or a previous target below the useful floor). */
function isRebasedBand(entry: Extract<MetricProgression, { status: "earned" }>): boolean {
  const step = progressionStep(entry.metric, entry.previousTarget).max;
  return entry.target.min > entry.previousTarget + step || entry.target.max > entry.previousTarget + step;
}

/**
 * Keeps the week's top working prescription per goal metric continuous with
 * the evidence: earned progression must move by the metric's step (or add
 * exactly one set at the same target), and unearned weeks stay in the hold
 * band.
 */
function validateMetricProgression(
  entry: MetricProgression,
  prescribed: GoalWorkSummary | undefined,
  messages: string[]
) {
  const before = messages.length;
  checkMetricProgression(entry, prescribed, messages);
  // Name the session budget wherever it limits these sets, so a repair does
  // not plan a route the budget clamp would cut again.
  const clause = budgetClause(entry, prescribed);
  if (clause === null) return;
  for (let index = before; index < messages.length; index += 1) messages[index] += ` ${clause}`;
}

function checkMetricProgression(
  entry: MetricProgression,
  prescribed: GoalWorkSummary | undefined,
  messages: string[]
) {
  const { label } = entry;
  const unit = METRIC_UNIT[entry.metric];

  switch (entry.status) {
    case "earned": {
      const { previousTarget, previousSets, target: band } = entry;
      if (!prescribed) {
        messages.push(`Clean matched performance earned ${label} progression. ${entry.note} safetyFlags alone cannot bypass it.`);
        return;
      }
      const repRoute = prescribed.target > previousTarget && prescribed.target >= band.min && prescribed.target <= band.max && prescribed.sets <= previousSets;
      const setRoute = entry.setRoute !== null && prescribed.target === entry.setRoute.target && prescribed.sets === entry.setRoute.sets;
      if (repRoute || setRoute) return;

      let explained = false;
      if (prescribed.target > Math.max(band.max, previousTarget)) {
        messages.push(
          isRebasedBand(entry)
            ? `${label} progression plans from the level the athlete showed: ${band.min}-${band.max} ${unit}${entry.cap !== null ? ` (working cap ${entry.cap})` : ""}; got ${prescribed.target}.`
            : `${label} progression must be ${describeStep(entry.metric, previousTarget)} from ${previousTarget} (at most ${band.max} ${unit}${entry.cap !== null ? `, working cap ${entry.cap}` : ""}); got +${prescribed.target - previousTarget}.`
        );
        explained = true;
      }
      if (prescribed.target > previousTarget && prescribed.sets > previousSets) {
        messages.push(`${label} progression cannot increase sets and the target in the same step (previous ${previousSets} sets, got ${prescribed.sets}).`);
        explained = true;
      }
      if (!explained) {
        messages.push(
          `Clean matched performance earned ${label} progression. ${entry.note} Got ${prescribed.target} ${unit} x ${prescribed.sets} sets. safetyFlags alone cannot bypass it.`
        );
      }
      return;
    }

    case "hold": {
      if (!prescribed) return;
      const { previousTarget, previousSets, target: band } = entry;
      if (prescribed.target > band.max) {
        messages.push(
          `${label} progression is not earned this week: keep the top working target between ${band.min} and ${band.max} ${unit} (previous ${previousTarget}); got ${prescribed.target}.`
        );
      } else if (prescribed.target < band.min) {
        // Below the useful floor (the band never opens under it, even after
        // missed sessions), or more than one step down.
        const belowUseful = band.min > previousTarget || (entry.floor !== null && prescribed.target < Math.min(entry.floor, band.max));
        messages.push(
          belowUseful
            ? `${label} work is below the useful level for the athlete's current best: keep the top working target between ${band.min} and ${band.max} ${unit} (previous ${previousTarget}); got ${prescribed.target}.`
            : `${label} target dropped more than one step without a computed reason: keep the top working target between ${band.min} and ${band.max} ${unit} (previous ${previousTarget}); got ${prescribed.target}.`
        );
      }
      if (prescribed.sets > entry.maxSets) {
        messages.push(
          isCalibrationHold(entry)
            ? `${label} sets stay at ${entry.maxSets} this week: recent ${label} sessions done as planned were rated ${EFFORT_LIMITS.abovePlanBy} or more above plan (previous ${previousSets} sets); got ${prescribed.sets}.`
            : `${label} sets can rise by at most one per week: at most ${entry.maxSets} sets (previous ${previousSets}); got ${prescribed.sets}.`
        );
      }
      return;
    }

    case "offload":
      if (prescribed && entry.target && prescribed.target > entry.target.max) {
        messages.push(`${label} work must not progress this week (${entry.note}); got ${prescribed.target} ${unit}, at most ${entry.target.max}.`);
      }
      return;

    case "free":
      // Only the caps apply.
      return;

    case "reduce":
      // Overreaching weeks are checked per block (overreaching.ts), never here.
      return;

    default:
      assertNever(entry);
  }
}

function validateGoalPrescription(
  exercise: Record<string, unknown>,
  effort: { label: EffortLabel; stimulus: EffortStimulus } | null,
  label: string,
  context: CoachContext,
  progression: Record<GoalMetric, MetricProgression>,
  testedMetrics: Set<GoalMetric>,
  messages: string[]
) {
  const metric = metricForExercise(exercise.exercise);
  if (!metric) return;
  const unit = METRIC_UNIT[metric];
  const value = goalValue(metric, exercise);
  const best = context.history.bestRecentTests[metric];

  if (isGoalTest(effort)) {
    // No tests while overreaching (overreaching.ts says so).
    if (context.readiness.state === "overreaching") return;
    testedMetrics.add(metric);
    // Tests stay at least 28 calendar days apart (the block's baseline counts as one).
    const last = lastTestOf(context, metric);
    if (last && last.days < ASSESSMENT_SPACING_DAYS) {
      messages.push(
        last.source === "test"
          ? `${label} ${exercise.exercise} is a test, but the last ${METRIC_LABEL[metric]} test was on ${last.date.slice(0, 10)}, fewer than ${ASSESSMENT_SPACING_DAYS} days ago. Use working sets instead.`
          : `${label} ${exercise.exercise} is a test, but the ${METRIC_LABEL[metric]} baseline was set at the plan block start on ${last.date.slice(0, 10)}, fewer than ${ASSESSMENT_SPACING_DAYS} days ago. Use working sets instead.`
      );
    }
    return;
  }

  const cap = progression[metric].cap;
  if (cap !== null && value > cap) {
    messages.push(
      `${label} ${exercise.exercise} prescribes ${value} ${unit} per set; the working cap is ${cap} (${Math.round(STRENGTH_LIMITS.workingCapRatio[metric] * 100)}% of the best recent ${best}). Lower it to ${cap} or fewer.`
    );
  }

  const useful = isUsefulGoalEffort(effort);
  if (useful && value < 1) {
    messages.push(
      `${label} ${exercise.exercise} is ${METRIC_LABEL[metric]} work at ${effort!.label} effort with 0 ${unit}: give each set ${unit} (at most ${cap ?? "the cap"}), or make it light technique work.`
    );
  }
  const sets = exercise.sets;
  const minSets = minGoalSets(context);
  if (useful && typeof sets === "number" && Number.isInteger(sets) && sets >= 1 &&
    (sets < minSets || sets > STRENGTH_LIMITS.goalSets.max)) {
    messages.push(
      `${label} ${exercise.exercise} has ${sets} working sets; goal work uses ${minSets}-${maxGoalSets(context)} sets this week.`
    );
  }
}

function validateHardSessionLoad(sessions: unknown[], context: CoachContext, messages: string[]) {
  const phase = strengthPhase(context);
  const hardOffsets: number[] = [];
  // A recovery week's limit leaves out a test on its last 2 days.
  let counted = 0;
  for (const session of sessions) {
    if (!isRecord(session) || typeof session.dayOffset !== "number") continue;
    const typed = session as WeeklyPlan["sessions"][number];
    if (hardestLabel(typed) !== null) hardOffsets.push(session.dayOffset);
    if ((strengthPhaseActive(phase) ? phaseHardestLabel(typed, phase) : hardestLabel(typed)) !== null) counted += 1;
  }

  const maxHard = maxHardStrengthSessions(context);
  if (counted > maxHard) {
    const why = phase.recoveryWeek
      ? " in a planned recovery week"
      : phase.raceTaper
        ? ` in the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days before the race`
        : overreachingLimits(context)?.maxHardSessions
          ? " while readiness is overreaching"
          : context.running ? " alongside the running week" : "";
    messages.push(
      `The plan has ${counted} hard strength sessions (hard, very_hard, or max_output in the session or any exercise); the weekly cap is ${maxHard}${why}. Make ${counted - maxHard} of them medium or light.`
    );
  }

  const unique = [...new Set(hardOffsets)].sort((a, b) => a - b);
  let streakStart = 0;
  for (let index = 1; index <= unique.length; index += 1) {
    if (index < unique.length && unique[index] === unique[index - 1] + 1) continue;
    const length = index - streakStart;
    if (length > STRENGTH_LIMITS.maxConsecutiveHardDays) {
      messages.push(
        `Hard strength sessions fall on ${length} consecutive days (offsets ${unique[streakStart]}-${unique[index - 1]}); allow at most ${STRENGTH_LIMITS.maxConsecutiveHardDays}. Make one of them medium or light, or move it.`
      );
    }
    streakStart = index;
  }
}

/**
 * A due test (assessment.ts) must be in the week: a goal test of the metric
 * (one max set) on a day that can take it. Due tests may share one session;
 * a metric with no legal day this week waits.
 */
function validateDueTests(sessions: unknown[], assessment: Assessment, messages: string[]) {
  if (assessment.due.length === 0) return;
  const testDays = new Set(assessment.testDayOffsets);
  for (const metric of assessment.due) {
    const tested = sessions.some((session) =>
      isRecord(session) &&
      typeof session.dayOffset === "number" &&
      testDays.has(session.dayOffset) &&
      Array.isArray(session.exercises) &&
      session.exercises.some((exercise) =>
        isRecord(exercise) &&
        metricForExercise(exercise.exercise) === metric &&
        isRecord(exercise.plannedEffort) &&
        isGoalTest(exercise.plannedEffort)
      )
    );
    if (!tested) {
      messages.push(
        `A ${METRIC_LABEL[metric]} test is due (${assessment.metrics[metric].reason}): plan one max set (stimulus test, max_output, 1 set) on offset ${orList(assessment.testDayOffsets)}. Due tests may share one session, and the test counts as a hard session.`
      );
    }
  }
}

/**
 * A normal week trains each goal exercise as useful work or a test in at
 * least 2 sessions, or in every session when fewer are planned (pull-ups only
 * with a pull-up bar; exposureMetrics). Useful work counts only when it
 * reaches the useful floor (45% of the best): 3 x 9 push-ups for a best of 40
 * is no exposure, whatever its label.
 */
function validateGoalExposures(sessions: unknown[], context: CoachContext, messages: string[]) {
  const metrics = exposureMetrics(context);
  if (metrics.length === 0 || sessions.length === 0) return;
  const needed = Math.min(STRENGTH_LIMITS.minSessionsPerGoalExercise, sessions.length);
  for (const metric of metrics) {
    const floor = usefulFloor(metric, context.history.bestRecentTests[metric]);
    const count = sessions.filter((session) =>
      isRecord(session) &&
      Array.isArray(session.exercises) &&
      session.exercises.some((exercise) =>
        isRecord(exercise) &&
        metricForExercise(exercise.exercise) === metric &&
        isRecord(exercise.plannedEffort) &&
        (isGoalTest(exercise.plannedEffort) ||
          (isUsefulGoalEffort(exercise.plannedEffort) && (floor === null || goalValue(metric, exercise) >= floor)))
      )
    ).length;
    if (count >= needed) continue;
    const name = METRIC_NAME[metric];
    const plural = metric !== "plankSeconds";
    const atFloor = floor === null ? "" : ` at the useful floor (${floor} ${METRIC_UNIT[metric]} or more)`;
    const notCounted = floor === null ? "light, technique and recovery work do not count" : "light, technique and recovery work, and work below the useful floor, do not count";
    messages.push(
      sessions.length === 1
        ? `${name} ${plural ? "are" : "is"} missing from the week's only session: with one session it holds every goal exercise (pull-ups only with a pull-up bar) as useful work at medium effort or harder${atFloor}, or a test. ${notCounted[0].toUpperCase()}${notCounted.slice(1)}.`
        : `${name} ${plural ? "appear" : "appears"} as useful work${atFloor} or a test in ${count} of ${sessions.length} sessions; a normal week trains each goal exercise in at least ${needed} sessions (pull-ups only with a pull-up bar). Add ${METRIC_LABEL[metric]} work at medium effort or harder${atFloor} to another session; ${notCounted}.`
    );
  }
}

/** The week's top useful block per goal metric (highest target, then most sets): what progression is judged on. */
function collectUsefulGoalWork(
  exercise: Record<string, unknown>,
  effort: { label: EffortLabel; stimulus: EffortStimulus },
  usefulGoalWork: Partial<Record<GoalMetric, GoalWorkSummary>>
) {
  const metric = metricForExercise(exercise.exercise);
  if (!metric || !isUsefulGoalEffort(effort)) return;
  const sets = typeof exercise.sets === "number" && Number.isInteger(exercise.sets) ? exercise.sets : 0;
  const value = goalValue(metric, exercise);
  const target = Number.isInteger(value) ? value : 0;
  const top = topBlock([...(usefulGoalWork[metric] ? [usefulGoalWork[metric]!] : []), { target, sets, volume: target * sets }]);
  if (top) usefulGoalWork[metric] = top;
}
