import { nextLocalMidnight, startOfLocalDay, validTimeZone } from "../local-time";
import { computePeriodization } from "./periodization";
import { planBlockContext } from "./plan-block";
import { addMonths, startOfMonthUTC, summarizeMonth, summarizeRollingTrend, summarizeTrend } from "./summarize-training-history";
import type {
  CoachContext,
  CoachRequest,
  ContextState,
  EffortLabel,
  EffortStimulus,
  PlannedExercisePrescription,
  PlannedGoalTrend,
  RecentGoalPerformance,
  TrainingLog
} from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Readiness flags from pain and very weak feedback are time-based: a trigger
 * counts for 7 days, or 14 when no strength log followed it (the athlete has
 * not shown a pain-free session yet), and a later clean log clears it early.
 */
export const READINESS_WINDOWS = {
  triggerDays: 7,
  unconfirmedTriggerDays: 14,
  /** A later log at or below this pain (and not very weak) clears a pain flag. */
  cleanPainMax: 2,
  /** A later log below this fatigue level (Weak = 8) and with pain below 4 clears a very-weak flag. */
  cleanFatigueBelow: 7
} as const;

/**
 * Planned RPE assumed when a log carries none (manually logged or legacy
 * sessions): the planned effort label's RPE when known, else 7 (a normal
 * hard working set). Without it those sessions could never earn progression.
 */
export const DEFAULT_PLANNED_RPE = 7;
const plannedRPEForLabel: Record<EffortLabel, number> = {
  light: 4,
  medium: 6,
  hard: 7,
  very_hard: 9,
  max_output: 10
};

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
  const blockStartMs = planBlockStartMs(request);
  const rollingTrend = summarizeRollingTrend(sortedLogs, now, blockStartMs);
  // A new plan block resets the current level and the progression evidence:
  // caps, progression and continuity use only the block's own logs and
  // prescriptions (the baseline set at the block start covers the rest).
  const blockLogs = blockStartMs === null ? sortedLogs : sortedLogs.filter((log) => Date.parse(log.completedAt) >= blockStartMs);
  const blockSessions = blockStartMs === null
    ? request.plannedSessions
    : request.plannedSessions.filter((session) => Date.parse(session.scheduledDate) >= blockStartMs);
  const validCompletedMonthLogCount = validLogCount(sortedLogs, previousFullMonthStart, currentMonthStart);
  const validCurrentMonthLogCount = validLogCount(sortedLogs, currentMonthStart, addMonths(currentMonthStart, 1));
  const riskFlags = collectRiskFlags(
    sortedLogs,
    last5Logs,
    now,
    lastFullMonth,
    previousFullMonth,
    request.weeklySessions,
    validCompletedMonthLogCount,
    validCurrentMonthLogCount
  );
  const today = todayWindow(request, now);
  const adherence = summarizeAdherence(request, now, today);
  const state = classifyState(
    riskFlags,
    twoFullMonthTrend.label,
    rollingTrend.label,
    validCompletedMonthLogCount,
    validCurrentMonthLogCount,
    adherence
  );

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
      rollingTrend,
      // The current level: the baseline set at the block start plus logs
      // since then. Without a block start, all logs (3 months) count.
      bestRecentTests: {
        pullUps: latestKnownBest("pullUps", "loggedPullUps", blockLogs, request.baseline.pullUps),
        pushUps: latestKnownBest("pushUps", "loggedPushUps", blockLogs, request.baseline.pushUps),
        plankSeconds: latestKnownBest("plankSeconds", "loggedPlankSeconds", blockLogs, request.baseline.plankSeconds)
      },
      ...bestBeforeBlock(sortedLogs, blockStartMs, request)
    },
    adherence,
    ...planBlockContext(request),
    periodization: computePeriodization({ request, readinessState: state, now }),
    plannedWork: summarizePlannedWork(blockSessions, blockLogs, request.weekStart, today, request.plannedSessions, blockStartMs),
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
  sortedLogs: TrainingLog[],
  last5Logs: TrainingLog[],
  now: Date,
  lastFullMonth: CoachContext["history"]["lastFullMonth"],
  previousFullMonth: CoachContext["history"]["previousFullMonth"],
  weeklySessions: number,
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number
): string[] {
  const flags: string[] = [];

  const unresolvedPain = unresolvedRecentTrigger(
    sortedLogs,
    now,
    (log) => log.painLevel >= 4,
    (log) => log.painLevel <= READINESS_WINDOWS.cleanPainMax && log.fatigueLevel < 9
  );
  if (unresolvedPain) flags.push("recent_pain_level_4_or_higher");
  const unresolvedVeryWeak = unresolvedRecentTrigger(
    sortedLogs,
    now,
    (log) => log.fatigueLevel >= 9,
    (log) => log.fatigueLevel < READINESS_WINDOWS.cleanFatigueBelow && log.painLevel < 4
  );
  if (unresolvedVeryWeak) flags.push("recent_how_you_felt_very_weak");
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
 * The latest trigger log still in force: inside the trigger window (7 days,
 * or 14 when no log at all followed it) and not followed by a clean log.
 * Logs are strength sessions, so the clearing log is of the same discipline.
 */
export function unresolvedRecentTrigger(
  sortedLogs: TrainingLog[],
  now: Date,
  isTrigger: (log: TrainingLog) => boolean,
  isClean: (log: TrainingLog) => boolean
): TrainingLog | null {
  const nowMs = now.getTime();
  const timed = sortedLogs
    .map((log) => ({ log, at: Date.parse(log.completedAt) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at <= nowMs);
  for (let index = timed.length - 1; index >= 0; index -= 1) {
    const { log, at } = timed[index];
    if (!isTrigger(log)) continue;
    const later = timed.slice(index + 1);
    const ageDays = (nowMs - at) / DAY_MS;
    const windowDays = later.length === 0 ? READINESS_WINDOWS.unconfirmedTriggerDays : READINESS_WINDOWS.triggerDays;
    if (ageDays > windowDays) return null;
    return later.some((entry) => isClean(entry.log)) ? null : log;
  }
  return null;
}

function planBlockStartMs(request: CoachRequest): number | null {
  const start = typeof request.planBlockStartedAt === "string" ? Date.parse(request.planBlockStartedAt) : Number.NaN;
  return Number.isFinite(start) ? start : null;
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
          sets: exercise.sets,
          stimulus: exercise.plannedEffortStimulus,
          volume: (exercise.exercise === "plank" ? exercise.targetSeconds : exercise.targetReps) * exercise.sets
        }))
    )
    .filter((entry): entry is GoalEntry & { metric: "pullUps" | "pushUps" | "plankSeconds" } =>
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
      pullUps: summarizeRecentGoalPerformance("pullUps", plannedSessions, logs, startTime, allPlannedSessions, blockStartMs),
      pushUps: summarizeRecentGoalPerformance("pushUps", plannedSessions, logs, startTime, allPlannedSessions, blockStartMs),
      plankSeconds: summarizeRecentGoalPerformance("plankSeconds", plannedSessions, logs, startTime, allPlannedSessions, blockStartMs)
    }
  };
}

