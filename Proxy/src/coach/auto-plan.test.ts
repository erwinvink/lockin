import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  AutoPlanStore,
  markAutoPlanFailed,
  markAutoPlanGenerated,
  prepareAutoPlanTrigger,
  refreshRequestForNightly,
  runDueAutoPlans,
  type AutoPlanSource,
  type AutoPlanTrigger
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

test("post-training replans for a clean push-up best of 20 matched to 17", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  const request = matchedPushRequest([
    { ...logFixture(), sessionId: "push-17", completedAt: "2026-06-13T09:00:00.000Z", pushUps: 20 }
  ]);

  const decision = await decide(store, "post_training", request, new Date("2026-06-13T18:00:00Z"));

  assert.equal(decision.action, "generate");
});

test("one exact clean completion holds and the second triggers progression planning", async (t) => {
  const firstStore = await testStore();
  t.after(firstStore.cleanup);
  const oneCompletion = matchedPushRequest([
    { ...logFixture(), sessionId: "push-a", completedAt: "2026-06-12T09:00:00.000Z", pushUps: 17 }
  ], ["push-a"]);

  const first = await decide(firstStore.store, "post_training", oneCompletion, new Date("2026-06-13T18:00:00Z"));
  assert.equal(first.action, "skip");

  const secondStore = await testStore();
  t.after(secondStore.cleanup);
  const twoCompletions = matchedPushRequest([
    { ...logFixture(), id: "log-a", sessionId: "push-a", completedAt: "2026-06-11T09:00:00.000Z", pushUps: 17 },
    { ...logFixture(), id: "log-b", sessionId: "push-b", completedAt: "2026-06-12T09:00:00.000Z", pushUps: 17 }
  ], ["push-a", "push-b"]);

  const second = await decide(secondStore.store, "post_training", twoCompletions, new Date("2026-06-13T18:00:00Z"));
  assert.equal(second.action, "generate");
});

test("training fingerprint includes logged goal values and field flags", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  await decide(store, "app_active", requestFixture({
    trainingLogs: [{ ...logFixture(), pushUps: 17 }]
  }), new Date("2026-06-13T10:00:00Z"));
  const before = (await store.read()).users["user-1"].latestTrainingHash;

  await decide(store, "app_active", requestFixture({
    trainingLogs: [{ ...logFixture(), pushUps: 20 }]
  }), new Date("2026-06-13T10:05:00Z"));
  const after = (await store.read()).users["user-1"].latestTrainingHash;

  assert.notEqual(before, after);
});

test("nightly refresh reanchors stale dates and recomputes rolling offsets", () => {
  const request = requestFixture({
    weekStart: "2026-07-01T00:00:00.000Z",
    trainingDays: ["monday", "wednesday", "friday"],
    trainingDayOffsets: [1, 3, 5],
    plannedSessions: [
      { id: "expired", scheduledDate: "2026-07-02T08:00:00.000Z", title: "Expired", focus: "push", status: "planned" },
      { id: "history", scheduledDate: "2026-07-02T08:00:00.000Z", title: "History", focus: "push", status: "completed" },
      { id: "future", scheduledDate: "2026-07-15T08:00:00.000Z", title: "Future", focus: "push", status: "planned" }
    ],
    running: {
      raceGoal: { name: "Race", raceDate: "2026-09-01T00:00:00.000Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40,
      longestRecentRunKm: 20,
      runningDays: ["tuesday", "thursday", "saturday"],
      runningDayOffsets: [1, 3, 5],
      longRunDay: "saturday",
      longRunDayOffset: 5,
      recentRuns: []
    }
  });

  const refreshed = refreshRequestForNightly(request, new Date("2026-07-13T10:00:00Z"), "Europe/Amsterdam");

  assert.equal(refreshed.weekStart, "2026-07-12T22:00:00.000Z");
  assert.equal(refreshed.timeZone, "Europe/Amsterdam");
  assert.deepEqual(refreshed.trainingDayOffsets, [2, 4]);
  assert.deepEqual(refreshed.running?.runningDayOffsets, [1, 3, 5]);
  assert.equal(refreshed.running?.longRunDayOffset, 5);
  assert.deepEqual(refreshed.plannedSessions.map((session) => session.id), ["history", "future"]);
});

test("nightly refresh keeps local midnight and weekday offsets correct across DST", () => {
  const spring = refreshRequestForNightly(
    requestFixture({ trainingDays: ["monday", "sunday"] }),
    new Date("2026-03-29T10:00:00Z"),
    "Europe/Amsterdam"
  );
  const autumn = refreshRequestForNightly(
    requestFixture({ trainingDays: ["monday", "sunday"] }),
    new Date("2026-10-25T10:00:00Z"),
    "Europe/Amsterdam"
  );

  assert.equal(spring.weekStart, "2026-03-28T23:00:00.000Z");
  assert.deepEqual(spring.trainingDayOffsets, [1]);
  assert.equal(autumn.weekStart, "2026-10-24T22:00:00.000Z");
  assert.deepEqual(autumn.trainingDayOffsets, [1]);
});

test("app active catches up a nightly run that was missed (S8a)", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);

  const evening = await decide(store, "app_active", requestFixture(), new Date("2026-06-13T10:00:00Z"));
  assert.equal(evening.action, "queue");

  // The proxy was down at 01:30; the app opens at 08:00 local the next day.
  const morning = await decide(store, "app_active", requestFixture(), new Date("2026-06-14T06:00:00Z"));

  assert.equal(morning.action, "generate");
  assert.equal(morning.message, "Catching up the overnight plan refresh.");
  assert.equal(morning.nextNightlyRunAt, "2026-06-14T23:30:00.000Z");
});

