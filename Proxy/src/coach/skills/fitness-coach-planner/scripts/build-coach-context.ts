import { addMonths, startOfMonthUTC, summarizeMonth, summarizeTrend } from "./summarize-training-history";
import type { CoachContext, CoachRequest, ContextState, TrainingLog } from "./types";

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
    readiness: {
      state,
      riskFlags
    }
  };
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

function classifyState(
  riskFlags: string[],
  trendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number,
  adherence: CoachContext["adherence"]
): ContextState {
  if (riskFlags.some((flag) => flag.includes("pain") || flag.includes("how_you_felt_very_weak"))) return "recovery_needed";
  if (riskFlags.includes("sudden_monthly_volume_increase") || riskFlags.includes("repeated_high_perceived_effort")) return "overreaching";
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
  return {
    ...log,
    perceivedEffort: log.rpe,
    howYouFeltScore,
    howYouFelt: howYouFeltLabel(howYouFeltScore),
    notes: trimNote(log.notes)
  };
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
