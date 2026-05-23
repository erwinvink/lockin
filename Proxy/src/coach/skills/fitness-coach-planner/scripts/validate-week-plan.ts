import type { CoachContext, ExerciseKind, WeeklyPlan } from "./types";

type ValidationResult = {
  accepted: boolean;
  messages: string[];
};

const pullBarExercises = new Set<ExerciseKind>(["pullUp", "scapularPull", "deadHang"]);
const pullExercises = new Set<ExerciseKind>(["pullUp", "scapularPull", "deadHang"]);
const pushExercises = new Set<ExerciseKind>(["pushUp", "inclinePushUp", "pikePushUp"]);
const coreExercises = new Set<ExerciseKind>(["plank", "hollowHold"]);
const goalLoggingByExercise: Partial<Record<ExerciseKind, "pullUps" | "pushUps" | "plankSeconds">> = {
  pullUp: "pullUps",
  pushUp: "pushUps",
  plank: "plankSeconds"
};

export function validateWeeklyPlan(plan: WeeklyPlan, context: CoachContext): ValidationResult {
  const messages: string[] = [];

  if (!plan || typeof plan !== "object") {
    return { accepted: false, messages: ["Plan is not an object."] };
  }

  if (!Array.isArray(plan.sessions)) {
    return { accepted: false, messages: ["Plan sessions is missing or not an array."] };
  }

  if (plan.sessions.length !== context.profile.weeklySessions) {
    messages.push(`Expected ${context.profile.weeklySessions} sessions, got ${plan.sessions.length}.`);
  }

  if (plan.contextState !== context.readiness.state) {
    messages.push(`Plan contextState ${plan.contextState} does not match built context ${context.readiness.state}.`);
  }

  const hasPullUpBar = context.profile.equipment.includes("pullUpBar");
  const pullCap = cap(context.history.bestRecentTests.pullUps, context.profile.baseline.pullUps, 0.85, 1);
  const pushCap = cap(context.history.bestRecentTests.pushUps, context.profile.baseline.pushUps, 0.75, 2);
  const plankCap = cap(context.history.bestRecentTests.plankSeconds, context.profile.baseline.plankSeconds, 0.8, 15);
  const weeklyPatterns = new Set<MovementPattern>();
  let balancedSessionCount = 0;
  let previousDayOffset = -1;

  for (const [sessionIndex, session] of plan.sessions.entries()) {
    if (!Array.isArray(session.exercises)) {
      messages.push(`Session ${sessionIndex + 1} exercises is missing or not an array.`);
      continue;
    }

    if (!Array.isArray(session.loggingFieldsRequired)) {
      messages.push(`Session ${sessionIndex + 1} loggingFieldsRequired is missing or not an array.`);
      continue;
    }

    if (session.estimatedDurationMinutes < 10 || session.estimatedDurationMinutes > 120) {
      messages.push(`Session ${sessionIndex + 1} estimated duration is outside 10-120 minutes.`);
    }

    if (!Number.isInteger(session.dayOffset) || session.dayOffset < 0 || session.dayOffset > 6) {
      messages.push(`Session ${sessionIndex + 1} dayOffset must be an integer from 0 through 6.`);
    }

    if (Number.isInteger(session.dayOffset)) {
      if (session.dayOffset <= previousDayOffset) {
        messages.push(`Session ${sessionIndex + 1} dayOffset must be strictly later than the previous session.`);
      }
      previousDayOffset = session.dayOffset;
    }

    const prescribedGoalFields = new Set<"pullUps" | "pushUps" | "plankSeconds">();
    const sessionPatterns = new Set<MovementPattern>();

    for (const exercise of session.exercises) {
      if (!hasPullUpBar && pullBarExercises.has(exercise.exercise)) {
        messages.push(`${exercise.exercise} requires pullUpBar, but pullUpBar is unavailable.`);
      }

      if (exercise.sets < 1 || exercise.sets > 10) {
        messages.push(`${exercise.exercise} has unsafe set count ${exercise.sets}.`);
      }

      if (exercise.reps < 0 || exercise.seconds < 0 || exercise.restSeconds < 0) {
        messages.push(`${exercise.exercise} contains a negative reps, seconds, or rest value.`);
      }

      if (exercise.exercise === "pullUp" && exercise.reps > pullCap) {
        messages.push(`Pull-up set exceeds cap: ${exercise.reps} > ${pullCap}.`);
      }

      if (exercise.exercise === "pushUp" && exercise.reps > pushCap) {
        messages.push(`Push-up set exceeds cap: ${exercise.reps} > ${pushCap}.`);
      }

      if (exercise.exercise === "plank" && exercise.seconds > plankCap) {
        messages.push(`Plank hold exceeds cap: ${exercise.seconds}s > ${plankCap}s.`);
      }

      const loggingField = goalLoggingByExercise[exercise.exercise];
      if (loggingField) prescribedGoalFields.add(loggingField);

      for (const pattern of patternsFor(exercise.exercise)) {
        sessionPatterns.add(pattern);
        weeklyPatterns.add(pattern);
      }

      if (context.readiness.state === "recovery_needed" && isHardIntensity(exercise.intensity)) {
        messages.push(`Recovery-needed plan contains hard intensity for ${exercise.exercise}.`);
      }
    }

    if (session.focus === "mixed" && !isBalancedEnough(sessionPatterns, hasPullUpBar)) {
      messages.push(`Session ${sessionIndex + 1} is marked mixed but does not cover enough movement patterns.`);
    }

    if (session.focus !== "mixed" && session.focus !== "recovery" && !sessionPatterns.has(session.focus)) {
      messages.push(`Session ${sessionIndex + 1} is marked ${session.focus} but does not prescribe that movement pattern.`);
    }

    if (
      context.readiness.state !== "recovery_needed" &&
      session.focus !== "mixed" &&
      session.focus !== "recovery" &&
      sessionPatterns.size < 2
    ) {
      messages.push(`Session ${sessionIndex + 1} is a single-focus day without support work.`);
    }

    if (isBalancedEnough(sessionPatterns, hasPullUpBar)) {
      balancedSessionCount += 1;
    }

    for (const prescribedField of prescribedGoalFields) {
      if (!session.loggingFieldsRequired.includes(prescribedField)) {
        messages.push(`Session ${sessionIndex + 1} prescribes ${prescribedField} work but does not require that log field.`);
      }
    }

    for (const requestedField of session.loggingFieldsRequired) {
      if (!prescribedGoalFields.has(requestedField)) {
        messages.push(`Session ${sessionIndex + 1} requires ${requestedField} logging without prescribing that goal exercise.`);
      }
    }
  }

  if (context.readiness.state !== "recovery_needed") {
    if (hasPullUpBar && !weeklyPatterns.has("pull")) {
      messages.push("Weekly plan does not include pull exposure.");
    }
    if (!weeklyPatterns.has("push")) {
      messages.push("Weekly plan does not include push exposure.");
    }
    if (!weeklyPatterns.has("core")) {
      messages.push("Weekly plan does not include core exposure.");
    }

    const requiredBalancedSessions = context.profile.weeklySessions >= 4 ? 2 : context.profile.weeklySessions >= 3 ? 1 : 0;
    if (balancedSessionCount < requiredBalancedSessions) {
      messages.push(`Expected at least ${requiredBalancedSessions} mixed or full-body sessions, got ${balancedSessionCount}.`);
    }
  }

  return { accepted: messages.length === 0, messages };
}

function cap(bestRecent: number | null, baseline: number, multiplier: number, minimum: number): number {
  const source = Math.max(bestRecent ?? 0, baseline, minimum);
  return Math.max(minimum, Math.floor(source * multiplier));
}

type MovementPattern = "pull" | "push" | "core";

function patternsFor(exercise: ExerciseKind): MovementPattern[] {
  const patterns: MovementPattern[] = [];
  if (pullExercises.has(exercise)) patterns.push("pull");
  if (pushExercises.has(exercise)) patterns.push("push");
  if (coreExercises.has(exercise)) patterns.push("core");
  return patterns;
}

function isBalancedEnough(patterns: Set<MovementPattern>, hasPullUpBar: boolean): boolean {
  if (hasPullUpBar) {
    return patterns.has("pull") && patterns.has("push") && patterns.has("core");
  }
  return patterns.has("push") && patterns.has("core");
}

function isHardIntensity(intensity: string): boolean {
  const normalized = intensity.toLowerCase();
  return normalized.includes("hard") || normalized.includes("max") || normalized.includes("failure");
}
