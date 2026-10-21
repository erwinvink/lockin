import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import type { CoachRequest } from "./types";

function request(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    model: "test-model",
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-10-21T22:00:00.000Z",
    weeklySessions: 4,
    trainingDays: ["monday", "wednesday", "friday", "saturday"],
    trainingDayOffsets: [1, 3, 5],
    equipment: ["pullUpBar"],
    targetDate: "2027-10-21T22:00:00.000Z",
    trainingLogs: [],
    plannedSessions: [],
    ...overrides
  };
}

test("passes the plan block start through and counts the week in the block", () => {
  const now = new Date("2026-10-22T08:00:00Z");
  const weekInBlock = (planBlockStartedAt: string) =>
    buildCoachContext(request({ planBlockStartedAt }), now).block?.weekInBlock;

  assert.deepEqual(buildCoachContext(request({ planBlockStartedAt: "2026-10-07T22:00:00.000Z" }), now).block, {
    startedAt: "2026-10-07T22:00:00.000Z",
    weekInBlock: 3
  });
  // Started today, six days ago, seven days ago.
  assert.equal(weekInBlock("2026-10-21T22:00:00.000Z"), 1);
  assert.equal(weekInBlock("2026-10-15T22:00:00.000Z"), 1);
  assert.equal(weekInBlock("2026-10-14T22:00:00.000Z"), 2);
  // A DST change inside the block (23-hour day) still counts whole days.
  assert.equal(weekInBlock("2026-10-14T23:00:00.000Z"), 2);
  // A start after the planned week (clock skew) is still week 1.
  assert.equal(weekInBlock("2026-10-25T22:00:00.000Z"), 1);
});

test("leaves the block out when the app sent no readable block start", () => {
  const now = new Date("2026-10-22T08:00:00Z");

  assert.equal("block" in buildCoachContext(request(), now), false);
  assert.equal("block" in buildCoachContext(request({ planBlockStartedAt: "not a date" }), now), false);
});
