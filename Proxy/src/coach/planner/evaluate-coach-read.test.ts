import assert from "node:assert/strict";
import test from "node:test";
import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import { evaluateCoachRead } from "./evaluate-coach-read";
import { POST_RACE_STRENGTH_TEXT } from "./season";
import { STRENGTH_PHASE_LIMITS } from "./strength-phase";
import type { CoachContext } from "./types";
import type { TrainingSignals } from "./compute-training-signals";

const NOW = new Date("2026-06-28T12:00:00Z");

test("marks excellent adherence with improving progress as ahead", () => {
  const evaluation = evaluateCoachRead(context({
    adherenceScorePct: 100,
    trendLabel: "improving"
  }), null, NOW);

  assert.equal(evaluation.status, "ahead");
  assert.equal(evaluation.statusLabel, "Ahead");
  assert.equal(evaluation.adherence.band, "excellent");
  assert.equal(evaluation.planDecision.action, "keep_plan");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, false);
  assert.equal(evaluation.snapshot.status, "ahead");
});

test("uses 80 percent adherence as the on-track standard", () => {
  const evaluation = evaluateCoachRead(context({
    adherenceScorePct: 83,
    trendLabel: "flat"
  }), null, NOW);

  assert.equal(evaluation.status, "on_track");
  assert.equal(evaluation.adherence.band, "on_track");
  assert.equal(evaluation.adherence.completedPct, 83);
  assert.equal(evaluation.adherence.standardPct, 80);
});

test("puts 60 to 79 percent adherence on watch without forcing a plan update", () => {
  const evaluation = evaluateCoachRead(context({
    adherenceScorePct: 75,
    todaySessions: [{ id: "today", title: "Easy run", status: "planned", focus: "mixed", scheduledDate: "2026-06-28T18:00:00Z" }]
  }), null, NOW);

  assert.equal(evaluation.status, "watch");
  assert.equal(evaluation.adherence.band, "watch");
  assert.equal(evaluation.planDecision.action, "gate_intensity");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, false);
  assert.match(evaluation.nextAction, /Easy run/);
});

test("marks below 60 percent adherence as behind while keeping future sessions excluded", () => {
  const evaluation = evaluateCoachRead(context({
    adherenceScorePct: 50,
    due: 2,
    completed: 1,
    missed: 1,
    future: 3
  }), null, NOW);

  assert.equal(evaluation.status, "behind");
  assert.equal(evaluation.adherence.band, "behind");
  assert.equal(evaluation.adherence.futureSessionsExcluded, 3);
  assert.equal(evaluation.adherence.completedPct, 50);
});

test("readiness overrides adherence when recovery is needed", () => {
  const evaluation = evaluateCoachRead(context({
    adherenceScorePct: 100,
    readinessState: "recovery_needed",
    riskFlags: ["recent_pain_level_4_or_higher"]
  }), null, NOW);

  assert.equal(evaluation.status, "needs_recovery");
  assert.equal(evaluation.planDecision.action, "recovery_first");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, true);
});

// The gate is the running planner's (wellness-gate.ts): HRV below the baseline (a hybrid athlete).
test("wellness can gate intensity without making the model calculate readiness", () => {
  const evaluation = evaluateCoachRead(
    {
      ...withRace(context({
        adherenceScorePct: 100,
        todaySessions: [{ id: "today", title: "Pull capacity", status: "planned", focus: "pull", scheduledDate: "2026-06-28T18:00:00Z" }]
      }), "2026-12-01T00:00:00Z"),
      garmin: { wellness: [{ date: "2026-06-27", hrvStatus: "LOW" }] }
    } as CoachContext,
    signals({ hrvGate: "favor-easy", trainingReadiness: 66 }),
    NOW
  );

  assert.equal(evaluation.status, "watch");
  assert.equal(evaluation.readiness.hrvGate, "favor-easy");
  assert.equal(evaluation.readiness.trainingReadiness, 66);
  assert.match(evaluation.readiness.rationale, /HRV below your baseline/);
  assert.equal(evaluation.planDecision.action, "gate_intensity");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, false);
});