test("scheduler retries a failed plan once nextRetryAt has passed (S8b)", async (t) => {
  const { store, cleanup } = await testStore(() => new Date("2026-06-13T12:00:00Z"));
  t.after(cleanup);
  await decide(store, "post_training", requestFixture({
    trainingLogs: [{ ...logFixture(), rpe: 9, painLevel: 4, fatigueLevel: 9, rpeDelta: 3 }]
  }), new Date("2026-06-13T11:00:00Z"));
  await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", new Date("2026-06-13T11:00:00Z")));

  const triggers: AutoPlanTrigger[] = [];
  await runDueAutoPlans({ store, runTrigger: async (trigger) => { triggers.push(trigger); } });

  assert.equal(triggers.length, 1);
  assert.equal(triggers[0]?.source, "post_training");
  assert.equal(triggers[0]?.force, true);
  assert.equal(triggers[0]?.retry, true);
  assert.equal(triggers[0]?.request.weekStart, "2026-06-12T22:00:00.000Z");
});

test("scheduler waits for nextRetryAt before retrying (S8b)", async (t) => {
  const { store, cleanup } = await testStore(() => new Date("2026-06-13T11:10:00Z"));
  t.after(cleanup);
  await decide(store, "manual", requestFixture(), new Date("2026-06-13T11:00:00Z"));
  await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", new Date("2026-06-13T11:00:00Z")));

  const triggers: AutoPlanTrigger[] = [];
  await runDueAutoPlans({ store, runTrigger: async (trigger) => { triggers.push(trigger); } });

  assert.equal(triggers.length, 0);
});

test("scheduler recovers a user stuck in generating after a restart (S8c)", async (t) => {
  const { store, cleanup } = await testStore(() => new Date("2026-06-13T11:31:00Z"));
  t.after(cleanup);
  await decide(store, "manual", requestFixture(), new Date("2026-06-13T11:00:00Z"));
  assert.equal((await store.read()).users["user-1"].status, "generating");

  const triggers: AutoPlanTrigger[] = [];
  await runDueAutoPlans({ store, runTrigger: async (trigger) => { triggers.push(trigger); } });

  const user = (await store.read()).users["user-1"];
  assert.equal(user.status, "retrying");
  assert.match(user.lastError ?? "", /interrupted/);
  assert.equal(triggers.length, 0);
});

test("scheduler leaves a generation that is still running alone (S8c)", async (t) => {
  // 25 minutes in: past the old 15-minute cutoff, but a generation can make
  // four OpenAI calls of up to five minutes each, so it may still be live.
  const { store, cleanup } = await testStore(() => new Date("2026-06-13T11:25:00Z"));
  t.after(cleanup);
  await decide(store, "manual", requestFixture(), new Date("2026-06-13T11:00:00Z"));

  await runDueAutoPlans({ store, runTrigger: async () => { throw new Error("must not run"); } });

  assert.equal((await store.read()).users["user-1"].status, "generating");
});

