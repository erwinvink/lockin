import assert from "node:assert/strict";
import test from "node:test";
import { validateRunningWeek } from "./validate-running-week";
import type { CoachContext, RunKind, RunningContext, RunningWeek } from "./types";

const baseRunning: RunningContext = {
  raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-09-12T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
  baselineWeeklyKm: 45,
  longestRecentRunKm: 20,
  runningDays: ["tuesday", "thursday", "saturday", "sunday"],
  runningDayOffsets: [1, 3, 5, 6],
  longRunDay: "saturday",
  recentRuns: [],
  weeksToRace: 18
};

const baseContext: CoachContext = {
  profile: {
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-05-11T00:00:00Z",
    weeklySessions: 4,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar", "yogaMat"],
    targetDate: "2027-05-11T00:00:00Z"
  },
  history: {
    last5Logs: [],
    rpeCalibration: {
      recentPlannedLogCount: 0,
      averageDeltaLast5: null,
      abovePlanBy2Count: 0,
      belowPlanBy2Count: 0,
      latestSummary: null
    },
    currentPartialMonth: emptyMonth("2026-05", true),
    lastFullMonth: emptyMonth("2026-04", false),
    previousFullMonth: emptyMonth("2026-03", false),
    twoFullMonthTrend: {
      pullUpsDelta: null,
      pushUpsDelta: null,
      plankSecondsDelta: null,
      logCountDelta: 0,
      label: "insufficient_history"
    },
    bestRecentTests: { pullUps: 5, pushUps: 20, plankSeconds: 60 }
  },
  adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
  plannedWork: {
    recentGoalTargets: {
      pullUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
      pushUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
      plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
    }
  },
  readiness: { state: "insufficient_history", riskFlags: [] },
  running: baseRunning
};

test("accepts a valid four-run week on the selected running days", () => {
  const result = validateRunningWeek(validWeek(), baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects a run scheduled for today", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], dayOffset: 0 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("today is locked")));
});

test("rejects runs scheduled outside the selected running-day offsets", () => {
  const week = validWeek();
  week.sessions[1] = { ...week.sessions[1], dayOffset: 2 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("non-running day")));
});

test("rejects non-increasing day offsets", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], dayOffset: 3 };
  week.sessions[1] = { ...week.sessions[1], dayOffset: 1 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("strictly increasing")));
});

test("rejects fewer runs than selected running days", () => {
  const week = validWeek();
  week.sessions = week.sessions.slice(0, 3);

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("exactly 4 runs")));
});

test("rejects a long run jumping more than 40% past the recent longest run without safety flags", () => {
  const week = validWeek();
  week.sessions[2] = { ...week.sessions[2], distanceKm: 30, durationMinutes: 195 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("40%")));
});

test("accepts the same long-run jump when safety flags explain it", () => {
  const week = validWeek();
  week.sessions[2] = { ...week.sessions[2], distanceKm: 30, durationMinutes: 195 };
  week.safetyFlags = ["Race distance demands a longer run; the rest of the week stays easy."];

  const result = validateRunningWeek(week, baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects a week where hard sessions outnumber half the runs without safety flags", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], kind: "hills" };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("hard running")));
});

test("accepts a hard-heavy week when safety flags explain it", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], kind: "hills" };
  week.safetyFlags = ["Deliberate back-to-back stimulus before next week's recovery block."];

  const result = validateRunningWeek(week, baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects a target whose low bound exceeds its high bound", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], target: { type: "pace", low: 400, high: 350 } };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("target low")));
});

test("rejects negative distance, duration, or elevation", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], distanceKm: -1 };
  week.sessions[1] = { ...week.sessions[1], durationMinutes: -30 };
  week.sessions[3] = { ...week.sessions[3], elevationMeters: -50 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.equal(result.messages.filter((message) => message.includes("negative")).length, 3);
});

test("rejects the longest run landing off the selected long-run day", () => {
  const week = validWeek();
  week.sessions[1] = { ...week.sessions[1], distanceKm: 24, durationMinutes: 150 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("long-run day")));
});

test("allows the longest run on the race-day offset even when it is not the long-run day", () => {
  const context = contextWith({
    raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-05-17T00:00:00Z" }
  });
  const week: RunningWeek = {
    summary: "Race week: short shakeouts, then the race effort on Sunday.",
    safetyFlags: [],
    sessions: [
      run("Easy shakeout", 1, "easy", 6),
      run("Recovery jog", 3, "recovery", 5),
      run("Pre-race shakeout", 5, "easy", 4),
      run("Race-day effort", 6, "long", 24)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("still applies ordering, target, negative, jump, and balance checks when no running days are selected", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined });
  const week: RunningWeek = {
    summary: "Improvised mid-week plan",
    safetyFlags: [],
    sessions: [
      { ...run("Tempo blocks", 2, "tempo", 10), target: { type: "pace", low: 400, high: 350 } },
      run("Intervals", 2, "intervals", -8),
      run("Long trail run", 5, "long", 35)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("strictly increasing")));
  assert.ok(result.messages.some((message) => message.includes("target low")));
  assert.ok(result.messages.some((message) => message.includes("negative")));
  assert.ok(result.messages.some((message) => message.includes("40%")));
  assert.ok(result.messages.some((message) => message.includes("hard running")));
  assert.ok(!result.messages.some((message) => message.includes("exactly")));
  assert.ok(!result.messages.some((message) => message.includes("non-running day")));
});

test("accepts an empty session list when the running week is already underway", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined });
  const week: RunningWeek = {
    summary: "This running week is already underway; the next full week starts after the coming rest days.",
    safetyFlags: [],
    sessions: []
  };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

function contextWith(overrides: Partial<RunningContext>): CoachContext {
  return {
    ...baseContext,
    running: { ...baseRunning, ...overrides }
  };
}

function validWeek(): RunningWeek {
  return {
    summary: "Steady aerobic week with one quality session and the long run on Saturday.",
    safetyFlags: [],
    sessions: [
      run("Easy aerobic run", 1, "easy", 8),
      run("Tempo blocks", 3, "tempo", 10),
      run("Long trail run", 5, "long", 22),
      run("Recovery jog", 6, "recovery", 6)
    ]
  };
}

function run(title: string, dayOffset: number, kind: RunKind, distanceKm: number): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Build durable aerobic capacity for the race.",
    distanceKm,
    durationMinutes: Math.round(Math.abs(distanceKm) * 6),
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