// Task 8 (audit C6): Garmin training readiness is a weak, heuristic signal
// the planner ignores, so on its own it can make the read cautious (watch)
// but never say "Needs recovery" while the plan stays a normal week.
test("training readiness 25 with normal logs reads watch, not needs recovery", () => {
  const evaluation = evaluateCoachRead(
    context({ adherenceScorePct: 100, trendLabel: "improving" }),
    signals({ hrvGate: "ok-for-hard", trainingReadiness: 25 }),
    NOW
  );

  assert.equal(evaluation.status, "watch");
  assert.equal(evaluation.statusLabel, "Watch");
  assert.equal(evaluation.readiness.painOrFatigueFlag, false);
  assert.notEqual(evaluation.planDecision.action, "recovery_first");
  assert.match(evaluation.readiness.rationale, /Training readiness is low at 25/);
});

// One source: the read's readiness is the planner's computed state. A rolling
// decline the planner answers with an overreaching offload used to read
// "Behind: do the next session at the planned effort" (audit C7).
test("a decline the planner calls overreaching reads watch, not behind", () => {
  const evaluation = evaluateCoachRead(
    context({ adherenceScorePct: 100, trendLabel: "declining", readinessState: "overreaching", reason: "The best push-ups of the last 3 weeks are below the 3 weeks before, with at least 2 results below the plan." }),
    null,
    NOW
  );

  assert.equal(evaluation.status, "watch");
  assert.match(evaluation.readiness.rationale, /below the plan/);
  assert.doesNotMatch(evaluation.nextAction, /at the planned effort/);
});

// One source: the wellness gate is the running planner's (HRV below the
// baseline, or poor sleep on 2 of the last 3 nights), not a second rule.
test("the read's wellness gate is the planner's: two poor nights read watch", () => {
  const poorSleep = {
    ...withRace(context({ adherenceScorePct: 100, trendLabel: "improving" }), "2026-12-01T00:00:00Z"),
    garmin: { wellness: [
      { date: "2026-06-26", sleepScore: 42 },
      { date: "2026-06-27", sleepScore: 45 }
    ] }
  } as CoachContext;

  const evaluation = evaluateCoachRead(poorSleep, signals({ hrvGate: "ok-for-hard", trainingReadiness: 70 }), NOW);

  assert.equal(evaluation.status, "watch");
  assert.match(evaluation.readiness.rationale, /poor sleep/);
});

// The progress label comes from the rolling 3-week windows when they exist,
// so the text says so instead of "month-to-month" (audit C7).
test("progress read from the rolling windows names the weeks, not months", () => {
  const rolling = {
    ...context({ adherenceScorePct: 100 }),
  } as CoachContext;
  rolling.history = { ...rolling.history, rollingTrend: { ...rolling.history.twoFullMonthTrend, label: "improving" } } as CoachContext["history"];

  const evaluation = evaluateCoachRead(rolling, null, NOW);

  assert.equal(evaluation.progress.rationale, "Your best results of the last 3 weeks are above the 3 weeks before.");
  assert.equal(evaluateCoachRead(context({ adherenceScorePct: 100, trendLabel: "improving" }), null, NOW).progress.rationale, "Recent month-to-month training metrics are improving.");
});

// Code review: the status reads the planner's wellness gate (Garmin rows),
// not trainingSignals.hrvGate. A favor-easy signal with no Garmin rows the
// gate could read leaves the read on track, so the source is visible.
test("a favor-easy HRV signal without Garmin rows does not drive the status", () => {
  const evaluation = evaluateCoachRead(
    withRace(context({ adherenceScorePct: 83, trendLabel: "flat" }), "2026-12-01T00:00:00Z"),
    signals({ hrvGate: "favor-easy", trainingReadiness: 66 }),
    NOW
  );

  assert.equal(evaluation.status, "on_track");
  assert.equal(evaluation.readiness.hrvGate, "favor-easy", "still shown as a signal");
});