test("a new night's plan gets a fresh retry budget after a failed day", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  const failAt = new Date("2026-06-13T00:00:00Z");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", failAt));
  }
  assert.equal((await store.read()).users["user-1"].status, "failed");

  const nightly = await decide(store, "nightly", requestFixture(), new Date("2026-06-13T23:35:00Z"));
  assert.equal(nightly.action, "generate");
  await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", new Date("2026-06-13T23:40:00Z")));

  const user = (await store.read()).users["user-1"];
  assert.equal(user.failureCount, 1);
  assert.equal(user.status, "retrying");
});

test("a scheduled retry keeps counting toward the same retry budget", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  await decide(store, "manual", requestFixture(), new Date("2026-06-13T11:00:00Z"));
  await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", new Date("2026-06-13T11:00:00Z")));

  await store.updateUser("user-1", (user) => prepareAutoPlanTrigger(user, {
    source: "manual",
    force: true,
    retry: true,
    timeZone: "Europe/Amsterdam",
    request: requestFixture()
  }, new Date("2026-06-13T11:31:00Z")));

  assert.equal((await store.read()).users["user-1"].failureCount, 1);
});

test("opening the app during a retry window keeps the pending retry", async (t) => {
  const { store, cleanup } = await testStore();
  t.after(cleanup);
  await decide(store, "manual", requestFixture(), new Date("2026-06-13T11:00:00Z"));
  await store.updateUser("user-1", (user) => markAutoPlanFailed(user, "OpenAI timed out", new Date("2026-06-13T11:00:00Z")));
  const before = (await store.read()).users["user-1"];

  const decision = await decide(store, "app_active", requestFixture(), new Date("2026-06-13T11:10:00Z"));

  const after = (await store.read()).users["user-1"];
  assert.equal(decision.action, "queue");
  assert.equal(after.status, "retrying");
  assert.equal(after.nextRetryAt, before.nextRetryAt);
});

test("an unreadable state file never rejects the scheduler tick (S1)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lockin-auto-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  await mkdir(statePath); // reading a directory fails with EISDIR
  const store = new AutoPlanStore(statePath);
  const logged: string[] = [];

  await runDueAutoPlans({ store, runTrigger: async () => undefined, log: (message) => logged.push(message) });

  assert.equal(logged.length, 1);
});

test("a corrupt state file reads as empty and is kept as a backup (S1)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "lockin-auto-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, '{"version":1,"users":{', "utf8");
  const store = new AutoPlanStore(statePath);

  const state = await store.read();
  await store.read();

  assert.deepEqual(state, { version: 1, users: {} });
  // Moved aside once, not copied again on every read.
  const names = await readdir(dir);
  const backups = names.filter((name) => name.startsWith("state.json.corrupt-"));
  assert.equal(backups.length, 1);
  assert.ok(!names.includes("state.json"));
  assert.equal(await readFile(join(dir, backups[0] ?? ""), "utf8"), '{"version":1,"users":{');
});

async function decide(store: AutoPlanStore, source: AutoPlanSource, request: CoachRequest, now: Date) {
  return await store.updateUser("user-1", (user) => {
    return prepareAutoPlanTrigger(user, { source, timeZone: "Europe/Amsterdam", request }, now);
  });
}

async function testStore(now?: () => Date): Promise<{ store: AutoPlanStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "lockin-auto-plan-"));
  return {
    store: new AutoPlanStore(join(dir, "state.json"), { now }),
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function requestFixture(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    userId: "user-1",
    model: "gpt-6.1-sol",
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
    plannedRPE: 6,
    actualRPE: 6,
    painLevel: 0,
    fatigueLevel: 4,
    rpeDelta: 0,
    notes: ""
  };
}

function matchedPushRequest(
  logs: ReturnType<typeof logFixture>[],
  sessionIds: string[] = ["push-17"]
): CoachRequest {
  return requestFixture({
    trainingLogs: logs,
    plannedSessions: [
      ...sessionIds.map((id, index) => ({
        id,
        scheduledDate: `2026-06-${String(11 + index).padStart(2, "0")}T08:00:00.000Z`,
        title: "Push standard",
        focus: "push" as const,
        status: "completed",
        exercises: [{
          exercise: "pushUp" as const,
          sets: 3,
          targetReps: 17,
          targetSeconds: 0,
          plannedEffortLabel: "hard" as const,
          plannedEffortStimulus: "strength" as const
        }]
      })),
      { id: "future", scheduledDate: "2026-06-14T08:00:00.000Z", title: "Future", focus: "push", status: "planned" }
    ]
  });
}

function weekFixture() {
  return {
    summary: "A safe week.",
    contextState: "building" as const,
    safetyFlags: [],
    sessions: []
  };
}
