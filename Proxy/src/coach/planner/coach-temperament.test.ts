import assert from "node:assert/strict";
import test from "node:test";
import {
  disciplineCoachSystemPrompt,
  disciplineCoachTemperament,
  flatGoalMetricsRequiringProgression
} from "./coach-temperament";
import type { CoachContext } from "./types";

test("flags immediate and repeated matched goal performance as needing progression", () => {
  const metrics = flatGoalMetricsRequiringProgression(cleanFlatContext());

  assert.deepEqual(metrics.map((metric) => metric.metric), ["pullUps", "pushUps"]);
});

test("old misses do not block earned progression", () => {
  const context = cleanFlatContext({
    adherence: { planned: 10, completed: 7, missed: 3, missedLast14Days: 0, deload: 0 }
  });

  assert.deepEqual(flatGoalMetricsRequiringProgression(context).map((metric) => metric.metric), ["pullUps", "pushUps"]);
});

test("repeated recent misses block mandatory progression", () => {
  const context = cleanFlatContext({
    adherence: { planned: 10, completed: 7, missed: 3, missedLast14Days: 2, deload: 0 }
  });

  assert.deepEqual(flatGoalMetricsRequiringProgression(context), []);
});

test("does not demand progression when recovery signals are present", () => {
  const context = cleanFlatContext({
    readiness: { state: "recovery_needed", riskFlags: ["recent_pain_level_4_or_higher"] },
    history: {
      ...baseHistory(),
      last5Logs: cleanRecentLogs().map((log, index) => ({
        ...log,
        painLevel: index === 0 ? 4 : log.painLevel
      }))
    }
  });

  assert.deepEqual(flatGoalMetricsRequiringProgression(context), []);
});

test("temperament contract stays direct without public-figure imitation", () => {
  assert.match(disciplineCoachSystemPrompt, /standards-driven/);
  assert.match(disciplineCoachTemperament.voice, /No hype/);
  assert.match(disciplineCoachTemperament.avoid.join(" "), /public figure/);
  assert.match(disciplineCoachTemperament.avoid.join(" "), /stagnation/);
});

function cleanFlatContext(overrides: Partial<CoachContext> = {}): CoachContext {
  const base: CoachContext = {
    profile: {
      baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
      goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
      profileNotes: "",
      weekStart: "2026-05-11T00:00:00Z",
      weeklySessions: 4,
      trainingDays: [],
      trainingDayOffsets: [],
      equipment: ["pullUpBar", "yogaMat"],
      targetDate: "2027-05-11T00:00:00Z"
    },
    history: baseHistory(),
    adherence: { planned: 6, completed: 6, missed: 0, deload: 0 },
    plannedWork: {
      todaySessions: [],
      recentGoalTargets: {
        pullUps: { latestTarget: 3, latestVolume: 12, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        pushUps: { latestTarget: 10, latestVolume: 30, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      },
      recentGoalPerformance: {
        pullUps: performance({ latestLoggedBest: 5, prescribedTarget: 3, prescribedSets: 4, delta: 2, consecutive: 1 }),
        pushUps: performance({ latestLoggedBest: 10, prescribedTarget: 10, prescribedSets: 3, delta: 0, consecutive: 2 }),
        plankSeconds: performance({})
      }
    },
    readiness: { state: "building", riskFlags: [] }
  };

  return {
    ...base,
    ...overrides,
    history: overrides.history ?? base.history,
    adherence: overrides.adherence ?? base.adherence,
    plannedWork: overrides.plannedWork ?? base.plannedWork,
    readiness: overrides.readiness ?? base.readiness
  };
}

function performance(options: {
  latestLoggedBest?: number;
  prescribedTarget?: number;
  prescribedSets?: number;
  delta?: number;
  consecutive?: number;
}): NonNullable<CoachContext["plannedWork"]["recentGoalPerformance"]>["pullUps"] {
  return {
    latestLoggedBest: options.latestLoggedBest ?? null,
    prescribedTarget: options.prescribedTarget ?? null,
    prescribedSets: options.prescribedSets ?? null,
    delta: options.delta ?? null,
    clean: options.latestLoggedBest === undefined ? null : true,
    consecutiveCleanCompletionsAtStandard: options.consecutive ?? 0,
    completedAt: options.latestLoggedBest === undefined ? null : "2026-05-08T00:00:00Z",
    latestTestDate: null
  };
}

function baseHistory(): CoachContext["history"] {
  return {
    last5Logs: cleanRecentLogs(),
    rpeCalibration: {
      recentPlannedLogCount: 2,
      averageDeltaLast5: -1,
      abovePlanBy2Count: 0,
      belowPlanBy2Count: 1,
      latestSummary: "RPE - Planned 7 | Actual 6"
    },
    currentPartialMonth: emptyMonth("2026-05", true),
    lastFullMonth: emptyMonth("2026-04", false),
    previousFullMonth: emptyMonth("2026-03", false),
    twoFullMonthTrend: {
      pullUpsDelta: null,
      pushUpsDelta: null,
      plankSecondsDelta: null,
      logCountDelta: 0,
      label: "insufficient_history"
    },
    bestRecentTests: { pullUps: 5, pushUps: 20, plankSeconds: 60 }
  };
}

function cleanRecentLogs(): CoachContext["history"]["last5Logs"] {
  return [
    {
      id: "log-1",
      sessionId: "session-1",
      completedAt: "2026-05-05T00:00:00Z",
      pullUps: 5,
      pushUps: 20,
      plankSeconds: 60,
      loggedPullUps: true,
      loggedPushUps: true,
      loggedPlankSeconds: true,
      rpe: 6,
      painLevel: 0,
      fatigueLevel: 5,
      notes: ""
    },
    {
      id: "log-2",
      sessionId: "session-2",
      completedAt: "2026-05-08T00:00:00Z",
      pullUps: 5,
      pushUps: 20,
      plankSeconds: 60,
      loggedPullUps: true,
      loggedPushUps: true,
      loggedPlankSeconds: true,
      rpe: 6,
      painLevel: 0,
      fatigueLevel: 5,
      notes: ""
    }
  ];
}

function emptyMonth(month: string, isPartial: boolean): CoachContext["history"]["lastFullMonth"] {
  return {
    month,
    isPartial,
    logCount: 0,
    pullUps: { count: 0, best: null, latest: null },
    pushUps: { count: 0, best: null, latest: null },
    plankSeconds: { count: 0, best: null, latest: null },
    averageRPE: null,
    maxPain: 0,
    maxFatigue: 0
  };
}
