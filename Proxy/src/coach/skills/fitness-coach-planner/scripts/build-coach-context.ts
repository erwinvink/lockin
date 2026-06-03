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
  const trainingDayOffsets = normalizeTrainingDayOffsets(request.trainingDayOffsets);
  const weeklySessions = Array.isArray(request.trainingDayOffsets)
    ? trainingDayOffsets.length
    : clampInt(request.weeklySessions, 0, 6);
  const riskFlags = collectRiskFlags(
    last5Logs,
    lastFullMonth,
    previousFullMonth,
    weeklySessions,
    validCompletedMonthLogCount
  );
  const adherence = summarizeAdherence(request);
  const state = classifyState(riskFlags, twoFullMonthTrend.label, validCompletedMonthLogCount, adherence);

  return {
    profile: {
      baseline: request.baseline,
      goals: request.goals,
      profileNotes: trimNote(request.profileNotes),
      weekStart: request.weekStart,
      weeklySessions,
      trainingDays: normalizeTrainingDays(request.trainingDays),
      trainingDayOffsets,
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
  validCompletedMonthLogCount: number
): string[] {
  const flags: string[] = [];

  if (last5Logs.some((log) => log.painLevel >= 4)) flags.push("recent_pain_level_4_or_higher");
  if (last5Logs.some((log) => log.fatigueLevel >= 9)) flags.push("recent_fatigue_level_9_or_higher");
  if (last5Logs.filter((log) => log.rpe >= 9).length >= 3) flags.push("repeated_high_rpe");
  if (lastFullMonth.maxPain >= 4) flags.push("last_full_month_pain_flag");
  if (lastFullMonth.maxFatigue >= 9) flags.push("last_full_month_fatigue_flag");

  const expectedMonthlySessions = Math.max(1, weeklySessions * 4);
  if (lastFullMonth.logCount > 0 && lastFullMonth.logCount < expectedMonthlySessions * 0.6) {
    flags.push("low_last_full_month_training_count");
  }

  if (previousFullMonth.logCount > 0 && lastFullMonth.logCount > previousFullMonth.logCount * 1.5) {
    flags.push("sudden_monthly_volume_increase");
  }

  if (validCompletedMonthLogCount < 3) {
    flags.push("insufficient_completed_month_history");
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
  adherence: CoachContext["adherence"]
): ContextState {
  if (riskFlags.some((flag) => flag.includes("pain") || flag.includes("fatigue"))) return "recovery_needed";
  if (riskFlags.includes("sudden_monthly_volume_increase") || riskFlags.includes("repeated_high_rpe")) return "overreaching";
  if (validCompletedMonthLogCount < 3 || trendLabel === "insufficient_history") return "insufficient_history";
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

function normalizeTrainingDays(days: string[] | undefined): string[] {
  const validDays = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
  return [...new Set(days ?? [])].filter((day) => validDays.has(day));
}

function normalizeTrainingDayOffsets(offsets: number[] | undefined): number[] {
  return [...new Set(offsets ?? [])]
    .filter((offset) => Number.isInteger(offset) && offset >= 1 && offset <= 6)
    .sort((a, b) => a - b);
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
  return {
    ...log,
    notes: trimNote(log.notes)
  };
}

function trimNote(note: string | undefined): string {
  return (note ?? "").trim().replace(/\s+/g, " ").slice(0, 800);
}
