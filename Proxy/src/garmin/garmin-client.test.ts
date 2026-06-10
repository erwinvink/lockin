import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { deleteWorkouts, garminSnapshot, garminStatus, pushWorkouts } from "./garmin-client";

type RecordedCall = { url: string; init?: RequestInit };

const onlineStatus = { ok: true, loggedIn: true, lastError: null };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  calls?: RecordedCall[]
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls?.push({ url, init });
    return handler(url, init);
  };
}

function failingFetch(): typeof fetch {
  return async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:8788");
  };
}

function useServiceURL(t: TestContext, value: string | undefined): void {
  const previous = process.env.GARMIN_SERVICE_URL;
  if (value === undefined) {
    delete process.env.GARMIN_SERVICE_URL;
  } else {
    process.env.GARMIN_SERVICE_URL = value;
  }
  t.after(() => {
    if (previous === undefined) {
      delete process.env.GARMIN_SERVICE_URL;
    } else {
      process.env.GARMIN_SERVICE_URL = previous;
    }
  });
}

function wellnessDay(date: string, trainingReadiness = 55) {
  return {
    date,
    sleepScore: 80,
    sleepSeconds: 27000,
    hrvStatus: "BALANCED",
    hrvMs: 52,
    bodyBattery: 70,
    trainingReadiness,
    restingHr: 47
  };
}

function activity(id: string) {
  return {
    garminActivityId: id,
    startTime: "2026-06-09 07:01:00",
    activityType: "trail_running",
    distanceKm: 12.4,
    movingSeconds: 4521,
    elevationGainM: 410,
    averageHr: 142,
    averagePaceSecPerKm: 365,
    name: "Morning trail"
  };
}

test("garminStatus maps the sidecar status payload through", async (t) => {
  useServiceURL(t, undefined);
  const calls: RecordedCall[] = [];
  const fetchImpl = stubFetch(() => jsonResponse({ ok: true, loggedIn: true, lastError: null }), calls);

  assert.deepEqual(await garminStatus(fetchImpl), { ok: true, loggedIn: true, lastError: null });
  assert.deepEqual(
    calls.map((call) => call.url),
    ["http://127.0.0.1:8788/status"]
  );
});

test("garminStatus reads GARMIN_SERVICE_URL lazily per call", async (t) => {
  useServiceURL(t, "http://garmin.test:9999");
  const calls: RecordedCall[] = [];
  const fetchImpl = stubFetch(() => jsonResponse({ ok: true, loggedIn: false, lastError: "MFA required" }), calls);

  assert.deepEqual(await garminStatus(fetchImpl), { ok: true, loggedIn: false, lastError: "MFA required" });
  assert.equal(calls[0]?.url, "http://garmin.test:9999/status");
});

test("garminStatus degrades instead of throwing when the sidecar is unreachable", async (t) => {
  useServiceURL(t, undefined);

  assert.deepEqual(await garminStatus(failingFetch()), {
    ok: false,
    loggedIn: false,
    lastError: "Garmin service is not reachable."
  });
});

test("garminStatus degrades on a non-200 response and mentions the HTTP status", async (t) => {
  useServiceURL(t, undefined);
  const status = await garminStatus(stubFetch(() => jsonResponse({ detail: "boom" }, 503)));

  assert.equal(status.ok, false);
  assert.equal(status.loggedIn, false);
  assert.match(status.lastError ?? "", /503/);
});

test("garminSnapshot combines status, wellness, and activities", async (t) => {
  useServiceURL(t, undefined);
  const wellness = [wellnessDay("2026-06-10"), wellnessDay("2026-06-09")];
  const activities = [activity("101")];
  const calls: RecordedCall[] = [];
  const fetchImpl = stubFetch((url) => {
    if (url.endsWith("/status")) return jsonResponse(onlineStatus);
    if (url.includes("/wellness")) return jsonResponse(wellness);
    return jsonResponse(activities);
  }, calls);

  const snapshot = await garminSnapshot(7, fetchImpl);

  assert.deepEqual(snapshot, { status: onlineStatus, wellness, activities });
  assert.deepEqual(
    calls.map((call) => call.url).sort(),
    [
      "http://127.0.0.1:8788/activities?days=7",
      "http://127.0.0.1:8788/status",
      "http://127.0.0.1:8788/wellness?days=7"
    ]
  );
});

test("garminSnapshot fetches wellness and activities in parallel", { timeout: 2000 }, async (t) => {
  useServiceURL(t, undefined);
  const release: Array<() => void> = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith("/status")) return Promise.resolve(jsonResponse(onlineStatus));
    // Resolve the wellness and activities requests only once BOTH have been
    // issued: a serialized client would deadlock here and trip the timeout.
    return new Promise<Response>((resolve) => {
      release.push(() => resolve(jsonResponse([])));
      if (release.length === 2) {
        for (const releaseOne of release) releaseOne();
      }
    });
  };

  const snapshot = await garminSnapshot(7, fetchImpl);

  assert.deepEqual(snapshot.wellness, []);
  assert.deepEqual(snapshot.activities, []);
});

