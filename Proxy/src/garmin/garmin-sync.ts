import { createHash } from "node:crypto";
import { deleteWorkouts, pushWorkouts, type GarminDeleteResponse, type GarminPushResponse, type GarminRequestOptions } from "./garmin-client";
import {
  GarminSyncStore,
  type GarminDeleteSyncRecord,
  type GarminSyncOperationStatus,
  type GarminSyncWorkoutPayload,
  type GarminUserSyncState,
  type GarminWorkoutSyncRecord
} from "./garmin-sync-store";

export type GarminSyncPlanRequest = {
  userId: string;
  planRevisionId: string;
  staleWorkoutIds?: unknown[];
  workouts?: unknown[];
};

export type GarminSyncWorkoutStatus = {
  sessionId: string;
  status: GarminSyncOperationStatus;
  garminWorkoutId: string | null;
  error: string | null;
  pushedAt: string | null;
};

export type GarminSyncPlanResponse = {
  userId: string;
  planRevisionId: string | null;
  status: GarminUserSyncState["status"];
  message: string;
  workouts: GarminSyncWorkoutStatus[];
  pendingDeleteCount: number;
  failedDeleteCount: number;
  nextRetryAt: string | null;
  lastError: string | null;
};

type GarminSyncDeps = {
  pushWorkouts: (workouts: unknown[], fetchImpl?: typeof fetch, options?: GarminRequestOptions) => Promise<GarminPushResponse>;
  deleteWorkouts: (workoutIds: unknown[], fetchImpl?: typeof fetch, options?: GarminRequestOptions) => Promise<GarminDeleteResponse>;
  now: () => Date;
};

const defaultDeps: GarminSyncDeps = {
  pushWorkouts,
  deleteWorkouts,
  now: () => new Date()
};

export async function submitGarminSyncPlan(
  store: GarminSyncStore,
  request: GarminSyncPlanRequest,
  deps: Partial<GarminSyncDeps> = {}
): Promise<GarminSyncPlanResponse> {
  const resolved = { ...defaultDeps, ...deps };
  const userId = cleanId(request.userId);
  const planRevisionId = cleanId(request.planRevisionId);
  if (!userId || !planRevisionId) {
    throw new GarminSyncInputError("userId and planRevisionId are required");
  }

  const workouts = asWorkouts(request.workouts ?? []);
  const staleWorkoutIds = asWorkoutIds(request.staleWorkoutIds ?? []);

  return store.updateUser(userId, async (user) => {
    user.planRevisionId = planRevisionId;
    user.status = "syncing";
    user.lastError = null;

    mergePlanIntoState(user, planRevisionId, workouts, staleWorkoutIds, resolved.now());
    await advanceSyncState(user, resolved);
    summarizeUser(user);
  }).then(toResponse);
}

export async function retryGarminSync(
  store: GarminSyncStore,
  userIdInput: string,
  deps: Partial<GarminSyncDeps> = {}
): Promise<GarminSyncPlanResponse> {
  const resolved = { ...defaultDeps, ...deps };
  const userId = cleanId(userIdInput);
  if (!userId) {
    throw new GarminSyncInputError("userId is required");
  }

  return store.updateUser(userId, async (user) => {
    for (const record of [...Object.values(user.workouts), ...Object.values(user.deletes)]) {
      if (record.status === "failed" || record.status === "retrying" || record.status === "blocked_on_delete") {
        record.status = "pending";
        record.nextRetryAt = null;
        record.lastError = null;
      }
    }
    user.status = "syncing";
    user.lastError = null;
    await advanceSyncState(user, resolved);
    summarizeUser(user);
  }).then(toResponse);
}

export async function getGarminSyncStatus(store: GarminSyncStore, userIdInput: string): Promise<GarminSyncPlanResponse> {
  const userId = cleanId(userIdInput);
  if (!userId) {
    throw new GarminSyncInputError("userId is required");
  }

  const state = await store.read();
  const user = state.users[userId] ?? emptyUser(userId, new Date().toISOString());
  summarizeUser(user);
  return toResponse(user);
}

function mergePlanIntoState(
  user: GarminUserSyncState,
  planRevisionId: string,
  workouts: GarminSyncWorkoutPayload[],
  staleWorkoutIds: string[],
  nowDate: Date
): void {
  const now = nowDate.toISOString();
  for (const workoutId of staleWorkoutIds) {
    addDelete(user, workoutId, now);
  }

  const desiredSessionIds = new Set(workouts.map((workout) => workout.sessionId));
  for (const record of Object.values(user.workouts)) {
    if (!desiredSessionIds.has(record.sessionId) && record.garminWorkoutId) {
      addDelete(user, record.garminWorkoutId, now);
      record.status = "deleted";
      record.updatedAt = now;
    }
  }

  for (const workout of workouts) {
    const contentHash = workoutContentHash(workout);
    const existing = user.workouts[workout.sessionId];
    if (existing?.contentHash === contentHash && existing.status === "synced" && existing.garminWorkoutId) {
      existing.payload = workout;
      existing.updatedAt = now;
      continue;
    }

    if (existing?.garminWorkoutId && existing.contentHash !== contentHash) {
      addDelete(user, existing.garminWorkoutId, now);
    }

    const adoptedGarminId = cleanId(workout.existingGarminWorkoutId ?? "") || null;
    user.workouts[workout.sessionId] = {
      sessionId: workout.sessionId,
      contentHash,
      payload: workout,
      status: adoptedGarminId ? "synced" : "pending",
      garminWorkoutId: adoptedGarminId,
      attempts: existing?.attempts ?? 0,
      lastError: null,
      nextRetryAt: null,
      pushedAt: adoptedGarminId ? existing?.pushedAt ?? now : null,
      updatedAt: now
    };
  }

  user.planRevisionId = planRevisionId;
}

