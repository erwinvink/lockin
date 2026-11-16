import { nextLocalMidnight, startOfLocalDay, validTimeZone } from "../local-time";
import { buildCurrentPlanContext, todayPlannedRunsFromRequest } from "./current-plan";
import { deliveredVsPlanned, describeDeliveredVsPlan, didMoreThanPlanned, overDeliveryMargin, plannedTargetFor } from "./delivered-work";
import { actualRPE, cleanCompletion, testsAGoal, validRPE, type EffortReadiness } from "./effort-flags";
import { supportedExercisesFor } from "./exercise-catalog";
import {
  GOAL_METRICS,
  hardestOf,
  isGoalTest,
  LOGGED_FLAG,
  METRIC_PLURAL,
  metricForExercise,
  prescribedValue,
  prescriptionEffort,
  topBlock,
  type GoalMetric
} from "./goal-metrics";
import { computePeriodization } from "./periodization";
import { computeReadiness, planBlockStartMs, sortedTrainingLogs } from "./readiness-state";
import { planBlockContext } from "./plan-block";
import { preTaperTrainingWeekKm } from "./running-floors";
import { computeSeason, daysBetween } from "./season";
import { ROLLING_TREND } from "./summarize-training-history";
import type {
  CoachContext,
  CoachRequest,
  ContextState,
  EffortLabel,
  PlannedExercisePrescription,
  PlannedGoalTrend,
  RecentGoalPerformance,
  TrainingLog
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

export { READINESS_WINDOWS, RECOVERY_NEEDED_FLAGS, unresolvedRecentTrigger } from "./readiness-flags";
/**
 * Planned RPE assumed when a log carries none (effort-flags.ts): without it
 * manually logged or legacy sessions could never earn progression.
 */
export { DEFAULT_PLANNED_RPE } from "./effort-flags";

export function buildCoachContext(request: CoachRequest, now = new Date()): CoachContext {
  const context = buildBaseContext(request, now);
  const currentPlan = buildCurrentPlanContext(request, context, now);
  const todayPlannedRuns = todayPlannedRunsFromRequest(request);
  return {
    ...context,
    ...(currentPlan ? { currentPlan } : {}),
    ...(todayPlannedRuns.length > 0 ? { todayPlannedRuns } : {})
  };
}

function buildBaseContext(request: CoachRequest, now: Date): CoachContext {
  const sortedLogs = sortedTrainingLogs(request);
  // Delivered work against each session's own plan (see delivered-work.ts).
  const sessionsById = new Map(request.plannedSessions.map((session) => [session.id, session]));
  const planOf = (log: TrainingLog) => sessionsById.get(log.sessionId)?.exercises;
  const deliveredWork = (log: TrainingLog) => deliveredVsPlanned(log, planOf(log));
  const last5Logs = sortedLogs.slice(-5).map((log) => {
    const normalized = normalizeLogForContext(log);
    const entries = deliveredWork(log);
    const deliveredVsPlan = describeDeliveredVsPlan(entries);
    return {
      ...normalized,
      ...(didMoreThanPlanned(entries) ? { didMoreThanPlanned: true } : {}),
      ...(deliveredVsPlan ? { deliveredVsPlan } : {})
    };
  });

  const blockStartMs = planBlockStartMs(request);
  // A new plan block resets the current level and the progression evidence:
  // caps, progression and continuity use only the block's own logs and
  // prescriptions (the baseline set at the block start covers the rest).
  const blockLogs = blockStartMs === null ? sortedLogs : sortedLogs.filter((log) => Date.parse(log.completedAt) >= blockStartMs);
  const blockSessions = blockStartMs === null
    ? request.plannedSessions
    : request.plannedSessions.filter((session) => Date.parse(session.scheduledDate) >= blockStartMs);
  const today = todayWindow(request, now);
  const adherence = summarizeAdherence(request, now, today);
  // One readiness for the planners, the coach read and the continuity exit signal (readiness-state.ts).
  const { state, riskFlags, effort, currentPartialMonth, lastFullMonth, previousFullMonth, twoFullMonthTrend, rollingTrend } =
    computeReadiness(request, sortedLogs, now, adherence);
  const season = computeSeason(request.running?.raceGoal, request.weekStart);

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
      supportedExercises: supportedExercisesFor(request.supportedExercises),
      targetDate: request.targetDate
    },
    history: {
      last5Logs,
      // Effort against the plan only where the work matched the plan: doing
      // clearly more than planned explains a higher effort.
      // Tests are left out too: a max set is the plan (as in the effort flags).
      rpeCalibration: summarizeRPECalibration(last5Logs.filter((log) => !log.didMoreThanPlanned && !testsAGoal(planOf(log)))),
      currentPartialMonth,
      lastFullMonth,
      previousFullMonth,
      twoFullMonthTrend,
      rollingTrend,
      // The current level: the baseline set at the block start plus logs
      // since then. Without a block start, all logs (3 months) count.
      bestRecentTests: {
        pullUps: latestKnownBest("pullUps", blockLogs, request.baseline.pullUps),
        pushUps: latestKnownBest("pushUps", blockLogs, request.baseline.pushUps),
        plankSeconds: latestKnownBest("plankSeconds", blockLogs, request.baseline.plankSeconds)
      },
      ...bestBeforeBlock(sortedLogs, blockStartMs, request)
    },
    adherence,
    ...planBlockContext(request),
    periodization: computePeriodization({ request, readinessState: state, now }),
    plannedWork: summarizePlannedWork(blockSessions, blockLogs, request.weekStart, today, request.plannedSessions, blockStartMs),
    readiness: {
      state,
      riskFlags,
      ...readinessDetail(state, effort, rollingTrend)
    },
    running: request.running
      ? {
          ...request.running,
          runningDayOffsets: normalizeFutureDayOffsets(request.running.runningDayOffsets),
          recentRuns: [...request.running.recentRuns]
            .sort((a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime())
            .slice(-30),
          weeksToRace: weeksToRace(request.running.raceGoal.raceDate, request.weekStart),
          // From the whole history the app sent: the last 30 runs stop short of the weeks before the taper.
          preTaperTrainingWeekKm: preTaperTrainingWeekKm(request.running, season, request.weekStart)
        }
      : undefined,
    season
  };
}

