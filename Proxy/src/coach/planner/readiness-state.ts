import { deliveredVsPlanned } from "./delivered-work";
import { effortReadiness, type EffortReadiness } from "./effort-flags";
import { RECOVERY_NEEDED_FLAGS, recoveryFlagsAt } from "./readiness-flags";
import { addMonths, startOfMonthUTC, summarizeMonth, summarizeRollingTrend, summarizeTrend } from "./summarize-training-history";
import type { CoachContext, CoachRequest, ContextState, TrainingLog } from "./types";

/**
 * The computed readiness, in one place: the context builder (and through it
 * the planners and the coach read) and the plan-continuity signals
 * (current-plan.ts) read it. The ladder itself is classifyState's.
 */
export type ComputedReadiness = {
  state: ContextState;
  riskFlags: string[];
  effort: EffortReadiness;
  currentPartialMonth: CoachContext["history"]["currentPartialMonth"];
  lastFullMonth: CoachContext["history"]["lastFullMonth"];
  previousFullMonth: CoachContext["history"]["previousFullMonth"];
  twoFullMonthTrend: CoachContext["history"]["twoFullMonthTrend"];
  rollingTrend: NonNullable<CoachContext["history"]["rollingTrend"]>;
};

/** The normal readiness states: no reactive offload or recovery. */
export const NORMAL_READINESS_STATES: ReadonlySet<ContextState> = new Set<ContextState>(["building", "plateau", "insufficient_history"]);

/**
 * Readiness at `now` from the logs sorted by completion time. Adherence only
 * tells plateau from building (both normal).
 */
export function computeReadiness(
  request: CoachRequest,
  sortedLogs: TrainingLog[],
  now: Date,
  adherence: CoachContext["adherence"]
): ComputedReadiness {
  // Delivered work against each session's own plan (see delivered-work.ts).
  const sessionsById = new Map(request.plannedSessions.map((session) => [session.id, session]));
  const planOf = (log: TrainingLog) => sessionsById.get(log.sessionId)?.exercises;
  const deliveredWork = (log: TrainingLog) => deliveredVsPlanned(log, planOf(log));
  const metPlan = (log: TrainingLog, metric: "pullUps" | "pushUps" | "plankSeconds") =>
    deliveredWork(log).some((entry) => entry.metric === metric && !entry.shortfall);
  const fellShort = (log: TrainingLog, metric: "pullUps" | "pushUps" | "plankSeconds") =>
    deliveredWork(log).some((entry) => entry.metric === metric && entry.shortfall);

  const currentMonthStart = startOfMonthUTC(now);
  const lastFullMonthStart = addMonths(currentMonthStart, -1);
  const previousFullMonthStart = addMonths(currentMonthStart, -2);
  const currentPartialMonth = summarizeMonth(sortedLogs, currentMonthStart, true);
  const lastFullMonth = summarizeMonth(sortedLogs, lastFullMonthStart, false);
  const previousFullMonth = summarizeMonth(sortedLogs, previousFullMonthStart, false);
  const twoFullMonthTrend = summarizeTrend(lastFullMonth, previousFullMonth);
  const blockStartMs = planBlockStartMs(request);
  const rollingTrend = summarizeRollingTrend(sortedLogs, now, blockStartMs, metPlan, fellShort);
  const effort = effortReadiness(sortedLogs, planOf, now, blockStartMs);
  const validCompletedMonthLogCount = validLogCount(sortedLogs, previousFullMonthStart, currentMonthStart);
  const validCurrentMonthLogCount = validLogCount(sortedLogs, currentMonthStart, addMonths(currentMonthStart, 1));
  const riskFlags = collectRiskFlags(
    sortedLogs,
    effort,
    now,
    lastFullMonth,
    previousFullMonth,
    request.weeklySessions,
    validCompletedMonthLogCount,
    validCurrentMonthLogCount
  );
  const state = classifyState(
    riskFlags,
    effort,
    twoFullMonthTrend.label,
    rollingTrend.label,
    validCompletedMonthLogCount,
    validCurrentMonthLogCount,
    adherence
  );
  return { state, riskFlags, effort, currentPartialMonth, lastFullMonth, previousFullMonth, twoFullMonthTrend, rollingTrend };
}