// The wellness gate acts only on the running planner (no quality run in the
// next 48 hours); the strength planner has no wellness rule. A strength-only
// athlete's read does not warn about a gate no plan follows.
test("a strength-only athlete's poor sleep does not read watch", () => {
  const sleepy = {
    ...context({ adherenceScorePct: 83, trendLabel: "flat" }),
    garmin: { wellness: [{ date: "2026-06-26", sleepScore: 42 }, { date: "2026-06-27", sleepScore: 45 }] }
  } as CoachContext;

  assert.equal(evaluateCoachRead(sleepy, null, NOW).status, "on_track");
  assert.equal(evaluateCoachRead(withRace(sleepy, "2026-12-01T00:00:00Z"), null, NOW).status, "watch", "a hybrid athlete's runs follow the gate");
});

test("asks for an automatic plan update when no sessions are planned", () => {
  const evaluation = evaluateCoachRead(context({
    planned: 0,
    due: 0,
    future: 0,
    completed: 0,
    missed: 0,
    adherenceScorePct: null,
    todaySessions: []
  }), null, NOW);

  assert.equal(evaluation.status, "on_track");
  assert.equal(evaluation.adherence.band, "not_enough_due_sessions");
  assert.equal(evaluation.planDecision.action, "update_plan");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, true);
});

function context(options: {
  planned?: number;
  due?: number;
  future?: number;
  completed?: number;
  missed?: number;
  adherenceScorePct?: number | null;
  readinessState?: CoachContext["readiness"]["state"];
  riskFlags?: string[];
  reason?: string;
  trendLabel?: CoachContext["history"]["twoFullMonthTrend"]["label"];
  todaySessions?: CoachContext["plannedWork"]["todaySessions"];
} = {}): CoachContext {
  return {
    profile: {
      baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
      goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
      profileNotes: "",
      weekStart: "2026-06-28T00:00:00Z",
      weeklySessions: 4,
      trainingDays: ["monday", "wednesday", "friday", "saturday"],
      trainingDayOffsets: [1, 3, 5, 6],
      equipment: ["pullUpBar"],
      targetDate: "2027-06-28T00:00:00Z"
    },
    history: {
      last5Logs: [],
      rpeCalibration: {
        recentPlannedLogCount: 0,
        averageDeltaLast5: null,
        abovePlanBy2Count: 0,
        belowPlanBy2Count: 0,
        latestSummary: null
      },
      currentPartialMonth: emptyMonth("2026-06", true),
      lastFullMonth: emptyMonth("2026-05", false),
      previousFullMonth: emptyMonth("2026-04", false),
      twoFullMonthTrend: {
        pullUpsDelta: null,
        pushUpsDelta: null,
        plankSecondsDelta: null,
        logCountDelta: 0,
        label: options.trendLabel ?? "insufficient_history"
      },
      bestRecentTests: { pullUps: 8, pushUps: 30, plankSeconds: 90 }
    },
    adherence: {
      planned: options.planned ?? 4,
      due: options.due ?? 4,
      future: options.future ?? 0,
      completed: options.completed ?? 4,
      partial: 0,
      missed: options.missed ?? 0,
      deload: 0,
      pending: 0,
      adherenceScorePct: "adherenceScorePct" in options ? options.adherenceScorePct ?? null : 100
    },
    plannedWork: {
      todaySessions: options.todaySessions ?? [],
      recentGoalTargets: {
        pullUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        pushUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      }
    },
    readiness: {
      state: options.readinessState ?? "building",
      riskFlags: options.riskFlags ?? [],
      ...(options.reason ? { reason: options.reason } : {})
    }
  };
}