/** Kept for older readers: 0 on race day and for any past race (the phase comes from the season). */
function weeksToRace(raceDate: string, weekStart: string): number {
  const days = daysBetween(weekStart, raceDate);
  return Number.isFinite(days) ? Math.max(0, Math.ceil(days / 7)) : 0;
}

/**
 * Why readiness is what it is, for the planners: the overreaching reason, or
 * the goal metrics a calibration holds (normal readiness only).
 */
function readinessDetail(
  state: ContextState,
  effort: EffortReadiness,
  rollingTrend: CoachContext["history"]["rollingTrend"]
): Pick<CoachContext["readiness"], "reason" | "calibration"> {
  if (state === "overreaching") {
    const declined = GOAL_METRICS.filter((metric) => (rollingTrend?.[`${metric}Delta`] ?? 0) < 0);
    const names = declined.map((metric) => METRIC_PLURAL[metric]);
    const what = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "results";
    const is = declined.length === 1 && declined[0] === "plankSeconds" ? "is" : "are";
    const weeks = ROLLING_TREND.windowDays / 7;
    return {
      reason: effort.overreaching ??
        `The best ${what} of the last ${weeks} weeks ${is} below the ${weeks} weeks before, with at least ${ROLLING_TREND.minShortfalls} results below the plan.`
    };
  }
  if (state === "recovery_needed" || !effort.calibration || effort.calibration.metrics.length === 0) return {};
  return { calibration: effort.calibration };
}

