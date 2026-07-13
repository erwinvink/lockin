import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCoachVerdict } from "./normalize-coach-verdict";
import type { CoachContext, CoachEvaluation, CoachSnapshot, CoachVerdict } from "./types";

test("uses computed evaluation as the source of truth for shouldUpdatePlan", () => {
  const normalized = normalizeCoachVerdict(
    verdict({ shouldUpdatePlan: true }),
    context({ readinessState: "building" }),
    evaluation({ shouldUpdatePlan: false })
  );

  assert.equal(normalized.shouldUpdatePlan, false);
  assert.equal(normalized.evaluation?.planDecision.shouldUpdatePlan, false);
});

test("keeps automatic update true when the computed evaluation requires it", () => {
  const normalized = normalizeCoachVerdict(
    verdict({ shouldUpdatePlan: false }),
    context({ readinessState: "recovery_needed" }),
    evaluation({ shouldUpdatePlan: true, planDecision: "recovery_first" })
  );

  assert.equal(normalized.shouldUpdatePlan, true);
  assert.equal(normalized.contextState, "recovery_needed");
});

test("keeps nextStep aligned with the computed next action and humanizes watch items", () => {
  const normalized = normalizeCoachVerdict(
    verdict({
      nextStep: "Ignore the computed action.",
      watchItems: ["recent_pain_level_4_or_higher"],
      safetyFlags: ["recent_effort_above_plan"]
    }),
    context({ riskFlags: ["recent_effort_above_plan"] }),
    evaluation({ nextAction: "Rest today and be ready for the next planned session." })
  );

  assert.equal(normalized.nextStep, "Rest today and be ready for the next planned session.");
  assert.deepEqual(normalized.watchItems, ["pain reached 4/10 recently", "Effort has been higher than planned"]);
});

function verdict(overrides: Partial<CoachVerdict> = {}): CoachVerdict {
  return {
    headline: "On track",
    summary: "The current read is steady.",
    latestChange: "Recent effort is stable.",
    recommendation: "Hold the current plan.",
    runningRead: "Running is steady.",
    strengthRead: "Strength is steady.",
    nextStep: "Complete the next planned session.",
    watchItems: [],
    shouldUpdatePlan: false,
    contextState: "building",
    safetyFlags: [],
    ...overrides
  };
}

function context(options: {
  readinessState?: CoachContext["readiness"]["state"];
  riskFlags?: string[];
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
      currentPartialMonth: month("2026-06", true),
      lastFullMonth: month("2026-05", false),
      previousFullMonth: month("2026-04", false),
      twoFullMonthTrend: {
        pullUpsDelta: null,
        pushUpsDelta: null,
        plankSecondsDelta: null,
        logCountDelta: 0,
        label: "insufficient_history"
      },
      bestRecentTests: { pullUps: 5, pushUps: 20, plankSeconds: 60 }
    },
    adherence: {
      planned: 4,
      due: 2,
      future: 2,
      completed: 2,
      partial: 0,
      missed: 0,
      deload: 0,
      pending: 0,
      adherenceScorePct: 100
    },
    plannedWork: {
      todaySessions: [],
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

function evaluation(options: {
  shouldUpdatePlan?: boolean;
  planDecision?: CoachEvaluation["planDecision"]["action"];
  nextAction?: string;
} = {}): CoachEvaluation & { snapshot: CoachSnapshot } {
  const shouldUpdatePlan = options.shouldUpdatePlan ?? false;
  const planDecision = options.planDecision ?? (shouldUpdatePlan ? "update_plan" : "keep_plan");
  const nextAction = options.nextAction ?? "Complete the next planned session as written and log the result.";
  return {
    status: shouldUpdatePlan ? "watch" : "on_track",
    statusLabel: shouldUpdatePlan ? "Watch" : "On track",
    adherence: {
      standardPct: 80,
      band: "on_track",
      completedPct: 100,
      dueSessions: 2,
      completedSessions: 2,
      partialSessions: 0,
      deloadSessions: 0,
      missedSessions: 0,
      futureSessionsExcluded: 2,
      rationale: "2 of 2 due sessions are complete."
    },
    readiness: {
      state: "building",
      painOrFatigueFlag: false,
      hrvGate: null,
      trainingReadiness: null,
      riskFlags: [],
      rationale: "No readiness gate is blocking normal work."
    },
    progress: {
      state: "not_enough_data",
      trendLabel: "insufficient_history",
      flatGoalMetrics: [],
      rationale: "Not enough clean history yet."
    },
    planDecision: {
      action: planDecision,
      shouldUpdatePlan,
      rationale: "Computed evaluation owns the plan decision."
    },
    nextAction,
    snapshot: {
      version: 1,
      generatedAt: "2026-06-28T12:00:00.000Z",
      status: shouldUpdatePlan ? "watch" : "on_track",
      statusLabel: shouldUpdatePlan ? "Watch" : "On track",
      adherencePct: 100,
      readinessState: "building",
      planDecision,
      shouldUpdatePlan,
      nextAction,
      facts: ["Adherence 100%"]
    }
  };
}

function month(monthName: string, isPartial: boolean): CoachContext["history"]["currentPartialMonth"] {
  return {
    month: monthName,
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
