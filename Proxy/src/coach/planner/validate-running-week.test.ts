import assert from "node:assert/strict";
import test from "node:test";
import { RELAXATION_LABELS, runningGuardrails, runningGuardrailsForPrompt } from "./running-guardrails";
import { runningDayAvailability, validateRunningWeek } from "./validate-running-week";
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
  const sparse = result.messages.find((message) => message.includes("too sparse"));
  // The repair names every computed reason that may lower the run count, in plain words.
  for (const label of Object.values(RELAXATION_LABELS)) assert.ok(sparse?.includes(label), `${sparse} names ${label}`);
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

test("rejects six running days even for an established high-volume athlete", () => {
  const context = contextWith({
    baselineWeeklyKm: 80,
    longestRecentRunKm: 35,
    runningDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    longRunDay: "saturday",
    longRunDayOffset: 6,
    recentRuns: Array.from({ length: 16 }, (_, index) => ({
      completedAt: new Date(Date.UTC(2026, 3, index + 1, 8)).toISOString(),
      distanceKm: 10,
      movingSeconds: 3600,
      elevationGainM: 100
    }))
  });
  const week: RunningWeek = {
    summary: "Six-day week.",
    safetyFlags: [],
    sessions: [
      run("Easy one", 1, "easy", 10),
      run("Tempo", 2, "tempo", 12),
      run("Easy three", 3, "easy", 10),
      run("Easy four", 4, "easy", 10),
      run("Recovery", 5, "recovery", 8),
      run("Long run", 6, "long", 30)
    ]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("complete rest day")));
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

// The cap was 1.4x the recent longest run; it is 1.15x now (Frandsen 2025).
// No runs on record here, so the reference is the app's recent longest run (20 km).
test("rejects a long run jumping more than 15% past the recent longest run without safety flags", () => {
  const week = validWeek();
  week.sessions[2] = { ...week.sessions[2], distanceKm: 30, durationMinutes: 195 };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("more than 15% above")));
});

// Finding: any safety flag used to waive the long-run cap. Flags are notes now.
test("a safety flag no longer waives the long-run cap", () => {
  const week = validWeek();
  week.sessions[2] = { ...week.sessions[2], distanceKm: 30, durationMinutes: 195 };
  week.safetyFlags = ["Race distance demands a longer run; the rest of the week stays easy."];

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  const message = result.messages.find((m) => m.includes("more than 15% above"));
  assert.ok(message);
  assert.ok(message.includes("30 km") && message.includes("cap 23 km") && message.includes("20 km"), message);
  assert.ok(message.includes("safety flags cannot waive"));
});

test("rejects a week where hard sessions outnumber half the runs without safety flags", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], kind: "hills" };

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("hard running")));
});

// Finding: any safety flag used to waive the hard-run ratio. Flags are notes now.
test("a safety flag no longer waives the hard-run cap", () => {
  const week = validWeek();
  week.sessions[0] = { ...week.sessions[0], kind: "hills" };
  week.safetyFlags = ["Deliberate back-to-back stimulus before next week's recovery block."];

  const result = validateRunningWeek(week, baseContext);

  assert.equal(result.accepted, false);
  const message = result.messages.find((m) => m.includes("hard running"));
  assert.ok(message);
  assert.ok(message.includes("3 hard runs") && message.includes("capped at 2"));
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
      run("Easy shakeout", 1, "easy", 4),
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
      run("Easy shakeout", 1, "easy", 4),
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
  // General preparation: the week carries its quality run (the floors).
  const week: RunningWeek = {
    summary: "Mid-week start with the long run on Saturday.",
    safetyFlags: [],
    sessions: [
      run("Tempo blocks", 1, "tempo", 8),
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
  // The longest run is off Saturday and inside the 23 km long-run cap.
  week.sessions[1] = { ...week.sessions[1], distanceKm: 23, durationMinutes: 144 };
  // Keep the week inside the weekly volume cap (51.8 km from the 45 km baseline).
  week.sessions[2] = { ...week.sessions[2], distanceKm: 12, durationMinutes: 75 };

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
      run("Easy shakeout", 1, "easy", 4),
      run("Long trail run", 3, "long", 24),
      run("Pre-race shakeout", 5, "easy", 5),
      run("Recovery jog", 6, "recovery", 4)
    ]
  };

  const result = validateRunningWeek(week, context);

  // Race week holds no long run (the long-run day is free there), so the
  // drifting long run is now rejected by the race-week rule instead.
  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("Run 2 (Long trail run) is a long run on offset 3") && message.includes("only short easy runs or shakeouts")));
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
  assert.ok(result.messages.some((message) => message.includes("more than 15% above")));
  assert.ok(result.messages.some((message) => message.includes("hard running")));
  assert.ok(!result.messages.some((message) => message.includes("exactly")));
  assert.ok(!result.messages.some((message) => message.includes("non-running day")));
});