type TodayWindow = { start: number; end: number };

// "Today" is [weekStart, next local midnight). weekStart is the app's local
// midnight for today. With the athlete's IANA zone the end is the real next
// midnight (23 or 25 hours away on DST days); without it, 24 hours later.
function todayWindow(request: CoachRequest, now: Date): TodayWindow {
  const timeZone = validTimeZone(request.timeZone);
  const weekStart = Date.parse(request.weekStart);
  const start = Number.isFinite(weekStart)
    ? weekStart
    : timeZone
      ? startOfLocalDay(now, timeZone).getTime()
      : now.getTime();
  // Measure from midday so a weekStart a little off local midnight (a zone
  // mismatch) still lands on the right calendar day.
  const end = timeZone
    ? nextLocalMidnight(new Date(start + 12 * 60 * 60 * 1000), timeZone).getTime()
    : start + 24 * 60 * 60 * 1000;
  return { start, end };
}

function summarizeAdherence(request: CoachRequest, now: Date, today: TodayWindow): CoachContext["adherence"] {
  const planned = request.plannedSessions.length;
  const nowTime = now.getTime();
  // Sessions are stored at local midnight, so "due" means scheduled before
  // today. Today's open sessions stay outside the score all day; once one
  // is finished (completed, partial, deload) it counts right away.
  const dueSessions = request.plannedSessions.filter((session) => {
    const scheduled = new Date(session.scheduledDate).getTime();
    if (!Number.isFinite(scheduled)) return false;
    if (scheduled < today.start) return true;
    return scheduled < today.end && session.status !== "planned" && session.status !== "missed";
  });
  const pendingToday = request.plannedSessions.filter((session) => {
    const scheduled = new Date(session.scheduledDate).getTime();
    return session.status === "planned" && scheduled >= today.start && scheduled < today.end;
  }).length;
  const future = Math.max(0, planned - dueSessions.length);
  const completed = dueSessions.filter((session) => session.status === "completed").length;
  const partial = dueSessions.filter((session) => session.status === "partial").length;
  const deload = dueSessions.filter((session) => session.status === "deload").length;
  const missed = dueSessions.filter((session) => session.status === "missed").length;
  const recentCutoff = nowTime - 14 * 24 * 60 * 60 * 1000;
  const missedLast14Days = dueSessions.filter((session) => {
    const scheduled = new Date(session.scheduledDate).getTime();
    return session.status === "missed" && scheduled >= recentCutoff;
  }).length;
  const pending = dueSessions.filter((session) => session.status === "planned").length;
  const adherenceScorePct = dueSessions.length > 0
    ? Math.round(((completed + deload + partial * 0.5) / dueSessions.length) * 100)
    : null;

  return {
    planned,
    due: dueSessions.length,
    future,
    completed,
    partial,
    missed,
    missedLast14Days,
    deload,
    pending,
    pendingToday,
    adherenceScorePct
  };
}