function emptyMonth(month: string, isPartial: boolean): CoachContext["history"]["currentPartialMonth"] {
  return {
    month,
    isPartial,
    logCount: 0,
    pullUps: { count: 0, best: null, latest: null },
    pushUps: { count: 0, best: null, latest: null },
    plankSeconds: { count: 0, best: null, latest: null },
    averageRPE: null,
    averagePerceivedEffort: null,
    maxPain: 0,
    maxFatigue: 0,
    worstHowYouFelt: null
  };
}

function signals(options: {
  hrvGate: "ok-for-hard" | "favor-easy" | null;
  trainingReadiness: number | null;
}): TrainingSignals {
  return {
    running: {
      last7DaysKm: 0,
      prior7DaysKm: 0,
      fourWeekAvgKm: 0,
      volumeVsFourWeekPct: null,
      last7DaysAscentM: 0,
      last7DaysDescentM: null,
      longestRunLast6WeeksKm: 0,
      recentLongRunsKm: [],
      lowIntensityTimeShareLast4Weeks: null,
      lowIntensityTimeShareLast3Weeks: null,
      noSpeedStimulusLast3Weeks: false,
      runCountLast7Days: 0
    },
    race: null,
    wellness: {
      latestDate: "2026-06-28",
      hrvStatus: options.hrvGate === "favor-easy" ? "LOW" : "BALANCED",
      hrvDate: "2026-06-28",
      hrvGate: options.hrvGate,
      sleepScore: null,
      sleepScoreDate: null,
      trainingReadiness: options.trainingReadiness,
      trainingReadinessDate: options.trainingReadiness === null ? null : "2026-06-28",
      restingHr: null,
      restingHrDate: null
    },
    lastRun: null
  };
}

// Task 8 review (probe coach-read-states.ts): in a planned recovery week and
// in the 10-day race taper the planner holds the goal targets (offload), yet
// the read said "Ahead" and "Recent push-up work needs visible progression".
// The read follows the computed strength phase: lighter on purpose, hold.
// After a race only the effort is capped, so progression stays expected.
function earnedPushUps(base: CoachContext): CoachContext {
  const performance = (earned: boolean) => ({
    latestLoggedBest: earned ? 24 : null,
    prescribedTarget: earned ? 24 : null,
    prescribedSets: earned ? 3 : null,
    delta: earned ? 0 : null,
    clean: earned ? true : null,
    consecutiveCleanCompletionsAtStandard: earned ? 2 : 0,
    completedAt: earned ? "2026-06-26T17:00:00Z" : null,
    latestTestDate: null
  });
  const context = {
    ...base,
    plannedWork: { ...base.plannedWork, recentGoalPerformance: { pullUps: performance(false), pushUps: performance(true), plankSeconds: performance(false) } }
  } as CoachContext;
  context.history = { ...context.history, rollingTrend: { ...context.history.twoFullMonthTrend, label: "improving" } } as CoachContext["history"];
  return context;
}

