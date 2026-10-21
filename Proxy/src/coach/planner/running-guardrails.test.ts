import assert from "node:assert/strict";
import test from "node:test";
import { clampRunningWeek, easyRunReference, runningGuardrails } from "./running-guardrails";
import { validateRunningWeek } from "./validate-running-week";
import type { CoachContext, RunKind, RunningContext, RunningWeek, RunSummary } from "./types";

// 2026-05-11 is a Monday; offsets 1-6 are Tuesday-Sunday.
const WEEK_START = "2026-05-11T00:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

test("weekly cap is 15% above the larger of the last 7 days and the 4-week average", () => {
  const guardrails = runningGuardrails(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }));

  assert.deepEqual(
    guardrails.weeklyVolume.kind === "capped" && [guardrails.weeklyVolume.referenceKm, guardrails.weeklyVolume.capKm],
    [45, 51.8]
  );
});

test("a recovery week last week does not drag the cap down to its low volume", () => {
  // Oldest first: three 45 km weeks, then a 25 km down week.
  const guardrails = runningGuardrails(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 25]) }));

  assert.equal(guardrails.weeklyVolume.kind, "capped");
  if (guardrails.weeklyVolume.kind !== "capped") return;
  assert.equal(guardrails.weeklyVolume.referenceKm, 40);
  assert.equal(guardrails.weeklyVolume.capKm, 46);
});

test("small bases get at least 3 km of room", () => {
  const guardrails = runningGuardrails(contextWith({ recentRuns: steadyWeeks([10, 10, 10, 10]), baselineWeeklyKm: 10 }));

  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 13);
});

test("no run history at all waives the weekly cap as a computed reason", () => {
  const guardrails = runningGuardrails(contextWith({ recentRuns: [], baselineWeeklyKm: 0, longestRecentRunKm: 0 }));

  assert.equal(guardrails.weeklyVolume.kind, "waived");
  assert.ok(guardrails.relaxations.some((relaxation) => relaxation.code === "missing_run_history"));
  assert.equal(guardrails.longRun, null);
});

test("without runs the manual baseline anchors the cap", () => {
  const guardrails = runningGuardrails(contextWith({ recentRuns: [], baselineWeeklyKm: 30 }));

  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 34.5);
});

test("a return after four weeks without runs is capped at 20 km", () => {
  const oldRuns = steadyWeeks([40, 40], 6);
  const guardrails = runningGuardrails(contextWith({ recentRuns: oldRuns, baselineWeeklyKm: 0 }));

  assert.equal(guardrails.weeklyVolume.kind, "capped");
  if (guardrails.weeklyVolume.kind !== "capped") return;
  assert.equal(guardrails.weeklyVolume.capKm, 20);
  assert.ok(guardrails.weeklyVolume.basis.includes("no runs in the last 4 weeks"));
});

test("rejects a week over the weekly cap with the cap, the planned km, and the reference", () => {
  const context = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 12),
    run("Tempo blocks", 2, "tempo", 12),
    run("Easy aerobic run", 3, "easy", 10),
    run("Long trail run", 5, "long", 22),
    run("Recovery jog", 6, "recovery", 8)
  ]);
  week.safetyFlags = ["Big week before the camp."];

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  const message = result.messages.find((m) => m.includes("Planned running volume"));
  assert.ok(message);
  assert.ok(message.includes("64 km") && message.includes("cap of 51.8 km") && message.includes("45 km"));
  assert.ok(message.includes("Remove at least 12.2 km"));
  assert.ok(message.includes("safety flags cannot waive"));
});

test("clamp shortens easy and recovery runs to fit the weekly cap and the result validates", () => {
  const context = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 2, "tempo", 12),
    run("Easy aerobic run", 3, "easy", 10),
    run("Long trail run", 5, "long", 24),
    run("Recovery jog", 6, "recovery", 8)
  ]);
  const guardrails = runningGuardrails(context);

  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);

  assert.deepEqual(clamped.sessions.map((s) => s.distanceKm), [4.5, 12, 6, 24, 4.5]);
  assert.equal(clamped.sessions[0].durationMinutes, Math.round(48 * (4.5 / 8)));
  assert.ok(adjustments.some((a) => a.includes("62 km") && a.includes("51.8 km cap")));
  assert.deepEqual(week.sessions.map((s) => s.distanceKm), [8, 12, 10, 24, 8], "input is not mutated");
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });
});

test("clamp leaves the week alone when easy runs cannot absorb the excess, so validation rejects it", () => {
  const context = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 4),
    run("Tempo blocks", 2, "tempo", 20),
    run("Long trail run", 5, "long", 28),
    run("Recovery jog", 6, "recovery", 4)
  ]);

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.deepEqual(clamped.sessions.map((s) => s.distanceKm), [4, 20, 28, 4]);
  assert.deepEqual(adjustments, []);
  assert.equal(validateRunningWeek(clamped, context).accepted, false);
});