function summarizePlannedWork(
  plannedSessions: CoachRequest["plannedSessions"],
  logs: TrainingLog[],
  weekStart: string,
  today: TodayWindow,
  allPlannedSessions: CoachRequest["plannedSessions"] = plannedSessions,
  blockStartMs: number | null = null
): CoachContext["plannedWork"] {
  const startTime = new Date(weekStart).getTime();
  const endOfToday = today.end;
  const todaySessions = allPlannedSessions
    .filter((session) => {
      const scheduled = new Date(session.scheduledDate).getTime();
      return Number.isFinite(scheduled) && scheduled >= startTime && scheduled < endOfToday;
    })
    .sort((a, b) => new Date(a.scheduledDate).getTime() - new Date(b.scheduledDate).getTime())
    .map((session) => {
      const hardest = hardestOf((session.exercises ?? []).map((exercise) => exercise.plannedEffortLabel));
      return {
        id: session.id,
        title: session.title,
        status: session.status,
        focus: session.focus,
        scheduledDate: session.scheduledDate,
        ...(hardest ? { hardestEffort: hardest } : {})
      };
    });
  const goalEntries = plannedSessions
    .filter((session) => new Date(session.scheduledDate).getTime() < startTime)
    .flatMap((session) =>
      (session.exercises ?? [])
        .filter(isGoalWorkPrescription)
        .map((exercise) => {
          const metric = metricForExercise(exercise.exercise);
          const target = metric ? prescribedValue(metric, exercise) : 0;
          return {
            metric,
            scheduledDate: session.scheduledDate,
            target,
            sets: exercise.sets,
            test: isGoalTest(prescriptionEffort(exercise)),
            volume: target * exercise.sets
          };
        })
    )
    .filter((entry): entry is GoalEntry & { metric: GoalMetric } =>
      entry.metric !== null && entry.target > 0 && entry.volume > 0
    )
    .sort((a, b) => new Date(b.scheduledDate).getTime() - new Date(a.scheduledDate).getTime());

  return {
    todaySessions,
    recentGoalTargets: {
      pullUps: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "pullUps")),
      pushUps: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "pushUps")),
      plankSeconds: summarizeGoalTrend(goalEntries.filter((entry) => entry.metric === "plankSeconds"))
    },
    recentGoalPerformance: {
      pullUps: summarizeRecentGoalPerformance("pullUps", plannedSessions, logs, today, allPlannedSessions, blockStartMs),
      pushUps: summarizeRecentGoalPerformance("pushUps", plannedSessions, logs, today, allPlannedSessions, blockStartMs),
      plankSeconds: summarizeRecentGoalPerformance("plankSeconds", plannedSessions, logs, today, allPlannedSessions, blockStartMs)
    }
  };
}

function summarizeRecentGoalPerformance(
  metric: "pullUps" | "pushUps" | "plankSeconds",
  plannedSessions: CoachRequest["plannedSessions"],
  logs: TrainingLog[],
  today: TodayWindow,
  allPlannedSessions: CoachRequest["plannedSessions"] = plannedSessions,
  blockStartMs: number | null = null
): RecentGoalPerformance {
  const sessionsById = new Map(plannedSessions.map((session) => [session.id, session]));
  const matches = logs
    .filter((log) => log[LOGGED_FLAG[metric]])
    .flatMap((log) => {
      const session = sessionsById.get(log.sessionId);
      const latestLoggedBest = log[metric];
      const prescription =
        latestGoalPrescription(session?.exercises ?? [], metric) ??
        overDeliveredEasyPrescription(session?.exercises ?? [], metric, latestLoggedBest);
      if (!prescription) return [];

      const overDelivered = latestLoggedBest - prescription.target >= overDeliveryMargin(metric, prescription.target);
      // One clean-completion rule (effort-flags.ts): the target met, no pain or
      // very weak feedback, effort within plan (clearly more than planned explains more).
      const clean = cleanCompletion(log, session?.exercises, metric) !== null;

      return [{
        completedAt: log.completedAt,
        latestLoggedBest,
        prescribedTarget: prescription.target,
        prescribedSets: prescription.sets,
        delta: latestLoggedBest - prescription.target,
        clean,
        overDelivered
      }];
    })
    .filter((match) => Number.isFinite(Date.parse(match.completedAt)))
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt));

  const latest = matches[0];
  let consecutiveCleanCompletionsAtStandard = 0;
  if (latest) {
    for (const match of matches) {
      if (
        match.prescribedTarget !== latest.prescribedTarget ||
        !match.clean ||
        match.latestLoggedBest < match.prescribedTarget
      ) {
        break;
      }
      consecutiveCleanCompletionsAtStandard += 1;
    }
  }

  return {
    latestLoggedBest: latest?.latestLoggedBest ?? null,
    prescribedTarget: latest?.prescribedTarget ?? null,
    prescribedSets: latest?.prescribedSets ?? null,
    delta: latest?.delta ?? null,
    clean: latest?.clean ?? null,
    overDelivered: latest?.overDelivered ?? null,
    consecutiveCleanCompletionsAtStandard,
    completedAt: latest?.completedAt ?? null,
    // Tests from before the block still count for the 28-day test spacing.
    latestTestDate: latestTestDate(metric, allPlannedSessions, today),
    ...(blockStartMs === null ? {} : { baselineSetAt: new Date(blockStartMs).toISOString() })
  };
}

