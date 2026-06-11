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

export type GarminRequestOptions = { timeoutMs?: number };
export type GarminSnapshotOptions = GarminRequestOptions & {
  includeActivities?: boolean;
  /** Activity lookback in days (default 60, capped 1..60). */
  activityDays?: number;
};

type SidecarResult = { ok: true; data: unknown } | { ok: false; error: string };

const unreachableError = "Garmin service is not reachable.";
const timedOutError = "Garmin service timed out.";

export async function garminStatus(fetchImpl: typeof fetch = fetch, options: GarminRequestOptions = {}): Promise<GarminStatus> {
  const result = await requestJSON("/status", fetchImpl, options.timeoutMs ?? 5_000);
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

export async function garminSnapshot(
  sinceDays = 7,
  fetchImpl: typeof fetch = fetch,
  options: GarminSnapshotOptions = {}
): Promise<GarminSnapshot> {
  const days = Number.isFinite(sinceDays) ? sinceDays : 7;
  // Activities are ONE upstream Garmin call regardless of range (unlike
  // wellness at ~4 calls per day), so a deep window is cheap and gives the
  // coaches real training history instead of a one-week peephole.
  const activityDays = Number.isFinite(options.activityDays ?? NaN) ? (options.activityDays as number) : 60;
  // A cold sidecar cache can serialize ~29 upstream Garmin calls, so the
  // default budget is generous; latency-sensitive callers pass a smaller one.
  const timeoutMs = options.timeoutMs ?? 120_000;
  // The sidecar serializes Garmin calls internally, so firing these in
  // parallel is safe and saves a round trip. The status sub-call shares the
  // snapshot budget because it can queue behind the wellness/activities work.
  const [status, wellness, activities] = await Promise.all([
    garminStatus(fetchImpl, { timeoutMs }),
    requestJSON(`/wellness?days=${clamp(days, 1, 30)}`, fetchImpl, timeoutMs),
    options.includeActivities === false
      ? Promise.resolve<SidecarResult>({ ok: true, data: [] })
      : requestJSON(`/activities?days=${clamp(activityDays, 1, 60)}`, fetchImpl, timeoutMs)
  ]);

  const failures = [...new Set([wellness, activities].flatMap((result) => (result.ok ? [] : [result.error])))];

  return {
    status: failures.length === 0 ? status : { ok: false, loggedIn: status.loggedIn, lastError: failures.join(" ") },
    wellness: wellness.ok ? asArray<GarminWellnessDay>(wellness.data) : [],
    activities: activities.ok ? asArray<GarminActivity>(activities.data) : []
  };
}

export async function pushWorkouts(
  workouts: unknown[],
  fetchImpl: typeof fetch = fetch,
  options: GarminRequestOptions = {}
): Promise<GarminPushResponse> {
  const result = await requestJSON("/workouts/push", fetchImpl, options.timeoutMs ?? 60_000, postInit({ workouts }));
  if (!result.ok) {
    return { results: [], error: result.error };
  }
  return extractResults<GarminPushResult>(result.data);
}

export async function deleteWorkouts(
  workoutIds: unknown[],
  fetchImpl: typeof fetch = fetch,
  options: GarminRequestOptions = {}
): Promise<GarminDeleteResponse> {
  if (workoutIds.length === 0) {
    return { results: [] };
  }

  const result = await requestJSON("/workouts/delete", fetchImpl, options.timeoutMs ?? 60_000, postInit({ workoutIds }));
  if (!result.ok) {
    return { results: [], error: result.error };
  }
  return extractResults<GarminDeleteResult>(result.data);
}

function serviceBaseURL(): string {
  return (process.env.GARMIN_SERVICE_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
}

async function requestJSON(path: string, fetchImpl: typeof fetch, timeoutMs: number, init?: RequestInit): Promise<SidecarResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    // Pass the signal so a real fetch aborts its socket, and race the abort
    // event explicitly so the budget holds even if the fetch implementation
    // ignores the signal (or the connection stalls without erroring).
    response = await new Promise<Response>((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      fetchImpl(`${serviceBaseURL()}${path}`, { ...init, signal }).then(resolve, reject);
    });
  } catch {
    return { ok: false, error: signal.aborted ? timedOutError : unreachableError };
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
// it as {results}. Accept both so neither side breaks the other, and surface
// anything else as an explicit error instead of silently dropping it.
function extractResults<T>(data: unknown): { results: T[]; error?: string } {
  if (Array.isArray(data)) {
    return { results: data as T[] };
  }
  const wrapped = (data as { results?: unknown } | null)?.results;
  if (Array.isArray(wrapped)) {
    return { results: wrapped as T[] };
  }
  return { results: [], error: "Garmin service returned an unrecognized shape." };
}
