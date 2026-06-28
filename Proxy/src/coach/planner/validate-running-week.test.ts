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
  longRunDayOffset: 5,
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
    todaySessions: [],
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
  assert.ok(result.messages.some((message) => message.includes("strictly later than the previous run")));
});

test("rejects a too-sparse established build week without safety flags", () => {
  const week = validWeek();
  week.sessions = week.sessions.slice(0, 3);

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("too sparse")));
});

test("accepts a progressive subset of six available days for an established base", () => {
  const context = contextWith({
    runningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    longRunDay: "friday",
    longRunDayOffset: 5
  });
  const week = validWeek();

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects daily running for a starter base even when six days are available", () => {
  const context = contextWith({
    baselineWeeklyKm: 0,
    longestRecentRunKm: 0,
    runningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    longRunDay: "saturday",
    longRunDayOffset: 6,
    recentRuns: []
  });
  const week: RunningWeek = {
    summary: "Daily starter week.",
    safetyFlags: [],
    sessions: [
      run("Easy starter run", 1, "easy", 3),
      run("Recovery jog", 2, "recovery", 3),
      run("Easy starter run", 3, "easy", 3),
      run("Recovery jog", 4, "recovery", 3),
      run("Easy starter run", 5, "easy", 3),
      run("Long starter run", 6, "long", 5)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("Starter running weeks")));
});