test("the race-day session is outside the weekly and long-run caps", () => {
  const context = contextWith({
    recentRuns: steadyWeeks([45, 45, 45, 45]),
    raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-05-17T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
    weeksToRace: 1
  });
  const week = runningWeek([
    run("Easy shakeout", 1, "easy", 6),
    run("Recovery jog", 3, "recovery", 5),
    run("Pre-race shakeout", 5, "easy", 4),
    run("Ridge Ultra 60K", 6, "long", 60)
  ]);

  assert.deepEqual(validateRunningWeek(week, context), { accepted: true, messages: [] });
  assert.deepEqual(clampRunningWeek(week, context).adjustments, []);
});

test("clamp shortens a run above the long-run cap and says so", () => {
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), longestRecentRunKm: 20 });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 6),
    run("Tempo blocks", 3, "tempo", 8),
    run("Long trail run", 5, "long", 32),
    run("Recovery jog", 6, "recovery", 5)
  ]);

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.equal(clamped.sessions[2].distanceKm, 28);
  assert.equal(clamped.sessions[2].durationMinutes, Math.round(192 * (28 / 32)));
  assert.ok(clamped.sessions[2].notes.some((note) => note.includes("1.4x")));
  assert.ok(adjustments.some((a) => a.includes("32 km to 28 km")));
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("rejects two hard runs on consecutive days", () => {
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 4, "tempo", 10),
    run("Long trail run", 5, "long", 20),
    run("Recovery jog", 6, "recovery", 6)
  ]);

  const result = validateRunningWeek(week, sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) }));

  assert.equal(result.accepted, false);
  const message = result.messages.find((m) => m.includes("consecutive days"));
  assert.ok(message);
  assert.ok(message.includes("tempo on offset 4") && message.includes("long on offset 5"));
});

test("allows back-to-back long runs for an 80 km+ race in build or peak, not for shorter races", () => {
  const b2bWeek = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Hill repeats", 3, "hills", 10),
    run("Long trail run", 5, "long", 22),
    run("Back-to-back long run", 6, "long", 14)
  ]);
  const hundred = sixDayContext({
    recentRuns: steadyWeeks([50, 50, 50, 50]),
    longestRecentRunKm: 24,
    raceGoal: { name: "Mozart 100", raceDate: "2026-07-06T00:00:00Z", distanceKm: 104, elevationGainM: 5000 },
    weeksToRace: 8
  });
  const fifty = sixDayContext({
    recentRuns: steadyWeeks([50, 50, 50, 50]),
    longestRecentRunKm: 24,
    raceGoal: { name: "Trail 50", raceDate: "2026-07-06T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
    weeksToRace: 8
  });

  assert.deepEqual(validateRunningWeek(b2bWeek, hundred), { accepted: true, messages: [] });
  const rejected = validateRunningWeek(b2bWeek, fifty);
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.messages.some((m) => m.includes("Back-to-back long runs are only allowed") && m.includes("50 km")));
});

test("a computed wellness gate lowers the run-count floor; a safety flag does not", () => {
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 20)
  ]);
  week.safetyFlags = ["Feeling flat this week."];
  const established = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });

  const flagged = validateRunningWeek(week, established);
  assert.equal(flagged.accepted, false);
  assert.ok(flagged.messages.some((m) => m.includes("too sparse") && m.includes("3 runs planned") && m.includes("at least 4")));

  const gated: CoachContext = {
    ...established,
    garmin: {
      wellness: [{ date: "2026-05-11", sleepScore: 72, sleepSeconds: 25000, hrvStatus: "LOW", hrvMs: 38, bodyBattery: 40, trainingReadiness: 35, restingHr: 52 }]
    }
  };
  assert.deepEqual(validateRunningWeek(week, gated), { accepted: true, messages: [] });
});

test("a stale wellness day does not trip the gate", () => {
  const context: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }),
    garmin: {
      wellness: [{ date: "2026-05-01", sleepScore: 30, sleepSeconds: 18000, hrvStatus: "LOW", hrvMs: 30, bodyBattery: 10, trainingReadiness: 10, restingHr: 60 }]
    }
  };

  assert.deepEqual(runningGuardrails(context).relaxations, []);
});

test("a recent run rated feel 1-2 is a computed relaxation", () => {
  const runs = steadyWeeks([45, 45, 45, 45]);
  runs[runs.length - 1] = { ...runs[runs.length - 1], feelScore: 2 };

  const guardrails = runningGuardrails(contextWith({ recentRuns: runs }));

  assert.ok(guardrails.relaxations.some((relaxation) => relaxation.code === "recent_run_distress"));
});

