import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { GarminSyncStore } from "./garmin-sync-store";
import { getGarminSyncStatus, retryGarminSync, submitGarminSyncPlan } from "./garmin-sync";

const workout = {
  sessionId: "session-1",
  title: "Tempo run",
  date: "2026-06-16",
  kind: "tempo",
  distanceKm: 8,
  durationMinutes: 45,
  target: { type: "hr", low: 150, high: 162 },
  notes: "Z3"
};

test("Garmin sync deletes stale workouts before creating replacements", async (t) => {
  const store = await tempStore(t);
  const calls: string[] = [];

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    staleWorkoutIds: ["old-1"],
    workouts: [workout]
  }, {
    deleteWorkouts: async (ids, _fetch, options) => {
      calls.push(`delete:${options?.userId}:${ids.join(",")}`);
      return { results: ids.map((workoutId) => ({ workoutId: String(workoutId), deleted: true, error: null })) };
    },
    pushWorkouts: async (workouts, _fetch, options) => {
      calls.push(`push:${options?.userId}:${workouts.length}`);
      return { results: [{ sessionId: "session-1", garminWorkoutId: "new-1", scheduled: true, error: null }] };
    }
  });

  assert.deepEqual(calls, ["delete:user-1:old-1", "push:user-1:1"]);
  assert.equal(response.status, "synced");
  assert.equal(response.workouts[0]?.garminWorkoutId, "new-1");

  const persisted = await getGarminSyncStatus(store, "user-1");
  assert.equal(persisted.status, "synced");
  assert.equal(persisted.workouts[0]?.status, "synced");
});

test("Garmin sync blocks replacement creation when stale delete fails", async (t) => {
  const store = await tempStore(t);
  let pushCalls = 0;

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    staleWorkoutIds: ["old-1"],
    workouts: [workout]
  }, {
    deleteWorkouts: async (ids) => ({
      results: ids.map((workoutId) => ({ workoutId: String(workoutId), deleted: false, error: "Garmin service timed out." }))
    }),
    pushWorkouts: async () => {
      pushCalls += 1;
      return { results: [] };
    }
  });

  assert.equal(pushCalls, 0);
  assert.equal(response.status, "blocked_on_delete");
  assert.equal(response.pendingDeleteCount, 1);
  assert.equal(response.workouts[0]?.status, "blocked_on_delete");
});

test("Garmin sync is idempotent for an already synced unchanged session", async (t) => {
  const store = await tempStore(t);
  let pushCalls = 0;

  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    workouts: [workout]
  }, {
    deleteWorkouts: async () => ({ results: [] }),
    pushWorkouts: async () => {
      pushCalls += 1;
      return { results: [{ sessionId: "session-1", garminWorkoutId: "new-1", scheduled: true, error: null }] };
    }
  });

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    workouts: [workout]
  }, {
    deleteWorkouts: async () => ({ results: [] }),
    pushWorkouts: async () => {
      pushCalls += 1;
      return { results: [] };
    }
  });

  assert.equal(pushCalls, 1);
  assert.equal(response.status, "synced");
  assert.equal(response.workouts[0]?.garminWorkoutId, "new-1");
});

test("Garmin sync retry replays failed pending workouts", async (t) => {
  const store = await tempStore(t);

  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    workouts: [workout]
  }, {
    deleteWorkouts: async () => ({ results: [] }),
    pushWorkouts: async () => ({ results: [], error: "Garmin service is not reachable." })
  });

  const retry = await retryGarminSync(store, "user-1", {
    deleteWorkouts: async () => ({ results: [] }),
    pushWorkouts: async () => ({
      results: [{ sessionId: "session-1", garminWorkoutId: "new-1", scheduled: true, error: null }]
    })
  });

  assert.equal(retry.status, "synced");
  assert.equal(retry.workouts[0]?.garminWorkoutId, "new-1");
});

