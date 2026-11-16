import assert from "node:assert/strict";
import test from "node:test";
import { coachReferencePointsFor, computeTrainingSignals } from "./compute-training-signals";
import { computeSeason, contextSeason } from "./season";
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

// The split counts time, and long runs are low intensity, so a normal build
// week (long run, one tempo, two easy runs) reads about 0.8, not 0.5.
test("computes the low-intensity time share (80/20 by time) from runs that carry a kind", () => {
  const context = baseContext({
    recentRuns: [
      run("2026-06-09T07:00:00Z", { kind: "long", movingSeconds: 9000 }),
      run("2026-06-07T07:00:00Z", { kind: "tempo", movingSeconds: 3600 }),
      run("2026-06-05T07:00:00Z", { kind: "easy", movingSeconds: 3600 }),
      run("2026-06-03T07:00:00Z", { kind: "easy", movingSeconds: 3600 }),
      // kind-less manual log is excluded from the split
      run("2026-06-01T07:00:00Z", {})
    ]
  });

  const signals = computeTrainingSignals(context, NOW);

  assert.ok(signals);
  assert.equal(signals.running.lowIntensityTimeShareLast4Weeks, 0.82, "16200 of 19800 seconds");
});

// Audit: the 80/20 check only alarmed below 0.75, and a share near 1.0 (what
// post-race weeks produce) means no speed stimulus at all.
test("three weeks of only easy running raise the no-speed-stimulus flag, except after the race", () => {
  const easyWeeks = (extra: RunSummary[] = []) => [
    run("2026-06-10T07:00:00Z", { kind: "easy" }),
    run("2026-06-07T07:00:00Z", { kind: "long", movingSeconds: 7200 }),
    run("2026-06-03T07:00:00Z", { kind: "easy" }),
    run("2026-05-31T07:00:00Z", { kind: "long", movingSeconds: 7200 }),
    run("2026-05-25T07:00:00Z", { kind: "recovery" }),
    ...extra
  ];

  // The race is 99 days out: base phase.
  const easyOnly = computeTrainingSignals(baseContext({ recentRuns: easyWeeks() }), NOW);
  assert.equal(easyOnly?.running.lowIntensityTimeShareLast3Weeks, 1);
  assert.equal(easyOnly?.running.noSpeedStimulusLast3Weeks, true);

  const withTempo = computeTrainingSignals(baseContext({ recentRuns: easyWeeks([run("2026-06-05T07:00:00Z", { kind: "tempo", movingSeconds: 2400 })]) }), NOW);
  assert.equal(withTempo?.running.noSpeedStimulusLast3Weeks, false);

  // A week after the 51 km race (post-race transition until day 13) easy weeks are the plan.
  const postRace = computeTrainingSignals(baseContext({ recentRuns: easyWeeks(), raceDate: "2026-06-04T00:00:00Z" }), NOW);
  assert.equal(postRace?.running.noSpeedStimulusLast3Weeks, false);
});

test("the race itself is left out of the 3- and 4-week easy shares", () => {
  // Day 20 after the race (general preparation): 10 h of racing on the race
  // date would read as easy time (0.98) and hide a 15-minute tempo session.
  const signals = computeTrainingSignals(baseContext({
    raceDate: "2026-05-22T00:00:00Z",
    recentRuns: [
      run("2026-05-22T07:00:00Z", { kind: "long", distanceKm: 51, movingSeconds: 36000 }),
      run("2026-06-01T07:00:00Z", { kind: "easy" }),
      run("2026-06-05T07:00:00Z", { kind: "tempo", movingSeconds: 900 }),
      run("2026-06-08T07:00:00Z", { kind: "easy" }),
      run("2026-06-10T07:00:00Z", { kind: "easy" })
    ]
  }), NOW);

  assert.equal(signals?.running.lowIntensityTimeShareLast3Weeks, 0.92);
  assert.equal(signals?.running.lowIntensityTimeShareLast4Weeks, 0.92, "the race is 20 days back, inside the 4 weeks too");
  assert.equal(signals?.running.noSpeedStimulusLast3Weeks, false);
});

test("maps days-to-race onto taper status", () => {
  const inTaper = computeTrainingSignals(baseContext({ raceDate: "2026-06-21T00:00:00Z" }), NOW);
  assert.equal(inTaper?.race?.taperStatus, "in-taper");

  const approaching = computeTrainingSignals(baseContext({ raceDate: "2026-06-29T00:00:00Z" }), NOW);
  assert.equal(approaching?.race?.taperStatus, "approaching");

  const training = computeTrainingSignals(baseContext({ raceDate: "2026-09-18T00:00:00Z" }), NOW);
  assert.equal(training?.race?.taperStatus, "training");
});

