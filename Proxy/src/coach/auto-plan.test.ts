import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AutoPlanStore,
  markAutoPlanGenerated,
  prepareAutoPlanTrigger,
  type AutoPlanSource
} from "./auto-plan";
import type { CoachRequest } from "./planner/types";

test("manual trigger always forces generation", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);

  const decision = await store.updateUser("user-1", (user) => {
    return prepareAutoPlanTrigger(user, {
      source: "manual",
      force: true,
      timeZone: "Europe/Amsterdam",
      request: requestFixture()
    }, new Date("2026-06-13T10:00:00Z"));
  });

  assert.equal(decision.action, "generate");
  assert.equal(decision.localDate, "2026-06-13");
});

test("app active stores context and queues the next local nightly run", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);

  const decision = await store.updateUser("user-1", (user) => {
    return prepareAutoPlanTrigger(user, {
      source: "app_active",
      timeZone: "Europe/Amsterdam",
      request: requestFixture()
    }, new Date("2026-06-13T10:00:00Z"));
  });

  assert.equal(decision.action, "queue");
  assert.equal(decision.nextNightlyRunAt, "2026-06-13T23:30:00.000Z");
});

test("nightly trigger runs once per local day for the same context", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  const request = requestFixture();
  const first = await decide(store, "nightly", request, new Date("2026-06-13T23:45:00Z"));
  assert.equal(first.action, "generate");

  await store.updateUser("user-1", (user) => {
    markAutoPlanGenerated(user, first, { weekStart: request.weekStart, summary: "Done", strengthWeek: weekFixture() });
  });

  const second = await decide(store, "nightly", request, new Date("2026-06-13T23:50:00Z"));
  assert.equal(second.action, "skip");
});

test("post-training skips normal completion and generates for high-risk feedback", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);

  const normal = await decide(store, "post_training", requestFixture({
    trainingLogs: [{ ...logFixture(), rpe: 6, painLevel: 0, fatigueLevel: 4, rpeDelta: 0 }]
  }), new Date("2026-06-13T18:00:00Z"));
  assert.equal(normal.action, "skip");

  const hard = await decide(store, "post_training", requestFixture({
    trainingLogs: [{ ...logFixture(), rpe: 9, painLevel: 4, fatigueLevel: 9, rpeDelta: 3 }]
  }), new Date("2026-06-13T19:00:00Z"));
  assert.equal(hard.action, "generate");

  await store.updateUser("user-1", (user) => {
    markAutoPlanGenerated(user, hard, { weekStart: "2026-06-13T00:00:00.000Z", summary: "Adjusted", strengthWeek: weekFixture() });
  });

  const repeated = await decide(store, "post_training", requestFixture({
    trainingLogs: [{ ...logFixture(), id: "log-2", rpe: 10, painLevel: 5, fatigueLevel: 10, rpeDelta: 4 }]
  }), new Date("2026-06-13T20:00:00Z"));
  assert.equal(repeated.action, "skip");
});

async function decide(store: AutoPlanStore, source: AutoPlanSource, request: CoachRequest, now: Date) {
  return await store.updateUser("user-1", (user) => {
    return prepareAutoPlanTrigger(user, { source, timeZone: "Europe/Amsterdam", request }, now);
  });
}

async function testStore(): Promise<{ store: AutoPlanStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "lockin-auto-plan-"));
  return {
    store: new AutoPlanStore(join(dir, "state.json")),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function requestFixture(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    userId: "user-1",
    model: "gpt-5-mini",
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 10, pushUps: 40, plankSeconds: 180 },
    profileNotes: "",
    weekStart: "2026-06-13T00:00:00.000Z",
    weeklySessions: 3,
    trainingDays: ["monday", "wednesday", "friday"],
    trainingDayOffsets: [1, 3, 5],
    equipment: ["pullUpBar"],
    targetDate: "2026-09-01T00:00:00.000Z",
    trainingLogs: [logFixture()],
    plannedSessions: [
      { id: "today", scheduledDate: "2026-06-13T08:00:00.000Z", title: "Today", focus: "pull", status: "completed" },
      { id: "future", scheduledDate: "2026-06-14T08:00:00.000Z", title: "Future", focus: "push", status: "planned" }
    ],
    ...overrides
  };
}

function logFixture() {
  return {
    id: "log-1",
    sessionId: "today",
    completedAt: "2026-06-13T09:00:00.000Z",
    pullUps: 5,
    pushUps: 20,
    plankSeconds: 60,
    loggedPullUps: true,
    loggedPushUps: true,
    loggedPlankSeconds: true,
    rpe: 6,
    painLevel: 0,
    fatigueLevel: 4,
    rpeDelta: 0,
    notes: ""
  };
}

function weekFixture() {
  return {
    summary: "A safe week.",
    contextState: "building" as const,
    safetyFlags: [],
    sessions: []
  };
}
