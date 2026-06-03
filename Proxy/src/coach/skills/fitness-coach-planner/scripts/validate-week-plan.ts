import type { CoachContext, ContextState, ExerciseKind, SessionFocus } from "./types";

type ValidationResult = {
  accepted: boolean;
  messages: string[];
};

const contextStates = new Set<ContextState>([
  "building",
  "plateau",
  "overreaching",
  "recovery_needed",
  "insufficient_history"
]);
const sessionFocuses = new Set<SessionFocus>(["pull", "push", "core", "mixed", "recovery"]);
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

  if (plan.sessions.length !== context.profile.weeklySessions) {
    messages.push(`Expected ${context.profile.weeklySessions} sessions, got ${plan.sessions.length}.`);
  }

  let previousDayOffset = -1;
  const allowedTrainingOffsets = new Set(context.profile.trainingDayOffsets);

  for (const [sessionIndex, session] of plan.sessions.entries()) {
    if (!isRecord(session)) {
      messages.push(`Session ${sessionIndex + 1} is not an object.`);
      continue;
    }

    if (typeof session.title !== "string") {
      messages.push(`Session ${sessionIndex + 1} title is missing or not a string.`);
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
      if (allowedTrainingOffsets.size > 0 && dayOffset >= 1 && dayOffset <= 6 && !allowedTrainingOffsets.has(dayOffset)) {
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
    }
  }

  return { accepted: messages.length === 0, messages };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
