import type { GarminWellnessDay } from "../coach/planner/types";

export type { GarminWellnessDay };

export type GarminStatus = {
  ok: boolean;
  loggedIn: boolean;
  lastError: string | null;
};

export type GarminActivity = {
  garminActivityId: string;
  startTime: string;
  activityType: string;
  distanceKm: number;
  movingSeconds: number;
  elevationGainM: number;
  averageHr: number;
  averagePaceSecPerKm: number;
  name: string;
};

export type GarminPushResult = {
  sessionId: string;
  garminWorkoutId: string | null;
  scheduled: boolean;
  error: string | null;
};

export type GarminDeleteResult = {
  workoutId: string;
  deleted: boolean;
  error: string | null;
};

export type GarminSnapshot = {
  status: GarminStatus;
  wellness: GarminWellnessDay[];
  activities: GarminActivity[];
};

export type GarminPushResponse = { results: GarminPushResult[]; error?: string };
export type GarminDeleteResponse = { results: GarminDeleteResult[]; error?: string };

type SidecarResult = { ok: true; data: unknown } | { ok: false; error: string };

const unreachableError = "Garmin service is not reachable.";

export async function garminStatus(fetchImpl: typeof fetch = fetch): Promise<GarminStatus> {
  const result = await requestJSON("/status", fetchImpl);
  if (!result.ok) {
    return { ok: false, loggedIn: false, lastError: result.error };
  }

  const data = (result.data ?? {}) as Partial<GarminStatus>;
  return {
    ok: data.ok === true,
    loggedIn: data.loggedIn === true,
    lastError: typeof data.lastError === "string" ? data.lastError : null
  };
}

export async function garminSnapshot(sinceDays = 7, fetchImpl: typeof fetch = fetch): Promise<GarminSnapshot> {
  const days = Number.isFinite(sinceDays) ? sinceDays : 7;
  // The sidecar serializes Garmin calls internally, so firing these in
  // parallel is safe and saves a round trip.
  const [status, wellness, activities] = await Promise.all([
    garminStatus(fetchImpl),
    requestJSON(`/wellness?days=${clamp(days, 1, 30)}`, fetchImpl),
    requestJSON(`/activities?days=${clamp(days, 1, 60)}`, fetchImpl)
  ]);

  const failures = [...new Set([wellness, activities].flatMap((result) => (result.ok ? [] : [result.error])))];

  return {
    status: failures.length === 0 ? status : { ok: false, loggedIn: status.loggedIn, lastError: failures.join(" ") },
    wellness: wellness.ok ? asArray<GarminWellnessDay>(wellness.data) : [],
    activities: activities.ok ? asArray<GarminActivity>(activities.data) : []
  };
}

export async function pushWorkouts(workouts: unknown[], fetchImpl: typeof fetch = fetch): Promise<GarminPushResponse> {
  const result = await requestJSON("/workouts/push", fetchImpl, postInit({ workouts }));
  if (!result.ok) {
    return { results: [], error: result.error };
  }
  return { results: extractResults<GarminPushResult>(result.data) };
}

export async function deleteWorkouts(workoutIds: unknown[], fetchImpl: typeof fetch = fetch): Promise<GarminDeleteResponse> {
  if (workoutIds.length === 0) {
    return { results: [] };
  }

  const result = await requestJSON("/workouts/delete", fetchImpl, postInit({ workoutIds }));
  if (!result.ok) {
    return { results: [], error: result.error };
  }
  return { results: extractResults<GarminDeleteResult>(result.data) };
}

function serviceBaseURL(): string {
  return (process.env.GARMIN_SERVICE_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
}

async function requestJSON(path: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<SidecarResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${serviceBaseURL()}${path}`, init);
  } catch {
    return { ok: false, error: unreachableError };
  }

  if (!response.ok) {
    return { ok: false, error: `Garmin service returned HTTP ${response.status} for ${path}.` };
  }

  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, error: `Garmin service returned invalid JSON for ${path}.` };
  }
}

function postInit(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  };
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(Math.floor(value), high));
}

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

// The sidecar returns a bare result array today; the documented contract wraps
// it as {results}. Accept both so neither side breaks the other.
function extractResults<T>(data: unknown): T[] {
  if (Array.isArray(data)) {
    return data as T[];
  }
  const wrapped = (data as { results?: unknown } | null)?.results;
  return Array.isArray(wrapped) ? (wrapped as T[]) : [];
}
