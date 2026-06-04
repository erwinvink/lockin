import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import type { CoachRequest, TrainingLog } from "./types";

test("keeps insufficient history when both completed-month and current evidence are sparse", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "insufficient_history");
  assert.ok(context.readiness.riskFlags.includes("insufficient_training_history"));
});

test("uses current-month logs as early evidence for building when readiness is clear", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 7, fatigueLevel: 2 }),
      trainingLog("2026-05-11T10:00:00Z", { rpe: 7, fatigueLevel: 5 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "building");
  assert.ok(!context.readiness.riskFlags.includes("insufficient_training_history"));
});

test("carries profile notes and recent workout notes into the context", () => {
  const request = baseRequest({
    profileNotes: "Left elbow feels sensitive after high pull volume.",
    trainingLogs: [
      trainingLog("2026-04-04T10:00:00Z", { notes: "Easy session." }),
      trainingLog("2026-04-11T10:00:00Z", { notes: "Shoulder tight near the end." }),
      trainingLog("2026-03-18T10:00:00Z", { notes: "Grip felt stable." })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.profile.profileNotes, "Left elbow feels sensitive after high pull volume.");
  assert.ok(context.history.last5Logs.some((log) => log.notes === "Shoulder tight near the end."));
});

test("adds Garmin-style self-evaluation labels to recent logs", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 8, fatigueLevel: 8 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));
  const latestLog = context.history.last5Logs.at(-1);

  assert.equal(latestLog?.perceivedEffort, 8);
  assert.equal(latestLog?.howYouFeltScore, 2);
  assert.equal(latestLog?.howYouFelt, "weak");
});

function baseRequest(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    model: "gpt-5-mini",
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-05-25T00:00:00Z",
    weeklySessions: 4,
    equipment: ["pullUpBar"],
    targetDate: "2027-05-25T00:00:00Z",
    trainingLogs: [],
    plannedSessions: [],
    ...overrides
  };
}

function trainingLog(completedAt: string, overrides: Partial<TrainingLog> = {}): TrainingLog {
  return {
    sessionId: `session-${completedAt}`,
    completedAt,
    pullUps: 5,
    pushUps: 20,
    plankSeconds: 60,
    loggedPullUps: true,
    loggedPushUps: true,
    loggedPlankSeconds: true,
    rpe: 7,
    painLevel: 0,
    fatigueLevel: 5,
    notes: "",
    ...overrides
  };
}