async function advanceSyncState(user: GarminUserSyncState, deps: GarminSyncDeps): Promise<void> {
  await drainDeletes(user, deps);
  const blockingDeletes = Object.values(user.deletes).filter((record) => record.status !== "deleted");
  if (blockingDeletes.length > 0) {
    const now = deps.now().toISOString();
    for (const workout of Object.values(user.workouts)) {
      if (workout.status !== "synced" && workout.status !== "deleted") {
        workout.status = "blocked_on_delete";
        workout.lastError = "Waiting for old Garmin workouts to be removed before replacement is created.";
        workout.updatedAt = now;
      }
    }
    return;
  }

  await pushPendingWorkouts(user, deps);
}

async function drainDeletes(user: GarminUserSyncState, deps: GarminSyncDeps): Promise<void> {
  const dueDeletes = Object.values(user.deletes).filter((record) => isDue(record, deps.now()));
  if (dueDeletes.length === 0) {
    return;
  }

  const ids = dueDeletes.map((record) => record.workoutId);
  const response = await deps.deleteWorkouts(ids, fetch, { userId: user.userId });
  if (response.error) {
    for (const record of dueDeletes) {
      markRetry(record, response.error, deps.now());
    }
    return;
  }

  const byId = new Map(response.results.map((result) => [result.workoutId, result]));
  for (const record of dueDeletes) {
    const result = byId.get(record.workoutId);
    if (result?.deleted) {
      record.status = "deleted";
      record.lastError = null;
      record.nextRetryAt = null;
      record.updatedAt = deps.now().toISOString();
    } else {
      markRetry(record, result?.error ?? "Garmin delete did not return a result.", deps.now());
    }
  }
}

async function pushPendingWorkouts(user: GarminUserSyncState, deps: GarminSyncDeps): Promise<void> {
  const dueWorkouts = Object.values(user.workouts).filter((record) => {
    return record.status !== "synced" && record.status !== "deleted" && isDue(record, deps.now());
  });
  if (dueWorkouts.length === 0) {
    return;
  }

  const response = await deps.pushWorkouts(dueWorkouts.map((record) => record.payload), fetch, { userId: user.userId });
  if (response.error) {
    for (const record of dueWorkouts) {
      markRetry(record, response.error, deps.now());
    }
    return;
  }

  applyPushResponse(user, dueWorkouts, response, deps.now());
}

function applyPushResponse(
  user: GarminUserSyncState,
  dueWorkouts: GarminWorkoutSyncRecord[],
  response: GarminPushResponse,
  nowDate: Date
): void {
  const now = nowDate.toISOString();
  const bySession = new Map(response.results.map((result) => [result.sessionId, result]));
  for (const record of dueWorkouts) {
    const result = bySession.get(record.sessionId);
    if (result?.scheduled && result.garminWorkoutId) {
      record.status = "synced";
      record.garminWorkoutId = result.garminWorkoutId;
      record.pushedAt = now;
      record.lastError = null;
      record.nextRetryAt = null;
      record.updatedAt = now;
      continue;
    }

    if (result?.garminWorkoutId) {
      addDelete(user, result.garminWorkoutId, now);
    }
    markRetry(record, result?.error ?? "Garmin push did not return a scheduled workout.", nowDate);
  }
}

function addDelete(user: GarminUserSyncState, workoutId: string, now: string): void {
  const cleanWorkoutId = cleanId(workoutId);
  if (!cleanWorkoutId) {
    return;
  }
  const existing = user.deletes[cleanWorkoutId];
  if (existing?.status === "deleted") {
    return;
  }
  user.deletes[cleanWorkoutId] = existing ?? {
    workoutId: cleanWorkoutId,
    status: "pending",
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    createdAt: now,
    updatedAt: now
  };
}

function markRetry(
  record: GarminWorkoutSyncRecord | GarminDeleteSyncRecord,
  error: string,
  nowDate: Date
): void {
  const now = nowDate.toISOString();
  record.attempts += 1;
  record.status = record.attempts >= 3 ? "failed" : "retrying";
  record.lastError = error;
  record.nextRetryAt = new Date(nowDate.getTime() + retryDelayMs(record.attempts)).toISOString();
  record.updatedAt = now;
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60 * 1000, 2 ** Math.max(0, attempts - 1) * 60 * 1000);
}