test("replan on a run day keeps today's watch workout (D0)", async (t) => {
  const store = await tempStore(t);
  const deleted: string[] = [];
  const deps = recordingDeps(deleted, { "run-sat": "100", "run-mon": "101", "run-wed": "102" });

  // Friday evening: Saturday's and Monday's runs are pushed to the watch.
  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-fri",
    lockedThroughDate: "2026-06-12",
    workouts: [runOn("run-sat", "2026-06-13"), runOn("run-mon", "2026-06-15")]
  }, { ...deps, now: () => new Date("2026-06-12T18:00:00Z") });

  // Saturday morning: the new plan is applied. The app only sends runs from
  // tomorrow on, because today is locked.
  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-sat",
    lockedThroughDate: "2026-06-13",
    workouts: [runOn("run-mon", "2026-06-15"), runOn("run-wed", "2026-06-17")]
  }, { ...deps, now: () => new Date("2026-06-13T06:00:00Z") });

  assert.deepEqual(deleted, []);
  const today = response.workouts.find((workout) => workout.sessionId === "run-sat");
  assert.equal(today?.status, "synced");
  assert.equal(today?.garminWorkoutId, "100");
});

test("without lockedThroughDate, today in Amsterdam stays protected (D0, old clients)", async (t) => {
  const store = await tempStore(t);
  const deleted: string[] = [];
  const deps = recordingDeps(deleted, { "run-sat": "100", "run-mon": "101" });

  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-fri",
    workouts: [runOn("run-sat", "2026-06-13"), runOn("run-mon", "2026-06-15")]
  }, { ...deps, now: () => new Date("2026-06-12T18:00:00Z") });

  // 00:30 on Saturday in Amsterdam is still Friday in UTC.
  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-sat",
    workouts: [runOn("run-mon", "2026-06-15")]
  }, { ...deps, now: () => new Date("2026-06-12T22:30:00Z") });

  assert.deepEqual(deleted, []);
});

test("explicit stale ids and dropped future runs are still deleted (D0)", async (t) => {
  const store = await tempStore(t);
  const deleted: string[] = [];
  const deps = recordingDeps(deleted, { "run-sat": "100", "run-mon": "101", "run-tue": "103" });

  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-fri",
    lockedThroughDate: "2026-06-12",
    workouts: [runOn("run-sat", "2026-06-13"), runOn("run-mon", "2026-06-15")]
  }, { ...deps, now: () => new Date("2026-06-12T18:00:00Z") });

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-sat",
    lockedThroughDate: "2026-06-13",
    staleWorkoutIds: ["100"],
    workouts: [runOn("run-tue", "2026-06-16")]
  }, { ...deps, now: () => new Date("2026-06-13T06:00:00Z") });

  assert.deepEqual(deleted.sort(), ["100", "101"]);
  // The record whose workout was explicitly deleted no longer claims to be on the watch.
  assert.deepEqual(response.workouts.map((workout) => workout.sessionId), ["run-tue"]);
});

