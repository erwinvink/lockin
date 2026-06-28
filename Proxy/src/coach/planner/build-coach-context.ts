import { addMonths, startOfMonthUTC, summarizeMonth, summarizeTrend } from "./summarize-training-history";
import type { CoachContext, CoachRequest, ContextState, PlannedExercisePrescription, PlannedGoalTrend, TrainingLog } from "./types";

export function buildCoachContext(request: CoachRequest, now = new Date()): CoachContext {
  const sortedLogs = [...request.trainingLogs].sort(
    (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
  );
  const last5Logs = sortedLogs.slice(-5).map(normalizeLogForContext);

  const currentMonthStart = startOfMonthUTC(now);
  const lastFullMonthStart = addMonths(currentMonthStart, -1);
  const previousFullMonthStart = addMonths(currentMonthStart, -2);

  const currentPartialMonth = summarizeMonth(sortedLogs, currentMonthStart, true);
  const lastFullMonth = summarizeMonth(sortedLogs, lastFullMonthStart, false);
  const previousFullMonth = summarizeMonth(sortedLogs, previousFullMonthStart, false);
  const twoFullMonthTrend = summarizeTrend(lastFullMonth, previousFullMonth);
  const validCompletedMonthLogCount = validLogCount(sortedLogs, previousFullMonthStart, currentMonthStart);
  const validCurrentMonthLogCount = validLogCount(sortedLogs, currentMonthStart, addMonths(currentMonthStart, 1));
  const riskFlags = collectRiskFlags(
    last5Logs,
    lastFullMonth,
    previousFullMonth,
    request.weeklySessions,
    validCompletedMonthLogCount,
    validCurrentMonthLogCount
  );
  const adherence = summarizeAdherence(request);
  const state = classifyState(riskFlags, twoFullMonthTrend.label, validCompletedMonthLogCount, validCurrentMonthLogCount, adherence);

  return {
    profile: {
      baseline: request.baseline,
      goals: request.goals,
      profileNotes: trimNote(request.profileNotes),
      weekStart: request.weekStart,
      weeklySessions: clampInt(request.weeklySessions, 1, 7),
      trainingDays: Array.isArray(request.trainingDays) ? request.trainingDays.filter((day) => typeof day === "string") : [],
      trainingDayOffsets: normalizeFutureDayOffsets(request.trainingDayOffsets),
      equipment: [...request.equipment].sort(),
      targetDate: request.targetDate
    },
    history: {
      last5Logs,
      rpeCalibration: summarizeRPECalibration(last5Logs),
      currentPartialMonth,
      lastFullMonth,
      previousFullMonth,
      twoFullMonthTrend,
      bestRecentTests: {
        pullUps: latestKnownBest("pullUps", "loggedPullUps", sortedLogs, request.baseline.pullUps),
        pushUps: latestKnownBest("pushUps", "loggedPushUps", sortedLogs, request.baseline.pushUps),
        plankSeconds: latestKnownBest("plankSeconds", "loggedPlankSeconds", sortedLogs, request.baseline.plankSeconds)
      }
    },
    adherence,
    plannedWork: summarizePlannedWork(request.plannedSessions, request.weekStart),
    readiness: {
      state,
      riskFlags
    },
    running: request.running
      ? {
          ...request.running,
          runningDayOffsets: normalizeFutureDayOffsets(request.running.runningDayOffsets),
          recentRuns: [...request.running.recentRuns]
            .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime())
            .slice(-30),
          weeksToRace: weeksToRace(request.running.raceGoal.raceDate, request.weekStart)
        }
      : undefined
  };
}

function weeksToRace(raceDate: string, weekStart: string): number {
  const days = Math.round((Date.parse(raceDate) - Date.parse(weekStart)) / (24 * 60 * 60 * 1000));
  return Number.isFinite(days) ? Math.max(0, Math.ceil(days / 7)) : 0;
}