function latestGoalPrescription(
  exercises: PlannedExercisePrescription[],
  metric: "pullUps" | "pushUps" | "plankSeconds"
): { target: number; sets: number; label?: EffortLabel } | null {
  // A test (one max set) is not a working prescription: matching a log to it
  // would make "1 set" the standard the next week continues from.
  return topBlock(exercises
    .filter((exercise) => isGoalWorkPrescription(exercise) && !isGoalTest(prescriptionEffort(exercise)) && metricForExercise(exercise.exercise) === metric)
    .map((exercise) => ({ target: prescribedValue(metric, exercise), sets: exercise.sets, label: exercise.plannedEffortLabel }))
    .filter((exercise) => exercise.target > 0 && exercise.sets > 0));
}

/**
 * Easy (light, technique or recovery) work is not a working prescription,
 * but doing clearly more than it asked is evidence: the athlete showed more
 * than the plan expected. Only then is the log matched to that easy target.
 */
function overDeliveredEasyPrescription(
  exercises: PlannedExercisePrescription[],
  metric: "pullUps" | "pushUps" | "plankSeconds",
  delivered: number
): { target: number; sets: number; label?: EffortLabel } | null {
  const target = plannedTargetFor(metric, exercises);
  if (target === null || !Number.isFinite(delivered) || delivered - target < overDeliveryMargin(metric, target)) return null;
  const prescription = exercises.find((exercise) =>
    metricForExercise(exercise.exercise) === metric &&
    prescribedValue(metric, exercise) === target &&
    !isGoalTest(prescriptionEffort(exercise))
  );
  return prescription ? { target, sets: prescription.sets, label: prescription.plannedEffortLabel } : null;
}

const DONE_STATUSES = new Set(["completed", "partial"]);

/**
 * The latest goal test of a metric: a test done before today, or one planned
 * for today (it happens today, so the coming days need no second test). A
 * missed, deloaded or overdue test was no test.
 */
