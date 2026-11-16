import assert from "node:assert/strict";
import test from "node:test";
import { cleanCompletion, effortAbovePlan, effortReadiness, goalMetricsTrained, highEffortOffPlan, plannedRPEOf, testsAGoal } from "./effort-flags";
import type { PlannedExercisePrescription, TrainingLog } from "./types";

// Effort judged against the plan: near-max ratings count only on work planned
// below very_hard, and tests or clearly-more-than-planned sessions never count.
const push = (label: PlannedExercisePrescription["plannedEffortLabel"], target = 24, stimulus: PlannedExercisePrescription["plannedEffortStimulus"] = "strength"): PlannedExercisePrescription[] =>
  [{ exercise: "pushUp", sets: stimulus === "test" ? 1 : 3, targetReps: target, targetSeconds: 0, plannedEffortLabel: label, plannedEffortStimulus: stimulus }];

function log(overrides: Partial<TrainingLog> = {}): TrainingLog {
  return {
    sessionId: "s", completedAt: "2026-11-10T17:00:00Z", pullUps: 0, pushUps: 24, plankSeconds: 0,
    loggedPullUps: false, loggedPushUps: true, loggedPlankSeconds: false, rpe: 9, painLevel: 0, fatigueLevel: 5, notes: "",
    ...overrides
  };
}

test("the planned RPE comes from the log, its label, the session's hardest label, else 7", () => {
  assert.equal(plannedRPEOf(log({ plannedRPE: 6 }), push("very_hard")), 6);
  assert.equal(plannedRPEOf(log({ plannedEffortLabel: "very_hard" }), push("hard")), 9);
  assert.equal(plannedRPEOf(log(), push("very_hard")), 9);
  assert.equal(plannedRPEOf(log(), undefined), 7);
});

test("RPE 9 counts as high effort only on work planned below very_hard, never on a test or more than planned", () => {
  assert.equal(highEffortOffPlan(log({ plannedRPE: 7 }), push("hard")), true);
  assert.equal(highEffortOffPlan(log({ plannedRPE: 9 }), push("very_hard")), false, "very_hard rated as planned");
  assert.equal(highEffortOffPlan(log({ rpe: 10, plannedRPE: 10, pushUps: 42 }), push("max_output", 40, "test")), false, "a test");
  assert.equal(highEffortOffPlan(log({ plannedRPE: 7, pushUps: 30 }), push("hard")), false, "30 against 24 planned is more than planned");
  assert.equal(highEffortOffPlan(log(), undefined), true, "an unknown plan reads as a normal hard set");
  assert.equal(testsAGoal(push("max_output", 40, "test")), true);
});

test("effort above plan needs a planned RPE and 2 or more above it", () => {
  assert.equal(effortAbovePlan(log({ rpe: 8, plannedRPE: 6 }), push("medium")), true);
  assert.equal(effortAbovePlan(log({ rpe: 8, plannedRPE: 7 }), push("hard")), false);
  assert.equal(effortAbovePlan(log({ rpe: 8 }), push("medium")), false, "no planned RPE: not planned work");
  assert.deepEqual(goalMetricsTrained(log(), push("hard")), ["pushUps"]);
  assert.deepEqual(goalMetricsTrained(log({ loggedPushUps: false }), push("hard")), ["pushUps"], "the session's plan when nothing was logged");
});

// Code review M8: effortReadiness on its own, with the 14-day window of the
// second marker and the block start that limits "completed cleanly before".
// Code review M2: its reasons read as plain sentences.
const NOW = new Date("2026-11-13T09:00:00Z");
const plans: Record<string, PlannedExercisePrescription[]> = {
  push: push("medium", 24, "volume"),
  plank: [{ exercise: "plank", sets: 3, targetReps: 0, targetSeconds: 60, plannedEffortLabel: "medium", plannedEffortStimulus: "volume" }]
};
const planOf = (entry: TrainingLog) => plans[entry.sessionId];
const pushLog = (completedAt: string, overrides: Partial<TrainingLog> = {}) =>
  log({ sessionId: "push", completedAt, rpe: 6, plannedRPE: 6, ...overrides });
