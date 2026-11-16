import assert from "node:assert/strict";
import test from "node:test";
import {
  clampRunningWeek,
  countedHardRuns,
  easyRunReference,
  RELAXATION_LABELS,
  RUNNING_FLOOR_LIMITS,
  RUNNING_LIMITS,
  runningGuardrails,
  runningGuardrailsForPrompt,
  weeklyBudgetAfterToday
} from "./running-guardrails";
import { SEASON_LIMITS } from "./season";
import { validateRunningWeek } from "./validate-running-week";
import {
  contextWith,
  DAY_MS,
  postRaceContext,
  recoveryContext,
  run,
  runningWeek,
  runSummary,
  sixDayContext,
  steadyWeeks,
  taperContext,
  todayPlanned,
  validFourRunWeek,
  WEEK_START,
  withWellness,
  lowHrvDay
} from "./running.fixtures";
import type { CoachContext, RunSummary } from "./types";
import { WELLNESS_GATE_LIMITS } from "./wellness-gate";


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

// The long run sits inside the 22.8 km long-run cap (1.15x the 19.8 km
// longest run of the last 30 days), so only the weekly cap is at work.
test("clamp shortens easy and recovery runs to fit the weekly cap and the result validates", () => {
  const context = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 2, "tempo", 12),
    run("Easy aerobic run", 3, "easy", 10),
    run("Long trail run", 5, "long", 22),
    run("Recovery jog", 6, "recovery", 8)
  ]);
  const guardrails = runningGuardrails(context);

  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);

  assert.deepEqual(clamped.sessions.map((s) => s.distanceKm), [5, 12, 6.5, 22, 5]);
  assert.equal(clamped.sessions[0].durationMinutes, Math.round(48 * (5 / 8)));
  assert.ok(adjustments.some((a) => a.includes("60 km") && a.includes("51.8 km cap")));
  assert.deepEqual(week.sessions.map((s) => s.distanceKm), [8, 12, 10, 22, 8], "input is not mutated");
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });
});

test("clamp leaves the week alone when easy runs cannot absorb the excess, so validation rejects it", () => {
  // 52.5 km against the 51.8 km cap; the easy runs are already at the 3 km minimum.
  const context = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 3),
    run("Tempo blocks", 2, "tempo", 21),
    run("Easy aerobic run", 3, "easy", 3),
    run("Long trail run", 5, "long", 22.5),
    run("Recovery jog", 6, "recovery", 3)
  ]);

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.deepEqual(clamped.sessions.map((s) => s.distanceKm), [3, 21, 3, 22.5, 3]);
  assert.deepEqual(adjustments, []);
  assert.equal(validateRunningWeek(clamped, context).accepted, false);
});

test("the race-day session is outside the weekly and long-run caps", () => {
  // Seven steady weeks so the pre-taper average (the 4 weeks before 21 days
  // out) is on record. Race-week shakeouts are capped at 50% of a normal
  // easy run (8.1 km here, so 4 km); the 3 km shakeouts fit under it.
  const context = contextWith({
    recentRuns: steadyWeeks([45, 45, 45, 45, 45, 45, 45]),
    raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-05-17T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
    weeksToRace: 1
  });
  const week = runningWeek([
    run("Easy shakeout", 1, "easy", 3),
    run("Recovery jog", 3, "recovery", 3),
    run("Pre-race shakeout", 5, "easy", 3),
    run("Ridge Ultra 60K", 6, "long", 60)
  ]);
  // The race's own climbing is outside the weekly climbing cap too.
  week.sessions[3].elevationMeters = 2400;

  assert.deepEqual(validateRunningWeek(week, context), { accepted: true, messages: [] });
  assert.deepEqual(clampRunningWeek(week, context).adjustments, []);
});

// The cap was 1.4x the recent longest run; a run more than 10-30% past the
// 30-day longest already raises overuse injuries (Frandsen 2025), so it is 1.15x.
test("clamp shortens a run above the long-run cap and says so", () => {
  // The longest run of the last 30 days is the 19.8 km long run: cap 22.8 km.
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), longestRecentRunKm: 20 });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 6),
    run("Tempo blocks", 3, "tempo", 8),
    run("Long trail run", 5, "long", 32),
    run("Recovery jog", 6, "recovery", 5)
  ]);

  const rejected = validateRunningWeek(week, context).messages.find((m) => m.startsWith("Run 3 (Long trail run) is 32 km"));
  assert.ok(rejected?.includes("more than 15% above the longest training run of the last 30 days") && rejected.includes("19.8 km") && rejected.includes("cap 22.8 km"), rejected);

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.equal(clamped.sessions[2].distanceKm, 22.5);
  assert.equal(clamped.sessions[2].durationMinutes, Math.round(192 * (22.5 / 32)));
  assert.ok(clamped.sessions[2].notes.some((note) => note.includes("15%") && note.includes("19.8 km")), clamped.sessions[2].notes.join("\n"));
  assert.ok(adjustments.some((a) => a.includes("32 km to 22.5 km")));
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("the long-run cap is 1.15x the longest training run of the last 30 days", () => {
  // A 26 km run 35 days ago (and the app's six-week longest of 26 km) is too old to count.
  const runs = [...steadyWeeks([45, 45, 45, 45]), runSummary(35, 26, "long")];
  const guardrails = runningGuardrails(contextWith({ recentRuns: runs, longestRecentRunKm: 26 }));

  assert.deepEqual([guardrails.longRun?.referenceKm, guardrails.longRun?.capKm], [19.8, 22.8]);
  assert.match(guardrails.longRun?.basis ?? "", /longest training run of the last 30 days/);
  assert.equal(guardrails.longRun?.demonstratedCapacity, null);
  const prompt = runningGuardrailsForPrompt(guardrails) as { longRun: { rule: string } };
  assert.match(prompt.longRun.rule, /1\.15x the longest training run of the last 30 days/);
  assert.ok(!prompt.longRun.rule.includes("1.4x"));
});

