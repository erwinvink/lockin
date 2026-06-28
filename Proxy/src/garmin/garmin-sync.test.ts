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

async function tempStore(t: test.TestContext): Promise<GarminSyncStore> {
  const dir = await mkdtemp(join(tmpdir(), "lockin-garmin-sync-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return new GarminSyncStore(join(dir, "state.json"));
}