test("an established base needs runs inside the last six weeks", () => {
  // Ten runs, all 8-10 weeks old: the old count no longer makes the base established.
  const oldRuns: RunSummary[] = Array.from({ length: 10 }, (_, index) => runSummary(56 + index * 2, 8, "easy"));
  const context = contextWith({ recentRuns: oldRuns, baselineWeeklyKm: 20, longestRecentRunKm: 12 });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 6),
    run("Easy aerobic run", 3, "easy", 6),
    run("Long easy run", 5, "long", 8)
  ]);

  const guardrails = runningGuardrails(context);

  assert.equal(guardrails.recentRunCountLast6Weeks, 0);
  assert.equal(guardrails.frequency?.minRuns, 3);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

test("rejects zero and implausible pace or heart-rate targets", () => {
  const week = validFourRunWeek();
  week.sessions[0] = { ...week.sessions[0], target: { type: "pace", low: 0, high: 0 } };
  week.sessions[1] = { ...week.sessions[1], target: { type: "hr", low: 150, high: 250 } };

  const result = validateRunningWeek(week, contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }));

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.startsWith("Run 1 pace target 0-0 s/km is outside the plausible 150-720")));
  assert.ok(result.messages.some((m) => m.startsWith("Run 2 heart-rate target 150-250 bpm is outside the plausible 80-210")));
});