function isDue(
  record: GarminWorkoutSyncRecord | GarminDeleteSyncRecord,
  nowDate: Date
): boolean {
  if (record.status === "synced" || record.status === "deleted") {
    return false;
  }
  return !record.nextRetryAt || Date.parse(record.nextRetryAt) <= nowDate.getTime();
}

function summarizeUser(user: GarminUserSyncState): void {
  const pendingDeletes = Object.values(user.deletes).filter((record) => record.status !== "deleted");
  const workouts = Object.values(user.workouts).filter((record) => record.status !== "deleted");
  const failed = [...pendingDeletes, ...workouts].filter((record) => record.status === "failed");
  const retrying = [...pendingDeletes, ...workouts].filter((record) => record.status === "retrying");
  const blocked = workouts.filter((record) => record.status === "blocked_on_delete");

  if (pendingDeletes.length > 0 && blocked.length > 0) {
    user.status = "blocked_on_delete";
    user.lastError = "Old Garmin workouts must be removed before replacements can be created.";
  } else if (failed.length > 0) {
    user.status = "failed";
    user.lastError = failed[0]?.lastError ?? "Garmin sync failed.";
  } else if (retrying.length > 0) {
    user.status = "retrying";
    user.lastError = retrying[0]?.lastError ?? "Garmin sync will retry.";
  } else if (workouts.every((record) => record.status === "synced")) {
    user.status = "synced";
    user.lastError = null;
  } else {
    user.status = "syncing";
    user.lastError = null;
  }
}

function toResponse(user: GarminUserSyncState): GarminSyncPlanResponse {
  const workouts = Object.values(user.workouts)
    .filter((record) => record.status !== "deleted")
    .sort((a, b) => a.payload.date.localeCompare(b.payload.date))
    .map((record) => ({
      sessionId: record.sessionId,
      status: record.status,
      garminWorkoutId: record.garminWorkoutId,
      error: record.lastError,
      pushedAt: record.pushedAt
    }));
  const deletes = Object.values(user.deletes);
  const nextRetryAt = [...Object.values(user.workouts), ...deletes]
    .flatMap((record) => (record.nextRetryAt ? [record.nextRetryAt] : []))
    .sort()[0] ?? null;

  return {
    userId: user.userId,
    planRevisionId: user.planRevisionId,
    status: user.status,
    message: messageFor(user),
    workouts,
    pendingDeleteCount: deletes.filter((record) => record.status !== "deleted").length,
    failedDeleteCount: deletes.filter((record) => record.status === "failed").length,
    nextRetryAt,
    lastError: user.lastError
  };
}

function messageFor(user: GarminUserSyncState): string {
  const workouts = Object.values(user.workouts).filter((record) => record.status !== "deleted");
  const syncedCount = workouts.filter((record) => record.status === "synced").length;
  switch (user.status) {
    case "synced":
      return syncedCount === 0
        ? "No future runs need Garmin."
        : `${syncedCount} ${syncedCount === 1 ? "run is" : "runs are"} on your watch.`;
    case "blocked_on_delete":
      return "Replacing Garmin workouts after old ones are removed.";
    case "retrying":
      return "Garmin sync hit a snag and will retry.";
    case "failed":
      return "Garmin sync needs attention.";
    case "syncing":
      return "Syncing planned runs to Garmin.";
    case "idle":
      return "Garmin watch sync is idle.";
  }
}

function asWorkouts(value: unknown[]): GarminSyncWorkoutPayload[] {
  return value.map((item) => normalizeWorkout(item)).filter((item): item is GarminSyncWorkoutPayload => item !== null);
}

function normalizeWorkout(value: unknown): GarminSyncWorkoutPayload | null {
  if (!isRecord(value)) {
    return null;
  }
  const sessionId = cleanId(value.sessionId);
  const title = cleanString(value.title);
  const date = cleanString(value.date);
  if (!sessionId || !title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return null;
  }
  const target = isRecord(value.target) ? value.target : {};
  return {
    sessionId,
    title,
    date,
    kind: cleanString(value.kind),
    distanceKm: finiteNumber(value.distanceKm),
    durationMinutes: Math.max(0, Math.round(finiteNumber(value.durationMinutes))),
    target: {
      type: cleanString(target.type),
      low: Math.round(finiteNumber(target.low)),
      high: Math.round(finiteNumber(target.high))
    },
    notes: cleanString(value.notes),
    existingGarminWorkoutId: cleanId(value.existingGarminWorkoutId ?? "") || null
  };
}

function asWorkoutIds(value: unknown[]): string[] {
  return [...new Set(value.map(cleanId).filter((id) => id.length > 0))];
}

function workoutContentHash(workout: GarminSyncWorkoutPayload): string {
  const { existingGarminWorkoutId: _unused, ...hashable } = workout;
  return createHash("sha256").update(JSON.stringify(hashable)).digest("hex");
}

function emptyUser(userId: string, now: string): GarminUserSyncState {
  return {
    userId,
    provider: "sidecar",
    planRevisionId: null,
    status: "idle",
    lastError: null,
    updatedAt: now,
    workouts: {},
    deletes: {}
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanId(value: unknown): string {
  return cleanString(value).slice(0, 200);
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GarminSyncInputError extends Error {}