// The planner names the reason a floor is lifted, so the prompt lists every
// one, with the numbers taken from the limits the code enforces.
test("the planner prompt builds its numbers from the limits and lists every reason that lifts a floor", () => {
  const guardrails = runningGuardrails(withWellness(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }), [lowHrvDay("2026-05-11")]));
  const prompt = runningGuardrailsForPrompt(guardrails) as {
    longRun: { rule: string };
    floors: { rule: string };
    wellnessGate: { rule: string };
    computedRelaxationRule: string;
    hardRuns: { maxHardRuns: Record<string, number | string>; counted: string };
  };
  const { longRunCapRatio, longRunWindowDays, recentRunWindowDays } = RUNNING_LIMITS;

  assert.ok(prompt.longRun.rule.includes(`${longRunCapRatio}x the longest training run of the last ${longRunWindowDays} days`), prompt.longRun.rule);
  assert.ok(prompt.longRun.rule.includes(`of the last ${recentRunWindowDays} days`), prompt.longRun.rule);
  assert.match(prompt.longRun.rule, /no runs on record/);
  assert.ok(prompt.floors.rule.includes(`${RUNNING_FLOOR_LIMITS.minRuns} or more runs`), prompt.floors.rule);
  assert.ok(prompt.floors.rule.includes("weeklyKm.reason") && !prompt.floors.rule.includes("four-week training average"), "the floor's numbers are stated once, in weeklyKm.reason");
  assert.ok(prompt.wellnessGate.rule.includes(`next ${WELLNESS_GATE_LIMITS.gateHours} hours`), prompt.wellnessGate.rule);
  for (const label of Object.values(RELAXATION_LABELS)) assert.ok(prompt.computedRelaxationRule.includes(label), label);
  for (const own of ["taper", "post-race transition", "starter base", "first week back", "the day after a hard run today", "race window"]) {
    assert.ok(prompt.computedRelaxationRule.includes(own), own);
  }
  assert.equal(prompt.hardRuns.maxHardRuns["5 or more runs"], 3);
  assert.match(prompt.hardRuns.counted, /today's run/);
});

test("a gate tripped by HRV and by sleep keeps the next 48 hours easy, in one sentence", () => {
  const wellness = [{ ...lowHrvDay("2026-05-09"), hrvStatus: null, sleepScore: 44 }, { ...lowHrvDay("2026-05-10"), hrvStatus: null, sleepScore: 44 }, lowHrvDay("2026-05-11")];
  const gate = runningGuardrails(withWellness(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }), wellness)).wellnessGate;

  assert.equal(gate?.reason, `HRV below your baseline and poor sleep on 2 of the last 3 nights keep the next ${WELLNESS_GATE_LIMITS.gateHours} hours easy`);
  assert.equal(runningGuardrails(withWellness(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }), [lowHrvDay("2026-05-11")])).wellnessGate?.reason, `HRV below your baseline keeps the next ${WELLNESS_GATE_LIMITS.gateHours} hours easy`);
});

// Audit: the race counted as the longest run, so after the 54 km race the cap read 75.6 km.
test("the 75.6 km post-race long-run cap is gone", () => {
  // Day 15 after a 54 km race: the race (on the stored race date) and a 21 km
  // race-kind run are demonstrated capacity; the longest training run is 18 km.
  const raceDate = new Date(Date.parse(WEEK_START) - 15 * DAY_MS).toISOString();
  const runs = [
    runSummary(29, 18, "long"),
    runSummary(22, 16, "long"),
    runSummary(20, 21, "race"),
    runSummary(15, 54, "long"),
    runSummary(10, 8, "easy"),
    runSummary(8, 10, "easy"),
    runSummary(5, 12, "long"),
    runSummary(3, 8, "easy"),
    runSummary(1, 8, "easy")
  ];
  const context = contextWith({
    recentRuns: runs,
    longestRecentRunKm: 54,
    raceGoal: { name: "Cauberg Trail", raceDate, distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  });
  const guardrails = runningGuardrails(context);

  assert.deepEqual([guardrails.longRun?.referenceKm, guardrails.longRun?.capKm], [18, 20.7], "1.15x the 18 km training run, not 1.4x the race");
  assert.match(guardrails.longRun?.demonstratedCapacity ?? "", /54 km race on 2026-04-26/);

  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 6),
    run("Tempo blocks", 3, "tempo", 6),
    run("Long trail run", 5, "long", 30),
    run("Recovery jog", 6, "recovery", 5)
  ]);
  assert.ok(validateRunningWeek(week, context, guardrails).messages.some((m) => m.startsWith("Run 3 (Long trail run) is 30 km") && m.includes("cap 20.7 km")));
  const { week: clamped } = clampRunningWeek(week, context, guardrails);
  assert.equal(clamped.sessions[2].distanceKm, 20.5);
});

// The fallback was the app's six-week longest run, which can be the race.
test("without a training run in the last 30 days the long-run cap falls back to the longest training run of the last 42 days", () => {
  const guardrails = runningGuardrails(contextWith({ recentRuns: [runSummary(33, 16, "long"), runSummary(36, 10, "easy")], longestRecentRunKm: 20 }));

  assert.deepEqual([guardrails.longRun?.referenceKm, guardrails.longRun?.capKm], [16, 18.4]);
  assert.match(guardrails.longRun?.basis ?? "", /last 42 days/);
});