test("accepts a three-run starter week from six available days", () => {
  const context = contextWith({
    baselineWeeklyKm: 0,
    longestRecentRunKm: 0,
    runningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    longRunDay: "friday",
    longRunDayOffset: 5,
    recentRuns: []
  });
  const week: RunningWeek = {
    summary: "Starter week with rest days between runs and one longer aerobic touch.",
    safetyFlags: ["Minimal assessment week because no recent running history is available."],
    sessions: [
      run("Easy starter run", 1, "easy", 3),
      run("Easy aerobic run", 3, "easy", 4),
      run("Long starter run", 5, "long", 5)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
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

test("keeps the race-day exemption stable across a DST transition", () => {
  // UK-style spring-forward week: weekStart is GMT local midnight (00:00Z) while
  // the race date is BST local midnight (23:00Z on the previous UTC day), a raw
  // difference of 5d23h. Truncating both instants to UTC calendar days computed
  // offset 5; rounding the raw difference correctly yields offset 6.
  const context: CoachContext = {
    ...baseContext,
    profile: { ...baseContext.profile, weekStart: "2026-03-23T00:00:00Z" },
    running: {
      ...baseRunning,
      raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-03-28T23:00:00Z" }
    }
  };
  const week: RunningWeek = {
    summary: "Race week across the clock change, with the race effort on Sunday.",
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

test("applies the race-day exemption across the October fall-back transition", () => {
  // Europe/London fall-back week: weekStart encodes local midnight Friday
  // 2026-10-23 BST (22T23:00Z) and the race local midnight Wednesday 2026-10-28
  // GMT (28T00:00Z), a raw difference of 5d1h. Rounding matches the app's
  // local-day offset 5; truncating both instants to UTC calendar days would
  // yield 6 and falsely reject the race-day long run.
  const context: CoachContext = {
    ...baseContext,
    profile: { ...baseContext.profile, weekStart: "2026-10-22T23:00:00Z" },
    running: {
      ...baseRunning,
      runningDays: ["monday", "wednesday", "thursday", "saturday"],
      runningDayOffsets: [1, 3, 5, 6],
      longRunDay: "saturday",
      longRunDayOffset: 1,
      raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-10-28T00:00:00Z" }
    }
  };

  const result = validateRunningWeek(raceExemptionWeek(), context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("applies the race-day exemption across the March spring-forward transition", () => {
  // Reverse case: weekStart local midnight Friday 2026-03-27 GMT (00:00Z) and
  // the race local midnight Wednesday 2026-04-01 BST (31T23:00Z), a raw
  // difference of 4d23h. Rounding restores the local-day offset 5; truncation
  // would land on 4.
  const context: CoachContext = {
    ...baseContext,
    profile: { ...baseContext.profile, weekStart: "2026-03-27T00:00:00Z" },
    running: {
      ...baseRunning,
      runningDays: ["monday", "wednesday", "thursday", "saturday"],
      runningDayOffsets: [1, 3, 5, 6],
      longRunDay: "saturday",
      longRunDayOffset: 1,
      raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-03-31T23:00:00Z" }
    }
  };

  const result = validateRunningWeek(raceExemptionWeek(), context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("keeps the race-day exemption unchanged when no DST transition is in play", () => {
  // Control for the two DST cases above: both instants are plain 00:00Z local
  // midnights five days apart, where rounding and UTC-day truncation agree.
  const context: CoachContext = {
    ...baseContext,
    profile: { ...baseContext.profile, weekStart: "2026-05-11T00:00:00Z" },
    running: {
      ...baseRunning,
      runningDays: ["tuesday", "thursday", "saturday", "sunday"],
      runningDayOffsets: [1, 3, 5, 6],
      longRunDay: "tuesday",
      longRunDayOffset: 1,
      raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-05-16T00:00:00Z" }
    }
  };

  const result = validateRunningWeek(raceExemptionWeek(), context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("places the long run correctly when the week starts mid-week (non-Monday)", () => {
  // weekStart Wednesday: offsets are rolling (thursday=1, saturday=3, sunday=4, tuesday=6),
  // so runningDayOffsets are NOT index-parallel with the Monday-first runningDays list.
  const context = wednesdayContext();
  const week: RunningWeek = {
    summary: "Mid-week start with the long run on Saturday.",
    safetyFlags: [],
    sessions: [
      run("Easy aerobic run", 1, "easy", 8),
      run("Long trail run", 3, "long", 22),
      run("Recovery jog", 4, "recovery", 6),
      run("Easy aerobic run", 6, "easy", 7)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects the longest run off the long-run day when the week starts mid-week (non-Monday)", () => {
  const context = wednesdayContext();
  const week: RunningWeek = {
    summary: "Mid-week start with the long run drifting to Sunday.",
    safetyFlags: [],
    sessions: [
      run("Easy aerobic run", 1, "easy", 8),
      run("Easy aerobic run", 3, "easy", 8),
      run("Long trail run", 4, "long", 22),
      run("Recovery jog", 6, "recovery", 6)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("long-run day")));
});

test("accepts co-longest runs when one of them lands on the long-run day", () => {
  const week: RunningWeek = {
    summary: "Tempo and long run share the top distance; the long run holds Saturday.",
    safetyFlags: [],
    sessions: [
      run("Tempo blocks", 1, "tempo", 10),
      run("Easy aerobic run", 3, "easy", 6),
      run("Long trail run", 5, "long", 10),
      run("Recovery jog", 6, "recovery", 5)
    ]
  };

  const result = validateRunningWeek(week, baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("skips long-run placement when longRunDayOffset is absent", () => {
  const context = contextWith({ longRunDayOffset: undefined });
  const week = validWeek();
  week.sessions[1] = { ...week.sessions[1], distanceKm: 24, durationMinutes: 150 };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("still enforces long-run placement when the race date is unparseable", () => {
  const context = contextWith({
    raceGoal: { ...baseRunning.raceGoal, raceDate: "not-a-date" }
  });
  const week = validWeek();
  week.sessions[1] = { ...week.sessions[1], distanceKm: 24, durationMinutes: 150 };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("long-run day")));
});

test("rejects the longest run when it lands on neither the race day nor the long-run day", () => {
  const context = contextWith({
    raceGoal: { ...baseRunning.raceGoal, raceDate: "2026-05-17T00:00:00Z" }
  });
  const week: RunningWeek = {
    summary: "Race week, but the longest effort drifts to Thursday.",
    safetyFlags: [],
    sessions: [
      run("Easy shakeout", 1, "easy", 6),
      run("Long trail run", 3, "long", 24),
      run("Pre-race shakeout", 5, "easy", 5),
      run("Recovery jog", 6, "recovery", 4)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("long-run day")));
});

test("rejects a non-integer day offset even when it falls inside 1 through 6", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
  const week: RunningWeek = {
    summary: "Improvised plan with a fractional offset.",
    safetyFlags: [],
    sessions: [run("Easy aerobic run", 2.5, "easy", 8)]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("dayOffset 1 through 6")));
});

test("still applies ordering, target, negative, jump, and balance checks when no running days are selected", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
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
  assert.ok(result.messages.some((message) => message.includes("strictly later than the previous run")));
  assert.ok(result.messages.some((message) => message.includes("target low")));
  assert.ok(result.messages.some((message) => message.includes("negative")));
  assert.ok(result.messages.some((message) => message.includes("40%")));
  assert.ok(result.messages.some((message) => message.includes("hard running")));
  assert.ok(!result.messages.some((message) => message.includes("exactly")));
  assert.ok(!result.messages.some((message) => message.includes("non-running day")));
});

test("accepts an empty session list when the running week is already underway", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
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

function wednesdayContext(): CoachContext {
  // 2026-05-13 is a Wednesday. Offsets are computed relative to the rolling
  // weekStart, so saturday sits at offset 3 even though it is third in the
  // Monday-first runningDays list (where indexOf would wrongly point at offset 4).
  return {
    ...baseContext,
    profile: { ...baseContext.profile, weekStart: "2026-05-13T00:00:00Z" },
    running: {
      ...baseRunning,
      runningDays: ["tuesday", "thursday", "saturday", "sunday"],
      runningDayOffsets: [1, 3, 4, 6],
      longRunDay: "saturday",
      longRunDayOffset: 3
    }
  };
}

function raceExemptionWeek(): RunningWeek {
  // The longest run sits on dayOffset 5 — the race day in the DST tests —
  // while longRunDayOffset is 1, so acceptance hinges on the race exemption
  // resolving the correct offset.
  return {
    summary: "Race week: easy running around the mid-week race effort.",
    safetyFlags: [],
    sessions: [
      run("Easy shakeout", 1, "easy", 6),
      run("Recovery jog", 3, "recovery", 5),
      run("Race-day effort", 5, "long", 24),
      run("Post-race jog", 6, "recovery", 4)
    ]
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

test("rejects an all-easy build week far from the race without safety flags", () => {
  const context: CoachContext = {
    ...baseContext,
    running: { ...baseRunning, weeksToRace: 10 }
  };
  const week = raceExemptionWeek();
  week.sessions = week.sessions.map((session, index) => ({
    ...session,
    kind: index === 0 ? "easy" : "recovery",
    distanceKm: 6
  }));

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.includes("at least one quality session")));
});

test("accepts an all-easy week with safety flags, in taper, or with few runs", () => {
  const flagged = raceExemptionWeek();
  flagged.sessions = flagged.sessions.map((s) => ({ ...s, kind: "easy", distanceKm: 6 }));
  flagged.safetyFlags = ["Recovery week after a 15% volume block."];
  assert.equal(
    validateRunningWeek(flagged, { ...baseContext, running: { ...baseRunning, weeksToRace: 10 } }).accepted,
    true
  );

  const taper = raceExemptionWeek();
  taper.sessions = taper.sessions.map((s) => ({ ...s, kind: "easy", distanceKm: 6 }));
  assert.equal(
    validateRunningWeek(taper, { ...baseContext, running: { ...baseRunning, weeksToRace: 2 } }).accepted,
    true
  );

  const sparse = raceExemptionWeek();
  sparse.sessions = sparse.sessions.slice(0, 2).map((s, i) => ({ ...s, kind: "easy", distanceKm: 6, dayOffset: i === 0 ? 1 : 3 }));
  const sparseContext: CoachContext = {
    ...baseContext,
    running: { ...baseRunning, weeksToRace: 10, runningDayOffsets: [1, 3], runningDays: ["tuesday", "thursday"], longRunDay: undefined, longRunDayOffset: undefined }
  };
  assert.equal(validateRunningWeek(sparse, sparseContext).accepted, true);
});