function withRace(base: CoachContext, raceDate: string): CoachContext {
  return {
    ...base,
    running: {
      raceGoal: { name: "Ridge Ultra", raceDate, distanceKm: 54, elevationGainM: 2000 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: [], weeksToRace: 0
    }
  } as CoachContext;
}

test("the read follows a planned recovery week: lighter on purpose, hold, not ahead", () => {
  const normal = evaluateCoachRead(earnedPushUps(context({ adherenceScorePct: 100 })), null, NOW);
  assert.equal(normal.status, "ahead");
  assert.equal(normal.planDecision.action, "update_plan", "outside the phase the earned step is due");

  const recovery = evaluateCoachRead({
    ...earnedPushUps(context({ adherenceScorePct: 100 })),
    periodization: { recoveryWeekDue: true, recoveryWeekReason: "3 loading weeks: a planned recovery week (3:1).", recoveryWeek: null } as unknown as CoachContext["periodization"]
  }, null, NOW);

  assert.equal(recovery.status, "on_track");
  assert.deepEqual(recovery.progress.flatGoalMetrics, []);
  assert.equal(recovery.planDecision.action, "keep_plan");
  assert.equal(recovery.planDecision.shouldUpdatePlan, false);
  assert.equal(recovery.progress.rationale, "This is a planned recovery week. Strength is lighter on purpose and the targets hold; no progression is expected this week.");
  assert.doesNotMatch(`${recovery.planDecision.rationale} ${recovery.progress.rationale}`, /needs visible progression/);
});

test("the read follows the 10-day race taper: lighter on purpose, hold, not ahead", () => {
  // The race is 5 days after the week start: inside the strength taper.
  const taper = evaluateCoachRead(withRace(earnedPushUps(context({ adherenceScorePct: 100 })), "2026-07-03T00:00:00Z"), null, NOW);

  assert.equal(taper.status, "on_track");
  assert.deepEqual(taper.progress.flatGoalMetrics, []);
  assert.equal(taper.planDecision.action, "keep_plan");
  assert.equal(taper.progress.rationale, `Ridge Ultra is 5 days away: this week is inside the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper. Strength is lighter on purpose and the targets hold; no progression is expected this week.`);
});

// Code review: with the race 16 days out the strength taper covers only the
// last planned days, yet the read said "These are the last 10 days before".
test("a race 16 days out reads that the strength taper starts this week", () => {
  const read = evaluateCoachRead(withRace(earnedPushUps(context({ adherenceScorePct: 100 })), "2026-07-14T00:00:00Z"), null, NOW);

  assert.equal(read.status, "on_track");
  assert.equal(read.progress.rationale, `Ridge Ultra is 16 days away: the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper starts this week. Strength is lighter on purpose and the targets hold; no progression is expected this week.`);
  assert.equal(read.planDecision.rationale, `Ridge Ultra is 16 days away: the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper starts this week. The lighter plan is the right structure: hold the targets.`);
});

test("after a race the read keeps progression and names the effort cap", () => {
  // The race was yesterday: post-race days 1-7 cap the effort, not progression (the planner's earned band).
  const postRace = evaluateCoachRead(withRace(earnedPushUps(context({ adherenceScorePct: 100 })), "2026-06-27T00:00:00Z"), null, NOW);

  assert.deepEqual(postRace.progress.flatGoalMetrics, ["push-up"]);
  assert.equal(postRace.planDecision.action, "update_plan");
  assert.ok(postRace.progress.rationale.endsWith(` After the race running recovers first while ${POST_RACE_STRENGTH_TEXT}.`), postRace.progress.rationale);
});

test("the verdict prompt's flat goal metrics follow the strength phase too", () => {
  const recovery = {
    ...earnedPushUps(context({ adherenceScorePct: 100 })),
    periodization: { recoveryWeekDue: true, recoveryWeekReason: "3:1", recoveryWeek: null } as unknown as CoachContext["periodization"]
  } as CoachContext;
  assert.deepEqual(flatGoalMetricsRequiringProgression(recovery), []);
  assert.deepEqual(flatGoalMetricsRequiringProgression(earnedPushUps(context({ adherenceScorePct: 100 }))).map((entry) => entry.metric), ["pushUps"]);
});

// Task 8 review: for a new user the planner reads too little history
// (insufficient_history) and plans a normal week, yet a rolling decline made
// the read say "Behind: do the next session at the planned effort". The read
// follows the planner: too little history to judge progress.
test("a new user's rolling decline reads not enough data, not behind, while the planner plans a normal week", () => {
  const newUser = context({ adherenceScorePct: 100, readinessState: "insufficient_history" });
  newUser.history = { ...newUser.history, rollingTrend: { ...newUser.history.twoFullMonthTrend, label: "declining" } } as CoachContext["history"];

  const evaluation = evaluateCoachRead(newUser, null, NOW);

  assert.equal(evaluation.status, "on_track");
  assert.equal(evaluation.progress.state, "not_enough_data");
  assert.equal(evaluation.progress.rationale, "There is not enough clean history to judge progress yet.");
  assert.doesNotMatch(evaluation.nextAction, /at the planned effort/);
});
