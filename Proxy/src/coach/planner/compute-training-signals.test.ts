import assert from "node:assert/strict";
import test from "node:test";
import { computeTrainingSignals } from "./compute-training-signals";
import type { CoachContext, GarminWellnessDay, RunSummary } from "./types";

const NOW = new Date("2026-06-11T12:00:00Z");

test("returns null without a running context", () => {
  assert.equal(computeTrainingSignals(baseContext({ running: undefined }), NOW), null);
});

test("computes rolling weekly volume and the 4-week comparison", () => {
  const context = baseContext({
    recentRuns: [
      run("2026-06-10T07:00:00Z", { distanceKm: 12 }),
      run("2026-06-08T07:00:00Z", { distanceKm: 8 }),
      // prior 7-day block
      run("2026-06-02T07:00:00Z", { distanceKm: 10 }),
      // older, still inside 28 days
      run("2026-05-26T07:00:00Z", { distanceKm: 10 }),
      run("2026-05-19T07:00:00Z", { distanceKm: 10 })
    ]
  });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals);
  assert.equal(signals.running.last7DaysKm, 20);
  assert.equal(signals.running.prior7DaysKm, 10);
  assert.equal(signals.running.fourWeekAvgKm, 12.5);
  assert.equal(signals.running.volumeVsFourWeekPct, 60);
  assert.equal(signals.running.runCountLast7Days, 2);
});

test("volume comparison is null without any 4-week baseline", () => {
  const context = baseContext({ recentRuns: [] });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals);
  assert.equal(signals.running.volumeVsFourWeekPct, null);
  assert.equal(signals.running.last7DaysKm, 0);
  assert.equal(signals.lastRun, null);
});

test("collects descent only when the pipeline delivers it", () => {
  const withDescent = computeTrainingSignals(
    baseContext({
      recentRuns: [
        run("2026-06-10T07:00:00Z", { distanceKm: 12, elevationGainM: 400, elevationLossM: 380 }),
        run("2026-06-08T07:00:00Z", { distanceKm: 8, elevationGainM: 100, elevationLossM: 90 })
      ]
    }),
    NOW
  );
  assert.ok(withDescent);
  assert.equal(withDescent.running.last7DaysDescentM, 470);
  assert.equal(withDescent.running.last7DaysAscentM, 500);

  const withoutDescent = computeTrainingSignals(
    baseContext({
      recentRuns: [run("2026-06-10T07:00:00Z", { distanceKm: 12, elevationGainM: 400 })]
    }),
    NOW
  );
  assert.ok(withoutDescent);
  assert.equal(withoutDescent.running.last7DaysDescentM, null);
});

test("tracks the longest run per trailing week, oldest first", () => {
  const context = baseContext({
    recentRuns: [
      run("2026-06-09T07:00:00Z", { distanceKm: 18, kind: "long" }),
      run("2026-06-02T07:00:00Z", { distanceKm: 16, kind: "long" }),
      run("2026-05-27T07:00:00Z", { distanceKm: 14, kind: "long" }),
      run("2026-05-26T07:00:00Z", { distanceKm: 6, kind: "easy" })
    ]
  });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals);
  assert.deepEqual(signals.running.recentLongRunsKm, [14, 16, 18]);
  assert.equal(signals.running.longestRunLast6WeeksKm, 18);
});

test("computes the easy share from runs that carry a kind", () => {
  const context = baseContext({
    recentRuns: [
      run("2026-06-09T07:00:00Z", { kind: "long" }),
      run("2026-06-07T07:00:00Z", { kind: "easy" }),
      run("2026-06-05T07:00:00Z", { kind: "easy" }),
      run("2026-06-03T07:00:00Z", { kind: "recovery" }),
      // kind-less manual log is excluded from the split
      run("2026-06-01T07:00:00Z", {})
    ]
  });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals);
  assert.equal(signals.running.easyShareLast4Weeks, 0.75);
});

test("maps days-to-race onto taper status", () => {
  const inTaper = computeTrainingSignals(baseContext({ raceDate: "2026-06-21T00:00:00Z" }), NOW);
  assert.equal(inTaper?.race?.taperStatus, "in-taper");

  const approaching = computeTrainingSignals(baseContext({ raceDate: "2026-06-29T00:00:00Z" }), NOW);
  assert.equal(approaching?.race?.taperStatus, "approaching");

  const training = computeTrainingSignals(baseContext({ raceDate: "2026-09-18T00:00:00Z" }), NOW);
  assert.equal(training?.race?.taperStatus, "training");
});

test("derives the HRV gate from the latest wellness day", () => {
  const balanced = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-10", { hrvStatus: "BALANCED" }), wellnessDay("2026-06-11", { hrvStatus: "BALANCED" })] }),
    NOW
  );
  assert.equal(balanced?.wellness?.hrvGate, "ok-for-hard");

  const suppressed = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "UNBALANCED" })] }),
    NOW
  );
  assert.equal(suppressed?.wellness?.hrvGate, "favor-easy");

  const unknown = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "" })] }),
    NOW
  );
  assert.equal(unknown?.wellness?.hrvGate, null);
  assert.equal(unknown?.wellness?.hrvStatus, null);
});

test("summarizes the most recent run with computed pace", () => {
  const context = baseContext({
    recentRuns: [
      run("2026-06-05T07:00:00Z", { distanceKm: 8 }),
      run("2026-06-10T07:00:00Z", { distanceKm: 10, movingSeconds: 3600, averageHr: 148, rpe: 6, feelScore: 4, kind: "easy" })
    ]
  });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals?.lastRun);
  assert.equal(signals.lastRun.distanceKm, 10);
  assert.equal(signals.lastRun.paceSecPerKm, 360);
  assert.equal(signals.lastRun.averageHr, 148);
  assert.equal(signals.lastRun.feelScore, 4);
});

function run(completedAt: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    completedAt,
    distanceKm: 10,
    movingSeconds: 3600,
    elevationGainM: 0,
    ...overrides
  };
}

function wellnessDay(date: string, overrides: Partial<GarminWellnessDay> = {}): GarminWellnessDay {
  return {
    date,
    sleepScore: 80,
    sleepSeconds: 27000,
    hrvStatus: "BALANCED",
    hrvMs: 50,
    bodyBattery: 60,
    trainingReadiness: 70,
    restingHr: 47,
    ...overrides
  };
}

function baseContext(options: {
  recentRuns?: RunSummary[];
  wellness?: GarminWellnessDay[];
  raceDate?: string;
  running?: undefined;
} = {}): CoachContext {
  const context = {
    readiness: { state: "building", riskFlags: [] },
    garmin: options.wellness ? { wellness: options.wellness } : undefined,
    running: "running" in options && options.running === undefined && !options.recentRuns && !options.raceDate
      ? undefined
      : {
          raceGoal: {
            name: "Eiger Ultra 51K",
            raceDate: options.raceDate ?? "2026-09-18T00:00:00Z",
            distanceKm: 51,
            elevationGainM: 3100
          },
          baselineWeeklyKm: 35,
          longestRecentRunKm: 16.4,
          runningDays: ["tuesday", "thursday", "saturday"],
          runningDayOffsets: [1, 3, 5],
          recentRuns: options.recentRuns ?? [],
          weeksToRace: 14
        }
  } as unknown as CoachContext;
  return context;
}