test("accepts an empty session list when the running week is already underway", () => {
  // Saturday-only runner on a Saturday: a selection exists, but no selected day is left this week.
  const context = contextWith({ runningDays: ["saturday"], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
  const week: RunningWeek = {
    summary: "This running week is already underway; the next full week starts after the coming rest days.",
    safetyFlags: [],
    sessions: []
  };

  const result = validateRunningWeek(week, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects runs on non-running days when the selected days have no offset left (S6)", () => {
  const context = contextWith({ runningDays: ["saturday"], runningDayOffsets: [], longRunDay: "saturday", longRunDayOffset: undefined });
  const week: RunningWeek = {
    summary: "Runs spread through the week.",
    safetyFlags: [],
    sessions: [run("Easy aerobic run", 1, "easy", 8), run("Tempo blocks", 3, "tempo", 10), run("Easy aerobic run", 5, "easy", 8)]
  };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.equal(result.messages.filter((message) => message.includes("non-running day")).length, 3);
});

test("treats an empty running-day selection as unconstrained (S6)", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
  const week: RunningWeek = {
    summary: "Steady aerobic week placed freely.",
    safetyFlags: [],
    sessions: [
      run("Easy aerobic run", 1, "easy", 8),
      run("Tempo blocks", 2, "tempo", 10),
      run("Long trail run", 4, "long", 22),
      run("Recovery jog", 6, "recovery", 6)
    ]
  };

  assert.deepEqual(validateRunningWeek(week, context), { accepted: true, messages: [] });
});

test("an unconstrained selection still needs runs this week (S6)", () => {
  const context = contextWith({ runningDays: [], runningDayOffsets: [], longRunDay: undefined, longRunDayOffset: undefined });
  const week: RunningWeek = { summary: "Nothing planned.", safetyFlags: [], sessions: [] };

  const result = validateRunningWeek(week, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("at least one run")));
});

test("running-day availability distinguishes no selection from no days left (S6)", () => {
  assert.deepEqual(
    runningDayAvailability(contextWith({ runningDays: [], runningDayOffsets: [] })),
    { unconstrained: true, offsets: [1, 2, 3, 4, 5, 6] }
  );
  assert.deepEqual(
    runningDayAvailability(contextWith({ runningDays: ["saturday"], runningDayOffsets: [] })),
    { unconstrained: false, offsets: [] }
  );
  assert.deepEqual(
    runningDayAvailability(contextWith({ runningDays: ["tuesday", "thursday"], runningDayOffsets: [1, 3] })),
    { unconstrained: false, offsets: [1, 3] }
  );
});

// weeksToRace reads 0 for any past race; the message says how long ago it was.
test("the back-to-back long-run message never calls a past race 0 weeks out", () => {
  const week: RunningWeek = {
    summary: "Two long runs at the weekend.",
    safetyFlags: [],
    sessions: [run("Easy aerobic run", 1, "easy", 8), run("Long trail run", 5, "long", 18), run("Second long run", 6, "long", 12)]
  };
  const context = contextWith({
    raceGoal: { name: "Trail 54K", raceDate: "2026-04-26T00:00:00Z", distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  });

  const message = validateRunningWeek(week, context).messages.find((m) => m.includes("Back-to-back long runs"));
  assert.ok(message);
  assert.ok(message.includes("(this race: 54 km, 15 days ago)"), message);
  assert.ok(!message.includes("weeks out)"), message);
});

test("the back-to-back long-run message says race day and a missing race date plainly", () => {
  const week: RunningWeek = {
    summary: "Two long runs at the weekend.",
    safetyFlags: [],
    sessions: [run("Easy aerobic run", 1, "easy", 8), run("Long trail run", 5, "long", 18), run("Second long run", 6, "long", 12)]
  };
  const message = (raceDate: string) => validateRunningWeek(week, contextWith({
    raceGoal: { name: "Trail 54K", raceDate, distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  })).messages.find((m) => m.includes("Back-to-back long runs")) ?? "";

  assert.ok(message("2026-05-11T00:00:00Z").includes("(this race: 54 km, today)"), message("2026-05-11T00:00:00Z"));
  assert.ok(message("not-a-date").includes("(this race: 54 km, no race date)"), message("not-a-date"));
  assert.ok(message("2026-07-20T00:00:00Z").includes("(this race: 54 km, 10 weeks out)"), message("2026-07-20T00:00:00Z"));
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
  // resolving the correct offset. Race-week shakeouts are now capped (5 km
  // without a normal easy run on record), so the first one is 4 km, not 6.
  return {
    summary: "Race week: easy running around the mid-week race effort.",
    safetyFlags: [],
    sessions: [
      run("Easy shakeout", 1, "easy", 4),
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

test("accepts an all-easy week for a computed reason, in taper, or with few runs, but not for a safety flag", () => {
  // Finding: a safety flag used to excuse an all-easy build week.
  const flagged = raceExemptionWeek();
  flagged.sessions = flagged.sessions.map((s) => ({ ...s, kind: "easy", distanceKm: 6 }));
  flagged.safetyFlags = ["Recovery week after a 15% volume block."];
  assert.equal(
    validateRunningWeek(flagged, { ...baseContext, running: { ...baseRunning, weeksToRace: 10 } }).accepted,
    false
  );

  // A computed recovery need (logged pain); strength-only overreaching no longer relaxes running (Task 8).
  const recovery = raceExemptionWeek();
  recovery.sessions = recovery.sessions.map((s) => ({ ...s, kind: "easy", distanceKm: 6 }));
  assert.equal(
    validateRunningWeek(recovery, {
      ...baseContext,
      readiness: { state: "recovery_needed", riskFlags: ["recent_pain_level_4_or_higher"] },
      running: { ...baseRunning, weeksToRace: 10 }
    }).accepted,
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

test("one short run in six weeks does not shrink the cap below the 20 km return cap", () => {
  const sparse = contextWith({
    baselineWeeklyKm: 1.3,
    longestRecentRunKm: 5,
    runningDays: ["tuesday", "thursday", "saturday"],
    runningDayOffsets: [1, 3, 5],
    recentRuns: [{ completedAt: "2026-04-21T08:00:00Z", distanceKm: 5, movingSeconds: 1800, elevationGainM: 40, kind: "easy" }]
  });
  const guardrails = runningGuardrails(sparse);

  assert.deepEqual(
    guardrails.weeklyVolume.kind === "capped" ? guardrails.weeklyVolume.capKm : null,
    20
  );
  // 80 m a run keeps the week inside the 300 m minimum weekly climbing cap.
  const week: RunningWeek = {
    summary: "Starter week.",
    safetyFlags: [],
    sessions: [run("Easy", 1, "easy", 3), run("Easy", 3, "easy", 3), run("Long", 5, "long", 5)].map((session) => ({ ...session, elevationMeters: 80 }))
  };
  assert.deepEqual(validateRunningWeek(week, sparse, guardrails), { accepted: true, messages: [] });

  const baselineOnly = runningGuardrails(contextWith({ baselineWeeklyKm: 1.3, longestRecentRunKm: 5, recentRuns: [] }));
  assert.equal(baselineOnly.weeklyVolume.kind === "capped" ? baselineOnly.weeklyVolume.capKm : null, 20);
});

test("the run floor never asks for more minimum-length runs than the weekly cap holds", () => {
  // Three 1 km runs in the last four weeks: an established pattern, so the
  // 15% / 3 km rule applies (1 km in the last 7 days + 3 km = 4 km) and only one 3 km run fits.
  const tiny = contextWith({
    baselineWeeklyKm: 0.8,
    longestRecentRunKm: 1,
    recentRuns: ["2026-04-20", "2026-04-27", "2026-05-04"].map((day) => ({
      completedAt: `${day}T08:00:00Z`, distanceKm: 1, movingSeconds: 400, elevationGainM: 0, kind: "easy"
    }))
  });
  const guardrails = runningGuardrails(tiny);

  assert.equal(guardrails.weeklyVolume.kind === "capped" ? guardrails.weeklyVolume.capKm : null, 4);
  assert.equal(guardrails.frequency?.minRuns, 1);
  assert.match(guardrails.frequency?.basis ?? "", /at most 1 runs of 3 km fit the 4 km cap/);
});

// A profile pain note used to lower the run floor; free text now relaxes no
// rule (the note is planner context), so the floors stay.
test("a profile note lowers neither the run floor nor the quality-session rule", () => {
  const established = contextWith({
    baselineWeeklyKm: 40,
    longestRecentRunKm: 18,
    runningDays: ["tuesday", "wednesday", "thursday", "saturday", "sunday"],
    runningDayOffsets: [1, 2, 3, 5, 6]
  });
  const withNote = (profileNotes: string): CoachContext => ({ ...established, profile: { ...established.profile, profileNotes } });
  const twoRuns: RunningWeek = { summary: "Lighter week.", safetyFlags: [], sessions: [run("Easy", 1, "easy", 8), run("Long", 5, "long", 16)] };
  const allEasy: RunningWeek = {
    summary: "Easy week.",
    safetyFlags: [],
    sessions: [run("Easy", 1, "easy", 8), run("Easy", 3, "easy", 8), run("Easy", 5, "easy", 10), run("Easy", 6, "easy", 6)]
  };

  const painNote = withNote("Left Achilles sore after long downhills. Keep each strength session within 45 minutes.");
  assert.deepEqual(runningGuardrails(painNote).relaxations, []);
  assert.ok(validateRunningWeek(twoRuns, painNote).messages.some((m) => m.includes("too sparse")), "the run floor stays");
  assert.ok(validateRunningWeek(allEasy, painNote).messages.some((m) => m.includes("needs at least one quality session")), "the quality floor stays");
});

// Running floors by phase (audit: nothing required a quality session or a
// volume floor, so weeks drifted into easy-only maintenance). The race is 124
// days out here: general preparation. Without logged runs there is no
// weekly-km floor (it holds last week's training km at most).
function sixDayContext(overrides: Partial<RunningContext> = {}): CoachContext {
  return contextWith({
    runningDays: ["tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    ...overrides
  });
}

function easyWeekWithLongRun(): RunningWeek {
  return {
    summary: "Easy aerobic week.",
    safetyFlags: [],
    sessions: [
      run("Easy aerobic run", 1, "easy", 8),
      run("Easy aerobic run", 2, "easy", 8),
      run("Easy aerobic run", 3, "easy", 8),
      run("Long trail run", 5, "long", 18),
      run("Easy aerobic run", 6, "easy", 6)
    ]
  };
}

test("general preparation rejects an all-easy week with a long run", () => {
  const result = validateRunningWeek(easyWeekWithLongRun(), sixDayContext());

  assert.equal(result.accepted, false);
  assert.equal(result.messages.length, 1, result.messages.join("\n"));
  assert.match(result.messages[0], /needs at least one quality session/);
  assert.match(result.messages[0], /the long run does not count/);
  assert.match(result.messages[0], /general preparation/);
  // The repair text names every computed reason that lifts the floor, and what cannot.
  for (const label of Object.values(RELAXATION_LABELS)) assert.ok(result.messages[0].includes(label), `names ${label}`);
  assert.match(result.messages[0], /a profile note, a wellness gate and a safety flag cannot/);
});

test("a tempo run satisfies the quality floor", () => {
  const week = easyWeekWithLongRun();
  week.sessions[1] = { ...week.sessions[1], title: "Tempo blocks", kind: "tempo" };

  assert.deepEqual(validateRunningWeek(week, sixDayContext()), { accepted: true, messages: [] });
});

test("transition accepts an all-easy week", () => {
  // Day 10 after a 54 km race: the post-race transition lasts until day 14.
  const context = contextWith({ raceGoal: { name: "Trail 54K", raceDate: "2026-05-01T00:00:00Z", distanceKm: 54, elevationGainM: 1400 }, weeksToRace: 0 });
  const week: RunningWeek = {
    summary: "Easy week after the race.",
    safetyFlags: [],
    sessions: [run("Recovery jog", 1, "recovery", 5), run("Easy run with strides", 3, "easy", 6), run("Easy long run", 5, "easy", 9), run("Easy run", 6, "easy", 5)]
  };
  const guardrails = runningGuardrails(context);

  assert.equal(guardrails.floors.qualityRun.required, false);
  assert.equal(guardrails.floors.weeklyKm.minKm, null);
  assert.match(guardrails.floors.qualityRun.reason, /transition/);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

// Four logged 45 km weeks: 85% of the four-week training average (38.3 km)
// is under last week's 45 km, so the weekly-km floor is 38.3 km.
function steadyHistory(): RunningContext["recentRuns"] {
  const parts: Array<[number, number, string]> = [[1, 7, "recovery"], [2, 20, "long"], [4, 10, "tempo"], [6, 8, "easy"]];
  return [0, 1, 2, 3].flatMap((week) => parts.map(([day, distanceKm, kind]) => ({
    completedAt: new Date(Date.parse(baseContext.profile.weekStart) - (week * 7 + day) * 24 * 60 * 60 * 1000 + 8 * 60 * 60 * 1000).toISOString(),
    distanceKm,
    movingSeconds: distanceKm * 360,
    elevationGainM: 150,
    kind
  })));
}

test("general preparation rejects a week under 85% of the reference km and accepts one at 90%", () => {
  const context = sixDayContext({ recentRuns: steadyHistory() });
  const guardrails = runningGuardrails(context);
  assert.equal(guardrails.floors.weeklyKm.minKm, 38.3);

  const short: RunningWeek = {
    summary: "Short week.",
    safetyFlags: [],
    sessions: [run("Easy", 1, "easy", 6), run("Tempo blocks", 2, "tempo", 8), run("Easy", 3, "easy", 6), run("Long trail run", 5, "long", 12), run("Easy", 6, "easy", 4)]
  };
  const result = validateRunningWeek(short, context, guardrails);
  assert.equal(result.accepted, false);
  const message = result.messages.find((m) => m.includes("below this week's floor"));
  assert.ok(message?.includes("36 km") && message.includes("38.3 km") && message.includes("85%") && message.includes("45 km"), result.messages.join("\n"));
  assert.ok(message?.includes("a recent run rated feel 1-2 or missing run history; a profile note, a wellness gate and a safety flag cannot"), message);

  const enough: RunningWeek = {
    ...short,
    sessions: [run("Easy", 1, "easy", 7), run("Tempo blocks", 2, "tempo", 8), run("Easy", 3, "easy", 7), run("Long trail run", 5, "long", 14), run("Easy", 6, "easy", 4.5)]
  };
  assert.deepEqual(validateRunningWeek(enough, context, guardrails), { accepted: true, messages: [] });
});

test("the planner is told the floors it must meet", () => {
  const prompt = runningGuardrailsForPrompt(runningGuardrails(sixDayContext({ recentRuns: steadyHistory() }))) as {
    floors: { qualityRun: { required: boolean }; weeklyKm: { minKm: number | null }; rule: string };
  };

  assert.equal(prompt.floors.qualityRun.required, true);
  assert.equal(prompt.floors.weeklyKm.minKm, 38.3);
  assert.match(prompt.floors.rule, /3 or more runs/);
  assert.match(prompt.floors.rule, /the long run does not count/);
});