test("clamp drops an implausible target without a reference and the result validates", () => {
  const context = contextWith({ recentRuns: [], baselineWeeklyKm: 45 });
  const week = validFourRunWeek();
  week.sessions[1] = { ...week.sessions[1], target: { type: "hr", low: 0, high: 0 } };

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.deepEqual(clamped.sessions[1].target, { type: "none", low: 0, high: 0 });
  assert.ok(adjustments.some((a) => a.includes("dropped") && a.includes("effort-based")));
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("clamp replaces an implausible easy-run target with the athlete's easy reference", () => {
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = validFourRunWeek();
  week.sessions[0] = { ...week.sessions[0], target: { type: "pace", low: 0, high: 0 } };

  const guardrails = runningGuardrails(context);
  const { week: clamped } = clampRunningWeek(week, context, guardrails);

  assert.ok(guardrails.easyReference?.hrBpm);
  assert.deepEqual(clamped.sessions[0].target, {
    type: "hr",
    low: guardrails.easyReference!.hrBpm!.low,
    high: guardrails.easyReference!.hrBpm!.high
  });
});

test("clamp replaces an easy-run pace that is far faster than the athlete's easy pace", () => {
  const runs = steadyWeeks([45, 45, 45, 45]).map(({ averageHr: _hr, ...run }) => run);
  const context = contextWith({ recentRuns: runs });
  const week = validFourRunWeek();
  week.sessions[0] = { ...week.sessions[0], target: { type: "pace", low: 270, high: 285 } };

  const guardrails = runningGuardrails(context);
  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);

  assert.equal(guardrails.easyReference?.hrBpm, null);
  assert.deepEqual(clamped.sessions[0].target, {
    type: "pace",
    low: guardrails.easyReference!.paceSecPerKm!.low,
    high: guardrails.easyReference!.paceSecPerKm!.high
  });
  assert.ok(adjustments.some((a) => a.includes("much faster than the athlete's easy pace")));
});

test("clamp swaps inverted target bounds", () => {
  const context = contextWith({ recentRuns: [], baselineWeeklyKm: 45 });
  const week = validFourRunWeek();
  week.sessions[1] = { ...week.sessions[1], target: { type: "pace", low: 400, high: 350 } };

  const { week: clamped } = clampRunningWeek(week, context);

  assert.deepEqual(clamped.sessions[1].target, { type: "pace", low: 350, high: 400 });
});

test("easy reference uses the median of easy-labelled runs", () => {
  const anchor = Date.parse(WEEK_START);
  const runs = [
    { ...runSummary(2, 10, "easy"), movingSeconds: 3600, averageHr: 140 },
    { ...runSummary(4, 10, "easy"), movingSeconds: 3500, averageHr: 138 },
    { ...runSummary(6, 10, "recovery"), movingSeconds: 3800, averageHr: 132 },
    { ...runSummary(8, 10, "tempo"), movingSeconds: 2800, averageHr: 165 }
  ];

  const reference = easyRunReference(runs, anchor);

  assert.equal(reference?.method, "labelled_easy_runs");
  assert.deepEqual(reference?.paceSecPerKm, { low: 345, high: 380, median: 360 });
  assert.deepEqual(reference?.hrBpm, { low: 130, high: 142, median: 138 });
});

test("easy reference falls back to the slower half of flat runs and needs enough runs", () => {
  const anchor = Date.parse(WEEK_START);
  const unlabelled = [300, 320, 340, 360, 380, 400].map((secPerKm, index) => {
    const { kind: _kind, ...summary } = runSummary(index + 1, 10, "easy");
    return { ...summary, movingSeconds: secPerKm * 10, averageHr: 130 + index * 4 };
  });

  const reference = easyRunReference(unlabelled, anchor);
  assert.equal(reference?.method, "slower_half_of_flat_runs");
  assert.equal(reference?.paceSecPerKm?.median, 380);

  assert.equal(easyRunReference(unlabelled.slice(0, 3), anchor), null);
});

function contextWith(overrides: Partial<RunningContext>): CoachContext {
  return {
    profile: {
      baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
      goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
      profileNotes: "",
      weekStart: WEEK_START,
      weeklySessions: 3,
      trainingDays: [],
      trainingDayOffsets: [],
      equipment: ["pullUpBar"],
      targetDate: "2027-05-11T00:00:00Z"
    },
    history: {
      last5Logs: [],
      rpeCalibration: { recentPlannedLogCount: 0, averageDeltaLast5: null, abovePlanBy2Count: 0, belowPlanBy2Count: 0, latestSummary: null },
      currentPartialMonth: emptyMonth("2026-05", true),
      lastFullMonth: emptyMonth("2026-04", false),
      previousFullMonth: emptyMonth("2026-03", false),
      twoFullMonthTrend: { pullUpsDelta: null, pushUpsDelta: null, plankSecondsDelta: null, logCountDelta: 0, label: "insufficient_history" },
      bestRecentTests: { pullUps: 10, pushUps: 40, plankSeconds: 90 }
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
    readiness: { state: "building", riskFlags: [] },
    running: {
      raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-07-20T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
      baselineWeeklyKm: 45,
      longestRecentRunKm: 20,
      runningDays: ["tuesday", "thursday", "saturday", "sunday"],
      runningDayOffsets: [1, 3, 5, 6],
      longRunDay: "saturday",
      longRunDayOffset: 5,
      recentRuns: [],
      weeksToRace: 10,
      ...overrides
    }
  };
}

function sixDayContext(overrides: Partial<RunningContext>): CoachContext {
  return contextWith({
    runningDays: ["tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    ...overrides
  });
}

/**
 * Weekly totals oldest first, ending the day before WEEK_START (or `weeksAgo`
 * weeks earlier). Each week: easy 18%, tempo 22%, long 44%, recovery 16%.
 */
function steadyWeeks(weeklyKm: number[], weeksAgo = 0): RunSummary[] {
  const runs: RunSummary[] = [];
  weeklyKm.forEach((km, index) => {
    const weekEndDaysAgo = (weeklyKm.length - 1 - index + weeksAgo) * 7 + 1;
    const parts: Array<[number, number, string, number]> = [
      [6, 0.18, "easy", 140],
      [4, 0.22, "tempo", 160],
      [2, 0.44, "long", 145],
      [1, 0.16, "recovery", 132]
    ];
    for (const [dayInWeek, share, kind, hr] of parts) {
      const daysAgo = weekEndDaysAgo + dayInWeek - 1;
      const distanceKm = Math.round(km * share * 10) / 10;
      runs.push({ ...runSummary(daysAgo, distanceKm, kind), averageHr: hr, movingSeconds: Math.round(distanceKm * (kind === "tempo" ? 290 : 360)) });
    }
  });
  return runs.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}

function runSummary(daysAgo: number, distanceKm: number, kind: string): RunSummary {
  return {
    completedAt: new Date(Date.parse(WEEK_START) - daysAgo * DAY_MS + 8 * 60 * 60 * 1000).toISOString(),
    distanceKm,
    movingSeconds: Math.round(distanceKm * 360),
    elevationGainM: 80,
    kind
  };
}

function validFourRunWeek(): RunningWeek {
  return runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 22),
    run("Recovery jog", 6, "recovery", 6)
  ]);
}

function runningWeek(sessions: RunningWeek["sessions"]): RunningWeek {
  return { summary: "Build week.", safetyFlags: [], sessions };
}

function run(title: string, dayOffset: number, kind: RunKind, distanceKm: number): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Build durable aerobic capacity for the race.",
    distanceKm,
    durationMinutes: Math.round(distanceKm * 6),
    elevationMeters: 120,
    target: { type: "pace", low: 330, high: 380 },
    zone: "Zone 2",
    notes: ["Keep the effort conversational."]
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