function collectRiskFlags(
  last5Logs: TrainingLog[],
  lastFullMonth: CoachContext["history"]["lastFullMonth"],
  previousFullMonth: CoachContext["history"]["previousFullMonth"],
  weeklySessions: number,
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number
): string[] {
  const flags: string[] = [];

  if (last5Logs.some((log) => log.painLevel >= 4)) flags.push("recent_pain_level_4_or_higher");
  if (last5Logs.some((log) => log.fatigueLevel >= 9)) flags.push("recent_how_you_felt_very_weak");
  if (last5Logs.filter((log) => log.rpe >= 9).length >= 3) flags.push("repeated_high_perceived_effort");
  if (last5Logs.filter((log) => typeof log.rpeDelta === "number" && log.rpeDelta >= 2).length >= 2) {
    flags.push("recent_effort_above_plan");
  }
  if (lastFullMonth.maxPain >= 4) flags.push("last_full_month_pain_flag");
  if (lastFullMonth.maxFatigue >= 9) flags.push("last_full_month_how_you_felt_very_weak");

  const expectedMonthlySessions = Math.max(1, weeklySessions * 4);
  if (lastFullMonth.logCount > 0 && lastFullMonth.logCount < expectedMonthlySessions * 0.6) {
    flags.push("low_last_full_month_training_count");
  }

  if (previousFullMonth.logCount > 0 && lastFullMonth.logCount > previousFullMonth.logCount * 1.5) {
    flags.push("sudden_monthly_volume_increase");
  }

  if (validCompletedMonthLogCount < 3 && validCurrentMonthLogCount < 2) {
    flags.push("insufficient_training_history");
  }

  return flags;
}

function summarizeAdherence(request: CoachRequest): CoachContext["adherence"] {
  const planned = request.plannedSessions.length;
  return {
    planned,
    completed: request.plannedSessions.filter((session) => session.status === "completed").length,
    missed: request.plannedSessions.filter((session) => session.status === "missed").length,
    deload: request.plannedSessions.filter((session) => session.status === "deload").length
  };
}

function summarizePlannedWork(plannedSessions: CoachRequest["plannedSessions"], weekStart: string): CoachContext["plannedWork"] {
  const startTime = new Date(weekStart).getTime();
  const endOfToday = startTime + 24 * 60 * 60 * 1000;
  const todaySessions = plannedSessions
    .filter((session) => {
      const scheduled = new Date(session.scheduledDate).getTime();
      return Number.isFinite(scheduled) && scheduled >= startTime && scheduled < endOfToday;
    })
    .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime())
    .map((session) => ({
      id: session.id,
      title: session.title,
      status: session.status,
      focus: session.focus,
      scheduledDate: session.scheduledDate
    }));
  const goalEntries = plannedSessions
    .filter((session) => new Date(session.scheduledDate).getTime() < startTime)
    .flatMap((session) =>
      (session.exercises ?? [])
        .filter(isGoalWorkPrescription)
        .map((exercise) => ({
          metric: goalMetricForExercise(exercise.exercise),
          scheduledDate: session.scheduledDate,
          target: exercise.exercise === "plank" ? exercise.targetSeconds : exercise.targetReps,
          volume: (exercise.exercise === "plank" ? exercise.targetSeconds : exercise.targetReps) * exercise.sets
        }))
    )
    .filter((entry): entry is { metric: "pullUps" | "pushUps" | "plankSeconds"; scheduledDate: string; target: number; volume: number } =>
      entry.metric !== null && entry.target > 0 && entry.volume > 0
    )
    .sort((a, b) => new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime());

  return {
    todaySessions,
    recentGoalTargets: {
      pullUps: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "pullUps")),
      pushUps: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "pushUps")),
      plankSeconds: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "plankSeconds"))
    }
  };
}

function isGoalWorkPrescription(exercise: PlannedExercisePrescription): boolean {
  if (!["pullUp", "pushUp", "plank"].includes(exercise.exercise)) return false;
  if (exercise.plannedEffortLabel === "light") return false;
  if (exercise.plannedEffortStimulus === "recovery" || exercise.plannedEffortStimulus === "technique") return false;
  return exercise.sets > 0 && (exercise.targetReps > 0 || exercise.targetSeconds > 0);
}

function goalMetricForExercise(exercise: string): "pullUps" | "pushUps" | "plankSeconds" | null {
  switch (exercise) {
    case "pullUp":
      return "pullUps";
    case "pushUp":
      return "pushUps";
    case "plank":
      return "plankSeconds";
    default:
      return null;
  }
}

function summarizeGoalTrend(
  entries: Array<{ scheduledDate: string; target: number; volume: number }>
): PlannedGoalTrend {
  const latest = entries[0];
  if (!latest) {
    return { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null };
  }

  let flatCount = 0;
  for (const entry of entries) {
    if (entry.target !== latest.target || entry.volume !== latest.volume) break;
    flatCount += 1;
  }

  return {
    latestTarget: latest.target,
    latestVolume: latest.volume,
    flatCount,
    latestDate: latest.scheduledDate
  };
}