test("garminSnapshot clamps sinceDays per endpoint", async (t) => {
  useServiceURL(t, undefined);
  const calls: RecordedCall[] = [];
  const fetchImpl = stubFetch((url) => (url.endsWith("/status") ? jsonResponse(onlineStatus) : jsonResponse([])), calls);

  await garminSnapshot(90, fetchImpl);
  await garminSnapshot(0, fetchImpl);

  const urls = calls.map((call) => call.url);
  assert.ok(urls.includes("http://127.0.0.1:8788/wellness?days=30"));
  assert.ok(urls.includes("http://127.0.0.1:8788/activities?days=60"));
  assert.ok(urls.includes("http://127.0.0.1:8788/wellness?days=1"));
  assert.ok(urls.includes("http://127.0.0.1:8788/activities?days=1"));
});

test("garminSnapshot keeps the successful half when one endpoint fails", async (t) => {
  useServiceURL(t, undefined);
  const fetchImpl = stubFetch((url) => {
    if (url.endsWith("/status")) return jsonResponse(onlineStatus);
    if (url.includes("/wellness")) return jsonResponse({ detail: "boom" }, 500);
    return jsonResponse([activity("7")]);
  });

  const snapshot = await garminSnapshot(7, fetchImpl);

  assert.deepEqual(snapshot.wellness, []);
  assert.equal(snapshot.activities.length, 1);
  assert.equal(snapshot.status.ok, false);
  assert.equal(snapshot.status.loggedIn, true);
  assert.match(snapshot.status.lastError ?? "", /wellness/);
});

test("garminSnapshot degrades fully when the sidecar is unreachable", async (t) => {
  useServiceURL(t, undefined);

  assert.deepEqual(await garminSnapshot(7, failingFetch()), {
    status: { ok: false, loggedIn: false, lastError: "Garmin service is not reachable." },
    wellness: [],
    activities: []
  });
});

test("pushWorkouts posts the batch and wraps the sidecar results", async (t) => {
  useServiceURL(t, undefined);
  const results = [{ sessionId: "s1", garminWorkoutId: "9001", scheduled: true, error: null }];
  const calls: RecordedCall[] = [];
  const workouts = [{ sessionId: "s1", title: "Tempo", date: "2026-06-12" }];

  const out = await pushWorkouts(workouts, stubFetch(() => jsonResponse(results), calls));

  assert.deepEqual(out, { results });
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/workouts/push");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { workouts });
});

test("pushWorkouts accepts a results-wrapped sidecar payload", async (t) => {
  useServiceURL(t, undefined);
  const results = [{ sessionId: "s1", garminWorkoutId: null, scheduled: false, error: "not logged in" }];

  const out = await pushWorkouts([{ sessionId: "s1" }], stubFetch(() => jsonResponse({ results })));

  assert.deepEqual(out, { results });
});

test("pushWorkouts degrades to empty results instead of throwing", async (t) => {
  useServiceURL(t, undefined);

  const unreachable = await pushWorkouts([{ sessionId: "s1" }], failingFetch());
  assert.deepEqual(unreachable.results, []);
  assert.equal(unreachable.error, "Garmin service is not reachable.");

  const serverError = await pushWorkouts([{ sessionId: "s1" }], stubFetch(() => jsonResponse({}, 502)));
  assert.deepEqual(serverError.results, []);
  assert.match(serverError.error ?? "", /502/);
});

test("deleteWorkouts posts ids and wraps the sidecar results", async (t) => {
  useServiceURL(t, undefined);
  const results = [{ workoutId: "9001", deleted: true, error: null }];
  const calls: RecordedCall[] = [];

  const out = await deleteWorkouts(["9001"], stubFetch(() => jsonResponse(results), calls));

  assert.deepEqual(out, { results });
  assert.equal(calls[0]?.url, "http://127.0.0.1:8788/workouts/delete");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { workoutIds: ["9001"] });
});

test("deleteWorkouts skips the network entirely for an empty id list", async (t) => {
  useServiceURL(t, undefined);
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return jsonResponse([]);
  };

  assert.deepEqual(await deleteWorkouts([], fetchImpl), { results: [] });
  assert.equal(called, false);
});

test("deleteWorkouts degrades to empty results instead of throwing", async (t) => {
  useServiceURL(t, undefined);

  const out = await deleteWorkouts(["9001"], failingFetch());

  assert.deepEqual(out.results, []);
  assert.equal(out.error, "Garmin service is not reachable.");
});