test("a month off after the 54 km race does not give a 62 km cap", () => {
  // The race 32 days ago, the taper before it, nothing since; the app's six-week longest run is the race.
  const raceDate = new Date(Date.parse(WEEK_START) - 32 * DAY_MS).toISOString();
  const race = { name: "Cauberg Trail", raceDate, distanceKm: 54, elevationGainM: 1400 };
  const taper = [runSummary(34, 8, "easy"), runSummary(36, 14, "long"), runSummary(38, 10, "tempo"), runSummary(40, 9, "easy")];
  const guardrails = runningGuardrails(contextWith({ recentRuns: [...taper, runSummary(32, 54, "long")], longestRecentRunKm: 54, raceGoal: race, weeksToRace: 0 }));

  assert.deepEqual([guardrails.longRun?.referenceKm, guardrails.longRun?.capKm], [14, 16.1], "1.15x the 14 km taper long run");

  // Only the race in the last 42 days: the return-week cap, never 1.15x the race.
  const raceOnly = runningGuardrails(contextWith({ recentRuns: [runSummary(32, 54, "long"), runSummary(50, 15, "long")], longestRecentRunKm: 54, raceGoal: race, weeksToRace: 0 }));
  assert.equal(raceOnly.longRun?.referenceKm, null);
  assert.equal(raceOnly.longRun?.capKm, RUNNING_LIMITS.returningFromBreakCapKm);
  assert.match(raceOnly.longRun?.basis ?? "", /return-week cap/);
  const week = runningWeek([run("Easy aerobic run", 1, "easy", 6), run("Long trail run", 5, "long", 24), run("Easy aerobic run", 6, "easy", 5)]);
  const message = validateRunningWeek(week, contextWith({ recentRuns: [runSummary(32, 54, "long"), runSummary(50, 15, "long")], longestRecentRunKm: 54, raceGoal: race, weeksToRace: 0 }), raceOnly)
    .messages.find((m) => m.startsWith("Run 2 (Long trail run) is 24 km"));
  assert.ok(message?.includes(`cap of ${RUNNING_LIMITS.returningFromBreakCapKm} km`), message);
});

test("the race's climbing stays out of the weekly climbing reference", () => {
  // Day 15 after a 54 km / 1,400 m race; the training runs climb 80 m each (8 in 4 weeks: 160 m a week).
  const raceDate = new Date(Date.parse(WEEK_START) - 15 * DAY_MS).toISOString();
  const runs = [
    runSummary(26, 12, "long"), runSummary(24, 8, "easy"), runSummary(22, 10, "long"), runSummary(19, 6, "easy"),
    { ...runSummary(15, 54, "long"), elevationGainM: 1400 },
    runSummary(10, 6, "easy"), runSummary(6, 8, "easy"), runSummary(3, 6, "easy"), runSummary(1, 10, "long")
  ];
  const guardrails = runningGuardrails(contextWith({
    recentRuns: runs,
    raceGoal: { name: "Cauberg Trail", raceDate, distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  }));

  assert.deepEqual([guardrails.weeklyClimb?.fourWeekAvgM, guardrails.weeklyClimb?.capM], [160, 300]);
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

// Review finding: the hard-run cap counted the planned runs only, while
// today's run is part of the same 7 days as the floors and caps.
test("today's hard run counts toward the hard-run cap", () => {
  const today = { completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString(), distanceKm: 9, movingSeconds: 2700, elevationGainM: 60, kind: "intervals" };
  const withToday = (kind: string) => sixDayContext({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), { ...today, kind }], longRunDay: "sunday", longRunDayOffset: 6 });
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 5),
    run("Tempo blocks", 2, "tempo", 7),
    run("Easy aerobic run", 3, "easy", 5),
    run("Hill repeats", 4, "hills", 7),
    run("Long trail run", 6, "long", 16)
  ]);

  const message = validateRunningWeek(week, withToday("intervals")).messages.find((m) => m.startsWith("The week has"));
  assert.ok(message?.includes("4 hard runs") && message.includes("in 6 runs over the 7 days, today's intervals run included") && message.includes("capped at 3"), message);
  // After an easy run today the same week has 3 hard runs in 6: allowed.
  assert.deepEqual(validateRunningWeek(week, withToday("easy")), { accepted: true, messages: [] });
});

// Only a real run today adds to the run count: a 1 km jog must not open a
// third hard run for the planned week.
test("a jog under 3 km today does not add a run to the hard-run cap", () => {
  const easyToday = (distanceKm: number) =>
    sixDayContext({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), { ...runSummary(0, distanceKm, "easy"), completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString() }] });
  // Three hard runs in four planned runs.
  const week = runningWeek([run("Tempo blocks", 1, "tempo", 8), run("Easy aerobic run", 2, "easy", 6), run("Hill repeats", 3, "hills", 8), run("Long trail run", 5, "long", 16)]);

  const jog = validateRunningWeek(week, easyToday(1)).messages.find((m) => m.startsWith("The week has"));
  assert.ok(jog?.includes("3 hard runs") && jog.includes("in 4 runs;") && jog.includes("capped at 2"), jog);
  assert.deepEqual(validateRunningWeek(week, easyToday(5)), { accepted: true, messages: [] }, "a 5 km run today makes it 3 hard runs in 5");
});