function classifyState(
  riskFlags: string[],
  trendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number,
  adherence: CoachContext["adherence"]
): ContextState {
  if (riskFlags.some((flag) => flag.includes("pain") || flag.includes("how_you_felt_very_weak"))) return "recovery_needed";
  if (
    riskFlags.includes("sudden_monthly_volume_increase") ||
    riskFlags.includes("repeated_high_perceived_effort") ||
    riskFlags.includes("recent_effort_above_plan")
  ) {
    return "overreaching";
  }
  const hasEarlyCurrentEvidence = validCurrentMonthLogCount >= 2;
  if ((validCompletedMonthLogCount < 3 || trendLabel === "insufficient_history") && !hasEarlyCurrentEvidence) {
    return "insufficient_history";
  }
  if (trendLabel === "flat" && adherence.completed >= Math.max(3, adherence.planned * 0.7)) return "plateau";
  if (trendLabel === "declining") return "overreaching";
  return "building";
}

function latestKnownBest(
  metric: "pullUps" | "pushUps" | "plankSeconds",
  flag: "loggedPullUps" | "loggedPushUps" | "loggedPlankSeconds",
  logs: TrainingLog[],
  baseline: number
): number | null {
  const values = logs.filter((log) => log[flag]).map((log) => log[metric]);
  if (values.length === 0) return baseline > 0 ? baseline : null;
  return Math.max(...values, baseline);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeFutureDayOffsets(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((offset): offset is number => typeof offset === "number" && Number.isInteger(offset) && offset >= 1 && offset <= 6)
  )].sort((a, b) => a - b);
}

function validLogCount(logs: TrainingLog[], start: Date, end: Date): number {
  return logs.filter((log) => {
    const completedAt = new Date(log.completedAt);
    return completedAt >= start && completedAt < end && hasLoggedGoalMetric(log);
  }).length;
}

function hasLoggedGoalMetric(log: TrainingLog): boolean {
  return log.loggedPullUps || log.loggedPushUps || log.loggedPlankSeconds;
}

function normalizeLogForContext(log: TrainingLog): TrainingLog {
  const howYouFeltScore = howYouFeltScoreFromFatigueLevel(log.fatigueLevel);
  const actualRPE = normalizeRPE(log.actualRPE) ?? normalizeRPE(log.rpe) ?? log.rpe;
  const plannedRPE = normalizeRPE(log.plannedRPE);
  const rpeDelta = typeof plannedRPE === "number" ? actualRPE - plannedRPE : undefined;
  const generatedSummary = typeof plannedRPE === "number"
    ? `RPE - Planned ${plannedRPE} | Actual ${actualRPE}`
    : undefined;

  return {
    ...log,
    rpe: actualRPE,
    perceivedEffort: actualRPE,
    plannedRPE,
    actualRPE,
    rpeDelta,
    rpeSummary: trimNote(log.rpeSummary || generatedSummary || ""),
    plannedEffortReason: trimNote(log.plannedEffortReason || ""),
    howYouFeltScore,
    howYouFelt: howYouFeltLabel(howYouFeltScore),
    notes: trimNote(log.notes)
  };
}

function summarizeRPECalibration(logs: TrainingLog[]): CoachContext["history"]["rpeCalibration"] {
  const deltas = logs
    .map((log) => log.rpeDelta)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const latestSummary = [...logs].reverse().find((log) => log.rpeSummary)?.rpeSummary ?? null;

  return {
    recentPlannedLogCount: deltas.length,
    averageDeltaLast5: averageDelta(deltas),
    abovePlanBy2Count: deltas.filter((delta) => delta >= 2).length,
    belowPlanBy2Count: deltas.filter((delta) => delta <= -2).length,
    latestSummary
  };
}

function averageDelta(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function normalizeRPE(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return rounded >= 1 && rounded <= 10 ? rounded : undefined;
}

function trimNote(note: string | undefined): string {
  return (note ?? "").trim().replace(/\s+/g, " ").slice(0, 800);
}

function howYouFeltScoreFromFatigueLevel(fatigueLevel: number): number {
  if (fatigueLevel >= 9) return 1;
  if (fatigueLevel >= 7) return 2;
  if (fatigueLevel >= 3) return 3;
  if (fatigueLevel >= 1) return 4;
  return 5;
}

function howYouFeltLabel(score: number): NonNullable<TrainingLog["howYouFelt"]> {
  if (score <= 1) return "very_weak";
  if (score === 2) return "weak";
  if (score === 4) return "strong";
  if (score >= 5) return "very_strong";
  return "normal";
}
