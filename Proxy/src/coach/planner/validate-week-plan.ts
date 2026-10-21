import {
  describeStep,
  GOAL_METRICS,
  goalValue,
  hardestLabel,
  maxHardStrengthSessions,
  METRIC_LABEL,
  metricForExercise,
  STRENGTH_LIMITS,
  strengthProgressionPlan,
  type GoalMetric,
  type MetricProgression
} from "./strength-guardrails";
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

export type WeeklyPlanValidationOptions = {
  /**
   * The fixed running week is heavy (see strengthMaintenanceReason): earned
   * progression may hold, but targets must not regress below it.
   */
  allowProgressionHoldForRunning?: boolean;
};

const ASSESSMENT_SPACING_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

const contextStates = new Set<ContextState>([
  "building",
  "plateau",
  "overreaching",
  "recovery_needed",
  "insufficient_history"
]);
const sessionFocuses = new Set<SessionFocus>(["pull", "push", "core", "mixed", "recovery"]);
const effortLabels = new Set<EffortLabel>(["light", "medium", "hard", "very_hard", "max_output"]);
const effortStimuli = new Set<EffortStimulus>(["recovery", "technique", "volume", "strength", "test"]);
const exerciseKinds = new Set<ExerciseKind>([
  "pullUp",
  "pushUp",
  "plank",
  "scapularPull",
  "hollowHold",
  "inclinePushUp",
  "pikePushUp",
  "deadHang",
  "shoulderMobility"
]);
const loggingFields = new Set(["pullUps", "pushUps", "plankSeconds"]);
const runningTitlePattern = /\b(?:easy|long|recovery|tempo|interval)\s+run\b|\brunning\b|\brun\b|\bjog(?:ging)?\b|\bintervals\b/i;
const phaseSummaryPattern = /^(?:Build|Offload|Restore|Maintenance|Assessment):/;