// The count reads each run by its day, so it does not depend on the order of
// the runs or on where today's run sits.
test("the hard-run count reads runs by their day, and a race today is a hard run", () => {
  const hundred = sixDayContext({
    recentRuns: steadyWeeks([50, 50, 50, 50]),
    longestRecentRunKm: 24,
    raceGoal: { name: "Mozart 100", raceDate: "2026-07-06T00:00:00Z", distanceKm: 104, elevationGainM: 5000 },
    weeksToRace: 8
  });
  // Back-to-back long runs are one block, also when the runs come out of order.
  const unordered = runningWeek([run("Long trail run", 6, "long", 20), run("Long trail run", 5, "long", 18), run("Tempo blocks", 2, "tempo", 8)]);
  assert.equal(countedHardRuns(unordered, runningGuardrails(hundred)), 2);

  const raceToday: CoachContext = { ...hundred, todayPlannedRuns: [{ dayOffset: 0, title: "Tune-up race", kind: "race", distanceKm: 21, elevationMeters: 300, target: null }] };
  assert.equal(countedHardRuns(runningWeek([run("Tempo blocks", 2, "tempo", 8)]), runningGuardrails(raceToday)), 2);
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

// The wellness gate used to lower the run-count floor for the whole week. It
// now lifts no floor and only keeps quality runs out of the next 48 hours.
test("a safety flag does not lower the run-count floor, and neither does a wellness gate", () => {
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

  const gated = withWellness(established, [lowHrvDay("2026-05-11")]);
  const gatedGuardrails = runningGuardrails(gated);
  assert.ok(gatedGuardrails.wellnessGate, "the gate tripped");
  assert.deepEqual(gatedGuardrails.relaxations, [], "the gate is not a computed relaxation: it lifts no floor");
  assert.ok(validateRunningWeek(week, gated, gatedGuardrails).messages.some((m) => m.includes("too sparse") && m.includes("at least 4")));
});

test("a stale wellness day does not trip the gate", () => {
  const context: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }),
    garmin: {
      wellness: [{ date: "2026-05-01", sleepScore: 30, sleepSeconds: 18000, hrvStatus: "LOW", hrvMs: 30, bodyBattery: 10, trainingReadiness: 10, restingHr: 60 }]
    }
  };

  assert.equal(runningGuardrails(context).wellnessGate, null);
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

// A race is demonstrated capacity, never a long-run reference: without a
// periodization cap the recovery week's long run is 70% of the longest
// training run of the last 6 weeks, not of a 40 km race.
test("the race stays out of the recovery week's long-run reference", () => {
  const context = recoveryContext();
  context.periodization = { ...context.periodization!, recoveryWeek: { ...context.periodization!.recoveryWeek!, longRunCapKm: null } };
  context.running = { ...context.running!, recentRuns: [...context.running!.recentRuns, runSummary(10, 40, "race")] };

  assert.equal(runningGuardrails(context).phase.recoveryWeek?.longRunCapKm, 13.9, "70% of the 19.8 km training long run");
});

test("a recovery week caps volume, the long run and quality sessions, with the limit and value in each message", () => {
  const context = recoveryContext();
  const guardrails = runningGuardrails(context);
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 20),
    run("Hill repeats", 6, "hills", 8)
  ]);
  week.safetyFlags = ["Feeling great, keep it hard."];

  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 33.8);
  assert.ok(guardrails.relaxations.some((relaxation) => relaxation.code === "planned_recovery_week"));
  assert.equal(guardrails.qualityLimit?.max, 1);

  const messages = validateRunningWeek(week, context, guardrails).messages;
  assert.ok(messages.some((m) => m.includes("above this week's cap of 33.8 km (planned recovery week")), "safety flags do not waive it");
  assert.ok(messages.some((m) => m.includes("Run 3 (Long trail run) is 20 km; in a recovery week the long run stays at or below 70% of the recent longest run: at most 14 km")));
  assert.ok(messages.some((m) => m.includes("2 quality sessions (tempo, intervals, hills: runs 2, 4)") && m.includes("at most 1")));
});

test("the clamp turns a recovery week into a passable one", () => {
  const context = recoveryContext();
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 20),
    run("Hill repeats", 6, "hills", 8)
  ]);

  const { week: clamped, adjustments } = clampRunningWeek(week, context);

  assert.deepEqual(clamped.sessions.map((session) => session.kind), ["easy", "tempo", "long", "easy"]);
  assert.equal(clamped.sessions[3].title, "Easy run");
  assert.ok(clamped.sessions[3].notes.some((note) => note.includes("a recovery week keeps one short quality session at most")));
  assert.equal(clamped.sessions[2].distanceKm, 14);
  assert.ok(clamped.sessions.reduce((sum, session) => sum + session.distanceKm, 0) <= 33.8);
  assert.ok(adjustments.some((a) => a.includes("hills changed to an easy run")));
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("an all-easy recovery week is fine", () => {
  const context = recoveryContext();
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 7),
    run("Easy run with strides", 3, "easy", 7),
    run("Easy long run", 5, "easy", 12),
    run("Recovery jog", 6, "recovery", 5)
  ]);

  assert.deepEqual(validateRunningWeek(week, context), { accepted: true, messages: [] });
});

