import { GOAL_EXERCISE, GOAL_METRICS, isGoalTest, isHardLabel, METRIC_LABEL, METRIC_PLURAL, type GoalMetric } from "./goal-metrics";
import { NORMAL_READINESS_STATES } from "./readiness-state";
import { contextSeason, daysBetween, SEASON_LIMITS } from "./season";
import { isBlocked, type MetricProgression } from "./strength-limits";
import { STRENGTH_PHASE_LIMITS, strengthPhase, strengthSessionRule } from "./strength-phase";
import type { CoachContext } from "./types";
import { freeOffsets, isHardRun, PLANNED_OFFSETS } from "./week-schedule";

/**
 * Assessment due: code schedules the goal tests the working caps wait for.
 * Working sets sit below the best, so only a test (or clearly doing more than
 * planned) moves the level; leaving tests to the model stalled progress.
 *
 * - Days since the test: from the latest test of the metric (done, or planned
 *   for today) or the plan block's baseline, whichever is later. With neither
 *   on record a test is due as soon as anything has been logged.
 * - Due at 42 days, or at 28 days when the metric's progression is blocked
 *   (earned, but the working cap and the set limit or session budget stop
 *   it) or readiness is plateau. Tests stay at least 28 days apart.
 * - Only in a normal-readiness week outside the season's taper phase (the
 *   last 21 days before the race; the 10-day strength taper inside it is a
 *   separate rule), judged per planned day too: a week that starts before
 *   the taper takes no test on its days inside it. Post-race days 1-7 take no
 *   test (judged per planned day), and a planned recovery week takes one on
 *   its last 2 days only.
 * - The validator requires the test only when a legal day exists: a training
 *   day that is not a hard-run day, the day before a long run or the race, or
 *   the week's only run-free day (the full rest day). Otherwise it waits.
 * - Fresh first: days that follow a hard run, a long run or hard strength are
 *   listed only when the week has no fresher legal day (the reason says so).
 */
export const ASSESSMENT_LIMITS = {
  /** Fewest days between two tests of a metric (the plan block's baseline counts as one). */
  spacingDays: 28,
  dueAfterDays: 42,
  /** Due this soon when progression is blocked at the cap and the set limit or budget, or on a plateau. */
  blockedDueAfterDays: 28,
  /** No test on post-race days 1-7 (the post-race strength rule: no max_output there). */
  postRaceNoTestDays: STRENGTH_PHASE_LIMITS.postRace.atMostHardThroughDay,
  /** In a planned recovery week tests sit on its last 2 days only. */
  recoveryWeekTestDays: STRENGTH_PHASE_LIMITS.recovery.testDays,
  /** Rest between two tested exercises. */
  restBetweenTestsMinutes: { min: 3, max: 5 }
} as const;

/**
 * The test protocol, stated in the session for the athlete (plain words; the
 * plan's schema is in the guardrails' assessmentRule). Both versions end with
 * this tail.
 */
export const ASSESSMENT_PROTOCOL_TAIL =
  `do one all-out set of each tested exercise in strict form, rest ${ASSESSMENT_LIMITS.restBetweenTestsMinutes.min}-${ASSESSMENT_LIMITS.restBetweenTestsMinutes.max} minutes between exercises, and write down the number.`;
/** The standard test. */
export const ASSESSMENT_PROTOCOL = `Test at the start of the session after a warm-up, on fresh legs (no hard training the day before): ${ASSESSMENT_PROTOCOL_TAIL}`;
/** The protocol when every day that can take the test follows hard work. */
export const ASSESSMENT_PROTOCOL_AFTER_HARD_WORK = `Test at the start of the session after a warm-up, as rested as this week allows (keep the day before easy): ${ASSESSMENT_PROTOCOL_TAIL}`;

export type AssessmentRun = { dayOffset: number; kind: string };
export type AssessmentOptions = {
  /** The fixed running week (combined plans); without it the long-run day from the request counts. */
  runs?: AssessmentRun[];
};

