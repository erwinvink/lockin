import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import type { CoachContext, ContextState, EffortLabel, EffortStimulus, ExerciseKind, SessionFocus } from "./types";

type ValidationResult = {
  accepted: boolean;
  messages: string[];
};

type GoalWorkSummary = {
  target: number;
  volume: number;
};

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

export function validateWeeklyPlan(plan: unknown, context: CoachContext): ValidationResult {
  const messages: string[] = [];

  if (!isRecord(plan)) {
    return { accepted: false, messages: ["Plan is not an object."] };
  }

  if (typeof plan.summary !== "string") {
    messages.push("Plan summary is missing or not a string.");
  }

  if (typeof plan.contextState !== "string" || !contextStates.has(plan.contextState as ContextState)) {
    messages.push("Plan contextState is missing or unknown.");
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
      validateEffortPolicy(sessionEffort, `Session ${sessionIndex + 1}`, plan.contextState, messages);
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
        validateEffortPolicy(exerciseEffort, `Session ${sessionIndex + 1} exercise`, plan.contextState, messages);
        collectUsefulGoalWork(exercise, exerciseEffort, usefulGoalWork);
      }
    }
  }

  validateWeekEffortPolicy(plan.contextState, plan.safetyFlags, context, sessionEffortLabels, usefulGoalWork, messages);

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
  contextState: unknown,
  safetyFlags: unknown,
  context: CoachContext,
  sessionEffortLabels: EffortLabel[],
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>,
  messages: string[]
) {
  const normalProgressionStates = new Set(["building", "plateau", "insufficient_history"]);
  const hasSafetyFlags = Array.isArray(safetyFlags) && safetyFlags.length > 0;
  if (!normalProgressionStates.has(String(contextState)) || hasSafetyFlags) return;

  if (sessionEffortLabels.length > 0 && sessionEffortLabels.every((label) => label === "light")) {
    messages.push("Normal progression weeks cannot be all light unless safetyFlags explain why.");
  }

  const floors: Array<["pullUps" | "pushUps" | "plankSeconds", number, string]> = [
    ["pullUps", 0.45, "pull-up"],
    ["pushUps", 0.45, "push-up"],
    ["plankSeconds", 0.45, "plank"]
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

  for (const { metric, label, latestTarget, latestVolume } of flatGoalMetricsRequiringProgression(context)) {
    const prescribed = usefulGoalWork[metric];
    if (!prescribed || (prescribed.target <= latestTarget && prescribed.volume <= latestVolume)) {
      messages.push(
        `Normal progression ${label} work repeats the recent flat prescription. Increase reps, hold time, sets, or add safetyFlags with a clear reason.`
      );
    }
  }
}

function collectUsefulGoalWork(
  exercise: Record<string, unknown>,
  effort: { label: EffortLabel; stimulus: EffortStimulus },
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>
) {
  if (effort.label === "light" || effort.stimulus === "recovery" || effort.stimulus === "technique") return;

  const exerciseKind = exercise.exercise;
  const sets = typeof exercise.sets === "number" && Number.isInteger(exercise.sets) ? exercise.sets : 0;
  const reps = typeof exercise.reps === "number" && Number.isInteger(exercise.reps) ? exercise.reps : 0;
  const seconds = typeof exercise.seconds === "number" && Number.isInteger(exercise.seconds) ? exercise.seconds : 0;

  if (exerciseKind === "pullUp") {
    recordGoalWork(usefulGoalWork, "pullUps", reps, reps * sets);
  } else if (exerciseKind === "pushUp") {
    recordGoalWork(usefulGoalWork, "pushUps", reps, reps * sets);
  } else if (exerciseKind === "plank") {
    recordGoalWork(usefulGoalWork, "plankSeconds", seconds, seconds * sets);
  }
}

function recordGoalWork(
  usefulGoalWork: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", GoalWorkSummary>>,
  metric: "pullUps" | "pushUps" | "plankSeconds",
  target: number,
  volume: number
) {
  const previous = usefulGoalWork[metric];
  usefulGoalWork[metric] = {
    target: Math.max(previous?.target ?? 0, target),
    volume: Math.max(previous?.volume ?? 0, volume)
  };
}