test("12 days out the taper caps volume against the pre-taper average and phases each day", () => {
  const guardrails = runningGuardrails(taperContext(12));
  const race = guardrails.phase.race;

  assert.ok(race);
  assert.deepEqual(race.days.map((day) => day.phase), ["taper_2w", "taper_2w", "taper_2w", "taper_2w", "taper_2w", "race_week", "race_week"]);
  assert.equal(race.referenceKm, 50);
  // (5 x 70% + 2 x 40%) / 7 of 50 km.
  assert.equal(race.weeklyKmCap, 30.7);
  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 30.7);
  assert.equal(race.normalEasyRunKm, 9);
  assert.equal(race.shortRunCapKm, 4.5, "50% of a normal 9 km easy run, to the nearest 0.5 km");
  assert.equal(race.longRunCapKm.taper_2w, 13.2, "60% of the recent longest 22 km");
  assert.equal(guardrails.qualityLimit?.max, 1);
});

test("the taper clamp keeps one quality session, removes hills inside 10 days and makes race week shakeouts", () => {
  const context = taperContext(12);
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Downhill repeats", 2, "hills", 10),
    run("Tempo blocks", 4, "tempo", 8),
    run("Long trail run", 5, "long", 18)
  ]);
  week.sessions[1].elevationMeters = 700;

  const messages = validateRunningWeek(week, context).messages;
  assert.ok(messages.some((m) => m.includes("Run 2 (Downhill repeats) is a hills run on offset 2, 10 days before the race: no new hill or downhill session inside 10 days")));
  assert.ok(messages.some((m) => m.includes("Run 2 (Downhill repeats) climbs 700 m over 10 km") && m.includes("at most 225 m")));
  assert.ok(messages.some((m) => m.includes("Run 4 (Long trail run) is a long run on offset 5, 7 days before Trail 75K: only short easy runs or shakeouts")));
  assert.ok(messages.some((m) => m.includes("race week shakeouts stay at or below 50% of a normal 9 km easy run (max 8 km): at most 4.5 km")));

  const { week: clamped } = clampRunningWeek(week, context);
  assert.deepEqual(clamped.sessions.map((session) => session.kind), ["easy", "easy", "tempo", "easy"]);
  assert.equal(clamped.sessions[3].title, "Easy shakeout run");
  assert.equal(clamped.sessions[3].distanceKm, 4.5);
  assert.ok(clamped.sessions[1].elevationMeters <= 225, "1.5x the usual 15 m/km over 10 km");
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("15-21 days out the weekly cap is 80% and the long run 75% of the recent longest", () => {
  const context = taperContext(20, [1, 3, 5, 6]);
  const guardrails = runningGuardrails(context);

  // Six days at 80% and one (14 days out) at 70% of 50 km.
  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 39.3);
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 8),
    run("Long trail run", 5, "long", 20),
    run("Recovery jog", 6, "recovery", 3)
  ]);
  assert.ok(validateRunningWeek(week, context).messages.some((m) => m.includes("15 days before the race the long run stays at or below 75% of the recent longest run: at most 16.5 km")));
  const { week: clamped } = clampRunningWeek(week, context);
  assert.equal(clamped.sessions[2].distanceKm, 16.5);
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

