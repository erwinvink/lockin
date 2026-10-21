import type {
  BlockWeekClassification,
  BlockWeekSummary,
  CoachRequest,
  ContextState,
  PeriodizationContext,
  PlannedSession,
  RunSummary,
  TrainingLog
} from "./types";

/**
 * Planned recovery weeks on the plan-block calendar.
 *
 * Rule (3:1): after three loading weeks in a row, counted from the block
 * start or the last unloading week, the next block week is a recovery week
 * in which running and strength back off together. Ultra coaches commonly
 * use 3:1 (2:1 for older or heavier athletes); a hybrid athlete carries two
 * loads, so the shorter end of the 3-5 week range is the default.
 *
 * Stateless and deterministic: the decision for block week K depends only
 * on complete weeks before K, so every nightly re-plan inside K reaches the
 * same answer. A week counts as unloading when it was
 * - a reactive offload (a deload session, pain >= 4 or very weak feedback,
 *   or three RPE 9+ sessions in that week),
 * - taper, race or post-race,
 * - a planned recovery week that was actually done lighter, or
 * - simply low volume (illness, travel): running at or below 80% of the four
 *   weeks before, or (strength only) hard sets at or below 60%.
 * Only the block's own weeks count as loading weeks; the four weeks before
 * the block only serve as a volume reference.
 */