function latestTestDate(
  metric: "pullUps" | "pushUps" | "plankSeconds",
  plannedSessions: CoachRequest["plannedSessions"],
  today: TodayWindow
): string | null {
  return plannedSessions
    .filter((session) => {
      const scheduled = Date.parse(session.scheduledDate);
      if (scheduled < today.start) return DONE_STATUSES.has(session.status);
      return scheduled < today.end && (session.status === "planned" || DONE_STATUSES.has(session.status));
    })
    .filter((session) => (session.exercises ?? []).some((exercise) =>
      metricForExercise(exercise.exercise) === metric && isGoalTest(prescriptionEffort(exercise))
    ))
    .map((session) => session.scheduledDate)
    .filter((date) => Number.isFinite(Date.parse(date)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

/** Goal work of a past session that is not easy work: not light, technique or recovery (tests included). */
function isGoalWorkPrescription(exercise: PlannedExercisePrescription): boolean {
  if (metricForExercise(exercise.exercise) === null) return false;
  if (exercise.plannedEffortLabel === "light") return false;
  if (exercise.plannedEffortStimulus === "recovery" || exercise.plannedEffortStimulus === "technique") return false;
  return exercise.sets > 0 && (exercise.targetReps > 0 || exercise.targetSeconds > 0);
}

type GoalEntry = {
  scheduledDate: string;
  target: number;
  sets: number;
  /** A goal test (one max set), not a working prescription. */
  test: boolean;
  volume: number;
};

function summarizeGoalTrend(entries: GoalEntry[]): PlannedGoalTrend {
  const latest = entries[0];
  if (!latest) {
    return {
      latestTarget: null,
      latestVolume: null,
      flatCount: 0,
      latestDate: null,
      latestWorkingTarget: null,
      latestWorkingSets: null,
      latestWorkingDate: null
    };
  }

  let flatCount = 0;
  for (const entry of entries) {
    if (entry.target !== latest.target || entry.volume !== latest.volume) break;
    flatCount += 1;
  }

  const working = latestWorkingPrescription(entries);
  return {
    latestTarget: latest.target,
    latestVolume: latest.volume,
    flatCount,
    latestDate: latest.scheduledDate,
    latestWorkingTarget: working?.target ?? null,
    latestWorkingSets: working?.sets ?? null,
    latestWorkingDate: working?.date ?? null
  };
}

/**
 * The top working prescription (highest target, then most sets) of the most
 * recent 7-day block of past goal work, tests excluded. This is the
 * "previous prescription" the validator keeps new targets continuous with;
 * using the block's top set matches how a new plan's goal work is summarized.
 */
function latestWorkingPrescription(entries: GoalEntry[]): { target: number; sets: number; date: string } | null {
  const working = entries.filter((entry) => !entry.test && Number.isFinite(Date.parse(entry.scheduledDate)));
  const latest = working[0];
  if (!latest) return null;
  const latestMs = Date.parse(latest.scheduledDate);
  const top = topBlock(working.filter((entry) => Date.parse(entry.scheduledDate) > latestMs - 7 * DAY_MS))!;
  return { target: top.target, sets: top.sets, date: latest.scheduledDate };
}


/**
 * Older, higher bests from before the current plan block, shown as context
 * only (the athlete restarted lower on purpose); omitted when none is higher.
 */
function bestBeforeBlock(
  sortedLogs: TrainingLog[],
  blockStartMs: number | null,
  request: CoachRequest
): Pick<CoachContext["history"], "bestBeforeBlock"> {
  if (blockStartMs === null) return {};
  const before = sortedLogs.filter((log) => Date.parse(log.completedAt) < blockStartMs);
  const higher = (metric: GoalMetric): number | null => {
    const values = before.filter((log) => log[LOGGED_FLAG[metric]]).map((log) => log[metric]);
    if (values.length === 0) return null;
    const best = Math.max(...values);
    return best > request.baseline[metric] ? best : null;
  };
  const pullUps = higher("pullUps");
  const pushUps = higher("pushUps");
  const plankSeconds = higher("plankSeconds");
  if (pullUps === null && pushUps === null && plankSeconds === null) return {};
  return {
    bestBeforeBlock: {
      blockStartedAt: new Date(blockStartMs).toISOString(),
      pullUps,
      pushUps,
      plankSeconds,
      note: "Higher values logged before the current plan block. Context only: working caps and progression use the current level (bestRecentTests)."
    }
  };
}

function latestKnownBest(metric: GoalMetric, logs: TrainingLog[], baseline: number): number | null {
  const values = logs.filter((log) => log[LOGGED_FLAG[metric]]).map((log) => log[metric]);
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

function normalizeLogForContext(log: TrainingLog): TrainingLog {
  const howYouFeltScore = howYouFeltScoreFromFatigueLevel(log.fatigueLevel);
  const rated = actualRPE(log);
  const plannedRPE = validRPE(log.plannedRPE);
  const rpeDelta = typeof plannedRPE === "number" ? rated - plannedRPE : undefined;
  const generatedSummary = typeof plannedRPE === "number"
    ? `RPE - Planned ${plannedRPE} | Actual ${rated}`
    : undefined;

  return {
    ...log,
    rpe: rated,
    perceivedEffort: rated,
    plannedRPE,
    actualRPE: rated,
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
