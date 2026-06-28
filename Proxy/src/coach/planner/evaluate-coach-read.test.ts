import assert from "node:assert/strict";
import test from "node:test";
import { evaluateCoachRead } from "./evaluate-coach-read";
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

test("wellness can gate intensity without making the model calculate readiness", () => {
  const evaluation = evaluateCoachRead(
    context({
      adherenceScorePct: 100,
      todaySessions: [{ id: "today", title: "Pull capacity", status: "planned", focus: "pull", scheduledDate: "2026-06-28T18:00:00Z" }]
    }),
    signals({ hrvGate: "favor-easy", trainingReadiness: 36 }),
    NOW
  );

  assert.equal(evaluation.status, "watch");
  assert.equal(evaluation.readiness.hrvGate, "favor-easy");
  assert.equal(evaluation.readiness.trainingReadiness, 36);
  assert.equal(evaluation.planDecision.action, "gate_intensity");
  assert.equal(evaluation.planDecision.shouldUpdatePlan, false);
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
      riskFlags: options.riskFlags ?? []
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
      easyShareLast4Weeks: null,
      runCountLast7Days: 0
    },
    race: null,
    wellness: {
      latestDate: "2026-06-28",
      hrvStatus: options.hrvGate === "favor-easy" ? "LOW" : "BALANCED",
      hrvGate: options.hrvGate,
      sleepScore: null,
      trainingReadiness: options.trainingReadiness,
      restingHr: null
    },
    lastRun: null
  };
}