// A past race used to read "in-taper", 0 days out, for ever after it.
test("a past race is never in taper", () => {
  // The 51 km race has a 13-day post-race window.
  const raceDay = computeTrainingSignals(baseContext({ raceDate: "2026-06-11T00:00:00Z" }), NOW)?.race;
  assert.deepEqual([raceDay?.taperStatus, raceDay?.daysToRace, raceDay?.daysSinceRace], ["in-taper", 0, null], "race day is still the race");

  const lastWindowDay = computeTrainingSignals(baseContext({ raceDate: "2026-05-29T00:00:00Z" }), NOW)?.race;
  assert.deepEqual([lastWindowDay?.taperStatus, lastWindowDay?.daysToRace, lastWindowDay?.daysSinceRace], ["post-race", null, 13]);

  const afterWindow = computeTrainingSignals(baseContext({ raceDate: "2026-05-28T00:00:00Z" }), NOW)?.race;
  assert.deepEqual([afterWindow?.taperStatus, afterWindow?.daysToRace, afterWindow?.daysSinceRace], ["none", null, 14]);
});

// One day count: the race signal reads the season, so the two agree at any
// hour, also late in the evening of a week with a daylight-saving change.
test("the race signal agrees with the season at any hour of the day", () => {
  // Amsterdam: 28 Mar 2026 (winter time) with the race on 4 Apr (summer time), 7 days out.
  const context = baseContext({ weekStart: "2026-03-27T23:00:00Z", raceDate: "2026-04-03T22:00:00Z" });
  for (const now of ["2026-03-27T23:30:00Z", "2026-03-28T11:00:00Z", "2026-03-28T22:30:00Z"]) {
    const race = computeTrainingSignals(context, new Date(now))?.race;
    assert.deepEqual([race?.daysToRace, race?.daysSinceRace, race?.taperStatus], [contextSeason(context).daysToRace, null, "in-taper"], now);
    assert.equal(race?.daysToRace, 7, now);
  }
});

test("an unreadable race date is no race, not a race in training", () => {
  const race = computeTrainingSignals(baseContext({ raceDate: "not-a-date" }), NOW)?.race;

  assert.deepEqual([race?.daysToRace, race?.daysSinceRace, race?.taperStatus], [null, null, "none"]);
});

// After the race the read still framed strength as part of the ultra build.
// That claim (heavy strength and plyometrics) is gone until the planner can
// prescribe them (Task 8; strength-skill-text.test.ts checks it).
test("the coach read gets the race-centred reference points only while a race is ahead", () => {
  const eiger = { name: "Eiger Ultra 51K", raceDate: "2026-09-18T00:00:00Z", distanceKm: 51 };
  const raceOnly = [/^Taper:/, /race distance/];
  const general = [/^Volume jumps:/, /^HRV gate:/, /^Downhill conditioning:/, /^Long-run progression:/];

  const ahead = coachReferencePointsFor(computeSeason(eiger, "2026-06-11T00:00:00Z"));
  for (const pattern of [...raceOnly, ...general]) assert.ok(ahead.some((point) => pattern.test(point)), `${pattern} while the race is ahead`);

  for (const weekStart of ["2026-09-20T00:00:00Z", "2026-11-15T00:00:00Z"]) {
    const after = coachReferencePointsFor(computeSeason(eiger, weekStart));
    for (const pattern of raceOnly) assert.ok(!after.some((point) => pattern.test(point)), `${pattern} after the race (${weekStart})`);
    for (const pattern of general) assert.ok(after.some((point) => pattern.test(point)), `${pattern} after the race (${weekStart})`);
  }
});

