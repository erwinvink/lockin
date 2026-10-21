import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGarminRouteHandler } from "./garmin-routes";
import { GarminSyncStore } from "./garmin-sync-store";

const APP_USER_ID = "8B059341-1C2D-4E5F-8A9B-0123456789AB";

async function startRoutes(t: test.TestContext, sidecarCalls: string[]) {
  const dir = await mkdtemp(join(tmpdir(), "lockin-garmin-routes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    sidecarCalls.push(url);
    let body: unknown = [];
    if (url.includes("/status") || url.includes("/connect") || url.includes("/disconnect")) {
      body = { ok: true, loggedIn: true, lastError: null };
    } else if (url.includes("/wellness")) {
      body = [{
        date: "2026-06-10",
        sleepScore: 0,
        sleepSeconds: 0,
        hrvStatus: "BALANCED",
        hrvMs: 52,
        bodyBattery: 70,
        trainingReadiness: 55,
        restingHr: 47,
        unavailableMetrics: ["sleepScore", "sleepSeconds"]
      }];
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const handler = createGarminRouteHandler({
    syncStore: new GarminSyncStore(join(dir, "sync.json")),
    fetchImpl,
    syncDeps: {
      pushWorkouts: async (workouts) => {
        sidecarCalls.push(`push:${workouts.length}`);
        return { results: [] };
      },
      deleteWorkouts: async (ids) => {
        sidecarCalls.push(`delete:${ids.join(",")}`);
        return { results: [] };
      }
    }
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(404).end();
    }
  });
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("Garmin routes reject a missing or blank userId instead of using the default account (S5)", async (t) => {
  const sidecarCalls: string[] = [];
  const baseURL = await startRoutes(t, sidecarCalls);

  const responses = await Promise.all([
    fetch(`${baseURL}/garmin/status`),
    fetch(`${baseURL}/garmin/status?userId=%20%20`),
    fetch(`${baseURL}/garmin/snapshot?sinceDays=7`),
    fetch(`${baseURL}/garmin/sync-status`),
    post(`${baseURL}/garmin/connect`, { email: "a@b.c", password: "x" }),
    post(`${baseURL}/garmin/disconnect`, {}),
    post(`${baseURL}/garmin/sync-plan`, { planRevisionId: "p1", workouts: [] }),
    post(`${baseURL}/garmin/retry-sync`, { userId: "" }),
    post(`${baseURL}/garmin/push-workouts`, { workouts: [] }),
    post(`${baseURL}/garmin/delete-workouts`, { workoutIds: ["1"] })
  ]);

  for (const response of responses) {
    assert.equal(response.status, 400, response.url);
    assert.match(((await response.json()) as { error: string }).error, /userId/);
  }
  assert.deepEqual(sidecarCalls, []);
});

test("Garmin routes only accept the app's UUID-shaped user ids (path traversal)", async (t) => {
  const sidecarCalls: string[] = [];
  const baseURL = await startRoutes(t, sidecarCalls);

  for (const userId of ["..", ".", "a/b", "../x", "user-1", `${APP_USER_ID}/..`, `${APP_USER_ID}x`]) {
    const query = encodeURIComponent(userId);
    const responses = await Promise.all([
      fetch(`${baseURL}/garmin/status?userId=${query}`),
      fetch(`${baseURL}/garmin/snapshot?userId=${query}`),
      post(`${baseURL}/garmin/disconnect`, { userId }),
      post(`${baseURL}/garmin/connect`, { userId, email: "a@b.c", password: "x" })
    ]);
    assert.deepEqual(responses.map((response) => response.status), [400, 400, 400, 400], userId);
  }
  assert.deepEqual(sidecarCalls, []);

  for (const userId of [APP_USER_ID, APP_USER_ID.toLowerCase()]) {
    const response = await fetch(`${baseURL}/garmin/status?userId=${userId}`);
    assert.equal(response.status, 200, userId);
  }
});

test("Garmin snapshot passes the user's id and unavailableMetrics through (S2/S5)", async (t) => {
  const sidecarCalls: string[] = [];
  const baseURL = await startRoutes(t, sidecarCalls);

  const response = await fetch(`${baseURL}/garmin/snapshot?sinceDays=7&userId=${APP_USER_ID}`);
  const body = await response.json() as { wellness: Array<{ unavailableMetrics?: string[] }> };

  assert.equal(response.status, 200);
  assert.deepEqual(body.wellness[0]?.unavailableMetrics, ["sleepScore", "sleepSeconds"]);
  assert.ok(sidecarCalls.every((url) => url.includes(`userId=${APP_USER_ID}`)));
});

test("Garmin sync-plan accepts lockedThroughDate from the app (D0)", async (t) => {
  const sidecarCalls: string[] = [];
  const baseURL = await startRoutes(t, sidecarCalls);

  const response = await post(`${baseURL}/garmin/sync-plan`, {
    userId: APP_USER_ID,
    planRevisionId: "plan-1",
    lockedThroughDate: "2026-06-13",
    workouts: []
  });

  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { status: string }).status, "synced");
});

test("non-Garmin paths are left to the next handler", async (t) => {
  const baseURL = await startRoutes(t, []);
  assert.equal((await fetch(`${baseURL}/health`)).status, 404);
});

test("Garmin routes answer invalid JSON with 400 and bodies over 2 MB with 413", async (t) => {
  const calls: string[] = [];
  const baseURL = await startRoutes(t, calls);

  const invalid = await fetch(`${baseURL}/garmin/disconnect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{\"userId\":" });
  assert.equal(invalid.status, 400);
  assert.match(((await invalid.json()) as { error: string }).error, /valid JSON/);

  assert.equal(await postDeclaringHugeBody(`${baseURL}/garmin/sync-plan`), 413);
  assert.deepEqual(calls, [], "nothing reached the sidecar");
});

/** Declares a body over 2 MB without sending it, so the 413 can be read without a write race. */
function postDeclaringHugeBody(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { "content-type": "application/json", "content-length": String(3 * 1024 * 1024) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.flushHeaders();
  });
}