test("in race week only shakeouts surround the race, and a tempo becomes a shakeout", () => {
  const context = taperContext(6, [1, 3, 5, 6]);
  const week = runningWeek([
    run("Easy shakeout", 1, "easy", 3),
    run("Race-pace tempo", 3, "tempo", 8),
    run("Pre-race shakeout", 5, "easy", 3),
    run("Trail 75K", 6, "long", 75)
  ]);

  assert.ok(validateRunningWeek(week, context).messages.some((m) => m.includes("Run 2 (Race-pace tempo) is a tempo run on offset 3, 3 days before Trail 75K")));
  const { week: clamped, adjustments } = clampRunningWeek(week, context);
  assert.equal(clamped.sessions[1].kind, "easy");
  assert.equal(clamped.sessions[1].distanceKm, 4.5);
  assert.equal(clamped.sessions[3].distanceKm, 75, "the race itself is untouched");
  assert.ok(adjustments.some((a) => a.includes("tempo changed to an easy run")));
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

// Review finding: a race stored without a name read "3 day(s) before : ...".
test("a race without a name reads as your race in the race-window rules", () => {
  const context = taperContext(6, [1, 3, 5, 6]);
  context.running!.raceGoal.name = " ";
  const week = runningWeek([
    run("Easy shakeout", 1, "easy", 3),
    run("Race-pace tempo", 3, "tempo", 8),
    run("Pre-race shakeout", 5, "easy", 3),
    run("Race day", 6, "long", 75)
  ]);

  const messages = validateRunningWeek(week, context).messages;
  assert.ok(messages.some((m) => m.includes("3 days before your race: only short easy runs")), messages.join("\n"));
  assert.equal(runningGuardrails(context).phase.race?.raceName, "your race");
});

test("the first week after the race allows easy and recovery runs only", () => {
  const context = taperContext(-2, [1, 3, 5, 6]);
  const week = runningWeek([run("Recovery jog", 1, "recovery", 4), run("Tempo blocks", 3, "tempo", 6), run("Easy run", 5, "easy", 5)]);

  const messages = validateRunningWeek(week, context).messages;
  assert.ok(messages.some((m) => m.includes("Run 2 (Tempo blocks) is a tempo run on offset 3, 5 days after Trail 75K: easy or recovery runs only")));
  const { week: clamped } = clampRunningWeek(week, context);
  assert.deepEqual(validateRunningWeek(clamped, context), { accepted: true, messages: [] });
});

// Audit: only the first week after the race restricted run kinds, so hard
// sessions were legal in the second post-race week.
test("after day 7 the post-race window allows easy runs, recovery runs and an easy long run only", () => {
  // Day 9 after a 54 km race: offsets 1-5 are days 10-14 (the window ends on day 14), offset 6 is day 15.
  const context = postRaceContext(9, 54, {
    runningDays: ["tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6]
  });
  const week = runningWeek([
    run("Easy run with strides", 1, "easy", 6),
    run("Tempo blocks", 2, "tempo", 8),
    run("Hill repeats", 3, "hills", 7),
    run("Easy long run", 5, "long", 14),
    run("Tempo blocks", 6, "tempo", 8)
  ]);

  const messages = validateRunningWeek(week, context).messages;
  assert.ok(messages.some((m) => m.startsWith("Run 2 (Tempo blocks) is a tempo run on offset 2, 11 days after Trail 54K") && m.includes("until day 14")), messages.join("\n"));
  assert.ok(messages.some((m) => m.startsWith("Run 3 (Hill repeats) is a hills run on offset 3")), messages.join("\n"));
  assert.ok(!messages.some((m) => m.startsWith("Run 4 (Easy long run) is a long run")), "an easy long run is fine");
  assert.ok(!messages.some((m) => m.startsWith("Run 5 (Tempo blocks) is a tempo run")), "day 15 is past the window");

  const { week: clamped } = clampRunningWeek(week, context);
  assert.deepEqual(clamped.sessions.map((session) => session.kind), ["easy", "easy", "easy", "long", "tempo"]);
});

// Audit: weekly descent and climbing had no growth cap.
test("weekly climbing is capped at 1.25x the 4-week average and never below 300 m", () => {
  // Steady weeks climb 4 x 80 m = 320 m a week: the cap is 400 m.
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const guardrails = runningGuardrails(context);
  assert.deepEqual([guardrails.weeklyClimb?.fourWeekAvgM, guardrails.weeklyClimb?.capM], [320, 400]);

  const week = validFourRunWeek();
  week.sessions[2].elevationMeters = 450;
  const message = validateRunningWeek(week, context, guardrails).messages.find((m) => m.startsWith("Planned climbing"));
  assert.ok(message?.includes("630 m") && message.includes("cap of 400 m") && message.includes("320 m"), message);

  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);
  assert.ok(clamped.sessions.reduce((sum, session) => sum + session.elevationMeters, 0) <= 400);
  assert.ok(clamped.sessions[2].notes.some((note) => note.includes("m of climbing")), clamped.sessions[2].notes.join("\n"));
  assert.ok(adjustments.some((a) => a.includes("630 m") && a.includes("400 m")), adjustments.join("\n"));
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });

  const flat = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]).map((entry) => ({ ...entry, elevationGainM: 0 })) });
  assert.equal(runningGuardrails(flat).weeklyClimb?.capM, 300, "a flat history still allows 300 m");
  assert.equal(runningGuardrails(contextWith({ recentRuns: [] })).weeklyClimb, null, "no run history: no climbing reference");
});

// Final review item 6: lowering every run in proportion turned a 6 x 3 min
// uphill session (240 m) into about 100 m. Easy and recovery runs give up
// their climbing first, then the long run; the quality or hill run last.
test("over the climbing cap, easy runs and then the long run give way before the hill session", () => {
  // Steady weeks climb 4 x 80 m = 320 m a week: the cap is 400 m.
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const guardrails = runningGuardrails(context);
  assert.equal(guardrails.weeklyClimb?.capM, 400);

  const week = runningWeek([run("Easy aerobic run", 1, "easy", 8), run("Hill intervals: 6 x 3 min uphill", 3, "hills", 10), run("Long trail run", 5, "long", 20), run("Recovery jog", 6, "recovery", 6)]);
  week.sessions.forEach((session, index) => { session.elevationMeters = [80, 240, 300, 40][index]; });

  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);
  // 660 m over 400 m: the easy and recovery runs drop their 120 m, the long run the other 140 m.
  assert.deepEqual(clamped.sessions.map((session) => session.elevationMeters), [0, 240, 160, 0]);
  assert.ok(!clamped.sessions[1].notes.some((note) => note.includes("m of climbing")), "the hill session keeps its route");
  assert.ok(adjustments.some((a) => a.includes("660 m") && a.includes("400 m") && a.includes("hill")), adjustments.join("\n"));
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });

  // Only when the easy runs and the long run are flat does the hill session give way.
  const steep = runningWeek([run("Easy aerobic run", 1, "easy", 8), run("Hill intervals", 3, "hills", 10), run("Long trail run", 5, "long", 20)]);
  steep.sessions.forEach((session, index) => { session.elevationMeters = [50, 500, 100][index]; });
  assert.deepEqual(clampRunningWeek(steep, context, guardrails).week.sessions.map((session) => session.elevationMeters), [0, 400, 0]);
});