export const RECOVERY_CYCLE = {
  loadingWeeksBeforeRecovery: 3,
  referenceWeeks: 4,
  /** A block week at or below 80% of the four weeks before counts as unloading. */
  lowVolumeRatio: 0.8,
  /** Days 2-7 of a planned recovery week at or below 90% of 6/7 of the reference: it was done. */
  executedRecoveryRatio: 0.9,
  /** Strength-only athletes: executed hard sets at or below 60% of the reference. */
  strengthLowVolumeRatio: 0.6,
  /** Below this weekly average the running volume does not classify a week. */
  minReferenceKm: 10,
  minReferenceHardSets: 3,
  maxScanWeeks: 10,
  /** How far back the app sends runs and planned sessions. */
  runHistoryDays: 70,
  sessionHistoryDays: 56,
  taperDays: 21,
  postRaceDays: 14,
  running: {
    weeklyKmCapRatio: 0.75,
    weeklyKmTargetRatio: { low: 0.6, high: 0.75 },
    longRunRatio: 0.7,
    maxQualityRuns: 1
  },
  strength: {
    hardSetRatio: 0.6,
    maxHardSessions: 1,
    maxGoalSetsPerExercise: 3
  }
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const HARD_LABELS = new Set(["hard", "very_hard", "max_output"]);
const EXECUTED_STATUSES = new Set(["completed", "partial", "deload"]);
const UNLOADING: ReadonlySet<BlockWeekClassification> = new Set([
  "recovery",
  "reactive_offload",
  "taper_or_race",
  "low_volume",
  "no_training"
]);

type WeekData = {
  index: number;
  start: number;
  end: number;
  runningCovered: boolean;
  strengthCovered: boolean;
  runningKm: number;
  /** Running in days 2-7: the part of a recovery week the recovery plan controls. */
  runningKmAfterDayOne: number;
  longestRunKm: number;
  plannedHardSets: number;
  executedHardSets: number;
  executedStrengthSessions: number;
  reactiveReason: string | null;
  raceReason: string | null;
};

export type PeriodizationInput = {
  request: CoachRequest;
  readinessState: ContextState;
  now: Date;
};

export function computePeriodization({ request, readinessState }: PeriodizationInput): PeriodizationContext {
  const blockStart = typeof request.planBlockStartedAt === "string" ? Date.parse(request.planBlockStartedAt) : Number.NaN;
  const weekStart = Date.parse(request.weekStart);
  const base = { cycle: "3:1" as const, recoveryWeek: null };
  if (!Number.isFinite(blockStart) || !Number.isFinite(weekStart)) {
    return {
      ...base,
      blockWeek: null,
      loadingWeeksSinceRecovery: 0,
      lastUnloadingWeek: null,
      recoveryWeekDue: false,
      recoveryWeekReason: "No plan block start was sent, so planned recovery weeks are off; reactive offloads still apply.",
      recentWeeks: []
    };
  }

  const currentWeek = blockWeekIndex(blockStart, weekStart);
  const runs = (request.running?.recentRuns ?? []).filter((run) => Number.isFinite(Date.parse(run.completedAt)));
  const hybrid = Boolean(request.running);
  const runCoverage = Math.max(
    weekStart - RECOVERY_CYCLE.runHistoryDays * DAY_MS,
    runs.length >= 30 ? Math.min(...runs.map((run) => Date.parse(run.completedAt))) : Number.NEGATIVE_INFINITY
  );
  const sessionCoverage = weekStart - RECOVERY_CYCLE.sessionHistoryDays * DAY_MS;
  const raceDate = request.running ? Date.parse(request.running.raceGoal.raceDate) : Number.NaN;

  const firstWeek = Math.max(1, currentWeek - RECOVERY_CYCLE.maxScanWeeks);
  const weekData = new Map<number, WeekData>();
  const dataFor = (index: number): WeekData => {
    let data = weekData.get(index);
    if (!data) {
      data = collectWeek(index, blockStart, runs, request.plannedSessions, request.trainingLogs, runCoverage, sessionCoverage, raceDate);
      weekData.set(index, data);
    }
    return data;
  };

  const summaries: BlockWeekSummary[] = [];
  const statusOf = new Map<number, "recovery" | "loading">();
  for (let index = firstWeek; index < currentWeek; index += 1) {
    const data = dataFor(index);
    if (hybrid ? !data.runningCovered : !data.strengthCovered) continue;
    const plannedRecovery = statusOf.get(index) === "recovery";
    const summary = classifyWeek(data, dataFor, hybrid, plannedRecovery);
    summaries.push(summary);
    // Decide the next week from the weeks so far (planned recovery weeks are
    // recomputed this way, so past decisions are reproducible).
    const streak = loadingStreak(summaries);
    statusOf.set(index + 1, streak >= RECOVERY_CYCLE.loadingWeeksBeforeRecovery && !inRaceWindow(raceDate, index + 1, blockStart) ? "recovery" : "loading");
  }

  const loadingWeeks = loadingStreak(summaries);
  const lastUnloading = [...summaries].reverse().find((summary) => UNLOADING.has(summary.classification)) ?? null;
  const since = lastUnloading
    ? `since the last unloading week (block week ${lastUnloading.blockWeek}: ${lastUnloading.note})`
    : "since the block start";
  const reference = referenceWeeks(currentWeek, dataFor, hybrid);
  const dueByCount = loadingWeeks >= RECOVERY_CYCLE.loadingWeeksBeforeRecovery;

  let due = false;
  let reason: string;
  const daysToRace = Number.isFinite(raceDate) ? Math.round((raceDate - weekStart) / DAY_MS) : null;
  if (daysToRace !== null && daysToRace >= 0 && daysToRace <= RECOVERY_CYCLE.taperDays) {
    reason = `The race is ${daysToRace} day(s) away: the taper takes the place of planned recovery weeks.`;
  } else if (daysToRace !== null && daysToRace < 0 && daysToRace >= -RECOVERY_CYCLE.postRaceDays) {
    reason = `The race was ${-daysToRace} day(s) ago: post-race recovery comes first.`;
  } else if (!dueByCount) {
    reason = `${loadingWeeks} loading week(s) ${since}; a planned recovery week follows ${RECOVERY_CYCLE.loadingWeeksBeforeRecovery} loading weeks (3:1).`;
  } else if (readinessState === "recovery_needed" || readinessState === "overreaching") {
    reason = `${loadingWeeks} loading weeks ${since}, but readiness is ${readinessState}: the reactive offload already backs off this week.`;
  } else {
    due = true;
    reason = `${loadingWeeks} loading weeks ${since}: block week ${currentWeek} is a planned recovery week (3:1). Run and strength both back off together this week.`;
  }

  const weekStartIso = new Date(blockStart + (currentWeek - 1) * WEEK_MS).toISOString();
  const weekEndIso = new Date(blockStart + currentWeek * WEEK_MS).toISOString();
  return {
    ...base,
    blockWeek: currentWeek,
    loadingWeeksSinceRecovery: loadingWeeks,
    lastUnloadingWeek: lastUnloading
      ? { blockWeek: lastUnloading.blockWeek, startsAt: lastUnloading.startsAt, classification: lastUnloading.classification, note: lastUnloading.note }
      : null,
    recoveryWeekDue: due,
    recoveryWeekReason: reason,
    recoveryWeek: due ? recoveryLimits(weekStartIso, weekEndIso, reference, dataFor, summaries) : null,
    recentWeeks: summaries.slice(-6)
  };
}

function blockWeekIndex(blockStart: number, at: number): number {
  const days = Math.max(0, Math.round((at - blockStart) / DAY_MS));
  return Math.floor(days / 7) + 1;
}

function weekRange(index: number, blockStart: number): { start: number; end: number } {
  return { start: blockStart + (index - 1) * WEEK_MS, end: blockStart + index * WEEK_MS };
}

/** The week starts inside the taper (21 days out) or the post-race weeks (14 days after). */
function inRaceWindow(raceDate: number, index: number, blockStart: number): boolean {
  if (!Number.isFinite(raceDate)) return false;
  const daysToRace = Math.round((raceDate - weekRange(index, blockStart).start) / DAY_MS);
  return daysToRace <= RECOVERY_CYCLE.taperDays && daysToRace >= -RECOVERY_CYCLE.postRaceDays;
}

function collectWeek(
  index: number,
  blockStart: number,
  runs: RunSummary[],
  sessions: PlannedSession[],
  logs: TrainingLog[],
  runCoverage: number,
  sessionCoverage: number,
  raceDate: number
): WeekData {
  const { start, end } = weekRange(index, blockStart);
  const within = (iso: string, from = start) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && at >= from && at < end;
  };
  const weekRuns = runs.filter((run) => within(run.completedAt));
  const strengthSessions = sessions.filter(
    (session) => within(session.scheduledDate) && session.discipline !== "running" && (session.exercises ?? []).length > 0
  );
  const hardSets = (list: PlannedSession[]) =>
    list.reduce(
      (total, session) =>
        total + (session.exercises ?? []).filter((exercise) => HARD_LABELS.has(exercise.plannedEffortLabel ?? "")).reduce((sum, exercise) => sum + Math.max(0, exercise.sets), 0),
      0
    );
  const executed = strengthSessions.filter((session) => EXECUTED_STATUSES.has(session.status));

  const weekLogs = logs.filter((log) => within(log.completedAt));
  const deloads = sessions.filter((session) => within(session.scheduledDate) && session.status === "deload").length;
  const pain = weekLogs.find((log) => log.painLevel >= 4);
  const veryWeak = weekLogs.find((log) => log.fatigueLevel >= 9);
  const veryHard = weekLogs.filter((log) => log.rpe >= 9).length;
  const reactiveReason = deloads > 0
    ? `${deloads} session(s) deloaded`
    : pain
      ? `pain ${pain.painLevel}/10 logged`
      : veryWeak
        ? "very weak session feedback"
        : veryHard >= 3
          ? `${veryHard} sessions at RPE 9 or higher`
          : null;

  // By where the week starts: the race inside it, a start 21 days or less
  // before the race (taper), or a start up to 14 days after it.
  let raceReason: string | null = null;
  if (Number.isFinite(raceDate)) {
    const daysFromStart = Math.round((raceDate - start) / DAY_MS);
    if (daysFromStart >= 0 && daysFromStart < 7) raceReason = "race week";
    else if (daysFromStart >= 7 && daysFromStart <= RECOVERY_CYCLE.taperDays) raceReason = "taper";
    else if (daysFromStart < 0 && daysFromStart >= -RECOVERY_CYCLE.postRaceDays) raceReason = "post-race";
  }

  return {
    index,
    start,
    end,
    runningCovered: start >= runCoverage,
    strengthCovered: start >= sessionCoverage,
    runningKm: round1(weekRuns.reduce((total, run) => total + Math.max(0, run.distanceKm), 0)),
    runningKmAfterDayOne: round1(
      weekRuns.filter((run) => within(run.completedAt, start + DAY_MS)).reduce((total, run) => total + Math.max(0, run.distanceKm), 0)
    ),
    longestRunKm: Math.max(0, ...weekRuns.map((run) => run.distanceKm)),
    plannedHardSets: hardSets(strengthSessions),
    executedHardSets: hardSets(executed),
    executedStrengthSessions: executed.length,
    reactiveReason,
    raceReason
  };
}