function summarizeRecentGoalPerformance(
  metric: "pullUps" | "pushUps" | "plankSeconds",
  plannedSessions: CoachRequest["plannedSessions"],
  logs: TrainingLog[],
  startTime: number,
  allPlannedSessions: CoachRequest["plannedSessions"] = plannedSessions,
  blockStartMs: number | null = null
): RecentGoalPerformance {
  const sessionsById = new Map(plannedSessions.map((session) => [session.id, session]));
  const matches = logs
    .filter((log) => log[loggedFlagForMetric(metric)])
    .flatMap((log) => {
      const session = sessionsById.get(log.sessionId);
      const prescription = latestGoalPrescription(session?.exercises ?? [], metric);
      if (!prescription) return [];

      const actualRPE = normalizeRPE(log.actualRPE) ?? normalizeRPE(log.rpe);
      const plannedRPE =
        normalizeRPE(log.plannedRPE) ??
        plannedRPEFromLabel(log.plannedEffortLabel) ??
        plannedRPEFromLabel(prescription.label) ??
        DEFAULT_PLANNED_RPE;
      const clean =
        typeof actualRPE === "number" &&
        typeof plannedRPE === "number" &&
        log.painLevel < 4 &&
        log.fatigueLevel < 9 &&
        actualRPE <= plannedRPE + 1;
      const latestLoggedBest = log[metric];

      return [{
        completedAt: log.completedAt,
        latestLoggedBest,
        prescribedTarget: prescription.target,
        prescribedSets: prescription.sets,
        delta: latestLoggedBest - prescription.target,
        clean
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
    consecutiveCleanCompletionsAtStandard,
    completedAt: latest?.completedAt ?? null,
    // Tests from before the block still count for the 28-day test spacing.
    latestTestDate: latestTestDate(metric, allPlannedSessions, startTime),
    ...(blockStartMs === null ? {} : { baselineSetAt: new Date(blockStartMs).toISOString() })
  };
}

function plannedRPEFromLabel(label: unknown): number | undefined {
  return typeof label === "string" && label in plannedRPEForLabel ? plannedRPEForLabel[label as EffortLabel] : undefined;
}

function latestGoalPrescription(
  exercises: PlannedExercisePrescription[],
  metric: "pullUps" | "pushUps" | "plankSeconds"
): { target: number; sets: number; label?: EffortLabel } | null {
  // A test (one max set) is not a working prescription: matching a log to it
  // would make "1 set" the standard the next week continues from.
  const candidates = exercises
    .filter((exercise) =>
      isGoalWorkPrescription(exercise) &&
      exercise.plannedEffortStimulus !== "test" &&
      exercise.plannedEffortLabel !== "max_output" &&
      goalMetricForExercise(exercise.exercise) === metric
    )
    .map((exercise) => ({
      target: metric === "plankSeconds" ? exercise.targetSeconds : exercise.targetReps,
      sets: exercise.sets,
      label: exercise.plannedEffortLabel
    }))
    .filter((exercise) => exercise.target > 0 && exercise.sets > 0)
    .sort((a, b) => b.target - a.target || b.sets - a.sets);
  return candidates[0] ?? null;
}

function latestTestDate(
  metric: "pullUps" | "pushUps" | "plankSeconds",
  plannedSessions: CoachRequest["plannedSessions"],
  startTime: number
): string | null {
  return plannedSessions
    .filter((session) => Date.parse(session.scheduledDate) < startTime)
    .filter((session) => (session.exercises ?? []).some((exercise) =>
      goalMetricForExercise(exercise.exercise) === metric && exercise.plannedEffortStimulus === "test"
    ))
    .map((session) => session.scheduledDate)
    .filter((date) => Number.isFinite(Date.parse(date)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function loggedFlagForMetric(
  metric: "pullUps" | "pushUps" | "plankSeconds"
): "loggedPullUps" | "loggedPushUps" | "loggedPlankSeconds" {
  if (metric === "pullUps") return "loggedPullUps";
  if (metric === "pushUps") return "loggedPushUps";
  return "loggedPlankSeconds";
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

type GoalEntry = {
  scheduledDate: string;
  target: number;
  sets: number;
  stimulus: EffortStimulus | undefined;
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
  const working = entries.filter((entry) => entry.stimulus !== "test" && Number.isFinite(Date.parse(entry.scheduledDate)));
  const latest = working[0];
  if (!latest) return null;
  const latestMs = Date.parse(latest.scheduledDate);
  const top = working
    .filter((entry) => Date.parse(entry.scheduledDate) > latestMs - 7 * DAY_MS)
    .reduce((best, entry) => (entry.target > best.target || (entry.target === best.target && entry.sets > best.sets) ? entry : best));
  return { target: top.target, sets: top.sets, date: latest.scheduledDate };
}

/** Flags that put readiness in recovery_needed. Month-level flags are watch items only. */
export const RECOVERY_NEEDED_FLAGS: ReadonlySet<string> = new Set(["recent_pain_level_4_or_higher", "recent_how_you_felt_very_weak"]);

function classifyState(
  riskFlags: string[],
  monthTrendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  rollingTrendLabel: CoachContext["history"]["twoFullMonthTrend"]["label"],
  validCompletedMonthLogCount: number,
  validCurrentMonthLogCount: number,
  adherence: CoachContext["adherence"]
): ContextState {
  if (riskFlags.some((flag) => RECOVERY_NEEDED_FLAGS.has(flag))) return "recovery_needed";
  if (
    riskFlags.includes("repeated_high_perceived_effort") ||
    riskFlags.includes("recent_effort_above_plan")
  ) {
    return "overreaching";
  }
  const hasEarlyCurrentEvidence = validCurrentMonthLogCount >= 2;
  if ((validCompletedMonthLogCount < 3 || monthTrendLabel === "insufficient_history") && !hasEarlyCurrentEvidence) {
    return "insufficient_history";
  }
  // Plateau and decline come from the rolling 3-week windows, so they show
  // up within weeks instead of after two full calendar months.
  if (rollingTrendLabel === "flat" && adherence.completed >= Math.max(3, adherence.planned * 0.7)) return "plateau";
  if (rollingTrendLabel === "declining") return "overreaching";
  return "building";
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
  const higher = (
    metric: "pullUps" | "pushUps" | "plankSeconds",
    flag: "loggedPullUps" | "loggedPushUps" | "loggedPlankSeconds"
  ): number | null => {
    const values = before.filter((log) => log[flag]).map((log) => log[metric]);
    if (values.length === 0) return null;
    const best = Math.max(...values);
    return best > request.baseline[metric] ? best : null;
  };
  const pullUps = higher("pullUps", "loggedPullUps");
  const pushUps = higher("pushUps", "loggedPushUps");
  const plankSeconds = higher("plankSeconds", "loggedPlankSeconds");
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