// Review finding: at a daytime re-plan the climbing reference (the 28 days up
// to the request time) held today's finished run, while today's climbing did
// not count against the cap, so a big climb today raised its own cap. The cap
// now follows the km cap: the 4 weeks before local midnight, today's climbing
// counted with the planned runs.
test("the climbing cap reads the 4 weeks before local midnight and counts today's climbing", () => {
  const hillyToday = { completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString(), distanceKm: 20, movingSeconds: 8400, elevationGainM: 1000, kind: "long" };
  const context = contextWith({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), hillyToday], longRunDay: "monday", longRunDayOffset: undefined });
  const guardrails = runningGuardrails(context, { now: new Date(Date.parse(WEEK_START) + 15 * 60 * 60 * 1000) });

  assert.deepEqual([guardrails.weeklyClimb?.fourWeekAvgM, guardrails.weeklyClimb?.capM], [320, 400], "today's 1000 m is not in the reference");
  assert.equal(guardrails.today?.elevationM, 1000);

  // 550 m planned on offsets 1-6 plus today's 1000 m is far over the 400 m cap.
  const week = runningWeek([run("Easy aerobic run", 1, "easy", 7), run("Tempo blocks", 3, "tempo", 7), run("Easy aerobic run", 5, "easy", 7), run("Recovery jog", 6, "recovery", 5)]);
  week.sessions.forEach((session, index) => { session.elevationMeters = [150, 150, 150, 100][index]; });
  const message = validateRunningWeek(week, context, guardrails).messages.find((m) => m.startsWith("Planned climbing"));
  assert.ok(message?.includes("550 m") && message.includes("today's 1000 m") && message.includes("cap of 400 m"), message);

  // Today's run used up the week's climbing: the clamp makes the rest flat.
  const { week: clamped } = clampRunningWeek(week, context, guardrails);
  assert.deepEqual(clamped.sessions.map((session) => session.elevationMeters), [0, 0, 0, 0]);
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });
});

test("a 100 km race keeps the easy post-race rules for 25 days", () => {
  // Day 20 after a 100 km race: days 20-25 still follow the post-race rules.
  const hundred = runningGuardrails(postRaceContext(20, 100));
  assert.deepEqual(hundred.phase.race?.days.map((day) => day.phase), [
    "post_race_2w", "post_race_2w", "post_race_2w", "post_race_2w", "post_race_2w", "post_race_2w", "normal"
  ]);
  // (6 days at 70% + 1 normal day at 115%) / 7 of the 50 km pre-taper average.
  assert.equal(hundred.weeklyVolume.kind === "capped" && hundred.weeklyVolume.capKm, 38.2);
  assert.ok(hundred.relaxations.some((relaxation) => relaxation.code === "post_race_recovery"));

  // Day 20 after a 54 km race: its 14-day window is over, so the normal build caps apply.
  const fiftyFour = runningGuardrails(postRaceContext(20, 54));
  assert.equal(fiftyFour.phase.race, null);
  assert.equal(fiftyFour.weeklyVolume.kind === "capped" && fiftyFour.weeklyVolume.capKm, 57.5);
  assert.ok(!fiftyFour.relaxations.some((relaxation) => relaxation.code === "post_race_recovery"));
});

test("race day is the race, not post-race; the day after is post-race", () => {
  const raceDay = runningGuardrails(postRaceContext(0, 54)).relaxations;
  assert.ok(!raceDay.some((relaxation) => relaxation.code === "post_race_recovery"), JSON.stringify(raceDay));
  assert.ok(raceDay.some((relaxation) => relaxation.code === "race_this_week" && relaxation.detail === "The race is today."));

  const dayAfter = runningGuardrails(postRaceContext(1, 54)).relaxations;
  assert.ok(dayAfter.some((relaxation) => relaxation.code === "post_race_recovery" && relaxation.detail === "The race was 1 day ago."));
});

test("the planner is told how long this race's post-race rules last", () => {
  const guardrails = runningGuardrails(postRaceContext(20, 100));
  const prompt = runningGuardrailsForPrompt(guardrails) as { raceWindow: { postRaceDays: number; rules: string[] } };

  assert.equal(prompt.raceWindow.postRaceDays, 25);
  // A day outside the race window is "normal", never "build" (that is a season phase).
  assert.ok(prompt.raceWindow.rules.some((rule) => rule.startsWith("normal: ")));
  assert.ok(prompt.raceWindow.rules.some((rule) => rule.includes("post_race_2w (day 8 to day postRaceDays after the race)")));
  const { kmPerDay, minDays, maxDays } = SEASON_LIMITS.postRace;
  assert.ok(prompt.raceWindow.rules.some((rule) => rule.includes(`one day per ${kmPerDay} km, ${minDays}-${maxDays} days`)));
  // Review finding: days 20-25 read "6 day(s) from day 8 after the race"; the label names the actual days.
  assert.ok(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.basis.includes("6 days (days 20-25 after the race) at 70%"), JSON.stringify(guardrails.weeklyVolume));
  assert.ok(!(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.basis.includes("from day 8")));
  const firstWeek = runningGuardrails(postRaceContext(5, 54)).weeklyVolume;
  assert.ok(firstWeek.kind === "capped" && firstWeek.basis.includes("3 days (days 5-7 after the race) at 40%"), JSON.stringify(firstWeek));
  assert.ok(firstWeek.kind === "capped" && firstWeek.basis.includes("4 days (days 8-11 after the race) at 70%"), JSON.stringify(firstWeek));
});

// The weekly cap counted offsets 1-6 only while the floor counted today too:
// both now use the same 7 days, today's run (done or planned) included.
test("a night with a 20 km long run today cannot plan the full cap again on offsets 1-6", () => {
  // Cap 51.8 km over the 7 days; today's 20 km long run leaves 31.8 km.
  const context: CoachContext = {
    ...sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]), longRunDay: "monday", longRunDayOffset: undefined }),
    todayPlannedRuns: todayPlanned("long", 20)
  };
  const guardrails = runningGuardrails(context);
  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 12),
    run("Tempo blocks", 2, "tempo", 10),
    run("Easy aerobic run", 3, "easy", 12),
    run("Easy aerobic run", 5, "easy", 10),
    run("Recovery jog", 6, "recovery", 7)
  ]);

  const message = validateRunningWeek(week, context, guardrails).messages.find((m) => m.startsWith("Planned running volume"));
  assert.ok(message?.includes("51 km") && message.includes("plus today's 20 km run, 71 km over the 7 days") && message.includes("cap of 51.8 km"), message);

  const { week: clamped, adjustments } = clampRunningWeek(week, context, guardrails);
  const plannedKm = clamped.sessions.reduce((sum, session) => sum + session.distanceKm, 0);
  assert.ok(plannedKm + 20 <= 51.8, `${plannedKm} km planned`);
  assert.ok(adjustments.some((a) => a.includes("31.8 km left after today's 20 km run")), adjustments.join("\n"));
  assert.deepEqual(validateRunningWeek(clamped, context, guardrails), { accepted: true, messages: [] });
});

