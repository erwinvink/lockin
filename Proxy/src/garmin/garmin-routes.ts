import type { IncomingMessage, ServerResponse } from "node:http";
import { ClientInputError, parseJSONObjectBody, readRequestBody, RequestBodyTooLargeError } from "../http-body";
import { connectGarmin, deleteWorkouts, disconnectGarmin, garminSnapshot, garminStatus, pushWorkouts } from "./garmin-client";
import {
  GarminSyncInputError,
  getGarminSyncStatus,
  retryGarminSync,
  submitGarminSyncPlan,
  type GarminSyncDeps
} from "./garmin-sync";
import type { GarminSyncStore } from "./garmin-sync-store";

export type GarminRouteDeps = {
  syncStore: GarminSyncStore;
  fetchImpl?: typeof fetch;
  syncDeps?: Partial<GarminSyncDeps>;
};

/**
 * The /garmin/* routes. Every route needs the app's userId: an empty one
 * would make the sidecar fall back to its default (owner) Garmin account, so
 * it is rejected with 400 before anything reaches the sidecar. Returns false
 * for paths it doesn't own.
 */
export function createGarminRouteHandler(deps: GarminRouteDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/garmin/")) {
      return false;
    }
    const route = `${req.method} ${url.pathname}`;

    try {
      switch (route) {
        case "GET /garmin/status":
          writeJSON(res, 200, await garminStatus(fetchImpl, { userId: requireUserId(url.searchParams.get("userId")) }));
          return true;
        case "GET /garmin/snapshot":
          writeJSON(res, 200, await garminSnapshot(sinceDays(url), fetchImpl, { userId: requireUserId(url.searchParams.get("userId")) }));
          return true;
        case "GET /garmin/sync-status":
          writeJSON(res, 200, await getGarminSyncStatus(deps.syncStore, requireUserId(url.searchParams.get("userId"))));
          return true;
        case "POST /garmin/connect": {
          const body = await readJSON(req);
          const userId = requireUserId(body.userId);
          writeJSON(res, 200, await connectGarmin({
            userId,
            email: typeof body.email === "string" ? body.email : "",
            password: typeof body.password === "string" ? body.password : "",
            mfaCode: typeof body.mfaCode === "string" ? body.mfaCode : undefined
          }, fetchImpl));
          return true;
        }
        case "POST /garmin/disconnect": {
          const body = await readJSON(req);
          writeJSON(res, 200, await disconnectGarmin(requireUserId(body.userId), fetchImpl));
          return true;
        }
        case "POST /garmin/sync-plan": {
          const body = await readJSON(req);
          writeJSON(res, 200, await submitGarminSyncPlan(deps.syncStore, {
            ...body,
            userId: requireUserId(body.userId),
            planRevisionId: typeof body.planRevisionId === "string" ? body.planRevisionId : ""
          }, deps.syncDeps));
          return true;
        }
        case "POST /garmin/retry-sync": {
          const body = await readJSON(req);
          writeJSON(res, 200, await retryGarminSync(deps.syncStore, requireUserId(body.userId), deps.syncDeps));
          return true;
        }
        case "POST /garmin/push-workouts": {
          // Legacy route (no app caller); kept user-scoped like the rest.
          const body = await readJSON(req);
          const userId = requireUserId(body.userId);
          if (!Array.isArray(body.workouts)) {
            writeJSON(res, 400, { error: "workouts array is required" });
            return true;
          }
          writeJSON(res, 200, await pushWorkouts(body.workouts, fetchImpl, { userId }));
          return true;
        }
        case "POST /garmin/delete-workouts": {
          // Legacy route (no app caller); kept user-scoped like the rest.
          const body = await readJSON(req);
          const userId = requireUserId(body.userId);
          if (!Array.isArray(body.workoutIds)) {
            writeJSON(res, 400, { error: "workoutIds array is required" });
            return true;
          }
          writeJSON(res, 200, await deleteWorkouts(body.workoutIds, fetchImpl, { userId }));
          return true;
        }
        default:
          return false;
      }
    } catch (error) {
      if (error instanceof GarminSyncInputError) {
        writeJSON(res, 400, { error: error.message });
        return true;
      }
      if (error instanceof ClientInputError) {
        writeJSON(res, 400, { error: error.message });
        return true;
      }
      if (error instanceof RequestBodyTooLargeError) {
        res.setHeader("connection", "close");
        writeJSON(res, 413, { error: error.message });
        return true;
      }
      throw error;
    }
  };
}

// The app always sends its profile UUID (uppercase from iOS). Anything else,
// in particular ".", ".." or "a/b", must never reach the sidecar, which keys
// token directories by this id.
const appUserIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUserId(value: unknown): string {
  const userId = typeof value === "string" ? value.trim() : "";
  if (!userId) {
    throw new GarminSyncInputError("userId is required");
  }
  if (!appUserIdPattern.test(userId)) {
    throw new GarminSyncInputError("userId must be the app's profile UUID");
  }
  return userId;
}

function sinceDays(url: URL): number {
  const raw = url.searchParams.get("sinceDays");
  const parsed = Number(raw);
  return raw !== null && raw.trim() !== "" && Number.isFinite(parsed) ? parsed : 7;
}

/** The JSON object body (empty means {}), capped at 2 MB: 413 above it, 400 for invalid JSON. */
async function readJSON(req: IncomingMessage): Promise<Record<string, unknown>> {
  return parseJSONObjectBody(await readRequestBody(req), { allowEmpty: true });
}

function writeJSON(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}