const aboveAt = (completedAt: string, overrides: Partial<TrainingLog> = {}) => pushLog(completedAt, { rpe: 8, ...overrides });

test("the second marker counts only within 14 days", () => {
  const weekOf = (weakAt: string) => [pushLog(weakAt, { fatigueLevel: 8 }), aboveAt("2026-11-04T17:00:00Z", { fatigueLevel: 8 }), aboveAt("2026-11-10T17:00:00Z")];

  const outside = effortReadiness(weekOf("2026-10-30T08:00:00Z"), planOf, NOW);
  assert.equal(outside.overreaching, null, "one weak rating inside the window");
  assert.deepEqual(outside.calibration?.metrics, ["pushUps"]);

  const inside = effortReadiness(weekOf("2026-10-30T10:00:00Z"), planOf, NOW);
  assert.equal(inside.overreaching, "2 recent sessions done as planned were rated 2 or more above plan, and 2 recent sessions were rated weak or very weak, within the last 14 days.");
  assert.equal(inside.calibration, null);
});

test("a target completed cleanly before counts only from the plan block's start", () => {
  const logs = [pushLog("2026-10-31T17:00:00Z"), aboveAt("2026-11-04T17:00:00Z"), aboveAt("2026-11-08T17:00:00Z"), pushLog("2026-11-10T17:00:00Z", { pushUps: 23 })];

  const anyTime = effortReadiness(logs, planOf, NOW);
  assert.equal(anyTime.overreaching, "2 recent sessions done as planned were rated 2 or more above plan, and a target completed cleanly before fell short (23 push-ups against 24 planned), within the last 14 days.");
  const sinceBlock = effortReadiness(logs, planOf, NOW, Date.parse("2026-11-01T00:00:00Z"));
  assert.equal(sinceBlock.overreaching, null, "the clean 24 was before this block");
});

test("effort that persists reads as one sentence, and a calibration names what holds", () => {
  const persists = effortReadiness([aboveAt("2026-11-04T17:00:00Z"), aboveAt("2026-11-07T17:00:00Z"), aboveAt("2026-11-10T17:00:00Z")], planOf, NOW);
  assert.equal(persists.overreaching, "3 recent sessions done as planned were rated 2 or more above plan within the last 14 days: 3 of the last 5, so it persists.");

  const plankLog = (completedAt: string) => log({ sessionId: "plank", completedAt, loggedPushUps: false, loggedPlankSeconds: true, plankSeconds: 60, rpe: 8, plannedRPE: 6 });
  const plank = effortReadiness([plankLog("2026-11-04T17:00:00Z"), plankLog("2026-11-10T17:00:00Z")], planOf, NOW);
  assert.match(plank.calibration?.reason ?? "", /: plank holds \(no progression, no extra set\) until a later session of it is clearly more than planned, or its working sets are done as planned\./);
  const both = effortReadiness([aboveAt("2026-11-04T17:00:00Z"), plankLog("2026-11-10T17:00:00Z")], planOf, NOW);
  assert.match(both.calibration?.reason ?? "", /: push-ups and plank hold \(no progression, no extra set\), each until a later session of it/);
});

// Final review (probe H3): an unrated session (no valid 1-10 rating in
// actualRPE or rpe) is no clean completion: its effort is unknown.
test("a session without a valid rating is not a clean completion", () => {
  const plan = push("medium", 24, "volume");
  assert.notEqual(cleanCompletion(log({ rpe: 6, plannedRPE: 6 }), plan, "pushUps"), null);
  assert.equal(cleanCompletion(log({ rpe: 0, plannedRPE: 6 }), plan, "pushUps"), null);
  assert.equal(cleanCompletion(log({ rpe: 0, actualRPE: 11, plannedRPE: 6 }), plan, "pushUps"), null);
});