/**
 * The readiness state recomputed for `at` from the logs known now: those
 * completed up to and including `at`, every window ending then. It is not a
 * stored copy of what the planner saw then: a log synced late with an
 * earlier time counts too. Adherence is today's (it only tells plateau from
 * building, both normal).
 */
export function readinessStateAt(request: CoachRequest, at: Date, adherence: CoachContext["adherence"]): ContextState {
  const atMs = at.getTime();
  const logs = sortedTrainingLogs(request).filter((log) => Date.parse(log.completedAt) <= atMs);
  return computeReadiness(request, logs, at, adherence).state;
}

export function sortedTrainingLogs(request: CoachRequest): TrainingLog[] {
  return [...request.trainingLogs].sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime());
}

export function planBlockStartMs(request: CoachRequest): number | null {
  const start = typeof request.planBlockStartedAt === "string" ? Date.parse(request.planBlockStartedAt) : Number.NaN;
  return Number.isFinite(start) ? start : null;
}

function collectRiskFlags(
  sortedLogs: TrainingLog[],
  effort: EffortReadiness,
  now: Date,
  lastFullMonth: CoachContext["history"]["lastFullMonth"],
  previousFullMonth: CoachContext["history"]["previousFullMonth"],
  weeklySessions: number,
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number
): string[] {
  const flags: string[] = [];

  flags.push(...recoveryFlagsAt(sortedLogs, now));
  // Effort is judged against the plan (effort-flags.ts): planned near-max
  // work, tests and sessions that did clearly more than planned never count.
  flags.push(...effort.flags);
  if (lastFullMonth.maxPain >= 4) flags.push("last_full_month_pain_flag");
  if (lastFullMonth.maxFatigue >= 9) flags.push("last_full_month_how_you_felt_very_weak");

  const expectedMonthlySessions = Math.max(1, weeklySessions * 4);
  if (lastFullMonth.logCount > 0 && lastFullMonth.logCount < expectedMonthlySessions * 0.6) {
    flags.push("low_last_full_month_training_count");
  }

  if (
    previousFullMonth.logCount >= expectedMonthlySessions * 0.6 &&
    lastFullMonth.logCount > previousFullMonth.logCount * 1.5
  ) {
    flags.push("sudden_monthly_volume_increase");
  }

  if (validCompletedMonthLogCount < 3 && validCurrentMonthLogCount < 2) {
    flags.push("insufficient_training_history");
  }

  return flags;
}

/**
 * The readiness ladder: recovery_needed (pain, very weak feedback), then
 * overreaching (an effort flag with a second marker within 14 days, or a
 * rolling decline with repeated results below plan), else a normal state.
 * Effort above plan alone only calibrates the goal metrics it touched.
 */
function classifyState(
  riskFlags: string[],
  effort: EffortReadiness,
  monthTrendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  rollingTrendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number,
  adherence: CoachContext["adherence"]
): ContextState {
  if (riskFlags.some((flag) => RECOVERY_NEEDED_FLAGS.has(flag))) return "recovery_needed";
  if (effort.overreaching !== null) return "overreaching";
  const hasEarlyCurrentEvidence = validCurrentMonthLogCount >= 2;
  if ((validCompletedMonthLogCount < 3 || monthTrendLabel === "insufficient_history") && !hasEarlyCurrentEvidence) {
    return "insufficient_history";
  }
  // Plateau and decline come from the rolling 3-week windows, so they show
  // up within weeks instead of after two full calendar months. A decline
  // already needs two results below plan (summarizeRollingTrend).
  if (rollingTrendLabel === "flat" && adherence.completed >= Math.max(3, adherence.planned * 0.7)) return "plateau";
  if (rollingTrendLabel === "declining") return "overreaching";
  return "building";
}

function validLogCount(logs: TrainingLog[], start: Date, end: Date): number {
  return logs.filter((log) => {
    const completedAt = new Date(log.completedAt);
    return completedAt >= start && completedAt < end && (log.loggedPullUps || log.loggedPushUps || log.loggedPlankSeconds);
  }).length;
}