// Review finding: in a daytime re-plan the cap's reference (the 7
// days up to the request time) held today's finished run, which also counts
// against the budget, so a big run today raised its own cap (46 -> 64.4 km).
test("the weekly cap's reference ends at local midnight, so today's run does not raise its own cap", () => {
  const today = { completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString(), distanceKm: 30, movingSeconds: 10800, elevationGainM: 300, kind: "long" };
  const context = contextWith({ recentRuns: [...steadyWeeks([40, 40, 40, 40]), today], longRunDay: "monday", longRunDayOffset: undefined });
  const guardrails = runningGuardrails(context, { now: new Date(Date.parse(WEEK_START) + 15 * 60 * 60 * 1000) });

  assert.equal(guardrails.weeklyVolume.kind === "capped" && guardrails.weeklyVolume.capKm, 46);
  assert.deepEqual(guardrails.today, { source: "done", distanceKm: 30, elevationM: 300, kinds: ["long"] });
  assert.equal(weeklyBudgetAfterToday(guardrails), 16);
});

test("when today's run leaves no room for a minimum run, the rest of the week may stay empty", () => {
  // First week back after a break: a 20 km cap, and today's planned 18 km run leaves 2 km.
  const context: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([40, 40], 6), baselineWeeklyKm: 0, longRunDay: "monday", longRunDayOffset: undefined }),
    todayPlannedRuns: todayPlanned("long", 18)
  };
  const guardrails = runningGuardrails(context);
  assert.equal(guardrails.frequency?.minRuns, 0);

  assert.deepEqual(validateRunningWeek(runningWeek([]), context, guardrails), { accepted: true, messages: [] });
  assert.ok(validateRunningWeek(runningWeek([run("Easy aerobic run", 3, "easy", 5)]), context, guardrails).messages.some((m) => m.includes("above this week's cap")));

  // Today's run is locked: even when it alone is over the cap, an empty rest of the week passes.
  const overCap: CoachContext = { ...context, todayPlannedRuns: todayPlanned("long", 22) };
  assert.deepEqual(validateRunningWeek(runningWeek([]), overCap), { accepted: true, messages: [] });
  const message = validateRunningWeek(runningWeek([run("Easy aerobic run", 3, "easy", 4)]), overCap).messages.find((m) => m.includes("above this week's cap"));
  assert.ok(message?.includes("Remove at least 4 km"), message);
});

// After a hard run today, a hard run tomorrow cannot move when tomorrow is
// the long-run day: the longest run must stay there, so it becomes easy.
test("after a hard run today, a hard long-run day tomorrow is told to become easy, not to move", () => {
  const today = { completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString(), distanceKm: 9, movingSeconds: 2700, elevationGainM: 60, kind: "intervals" };
  const context = contextWith({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), today], runningDays: ["tuesday", "thursday", "saturday", "sunday"], runningDayOffsets: [1, 3, 5, 6], longRunDay: "tuesday", longRunDayOffset: 1 });
  const week = runningWeek([run("Long trail run", 1, "long", 18), run("Easy aerobic run", 3, "easy", 8), run("Tempo blocks", 5, "tempo", 8), run("Recovery jog", 6, "recovery", 6)]);

  const message = validateRunningWeek(week, context).messages.find((m) => m.startsWith("Run 1 (Long trail run)"));
  assert.ok(message?.includes("Make it an easy run on this day") && message.includes("long-run day"), message);
  assert.ok(!message?.includes("move it to a later day"), message);
});

// Final review item 10: the race-window text the planner passes on to the
// athlete (run notes, reasons, the volume basis) says "1 day" and "4 days",
// never "day(s)".
test("race-window text uses plain plurals", () => {
  for (const context of [postRaceContext(1, 54), postRaceContext(9, 54), taperContext(12), taperContext(2)]) {
    const guardrails = runningGuardrails(context);
    const { week, adjustments } = clampRunningWeek(runningWeek([run("Hill intervals", 1, "hills", 9), run("Easy", 3, "easy", 6), run("Long", 5, "long", 14)]), context, guardrails);
    const text = JSON.stringify([runningGuardrailsForPrompt(guardrails), week, adjustments, validateRunningWeek(week, context, guardrails).messages]);
    assert.ok(!text.includes("(s)"), text.match(/.{60}\(s\).{20}/)?.[0]);
  }
  const dayAfter = JSON.stringify(runningGuardrailsForPrompt(runningGuardrails(postRaceContext(1, 54))));
  assert.ok(dayAfter.includes("The race was 1 day ago."), dayAfter);
  // Race day today: offset 1 is post-race day 1, so a hill run there reads "1 day after".
  const raceToday = postRaceContext(0, 54);
  const messages = validateRunningWeek(runningWeek([run("Hill intervals", 1, "hills", 9), run("Easy", 3, "easy", 6)]), raceToday).messages;
  assert.ok(messages.some((m) => m.includes("1 day after Trail 54K")), messages.join("\n"));
});
