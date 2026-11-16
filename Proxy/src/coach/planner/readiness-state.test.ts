import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import { readinessStateAt } from "./readiness-state";
import type { CoachRequest, TrainingLog } from "./types";

const AT = new Date("2026-05-11T01:30:00.000Z");

function request(logs: TrainingLog[]): CoachRequest {
  return {
    model: "test-model",
    baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
    goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-05-12T00:00:00.000Z",
    weeklySessions: 3,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar"],
    targetDate: "2027-05-11T00:00:00Z",
    trainingLogs: logs,
    plannedSessions: []
  };
}

function painLog(completedAt: string): TrainingLog {
  return {
    sessionId: `log-${completedAt}`, completedAt, pullUps: 8, pushUps: 30, plankSeconds: 90,
    loggedPullUps: true, loggedPushUps: true, loggedPlankSeconds: true, rpe: 7, painLevel: 5, fatigueLevel: 5, notes: ""
  };
}

// The state when the current plan was made (current-plan.ts) is recomputed
// from the logs up to and including that moment; a later log is left out.
test("a log exactly at the cutoff counts; one a millisecond after it does not", () => {
  const adherence = buildCoachContext(request([]), AT).adherence;

  assert.equal(readinessStateAt(request([painLog(AT.toISOString())]), AT, adherence), "recovery_needed");
  assert.notEqual(readinessStateAt(request([painLog(new Date(AT.getTime() + 1).toISOString())]), AT, adherence), "recovery_needed");
});