type Reference = { runningKm: number | null; hardSets: number | null; weeks: number[] };

/** The average of the (up to) four covered weeks before `index`, pre-block weeks included. */
function referenceWeeks(index: number, dataFor: (index: number) => WeekData, hybrid: boolean): Reference {
  const weeks: WeekData[] = [];
  for (let offset = 1; offset <= RECOVERY_CYCLE.referenceWeeks; offset += 1) {
    const data = dataFor(index - offset);
    if (hybrid ? data.runningCovered : data.strengthCovered) weeks.push(data);
  }
  if (weeks.length < 2) return { runningKm: null, hardSets: null, weeks: weeks.map((week) => week.index) };
  return {
    runningKm: round1(weeks.reduce((total, week) => total + week.runningKm, 0) / weeks.length),
    hardSets: round1(weeks.reduce((total, week) => total + week.executedHardSets, 0) / weeks.length),
    weeks: weeks.map((week) => week.index)
  };
}

function classifyWeek(
  data: WeekData,
  dataFor: (index: number) => WeekData,
  hybrid: boolean,
  plannedRecovery: boolean
): BlockWeekSummary {
  const reference = referenceWeeks(data.index, dataFor, hybrid);
  const summary = (classification: BlockWeekClassification, note: string): BlockWeekSummary => ({
    blockWeek: data.index,
    startsAt: new Date(data.start).toISOString(),
    runningKm: hybrid ? data.runningKm : null,
    hardStrengthSets: data.executedHardSets,
    classification,
    note
  });

  if (data.reactiveReason) return summary("reactive_offload", `reactive offload: ${data.reactiveReason}`);
  if (data.raceReason) return summary("taper_or_race", data.raceReason);

  const runningRef = hybrid && reference.runningKm !== null && reference.runningKm >= RECOVERY_CYCLE.minReferenceKm ? reference.runningKm : null;
  const strengthRef = reference.hardSets !== null && reference.hardSets >= RECOVERY_CYCLE.minReferenceHardSets ? reference.hardSets : null;

  if (plannedRecovery) {
    const done = runningRef !== null
      ? data.runningKmAfterDayOne <= RECOVERY_CYCLE.executedRecoveryRatio * (6 / 7) * runningRef
      : strengthRef !== null
        ? data.executedHardSets <= 0.8 * strengthRef
        : true;
    if (done) return summary("recovery", "planned recovery week, done lighter");
  }

  if (runningRef !== null) {
    if (data.runningKm <= RECOVERY_CYCLE.lowVolumeRatio * runningRef) {
      return summary("low_volume", `${data.runningKm} km, at or below 80% of the ${runningRef} km average before it`);
    }
    return summary("loading", plannedRecovery ? `planned recovery week trained through (${data.runningKm} km)` : `${data.runningKm} km`);
  }
  if (!hybrid && strengthRef !== null) {
    if (data.executedHardSets <= RECOVERY_CYCLE.strengthLowVolumeRatio * strengthRef) {
      return summary("low_volume", `${data.executedHardSets} hard sets, at or below 60% of the ${strengthRef} average before it`);
    }
    return summary("loading", `${data.executedHardSets} hard sets`);
  }
  const trained = data.runningKm > 0 || data.executedStrengthSessions > 0;
  return trained
    ? summary("loading", hybrid ? `${data.runningKm} km (no steady base to compare yet)` : `${data.executedStrengthSessions} strength session(s)`)
    : summary("no_training", "no training logged");
}