test("past runs leave the sync state without being deleted from Garmin; today's stays (D0)", async (t) => {
  const store = await tempStore(t);
  const deleted: string[] = [];
  const pushed: string[] = [];
  const deps = {
    deleteWorkouts: async (ids: unknown[]) => {
      deleted.push(...ids.map(String));
      return { results: ids.map((workoutId) => ({ workoutId: String(workoutId), deleted: true, error: null })) };
    },
    pushWorkouts: async (workouts: unknown[]) => ({
      results: workouts.map((item) => {
        const sessionId = String((item as { sessionId: string }).sessionId);
        pushed.push(sessionId);
        // Friday's push fails, so it stays pending with no Garmin id.
        return sessionId === "run-fri"
          ? { sessionId, garminWorkoutId: null, scheduled: false, error: "Garmin hiccup" }
          : { sessionId, garminWorkoutId: `id-${sessionId}`, scheduled: true, error: null };
      })
    })
  };

  await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-wed",
    lockedThroughDate: "2026-06-10",
    workouts: [runOn("run-thu", "2026-06-11"), runOn("run-fri", "2026-06-12"), runOn("run-sat", "2026-06-13")]
  }, { ...deps, now: () => new Date("2026-06-10T18:00:00Z") });
  pushed.length = 0;

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-sat",
    lockedThroughDate: "2026-06-13",
    workouts: [runOn("run-mon", "2026-06-15")]
  }, { ...deps, now: () => new Date("2026-06-13T06:00:00Z") });

  assert.deepEqual(deleted, []);
  assert.deepEqual(pushed, ["run-mon"]);
  assert.deepEqual(response.workouts.map((workout) => workout.sessionId), ["run-sat", "run-mon"]);
  assert.equal(response.status, "synced");
  assert.equal(response.message, "2 runs are on your watch.");
  const persisted = await getGarminSyncStatus(store, "user-1");
  assert.deepEqual(persisted.workouts.map((workout) => workout.sessionId), ["run-sat", "run-mon"]);
});

test("a changed run never adopts the id it is deleting (S3)", async (t) => {
  const store = await tempStore(t);
  const deleted: string[] = [];
  let nextId = 1;
  const deps = {
    deleteWorkouts: async (ids: unknown[]) => {
      deleted.push(...ids.map(String));
      return { results: ids.map((workoutId) => ({ workoutId: String(workoutId), deleted: true, error: null })) };
    },
    pushWorkouts: async (workouts: unknown[]) => ({
      results: workouts.map((item) => ({
        sessionId: String((item as { sessionId: string }).sessionId),
        garminWorkoutId: `new-${nextId++}`,
        scheduled: true,
        error: null
      }))
    }),
    now: () => new Date("2026-06-12T18:00:00Z")
  };

  await submitGarminSyncPlan(store, { userId: "user-1", planRevisionId: "plan-1", workouts: [workout] }, deps);
  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-2",
    workouts: [{ ...workout, distanceKm: 10, existingGarminWorkoutId: "new-1" }]
  }, deps);

  assert.deepEqual(deleted, ["new-1"]);
  assert.equal(response.workouts[0]?.status, "synced");
  assert.equal(response.workouts[0]?.garminWorkoutId, "new-2");
});

test("an unknown session still adopts the app's existing Garmin id", async (t) => {
  const store = await tempStore(t);
  let pushCalls = 0;

  const response = await submitGarminSyncPlan(store, {
    userId: "user-1",
    planRevisionId: "plan-1",
    workouts: [{ ...workout, existingGarminWorkoutId: "legacy-9" }]
  }, {
    deleteWorkouts: async () => ({ results: [] }),
    pushWorkouts: async () => {
      pushCalls += 1;
      return { results: [] };
    },
    now: () => new Date("2026-06-12T18:00:00Z")
  });

  assert.equal(pushCalls, 0);
  assert.equal(response.workouts[0]?.garminWorkoutId, "legacy-9");
});

function runOn(sessionId: string, date: string) {
  return { ...workout, sessionId, title: `Run ${sessionId}`, date };
}

function recordingDeps(deleted: string[], idsBySession: Record<string, string>) {
  return {
    deleteWorkouts: async (ids: unknown[]) => {
      deleted.push(...ids.map(String));
      return { results: ids.map((workoutId) => ({ workoutId: String(workoutId), deleted: true, error: null })) };
    },
    pushWorkouts: async (workouts: unknown[]) => ({
      results: workouts.map((item) => {
        const sessionId = String((item as { sessionId: string }).sessionId);
        return { sessionId, garminWorkoutId: idsBySession[sessionId] ?? null, scheduled: true, error: null };
      })
    })
  };
}

async function tempStore(t: test.TestContext): Promise<GarminSyncStore> {
  const dir = await mkdtemp(join(tmpdir(), "lockin-garmin-sync-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return new GarminSyncStore(join(dir, "state.json"));
}