export function validateWeeklyPlan(
  plan: unknown,
  context: CoachContext,
  options: WeeklyPlanValidationOptions = {}
): ValidationResult {
  const messages: string[] = [];

  if (!isRecord(plan)) {
    return { accepted: false, messages: ["Plan is not an object."] };
  }

  if (typeof plan.summary !== "string") {
    messages.push("Plan summary is missing or not a string.");
  } else if (!phaseSummaryPattern.test(plan.summary.trim())) {
    messages.push("Plan summary must start with Build:, Offload:, Restore:, Maintenance:, or Assessment:.");
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
  const maximumSessionCount = hasSelectedTrainingDays
    ? Math.min(context.profile.weeklySessions, allowedTrainingOffsets.size)
    : context.profile.weeklySessions;
  const hasSafetyFlags = Array.isArray(plan.safetyFlags) && plan.safetyFlags.length > 0;

  if (plan.sessions.length > maximumSessionCount) {
    messages.push(`Expected no more than ${maximumSessionCount} future sessions, got ${plan.sessions.length}.`);
  }

  if (maximumSessionCount > 0 && plan.sessions.length === 0 && !hasSafetyFlags) {
    messages.push("Plan includes no future strength sessions, so safetyFlags must explain why.");
  }

  let previousDayOffset = -1;
  const sessionEffortLabels: EffortLabel[] = [];
  const usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>> = {};
  const testedMetrics = new Set<GoalMetric>();
  const progression = strengthProgressionPlan(context, { maintenance: options.allowProgressionHoldForRunning === true });

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

      if (typeof exercise.exercise !== "string" || !exerciseKinds.has(exercise.exercise as ExerciseKind)) {
        messages.push(`Session ${sessionIndex + 1} has an unknown exercise.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  if (contextState === "recovery_needed" && ["hard", "very_hard", "max_output"].includes(effort.label)) {
    messages.push(`${label} cannot be ${effort.label} during recovery_needed.`);
  }
}

function validateWeekEffortPolicy(
  context: CoachContext,
  sessionEffortLabels: EffortLabel[],
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>,
  progression: Record<GoalMetric, MetricProgression>,
  testedMetrics: Set<GoalMetric>,
  maximumSessionCount: number,
  messages: string[]
) {
  const normalProgressionStates = new Set(["building", "plateau", "insufficient_history"]);
  if (!normalProgressionStates.has(context.readiness.state)) return;

  if (sessionEffortLabels.length > 0 && sessionEffortLabels.every((label) => label === "light")) {
    messages.push("Normal progression weeks cannot be all light without computed recovery or maintenance evidence.");
  }

  const floors: Array<["pullUps" | "pushUps" | "plankSeconds", number, string]> = [
    ["pullUps", STRENGTH_LIMITS.usefulFloorRatio, "pull-up"],
    ["pushUps", STRENGTH_LIMITS.usefulFloorRatio, "push-up"],
    ["plankSeconds", STRENGTH_LIMITS.usefulFloorRatio, "plank"]
  ];

  for (const [metric, multiplier, label] of floors) {
    const best = context.history.bestRecentTests[metric];
    const prescribed = usefulGoalWork[metric]?.target;
    if (best === null || best < 10 || prescribed === undefined) continue;
    const minimum = Math.ceil(best * multiplier);
    if (prescribed < minimum) {
      messages.push(`Normal progression ${label} goal work is below the useful stimulus floor (${prescribed} < ${minimum}). Mark it light/technique or progress it.`);
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

/**
 * Keeps the week's top working prescription per goal metric continuous with
 * the evidence: earned progression must move by the metric's step (or add
 * exactly one set at the same target), a maintenance week may hold but not
 * regress, and unearned weeks stay in the hold band.
 */
function validateMetricProgression(
  entry: MetricProgression,
  prescribed: GoalWorkSummary | undefined,
  messages: string[]
) {
  const { label, previousTarget, previousSets, target: band } = entry;
  const unit = entry.metric === "plankSeconds" ? "seconds" : "reps";

  if (entry.status === "earned") {
    if (!prescribed) {
      messages.push(`Clean matched performance earned ${label} progression. ${entry.note} safetyFlags alone cannot bypass it.`);
      return;
    }
    if (previousTarget === null || previousSets === null || !band) return;
    const repRoute = prescribed.target > previousTarget && prescribed.target >= band.min && prescribed.target <= band.max && prescribed.sets <= previousSets;
    const setRoute = entry.setRoute !== null && prescribed.target === entry.setRoute.target && prescribed.sets === entry.setRoute.sets;
    if (repRoute || setRoute) return;

    let explained = false;
    if (prescribed.target > Math.max(band.max, previousTarget)) {
      messages.push(
        `${label} progression must be ${describeStep(entry.metric, previousTarget)} from ${previousTarget} (at most ${band.max} ${unit}${entry.cap !== null ? `, working cap ${entry.cap}` : ""}); got +${prescribed.target - previousTarget}.`
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

  if (!prescribed || !band || previousTarget === null || previousSets === null) return;

  if (entry.status === "maintenance") {
    if (prescribed.target < band.min) {
      messages.push(
        `Maintenance week: hold ${label} work at ${band.min} ${unit} or more (earned standard ${previousTarget}); got ${prescribed.target}. Holding is allowed, regressing is not.`
      );
    }
    if (prescribed.target > band.max) {
      messages.push(`${label} progression must be ${describeStep(entry.metric, previousTarget)} from ${previousTarget} (at most ${band.max} ${unit}); got +${prescribed.target - previousTarget}.`);
    }
    if (prescribed.target > previousTarget && prescribed.sets > previousSets) {
      messages.push(`${label} progression cannot increase sets and the target in the same step (previous ${previousSets} sets, got ${prescribed.sets}).`);
    } else if (prescribed.sets > Math.min(STRENGTH_LIMITS.goalSets.max, previousSets + 1)) {
      messages.push(`${label} sets can rise by at most one per week: at most ${previousSets + 1} sets (previous ${previousSets}); got ${prescribed.sets}.`);
    }
    return;
  }

  if (entry.status === "hold") {
    if (prescribed.target > band.max) {
      messages.push(
        `${label} progression is not earned this week: keep the top working target between ${band.min} and ${band.max} ${unit} (previous ${previousTarget}); got ${prescribed.target}.`
      );
    } else if (prescribed.target < band.min) {
      messages.push(
        `${label} target dropped more than one step without a computed reason: keep the top working target between ${band.min} and ${band.max} ${unit} (previous ${previousTarget}); got ${prescribed.target}.`
      );
    }
    if (entry.maxSets !== null && prescribed.sets > entry.maxSets) {
      messages.push(`${label} sets can rise by at most one per week: at most ${entry.maxSets} sets (previous ${previousSets}); got ${prescribed.sets}.`);
    }
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
  const unit = metric === "plankSeconds" ? "seconds" : "reps";
  const value = goalValue(metric, exercise);
  const best = context.history.bestRecentTests[metric];

  if (effort?.stimulus === "test") {
    testedMetrics.add(metric);
    const performance = context.plannedWork.recentGoalPerformance?.[metric];
    const weekStart = Date.parse(context.profile.weekStart);
    const latestTest = performance?.latestTestDate ?? null;
    const baselineSetAt = performance?.baselineSetAt ?? null;
    const testAge = latestTest ? weekStart - Date.parse(latestTest) : Number.POSITIVE_INFINITY;
    const baselineAge = baselineSetAt ? weekStart - Date.parse(baselineSetAt) : Number.POSITIVE_INFINITY;
    if (Number.isFinite(testAge) && testAge < ASSESSMENT_SPACING_DAYS * DAY_MS) {
      messages.push(
        `${label} ${exercise.exercise} is a test, but the last ${METRIC_LABEL[metric]} test was on ${String(latestTest).slice(0, 10)}, fewer than ${ASSESSMENT_SPACING_DAYS} days ago. Use working sets instead.`
      );
    } else if (Number.isFinite(baselineAge) && baselineAge < ASSESSMENT_SPACING_DAYS * DAY_MS) {
      messages.push(
        `${label} ${exercise.exercise} is a test, but the ${METRIC_LABEL[metric]} baseline was set at the plan block start on ${String(baselineSetAt).slice(0, 10)}, fewer than ${ASSESSMENT_SPACING_DAYS} days ago. Use working sets instead.`
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

  const useful = effort && effort.label !== "light" && effort.stimulus !== "recovery" && effort.stimulus !== "technique";
  const sets = exercise.sets;
  if (useful && typeof sets === "number" && Number.isInteger(sets) && sets >= 1 &&
    (sets < STRENGTH_LIMITS.goalSets.min || sets > STRENGTH_LIMITS.goalSets.max)) {
    messages.push(
      `${label} ${exercise.exercise} has ${sets} working sets; goal work uses ${STRENGTH_LIMITS.goalSets.min}-${STRENGTH_LIMITS.goalSets.max} sets.`
    );
  }
}

function validateHardSessionLoad(sessions: unknown[], context: CoachContext, messages: string[]) {
  const hardOffsets: number[] = [];
  for (const session of sessions) {
    if (!isRecord(session) || typeof session.dayOffset !== "number") continue;
    if (hardestLabel(session as WeeklyPlan["sessions"][number]) !== null) hardOffsets.push(session.dayOffset);
  }

  const maxHard = maxHardStrengthSessions(context);
  if (hardOffsets.length > maxHard) {
    messages.push(
      `The plan has ${hardOffsets.length} hard strength sessions (hard, very_hard, or max_output in the session or any exercise); the weekly cap is ${maxHard}${context.running ? " alongside the running week" : ""}. Make ${hardOffsets.length - maxHard} of them medium or light.`
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

function collectUsefulGoalWork(
  exercise: Record<string, unknown>,
  effort: { label: EffortLabel; stimulus: EffortStimulus },
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>
) {
  if (effort.label === "light" || effort.stimulus === "recovery" || effort.stimulus === "technique" || effort.stimulus === "test") return;

  const exerciseKind = exercise.exercise;
  const sets = typeof exercise.sets === "number" && Number.isInteger(exercise.sets) ? exercise.sets : 0;
  const reps = typeof exercise.reps === "number" && Number.isInteger(exercise.reps) ? exercise.reps : 0;
  const seconds = typeof exercise.seconds === "number" && Number.isInteger(exercise.seconds) ? exercise.seconds : 0;

  if (exerciseKind === "pullUp") {
    recordGoalWork(usefulGoalWork, "pullUps", reps, sets);
  } else if (exerciseKind === "pushUp") {
    recordGoalWork(usefulGoalWork, "pushUps", reps, sets);
  } else if (exerciseKind === "plank") {
    recordGoalWork(usefulGoalWork, "plankSeconds", seconds, sets);
  }
}

function recordGoalWork(
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>,
  metric: "pullUps" | "pushUps" | "plankSeconds",
  target: number,
  sets: number
) {
  const previous = usefulGoalWork[metric];
  if (!previous || target > previous.target || (target === previous.target && sets > previous.sets)) {
    usefulGoalWork[metric] = { target, sets, volume: target * sets };
  }
}