function loadingStreak(summaries: BlockWeekSummary[]): number {
  let streak = 0;
  for (let index = summaries.length - 1; index >= 0; index -= 1) {
    if (summaries[index].classification !== "loading") break;
    streak += 1;
  }
  return streak;
}

function recoveryLimits(
  startsAt: string,
  endsAt: string,
  reference: Reference,
  dataFor: (index: number) => WeekData,
  summaries: BlockWeekSummary[]
): NonNullable<PeriodizationContext["recoveryWeek"]> {
  const { running, strength } = RECOVERY_CYCLE;
  const referenceKm = reference.runningKm !== null && reference.runningKm > 0 ? reference.runningKm : null;
  const longest = Math.max(0, ...reference.weeks.map((index) => dataFor(index).longestRunKm));
  const lastLoading = [...summaries].reverse().find((summary) => summary.classification === "loading");
  const referenceHardSets = lastLoading ? dataFor(lastLoading.blockWeek).plannedHardSets : null;
  return {
    startsAt,
    endsAt,
    referenceWeeklyKm: referenceKm,
    weeklyKmCap: referenceKm === null ? null : round1(referenceKm * running.weeklyKmCapRatio),
    targetWeeklyKm:
      referenceKm === null
        ? null
        : { low: round1(referenceKm * running.weeklyKmTargetRatio.low), high: round1(referenceKm * running.weeklyKmTargetRatio.high) },
    longRunCapKm: longest > 0 ? round1(longest * running.longRunRatio) : null,
    maxQualityRuns: running.maxQualityRuns,
    referenceHardStrengthSets: referenceHardSets !== null && referenceHardSets >= RECOVERY_CYCLE.minReferenceHardSets ? referenceHardSets : null,
    hardStrengthSetCap:
      referenceHardSets !== null && referenceHardSets >= RECOVERY_CYCLE.minReferenceHardSets
        ? Math.floor(referenceHardSets * strength.hardSetRatio + 1e-9)
        : null,
    maxHardStrengthSessions: strength.maxHardSessions,
    maxGoalSetsPerExercise: strength.maxGoalSetsPerExercise
  };
}

function round1(value: number): number {
  return Math.round(value * 10 + 1e-9) / 10;
}
