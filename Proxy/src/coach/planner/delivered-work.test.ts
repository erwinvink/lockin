import assert from "node:assert/strict";
import test from "node:test";
import { deliveredVsPlanned, describeDelivered, didMoreThanPlanned, overDeliveryMargin } from "./delivered-work";
import type { PlannedExercisePrescription, TrainingLog } from "./types";

// The athlete's complaint: an easy session asked for 10 push-ups, he did 38 and
// honestly rated it hard, and the coach read that as "too hard, make it easier".
// The coach has to compare the effort with the work actually delivered.

test("doing clearly more than planned needs a margin of 2 reps or 10%, and 5 s or 10% on a plank", () => {
  assert.equal(overDeliveryMargin("pushUps", 10), 2);
  assert.equal(overDeliveryMargin("pushUps", 30), 3);
  assert.equal(overDeliveryMargin("pullUps", 5), 2);
  assert.equal(overDeliveryMargin("plankSeconds", 30), 5);
  assert.equal(overDeliveryMargin("plankSeconds", 90), 9);
});

test("38 push-ups against an easy 10 is more than planned, even when the 10 was light technique work", () => {
  const entries = deliveredVsPlanned(log({ pushUps: 38, loggedPushUps: true }), [
    prescription("pushUp", 10, "light", "technique")
  ]);

  assert.deepEqual(entries, [{ metric: "pushUps", planned: 10, delivered: 38, delta: 28, overDelivered: true, shortfall: false }]);
});

test("the plan to compare with is the session's highest target of that exercise", () => {
  const entries = deliveredVsPlanned(log({ pushUps: 21, loggedPushUps: true }), [
    prescription("pushUp", 12, "medium", "volume"),
    prescription("pushUp", 20, "hard", "strength")
  ]);

  assert.equal(entries[0].planned, 20);
  assert.equal(entries[0].overDelivered, false);
});

test("a metric without a planned target is not compared", () => {
  assert.deepEqual(deliveredVsPlanned(log({ pushUps: 30, loggedPushUps: true }), [prescription("pullUp", 5, "hard", "strength")]), []);
  assert.deepEqual(deliveredVsPlanned(log({ pushUps: 30, loggedPushUps: true }), [prescription("pushUp", 30, "max_output", "test")]), []);
});

test("did more than planned: at least one goal metric clearly above the plan and none below it", () => {
  const easyPush = [prescription("pushUp", 10, "medium", "volume"), prescription("pullUp", 5, "medium", "volume")];

  assert.equal(didMoreThanPlanned(deliveredVsPlanned(log({ pushUps: 38, loggedPushUps: true, pullUps: 5, loggedPullUps: true }), easyPush)), true);
  assert.equal(didMoreThanPlanned(deliveredVsPlanned(log({ pushUps: 38, loggedPushUps: true, pullUps: 4, loggedPullUps: true }), easyPush)), false);
  assert.equal(didMoreThanPlanned(deliveredVsPlanned(log({ pushUps: 11, loggedPushUps: true, pullUps: 5, loggedPullUps: true }), easyPush)), false);
  assert.equal(didMoreThanPlanned([]), false);
});

// Review finding: a max test plus easy back-off sets logs the test result as
// the best set; comparing it with the back-off target read a test as "did
// more than planned". A metric the session tests is not compared.
test("a metric the session tests is not compared with its back-off sets", () => {
  const entries = deliveredVsPlanned(log({ pushUps: 42, loggedPushUps: true }), [
    prescription("pushUp", 40, "max_output", "test"),
    prescription("pushUp", 10, "light", "technique")
  ]);

  assert.deepEqual(entries, []);
});

test("planks compare seconds with a 5 s or 10% margin", () => {
  const plank = (planned: number, delivered: number) =>
    deliveredVsPlanned(log({ plankSeconds: delivered, loggedPlankSeconds: true }), [prescription("plank", planned, "medium", "volume")])[0];

  assert.equal(plank(30, 35).overDelivered, true);
  assert.equal(plank(30, 34).overDelivered, false);
  assert.equal(plank(90, 98).overDelivered, false);
  assert.equal(plank(90, 99).overDelivered, true);
  assert.equal(plank(60, 55).shortfall, true);
});

test("delivered work is described in plain words with units", () => {
  const entry = (metric: "pullUps" | "pushUps" | "plankSeconds", planned: number, delivered: number) =>
    ({ metric, planned, delivered, delta: delivered - planned, overDelivered: true, shortfall: false });

  assert.equal(describeDelivered(entry("pushUps", 10, 38)), "38 push-ups against 10 planned");
  assert.equal(describeDelivered(entry("pullUps", 5, 7)), "7 pull-ups against 5 planned");
  assert.equal(describeDelivered(entry("plankSeconds", 30, 45)), "45 s plank against 30 s planned");
});

function prescription(
  exercise: PlannedExercisePrescription["exercise"],
  target: number,
  label: NonNullable<PlannedExercisePrescription["plannedEffortLabel"]>,
  stimulus: NonNullable<PlannedExercisePrescription["plannedEffortStimulus"]>
): PlannedExercisePrescription {
  return {
    exercise,
    sets: 2,
    targetReps: exercise === "plank" ? 0 : target,
    targetSeconds: exercise === "plank" ? target : 0,
    plannedEffortLabel: label,
    plannedEffortStimulus: stimulus
  };
}

function log(overrides: Partial<TrainingLog>): TrainingLog {
  return {
    sessionId: "session",
    completedAt: "2026-11-10T17:00:00Z",
    pullUps: 0,
    pushUps: 0,
    plankSeconds: 0,
    loggedPullUps: false,
    loggedPushUps: false,
    loggedPlankSeconds: false,
    rpe: 8,
    painLevel: 0,
    fatigueLevel: 3,
    notes: "",
    ...overrides
  };
}