// UNBALANCED used to read as suppressed; it can sit above the baseline, so
// only HRV below the baseline favors easy work (wellness-gate.ts).
test("derives the HRV gate from the latest wellness day", () => {
  const balanced = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-10", { hrvStatus: "BALANCED" }), wellnessDay("2026-06-11", { hrvStatus: "BALANCED" })] }),
    NOW
  );
  assert.equal(balanced?.wellness?.hrvGate, "ok-for-hard");

  const low = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "LOW" })] }), NOW);
  assert.equal(low?.wellness?.hrvGate, "favor-easy");

  const unbalanced = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "UNBALANCED" })] }), NOW);
  assert.equal(unbalanced?.wellness?.hrvGate, null, "above or below the baseline: no gate on its own");

  const belowBaseline = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "UNBALANCED", hrvWeeklyAvgMs: 40, hrvBaselineLowMs: 46 })] }),
    NOW
  );
  assert.equal(belowBaseline?.wellness?.hrvGate, "favor-easy");

  const aboveBaseline = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "UNBALANCED", hrvWeeklyAvgMs: 66, hrvBaselineLowMs: 46 })] }),
    NOW
  );
  assert.equal(aboveBaseline?.wellness?.hrvGate, "ok-for-hard");

  const unknown = computeTrainingSignals(
    baseContext({ wellness: [wellnessDay("2026-06-11", { hrvStatus: "" })] }),
    NOW
  );
  assert.equal(unknown?.wellness?.hrvGate, null);
  assert.equal(unknown?.wellness?.hrvStatus, null);
});

// The 01:30 nightly plan: today's row has no HRV reading yet.
test("the HRV signal reads the latest day with an HRV reading, at most 2 days old", () => {
  const emptyToday = wellnessDay("2026-06-11", { hrvStatus: "", hrvMs: 0, sleepScore: 0 });

  const night = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-10", { hrvStatus: "LOW" }), emptyToday] }), NOW);
  assert.equal(night?.wellness?.hrvStatus, "LOW");
  assert.equal(night?.wellness?.hrvGate, "favor-easy");

  const old = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-08", { hrvStatus: "LOW" }), emptyToday] }), NOW);
  assert.equal(old?.wellness?.hrvStatus, null, "3 days old");
  assert.equal(old?.wellness?.hrvGate, null);
});

// The 01:30 nightly plan: today's row is there but still empty, so each value
// comes from the latest day that has it, with that day, so the coach never
// presents yesterday's number as today's.
test("each wellness value comes from the latest day that has it, with that day", () => {
  const emptyToday = wellnessDay("2026-06-11", { hrvStatus: "", hrvMs: 0, sleepScore: 0, trainingReadiness: 0, restingHr: 0, bodyBattery: 0 });
  const yesterday = wellnessDay("2026-06-10", { hrvStatus: "BALANCED", sleepScore: 74, trainingReadiness: 55, restingHr: 49 });
  const wellness = computeTrainingSignals(baseContext({ wellness: [yesterday, emptyToday] }), NOW)?.wellness;

  assert.deepEqual(wellness, {
    latestDate: "2026-06-11",
    hrvStatus: "BALANCED",
    hrvDate: "2026-06-10",
    hrvGate: "ok-for-hard",
    sleepScore: 74,
    sleepScoreDate: "2026-06-10",
    trainingReadiness: 55,
    trainingReadinessDate: "2026-06-10",
    restingHr: 49,
    restingHrDate: "2026-06-10"
  });
});

test("wellness values more than 2 days old are left out", () => {
  const emptyToday = wellnessDay("2026-06-11", { hrvStatus: "", hrvMs: 0, sleepScore: 0, trainingReadiness: 0, restingHr: 0, bodyBattery: 0 });
  const stale = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-08", { sleepScore: 74, trainingReadiness: 22, restingHr: 49 }), emptyToday] }), NOW)?.wellness;
  assert.deepEqual(
    [stale?.sleepScore, stale?.sleepScoreDate, stale?.trainingReadiness, stale?.trainingReadinessDate, stale?.restingHr, stale?.restingHrDate],
    [null, null, null, null, null, null],
    "3 days old"
  );

  const twoDays = computeTrainingSignals(baseContext({ wellness: [wellnessDay("2026-06-09", { sleepScore: 74 }), emptyToday] }), NOW)?.wellness;
  assert.deepEqual([twoDays?.sleepScore, twoDays?.sleepScoreDate], [74, "2026-06-09"], "2 days old");
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
  weekStart?: string;
  running?: undefined;
} = {}): CoachContext {
  const context = {
    profile: { weekStart: options.weekStart ?? "2026-06-11T00:00:00Z" },
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

test("the planner texts describe the intensity split the way the signal reports it", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const root = join(process.cwd(), "src", "coach", "skills", "running-coach-planner");
  const texts = await Promise.all([readFile(join(root, "SKILL.md"), "utf8"), readFile(join(root, "references", "ultra-periodization.md"), "utf8")]);
  for (const text of texts) {
    assert.ok(!text.includes("easyShareLast4Weeks"), "the old count-based share is gone");
    assert.ok(text.includes("lowIntensityTimeShareLast4Weeks"));
    assert.match(text, /about 0\.8/);
  }
});
