import assert from "node:assert/strict";
import test from "node:test";
import {
  disciplineCoachSystemPrompt,
  disciplineCoachTemperament,
  flatGoalMetricsRequiringProgression
} from "./coach-temperament";
import type { CoachContext } from "./types";

test("flags clean flat goal prescriptions as needing progression", () => {
  const metrics = flatGoalMetricsRequiringProgression(cleanFlatContext());

  assert.deepEqual(metrics.map((metric) => metric.metric), ["pullUps", "pushUps"]);
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
      recentGoalTargets: {
        pullUps: { latestTarget: 3, latestVolume: 12, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        pushUps: { latestTarget: 10, latestVolume: 30, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
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
