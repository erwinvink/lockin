import assert from "node:assert/strict";
import test from "node:test";
import { createGarminEnricher, sanitizeWellnessForCoach } from "./garmin-enrichment";
import type { CoachContext, GarminWellnessDay } from "../coach/planner/types";
import { computeTrainingSignals } from "../coach/planner/compute-training-signals";

function wellnessDay(date: string, overrides: Partial<GarminWellnessDay> = {}): GarminWellnessDay {
  return {
    date,
    sleepScore: 80,
    sleepSeconds: 27000,
    hrvStatus: "BALANCED",
    hrvMs: 52,
    bodyBattery: 70,
    trainingReadiness: 55,
    restingHr: 47,
    ...overrides
  };
}

function sidecarFetch(wellness: unknown[], calls: string[], loggedIn = true): typeof fetch {
  return async (input) => {
    const url = String(input);
    calls.push(url);
    const body = url.includes("/status") ? { ok: true, loggedIn, lastError: null } : wellness;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function context(): CoachContext {
  return {
    profile: {
      baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
      goals: { pullUps: 10, pushUps: 40, plankSeconds: 120 },
      profileNotes: "",
      weekStart: "2026-06-10T00:00:00Z",
      weeklySessions: 3,
      trainingDays: [],
      trainingDayOffsets: [],
      equipment: [],
      targetDate: "2026-09-01T00:00:00Z"
    },
    history: {
      last5Logs: [],
      rpeCalibration: { recentPlannedLogCount: 0, averageDeltaLast5: null, abovePlanBy2Count: 0, belowPlanBy2Count: 0, latestSummary: null },
      currentPartialMonth: emptyMonth("2026-06", true),
      lastFullMonth: emptyMonth("2026-05", false),
      previousFullMonth: emptyMonth("2026-04", false),
      twoFullMonthTrend: { pullUpsDelta: null, pushUpsDelta: null, plankSecondsDelta: null, logCountDelta: 0, label: "insufficient_history" },
      bestRecentTests: { pullUps: 5, pushUps: 20, plankSeconds: 60 }
    },
    adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
    plannedWork: {
      todaySessions: [],
      recentGoalTargets: {
        pullUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        pushUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      }
    },
    readiness: { state: "building", riskFlags: [] }
  };
}

function hybridContext(): CoachContext {
  return {
    ...context(),
    running: {
      raceGoal: { name: "Ridge 50K", raceDate: "2026-09-12T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40,
      longestRecentRunKm: 20,
      runningDays: ["tuesday", "saturday"],
      runningDayOffsets: [1, 5],
      recentRuns: [],
      weeksToRace: 13
    }
  };
}

function emptyMonth(month: string, isPartial: boolean): CoachContext["history"]["lastFullMonth"] {
  return {
    month,
    isPartial,
    logCount: 0,
    pullUps: { count: 0, best: null, latest: null },
    pushUps: { count: 0, best: null, latest: null },
    plankSeconds: { count: 0, best: null, latest: null },
    averageRPE: null,
    maxPain: 0,
    maxFatigue: 0
  };
}

test("unavailable and zero wellness metrics become missing, never real low values (S2)", () => {
  const sanitized = sanitizeWellnessForCoach(wellnessDay("2026-06-10", {
    sleepScore: 0,
    sleepSeconds: 0,
    hrvStatus: "",
    bodyBattery: 0,
    trainingReadiness: 12,
    unavailableMetrics: ["sleepScore", "sleepSeconds", "trainingReadiness"]
  }));

  assert.deepEqual(sanitized, {
    date: "2026-06-10",
    sleepScore: null,
    sleepSeconds: null,
    hrvStatus: null,
    hrvMs: 52,
    bodyBattery: null,
    trainingReadiness: null,
    restingHr: 47
  });
});

test("enrichment puts sanitized wellness into the coach context (S2)", async () => {
  const calls: string[] = [];
  const enrich = createGarminEnricher({
    fetchImpl: sidecarFetch([
      wellnessDay("2026-06-10", { trainingReadiness: 0, sleepScore: 0, unavailableMetrics: ["sleepScore", "trainingReadiness"] }),
      wellnessDay("2026-06-09", { trainingReadiness: 20 })
    ], calls),
    log: () => undefined
  });

  const enriched = await enrich(hybridContext(), "user-1");
  const signals = computeTrainingSignals(enriched);

  assert.equal(enriched.garmin?.wellness[0]?.sleepScore, null);
  assert.equal(enriched.garmin?.wellness[0]?.trainingReadiness, null);
  assert.equal(signals?.wellness?.trainingReadiness, null);
  assert.equal(signals?.wellness?.sleepScore, null);
  // A failed readiness fetch must not raise the low-readiness flag.
  assert.deepEqual(enriched.readiness.riskFlags, []);
});

test("enrichment flags a real low training readiness", async () => {
  const enrich = createGarminEnricher({
    fetchImpl: sidecarFetch([wellnessDay("2026-06-10", { trainingReadiness: 20 })], []),
    log: () => undefined
  });

  const enriched = await enrich(context(), "user-1");

  assert.deepEqual(enriched.readiness.riskFlags, ["garmin: training readiness low"]);
});

test("enrichment never falls back to the default Garmin user (S5)", async () => {
  const calls: string[] = [];
  const logged: string[] = [];
  const enrich = createGarminEnricher({ fetchImpl: sidecarFetch([wellnessDay("2026-06-10")], calls), log: (message) => logged.push(message) });

  const enriched = await enrich(context(), undefined);

  assert.deepEqual(calls, []);
  assert.equal(enriched.garmin, undefined);
  assert.equal(logged.length, 1);
});

test("enrichment asks for two days only and caches per user (S12)", async () => {
  const calls: string[] = [];
  let now = 1_000_000;
  const enrich = createGarminEnricher({
    fetchImpl: sidecarFetch([wellnessDay("2026-06-10")], calls),
    now: () => now,
    cacheTtlMs: 10 * 60_000,
    log: () => undefined
  });

  await enrich(context(), "user-1");
  await enrich(context(), "user-1");
  const wellnessCalls = () => calls.filter((url) => url.includes("/wellness"));
  assert.deepEqual(wellnessCalls(), ["http://127.0.0.1:8788/wellness?days=2&userId=user-1"]);

  await enrich(context(), "user-2");
  assert.equal(wellnessCalls().length, 2);

  now += 10 * 60_000 + 1;
  await enrich(context(), "user-1");
  assert.equal(wellnessCalls().length, 3);
});

test("enrichment logs when the coach context goes out without Garmin data (S12)", async () => {
  const logged: string[] = [];
  const enrich = createGarminEnricher({
    fetchImpl: sidecarFetch([], [], false),
    log: (message) => logged.push(message)
  });

  const enriched = await enrich(context(), "user-1");

  assert.equal(enriched.garmin, undefined);
  assert.equal(logged.length, 1);
  assert.match(logged[0] ?? "", /without Garmin/);
});

test("a snapshot where every metric failed is neither used nor cached", async () => {
  const calls: string[] = [];
  const logged: string[] = [];
  const allFailed = wellnessDay("2026-06-10", {
    sleepScore: 0,
    sleepSeconds: 0,
    hrvStatus: "",
    hrvMs: 0,
    bodyBattery: 0,
    trainingReadiness: 0,
    restingHr: 0,
    unavailableMetrics: ["sleepScore", "sleepSeconds", "hrvStatus", "hrvMs", "bodyBattery", "trainingReadiness", "restingHr"]
  });
  const enrich = createGarminEnricher({ fetchImpl: sidecarFetch([allFailed], calls), log: (message) => logged.push(message) });

  const first = await enrich(context(), "user-1");
  await enrich(context(), "user-1");

  assert.equal(first.garmin, undefined);
  assert.equal(calls.filter((url) => url.includes("/wellness")).length, 2);
  assert.match(logged[0] ?? "", /no usable wellness/);
});