export type MetricAssessment = {
  metric: GoalMetric;
  /** Whole days from the last test (or the block's baseline) to the week start; null when none is on record. */
  daysSinceTest: number | null;
  lastTestDate: string | null;
  /** Progression is blocked (cap and set limit or budget) or readiness is plateau. */
  blocked: boolean;
  due: boolean;
  /** One plain clause: why it is or is not due. */
  reason: string;
};

export type Assessment = {
  /** Metrics to test this week: due, and a legal day exists (enforced). */
  due: GoalMetric[];
  /** Due metrics no day this week can take: they wait for next week. */
  waiting: GoalMetric[];
  /** Day offsets a test may sit on. */
  testDayOffsets: number[];
  protocol: string;
  /** The week in one plain sentence. */
  reason: string;
  metrics: Record<GoalMetric, MetricAssessment>;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pull-ups need a bar; an equipment list never filled in is not checked (as everywhere else). */
export function hasPullUpBar(context: CoachContext): boolean {
  return context.profile.equipment.length === 0 || context.profile.equipment.includes("pullUpBar");
}

export type LastTest = {
  date: string;
  /** Whole calendar days from it to the week start, never below 0 (a test later today is today's). */
  days: number;
  /** A goal test, or the plan block's baseline. */
  source: "test" | "baseline";
};

/**
 * The later of the latest test and the plan block's baseline, with its age in
 * whole calendar days at the week start (daysBetween: a daylight-saving change
 * is no extra or missing day). The due rule and the 28-day spacing both read
 * it, so a due test always clears the spacing.
 */
export function lastTestOf(context: CoachContext, metric: GoalMetric): LastTest | null {
  const performance = context.plannedWork.recentGoalPerformance?.[metric];
  const candidates = [
    { date: performance?.latestTestDate, source: "test" as const },
    { date: performance?.baselineSetAt, source: "baseline" as const }
  ]
    .filter((entry): entry is { date: string; source: "test" | "baseline" } => typeof entry.date === "string" && Number.isFinite(Date.parse(entry.date)))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const last = candidates[0];
  const days = last ? daysBetween(last.date, context.profile.weekStart) : Number.NaN;
  if (!last || !Number.isFinite(days)) return null;
  return { date: last.date, days: Math.max(0, days), source: last.source };
}

/** "the last test is today", "the last test was 1 day ago", "the last test was 30 days ago". */
function lastTestText(days: number): string {
  return days === 0 ? "the last test is today" : `the last test was ${days} ${days === 1 ? "day" : "days"} ago`;
}

/** Why no test is due this week at all, or null (post-race days are judged per day, in testDays). */
function weekPause(context: CoachContext): string | null {
  if (!NORMAL_READINESS_STATES.has(context.readiness.state)) return `readiness is ${context.readiness.state.replace("_", " ")}`;
  if (contextSeason(context).phase === "taper" || strengthPhase(context).raceTaper) {
    return `it is the taper phase (the last ${SEASON_LIMITS.phaseUntilDays.taper} days before the race)`;
  }
  return null;
}

export type TestDays = {
  /** Day offsets a test may sit on: the fresh ones when the week has any. */
  offsets: number[];
  /** Every listed day follows hard work (no fresher legal day this week). */
  afterHardWork: boolean;
  /** Why no day is left, when that is down to the taper, the post-race week or a recovery week. */
  none: string | null;
};

/**
 * Days a test may sit on: a training day; not a hard-run day, the day before
 * a long run or the race, or the race day; not a day of the taper phase (the
 * last 21 days before the race); not post-race days 1-7; not the
 * week's only run-free day (it stays the full rest day); in a recovery week
 * only its last 2 days. Days after hard work (a hard run, a long run, or hard
 * strength today) are listed only when no fresher one is left.
 */
export function testDays(context: CoachContext, options: AssessmentOptions = {}): TestDays {
  const phase = strengthPhase(context);
  const training = context.profile.trainingDays.length > 0 ? new Set(context.profile.trainingDayOffsets) : null;
  const longRunDay = context.running?.longRunDayOffset;
  const runs = options.runs ?? (typeof longRunDay === "number" ? [{ dayOffset: longRunDay, kind: "long" }] : []);
  const hardRuns = new Set(runs.filter((run) => isHardRun(run.kind)).map((run) => run.dayOffset));
  const longRuns = new Set(runs.filter((run) => run.kind === "long").map((run) => run.dayOffset));
  const raceDay = context.running ? daysBetween(context.profile.weekStart, context.running.raceGoal.raceDate) : Number.NaN;
  // With the runs fixed, the week's only run-free day is the full rest day.
  const runFree = freeOffsets(runs.map((run) => run.dayOffset));
  const restDay = options.runs && runFree.length === 1 ? runFree[0] : null;
  let postRace = false;
  let recovery = false;
  let taper = false;
  const legal = PLANNED_OFFSETS.filter((offset) => {
    if (training && !training.has(offset)) return false;
    // The taper phase pauses tests per day: a week that starts before it takes none on its days inside it.
    if (raceDay - offset >= 0 && raceDay - offset <= SEASON_LIMITS.phaseUntilDays.taper) {
      taper = true;
      return false;
    }
    // Post-race days 1-7, the race taper and a recovery week before its last 2 days take no test (strength-phase.ts).
    const rule = strengthSessionRule(offset, phase);
    if (rule.light && !rule.testsAllowed) {
      if (rule.source === "post_race") postRace = true;
      else if (rule.source === "recovery_week") recovery = true;
      return false;
    }
    if (hardRuns.has(offset) || longRuns.has(offset + 1)) return false;
    if (offset === raceDay || offset + 1 === raceDay) return false;
    return offset !== restDay;
  });
  const hardWork = hardWorkDays(context, runs);
  const fresh = legal.filter((offset) => !hardWork.has(offset - 1));
  if (fresh.length > 0) return { offsets: fresh, afterHardWork: false, none: null };
  const none = legal.length > 0
    ? null
    : taper
      ? `the taper (the last ${SEASON_LIMITS.phaseUntilDays.taper} days before the race) takes no test`
      : postRace
        ? `the first week after the race (post-race days 1-${ASSESSMENT_LIMITS.postRaceNoTestDays}) takes no test`
        : recovery
          ? `a recovery week takes a test on its last ${ASSESSMENT_LIMITS.recoveryWeekTestDays} days only`
          : null;
  return { offsets: legal, afterHardWork: legal.length > 0, none };
}

/** Offsets 0-6 with known hard work: hard runs (today's too) and a hard strength session today. */
function hardWorkDays(context: CoachContext, runs: AssessmentRun[]): Set<number> {
  const days = new Set(runs.filter((run) => isHardRun(run.kind)).map((run) => run.dayOffset));
  const start = Date.parse(context.profile.weekStart);
  const hardRunToday =
    (context.todayPlannedRuns ?? []).some((run) => isHardRun(run.kind)) ||
    (context.running?.recentRuns ?? []).some((run) => {
      const at = Date.parse(run.completedAt);
      return at >= start && at < start + DAY_MS && isHardRun(run.kind);
    });
  const hardStrengthToday = (context.plannedWork.todaySessions ?? []).some((session) =>
    session.status !== "missed" && isHardLabel(session.hardestEffort)
  );
  if (hardRunToday || hardStrengthToday) days.add(0);
  return days;
}

/** The offsets of testDays. */
export function testDayOffsets(context: CoachContext, options: AssessmentOptions = {}): number[] {
  return testDays(context, options).offsets;
}

export function assessmentFor(
  context: CoachContext,
  progression: Record<GoalMetric, MetricProgression>,
  options: AssessmentOptions = {}
): Assessment {
  const pause = weekPause(context);
  const anyLogs = (context.history.last5Logs?.length ?? 0) > 0;
  const plateau = context.readiness.state === "plateau";
  const { dueAfterDays, blockedDueAfterDays } = ASSESSMENT_LIMITS;
  const metrics = {} as Record<GoalMetric, MetricAssessment>;
  for (const metric of GOAL_METRICS) {
    const last = lastTestOf(context, metric);
    const days = last?.days ?? null;
    const blocked = isBlocked(progression[metric]) || plateau;
    const blockedWhy = plateau ? "readiness is plateau" : "progression is blocked at the working cap and the set limit or session budget";
    let due = false;
    let reason: string;
    if (metric === "pullUps" && !hasPullUpBar(context)) {
      reason = "no pull-up bar";
    } else if (pause) {
      reason = `no test while ${pause}`;
    } else if (days === null) {
      due = anyLogs;
      reason = anyLogs ? "no test or plan start is on record" : "the baseline is fresh: nothing is logged yet";
    } else if (days >= dueAfterDays) {
      due = true;
      reason = lastTestText(days);
    } else if (days >= blockedDueAfterDays && blocked) {
      due = true;
      reason = `${lastTestText(days)} and ${blockedWhy}`;
    } else {
      reason = `${lastTestText(days)} (due at ${dueAfterDays} days, or ${blockedDueAfterDays} while progression is blocked)`;
    }
    metrics[metric] = { metric, daysSinceTest: days, lastTestDate: last?.date ?? null, blocked, due, reason };
  }

  const dueMetrics = GOAL_METRICS.filter((metric) => metrics[metric].due);
  const days = dueMetrics.length > 0 ? testDays(context, options) : { offsets: [], afterHardWork: false, none: null };
  const offsets = days.offsets;
  const names = (list: GoalMetric[]) => list.map((metric) => METRIC_PLURAL[metric]).join(", ");
  const why = (list: GoalMetric[]) => list.map((metric) => `${METRIC_PLURAL[metric]}: ${metrics[metric].reason}`).join("; ");
  if (dueMetrics.length === 0) {
    return {
      due: [],
      waiting: [],
      testDayOffsets: [],
      protocol: ASSESSMENT_PROTOCOL,
      reason: pause ? `No test is due: ${pause}.` : "No test is due this week.",
      metrics
    };
  }
  if (offsets.length === 0) {
    return {
      due: [],
      waiting: dueMetrics,
      testDayOffsets: [],
      protocol: ASSESSMENT_PROTOCOL,
      reason: `A test of ${names(dueMetrics)} is due (${why(dueMetrics)}), but no day this week can take it${days.none ? ` (${days.none})` : ""}: it waits for next week.`,
      metrics
    };
  }
  const tiredNote = days.afterHardWork
    ? "; every day that can take it follows hard work (a hard run, a long run or hard strength the day before), so keep the rest of the day before easy"
    : "";
  return {
    due: dueMetrics,
    waiting: [],
    testDayOffsets: offsets,
    protocol: days.afterHardWork ? ASSESSMENT_PROTOCOL_AFTER_HARD_WORK : ASSESSMENT_PROTOCOL,
    reason: `A test of ${names(dueMetrics)} is due (${why(dueMetrics)}): one max set each on offset ${orList(offsets)}${tiredNote}; due tests may share one session, and a test is a hard session.`,
    metrics
  };
}

/**
 * A due test the plan made earlier does not hold (a max_output goal set on a
 * day that can take it) is a continuity change signal for the strength
 * planner: the test is added and the rest of the plan can stay.
 */
export function assessmentChangeSignals(context: CoachContext, assessment: Assessment): string[] {
  const plan = context.currentPlan;
  if (!plan || assessment.due.length === 0) return [];
  const days = new Set(assessment.testDayOffsets);
  const missing = assessment.due.filter((metric) => !plan.strengthSessions.some((session) =>
    days.has(session.dayOffset) && session.goalWork.some((work) => work.exercise === GOAL_EXERCISE[metric] && isGoalTest({ label: work.effort, stimulus: work.stimulus }))
  ));
  if (missing.length === 0) return [];
  const which = missing.map((metric) => METRIC_LABEL[metric]).join(" and ");
  return [`A ${which} test is due and the plan made earlier holds none: add it (one max set) and keep the rest.`];
}

/** "2", "2 or 5", "2, 3 or 5". */
export function orList(values: number[]): string {
  return values.length <= 1 ? values.join("") : `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}
