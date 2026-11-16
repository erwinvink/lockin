import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import { followsTodayHardRun, qualityRunDays, todayHardKind, type TodayRun } from "./running-floors";
import { clampRunningWeek, runningGuardrails } from "./running-guardrails";
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
  WEEK_START,
  withWellness,
  lowHrvDay
} from "./running.fixtures";
import { contextSeason } from "./season";
import type { CoachContext, RunSummary } from "./types";
import { validateRunningWeek } from "./validate-running-week";

// The running floors (running-floors.ts): the quality-run and weekly-km
// floors, what lifts them, and today's run, which they count.

// The gate acts on the next 48 hours only: the week keeps its run-count,
// quality-run and weekly-km floors, and the quality run moves to a later day.
test("a wellness gate keeps both floors but no quality run may fall in the next 48 h", () => {
  const gated = withWellness(sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) }), [lowHrvDay("2026-05-11")]);
  const guardrails = runningGuardrails(gated);
  assert.deepEqual(guardrails.wellnessGate?.offsets, [1]);
  assert.equal(guardrails.floors.qualityRun.required, true);
  assert.match(guardrails.floors.qualityRun.reason, /next 48 hours/);
  assert.equal(guardrails.floors.weeklyKm.minKm, 38.3);

  // A tempo tomorrow is rejected, and the clamp makes it easy; with no later
  // quality run the week is then sent back for the quality floor.
  const tomorrow = runningWeek([
    run("Tempo blocks", 1, "tempo", 10),
    run("Easy aerobic run", 2, "easy", 8),
    run("Easy aerobic run", 3, "easy", 8),
    run("Long trail run", 5, "long", 18),
    run("Recovery jog", 6, "recovery", 6)
  ]);
  const messages = validateRunningWeek(tomorrow, gated, guardrails).messages;
  assert.ok(messages.some((m) => m.startsWith("Run 1 (Tempo blocks) is a tempo run on offset 1") && m.includes("48 hours")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("needs at least one quality session")), "a quality run inside the 48 hours does not count");
  const { week: clamped, adjustments } = clampRunningWeek(tomorrow, gated, guardrails);
  assert.deepEqual(clamped.sessions.map((session) => session.kind), ["easy", "easy", "easy", "long", "recovery"]);
  assert.ok(clamped.sessions[0].notes.some((note) => note.includes("HRV below your baseline")), clamped.sessions[0].notes.join("\n"));
  assert.ok(adjustments.some((a) => a.includes("tempo changed to an easy run")));
  const allEasy = validateRunningWeek(clamped, gated, guardrails).messages;
  assert.equal(allEasy.length, 1, allEasy.join("\n"));
  assert.match(allEasy[0], /needs at least one quality session/);
  assert.match(allEasy[0], /not in the next 48 hours/);

  // A tempo on offset 3 satisfies the floor.
  const later = runningWeek([
    run("Easy aerobic run", 1, "easy", 10),
    run("Easy aerobic run", 2, "easy", 8),
    run("Tempo blocks", 3, "tempo", 8),
    run("Long trail run", 5, "long", 18),
    run("Recovery jog", 6, "recovery", 6)
  ]);
  assert.deepEqual(validateRunningWeek(later, gated, guardrails), { accepted: true, messages: [] });

  // The weekly-km floor stays: 30 km is under 38.3 km.
  const lighter = runningWeek([
    run("Easy aerobic run", 1, "easy", 5),
    run("Easy aerobic run", 2, "easy", 5),
    run("Tempo blocks", 3, "tempo", 6),
    run("Long trail run", 5, "long", 10),
    run("Recovery jog", 6, "recovery", 4)
  ]);
  assert.ok(validateRunningWeek(lighter, gated, guardrails).messages.some((m) => m.includes("below this week's floor of 38.3 km")));
});

test("a gate with no eligible later day lifts only the quality floor", () => {
  // Tuesday and Friday-Sunday with the long run on Saturday: Tuesday is the
  // only day away from the long run, and the gate keeps it easy.
  const context = withWellness(contextWith({
    recentRuns: steadyWeeks([45, 45, 45, 45]),
    runningDays: ["tuesday", "friday", "saturday", "sunday"],
    runningDayOffsets: [1, 4, 5, 6],
    longRunDay: "saturday",
    longRunDayOffset: 5
  }), [lowHrvDay("2026-05-11")]);
  const guardrails = runningGuardrails(context);
  assert.equal(guardrails.floors.qualityRun.required, false);
  assert.match(guardrails.floors.qualityRun.reason, /next 48 hours/);
  assert.match(guardrails.floors.qualityRun.reason, /no later running day away from the long run/);
  assert.equal(guardrails.floors.weeklyKm.minKm, 38.3, "the weekly-km floor stays");
  assert.equal(runningGuardrails({ ...context, garmin: undefined }).floors.qualityRun.required, true, "without the gate Tuesday takes the quality run");

  const allEasy = runningWeek([
    run("Easy aerobic run", 1, "easy", 10),
    run("Easy aerobic run", 4, "easy", 9),
    run("Long trail run", 5, "long", 18),
    run("Easy aerobic run", 6, "easy", 8)
  ]);
  assert.deepEqual(validateRunningWeek(allEasy, context, guardrails), { accepted: true, messages: [] });

  const lighter = runningWeek([
    run("Easy aerobic run", 1, "easy", 6),
    run("Easy aerobic run", 4, "easy", 6),
    run("Long trail run", 5, "long", 14),
    run("Easy aerobic run", 6, "easy", 6)
  ]);
  assert.ok(validateRunningWeek(lighter, context, guardrails).messages.some((m) => m.includes("below this week's floor of 38.3 km")));
  const threeRuns = runningWeek(allEasy.sessions.slice(1));
  assert.ok(validateRunningWeek(threeRuns, context, guardrails).messages.some((m) => m.includes("too sparse")), "the run-count floor stays");
});

test("a recovery week lifts both floors", () => {
  // The week is all easy and below the 38.3 km floor of a normal week (85% of 45 km).
  const recovery = recoveryContext();
  const recoveryGuardrails = runningGuardrails(recovery);
  assert.deepEqual([recoveryGuardrails.floors.qualityRun.required, recoveryGuardrails.floors.weeklyKm.minKm], [false, null]);
  const lighter = runningWeek([
    run("Easy aerobic run", 1, "easy", 7),
    run("Easy run with strides", 3, "easy", 7),
    run("Easy long run", 5, "easy", 11),
    run("Recovery jog", 6, "recovery", 5)
  ]);
  assert.deepEqual(validateRunningWeek(lighter, recovery, recoveryGuardrails), { accepted: true, messages: [] });

  // Without the recovery week the same week is sent back for both floors.
  const messages = validateRunningWeek(lighter, contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) })).messages;
  assert.ok(messages.some((m) => m.includes("needs at least one quality session")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("below this week's floor of 38.3 km")), messages.join("\n"));
});

test("a starter base and the first week back after a break have no floors", () => {
  const starter = runningGuardrails(contextWith({ baselineWeeklyKm: 10, longestRecentRunKm: 6, recentRuns: [runSummary(5, 5, "easy")] }));
  assert.equal(starter.floors.qualityRun.required, false);
  assert.match(starter.floors.qualityRun.reason, /starter base/i);

  const returning = runningGuardrails(contextWith({ recentRuns: steadyWeeks([40, 40], 6), baselineWeeklyKm: 0 }));
  assert.deepEqual([returning.floors.qualityRun.required, returning.floors.weeklyKm.minKm], [false, null]);
  assert.match(returning.floors.qualityRun.reason, /4\+ weeks without runs/);
});

test("the quality floor is lifted when no running day away from the long run is free", () => {
  // Friday to Sunday with the long run on Saturday: a quality run would sit next to it.
  const context = contextWith({
    recentRuns: steadyWeeks([45, 45, 45, 45]),
    runningDays: ["friday", "saturday", "sunday"],
    runningDayOffsets: [4, 5, 6],
    longRunDay: "saturday",
    longRunDayOffset: 5
  });
  const guardrails = runningGuardrails(context);
  assert.equal(guardrails.floors.qualityRun.required, false);
  assert.equal(guardrails.floors.weeklyKm.minKm, 38.3, "the weekly-km floor stays");

  const week = runningWeek([run("Easy aerobic run", 4, "easy", 10), run("Long trail run", 5, "long", 18), run("Easy aerobic run", 6, "easy", 11)]);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

test("a peak week that reaches into the taper keeps one quality run and drops the weekly-km floor", () => {
  // 24 days out (peak): offsets 3-6 are 21-18 days out, in the taper's first week.
  const guardrails = runningGuardrails(taperContext(24, [1, 3, 5, 6]));

  assert.equal(guardrails.floors.qualityRun.required, true);
  assert.equal(guardrails.qualityLimit?.max, 1);
  assert.equal(guardrails.floors.weeklyKm.minKm, null);
  assert.match(guardrails.floors.weeklyKm.reason, /race window/);
});

test("the weekly-km floor is lifted when the free days cannot hold it under the long-run cap", () => {
  // Five 9 km runs a week (45 km): no run may exceed 10.4 km, and only three
  // days are free, so 31.2 km is the most the week can hold (floor 38.3 km).
  const runs = Array.from({ length: 20 }, (_, index) => runSummary(1 + index * 1.4, 9, "easy"));
  const context = contextWith({ recentRuns: runs, runningDays: ["tuesday", "thursday", "saturday"], runningDayOffsets: [1, 3, 5], longRunDayOffset: 5 });
  const guardrails = runningGuardrails(context);

  assert.equal(guardrails.longRun?.capKm, 10.4);
  assert.equal(guardrails.floors.weeklyKm.minKm, null);
  assert.match(guardrails.floors.weeklyKm.reason, /3 runs of at most 10\.4 km/);
  assert.equal(guardrails.floors.qualityRun.required, true, "the quality floor stays");

  const week = runningWeek([run("Easy aerobic run", 1, "easy", 10), run("Tempo blocks", 3, "tempo", 10), run("Long run", 5, "long", 10.4)]);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

test("the weekly-km floor never asks for every run at its cap: it stays at 90% of what the free days hold", () => {
  // Five 9 km runs a week (45 km, floor 38.3 km): four free days under the
  // 10.4 km long-run cap hold 41.6 km, so the floor would need every run
  // within a few hundred metres of its cap. It drops to 90% of 41.6 km,
  // rounded down to the half kilometre: 37 km, which round distances reach.
  const runs = Array.from({ length: 20 }, (_, index) => runSummary(1 + index * 1.4, 9, "easy"));
  const context = contextWith({
    recentRuns: runs,
    runningDays: ["tuesday", "thursday", "friday", "sunday"],
    runningDayOffsets: [1, 3, 4, 6],
    longRunDayOffset: 6
  });
  const guardrails = runningGuardrails(context);

  assert.equal(guardrails.longRun?.capKm, 10.4);
  assert.equal(guardrails.frequency?.maxRuns, 4);
  assert.equal(guardrails.floors.weeklyKm.minKm, 37);
  assert.match(guardrails.floors.weeklyKm.reason, /90% of the 41\.6 km that 4 runs of at most 10\.4 km hold/);

  const week = runningWeek([
    run("Easy aerobic run", 1, "easy", 9),
    run("Tempo blocks", 3, "tempo", 9),
    run("Easy aerobic run", 4, "easy", 9),
    run("Long run", 6, "long", 10)
  ]);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

// The floor compared the week with 85% of the larger of last week and the
// 4-week average, race included, so it could ask for a jump after a lighter
// week. It now asks at most to hold last week's training km.
test("the weekly-km floor never asks for more than last week's training km", () => {
  // Three 45 km weeks, then 25 km: 85% of the 40 km average is 34 km, last week 25 km.
  const guardrails = runningGuardrails(contextWith({ recentRuns: steadyWeeks([45, 45, 45, 25]) }));

  assert.equal(guardrails.floors.weeklyKm.minKm, 25);
  assert.match(guardrails.floors.weeklyKm.reason, /last week/);
});

test("on 15 Nov, after the 54 km race and two easy weeks, the floor stays under last week's volume and the first speed session is due", () => {
  const at = (date: string, km: number, kind: string, climb = 80): RunSummary => ({
    completedAt: `${date}T08:00:00Z`, distanceKm: km, movingSeconds: Math.round(km * 360), elevationGainM: climb, kind
  });
  const runs = [
    at("2026-10-18", 14, "long"), at("2026-10-20", 6, "easy"), at("2026-10-22", 7, "tempo"),
    at("2026-10-25", 12, "long"), at("2026-10-27", 6, "easy"), at("2026-10-29", 5, "easy"),
    at("2026-10-31", 54, "long", 1400),
    at("2026-11-03", 4, "recovery"), at("2026-11-05", 5, "easy"), at("2026-11-07", 6, "easy"),
    at("2026-11-09", 5, "easy"), at("2026-11-11", 6, "easy"), at("2026-11-14", 9, "easy")
  ];
  const base = contextWith({
    recentRuns: runs,
    baselineWeeklyKm: 40,
    longestRecentRunKm: 54,
    raceGoal: { name: "Cauberg Trail", raceDate: "2026-10-30T23:00:00Z", distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  });
  // Amsterdam: Sunday 15 Nov starts at 23:00Z on the 14th.
  const context: CoachContext = { ...base, profile: { ...base.profile, weekStart: "2026-11-14T23:00:00Z" } };
  const guardrails = runningGuardrails(context);

  assert.equal(contextSeason(context).phase, "general_preparation");
  // No runs on record before the taper (from 18 Oct), so the floor cannot read
  // the weeks before it and keeps the four-week average (see the next tests).
  assert.equal(guardrails.floors.weeklyKm.minKm, 18.1, "85% of the 21.3 km four-week training average, the race left out");
  assert.ok((guardrails.floors.weeklyKm.minKm ?? 0) <= 20, "never more than last week's 20 km");
  assert.equal(guardrails.floors.qualityRun.required, true);
});

// Final review item 4: after the post-race transition the four-week average
// still carries the taper and the race, so 85% of it (18.7 km against a
// 40 km base) let weeks planned at the floor keep shrinking. For the first 3
// weeks after the transition the floor reads the four weeks before the taper
// instead; it never asks for more than last week's training km.
function afterRaceHistory(extraWeeksOf33Km = 0): RunSummary[] {
  const runs: RunSummary[] = [];
  const at = (date: string, km: number, kind: string) =>
    runs.push({ completedAt: `${date}T08:00:00Z`, distanceKm: km, movingSeconds: Math.round(km * 360), elevationGainM: 60, kind });
  const day = (date: string, offset: number) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * DAY_MS).toISOString().slice(0, 10);
  // Four 40 km weeks before the taper (12 Sep - 9 Oct): Tue tempo, Thu easy, Sat long, Sun easy.
  for (let week = 0; week < 4; week += 1) {
    const saturday = day("2026-09-12", week * 7);
    at(saturday, 17, "long"); at(day(saturday, 1), 7, "easy"); at(day(saturday, 3), 8, "tempo"); at(day(saturday, 5), 8, "easy");
  }
  // Taper (10-30 Oct), the 54 km race, two easy post-race weeks.
  at("2026-10-10", 14, "long"); at("2026-10-11", 6, "easy"); at("2026-10-13", 7, "tempo"); at("2026-10-15", 6, "easy");
  at("2026-10-17", 11, "long"); at("2026-10-18", 5, "easy"); at("2026-10-20", 6, "intervals"); at("2026-10-22", 5, "easy");
  at("2026-10-24", 7, "easy"); at("2026-10-25", 4, "easy"); at("2026-10-27", 5, "easy"); at("2026-10-29", 4, "easy");
  at("2026-10-31", 54, "race");
  at("2026-11-03", 5, "recovery"); at("2026-11-05", 6, "easy"); at("2026-11-07", 8, "easy");
  at("2026-11-08", 6, "easy"); at("2026-11-10", 7, "easy"); at("2026-11-12", 8, "easy"); at("2026-11-14", 12, "long");
  // Later weeks of 33 km (Sun easy 6, Tue tempo 7, Thu easy 8, Sat long 12).
  for (let week = 0; week < extraWeeksOf33Km; week += 1) {
    const sunday = day("2026-11-15", week * 7);
    at(sunday, 6, "easy"); at(day(sunday, 2), 7, "tempo"); at(day(sunday, 4), 8, "easy"); at(day(sunday, 6), 12, "long");
  }
  return runs;
}

function afterRaceContext(weekStart: string, extraWeeksOf33Km = 0): CoachContext {
  const base = contextWith({
    recentRuns: afterRaceHistory(extraWeeksOf33Km),
    baselineWeeklyKm: 40,
    longestRecentRunKm: 17,
    raceGoal: { name: "Trail race 54K", raceDate: "2026-10-30T23:00:00Z", distanceKm: 54, elevationGainM: 1400 },
    weeksToRace: 0
  });
  return { ...base, profile: { ...base.profile, weekStart } };
}

test("after the post-race transition the floor reads the weeks before the taper, so it holds last week instead of 85% of a taper average", () => {
  // Amsterdam: Sunday 15 Nov starts at 23:00Z on the 14th (day 15 after the race, the first day after the 14-day window).
  const context = afterRaceContext("2026-11-14T23:00:00Z");
  const guardrails = runningGuardrails(context);

  assert.equal(contextSeason(context).phase, "general_preparation");
  // Last week (8-14 Nov): 6 + 7 + 8 + 12 = 33 km; 85% of the 40 km pre-taper week is 34 km.
  assert.equal(guardrails.floors.weeklyKm.minKm, 33, guardrails.floors.weeklyKm.reason);
  assert.match(guardrails.floors.weeklyKm.reason, /40 km/);
  assert.match(guardrails.floors.weeklyKm.reason, /before the taper/);
  assert.match(guardrails.floors.weeklyKm.reason, /last week's 33 km/);

  // A shrinking week (30 km) is sent back; holding last week (34 km) passes.
  const shrinking = runningWeek([run("Easy", 1, "easy", 6), run("Tempo", 3, "tempo", 8), run("Long", 5, "long", 12), run("Easy", 6, "easy", 4)]);
  const messages = validateRunningWeek(clampRunningWeek(shrinking, context, guardrails).week, context, guardrails).messages;
  assert.ok(messages.some((m) => m.includes("33 km")), messages.join("\n"));
  const holding = runningWeek([run("Easy", 1, "easy", 7), run("Tempo", 3, "tempo", 9), run("Long", 5, "long", 13), run("Easy", 6, "easy", 5)]);
  assert.deepEqual(validateRunningWeek(clampRunningWeek(holding, context, guardrails).week, context, guardrails), { accepted: true, messages: [] });
});

// The context keeps the last 30 runs, which stop short of the weeks before
// the taper; the pre-taper week is read from the whole history the app sends.
test("the pre-taper week comes from the full run history, not the 30 runs the context keeps", () => {
  const context = buildCoachContext({
    model: "test-model", baseline: { pullUps: 8, pushUps: 40, plankSeconds: 90 }, goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "", weekStart: "2026-11-21T23:00:00Z", weeklySessions: 3, trainingDays: [], trainingDayOffsets: [], equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z", plannedSessions: [], trainingLogs: [],
    running: {
      raceGoal: { name: "Trail race 54K", raceDate: "2026-10-30T23:00:00Z", distanceKm: 54, elevationGainM: 1400 },
      baselineWeeklyKm: 40, longestRecentRunKm: 17, runningDays: ["tuesday", "thursday", "saturday", "sunday"], runningDayOffsets: [2, 4, 6],
      longRunDay: "saturday", longRunDayOffset: 6, recentRuns: afterRaceHistory(1)
    }
  }, new Date("2026-11-22T00:30:00Z"));

  assert.equal(context.running?.recentRuns.length, 30, "the context keeps the last 30 runs");
  assert.equal(context.running?.preTaperTrainingWeekKm, 40);
  const floor = runningGuardrails(context).floors.weeklyKm;
  // Last week (15-21 Nov) 33 km; 85% of the 40 km pre-taper week is 34 km.
  assert.equal(floor.minKm, 33, floor.reason);
  assert.match(floor.reason, /before the taper/);
});

test("three weeks after the transition the floor reads the four-week average again", () => {
  // Day 35 after the race (14 + 21): still the weeks before the taper.
  const lastDay = runningGuardrails(afterRaceContext("2026-12-04T23:00:00Z", 3));
  assert.match(lastDay.floors.weeklyKm.reason, /before the taper/);
  // Day 36: four 33 km weeks on record, so 85% of their average.
  const after = runningGuardrails(afterRaceContext("2026-12-05T23:00:00Z", 3));
  assert.doesNotMatch(after.floors.weeklyKm.reason, /before the taper/);
  assert.match(after.floors.weeklyKm.reason, /four-week training average/);
});

test("today's planned run counts toward the weekly-km floor", () => {
  // Floor 38.3 km; today's 18 km long run plus 25 km planned is 43 km over the 7 days.
  // The long-run day is today, so the app sends no long-run offset.
  const base = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), longRunDay: "monday", longRunDayOffset: undefined });
  const week = runningWeek([run("Easy aerobic run", 1, "easy", 7), run("Tempo blocks", 3, "tempo", 8), run("Easy aerobic run", 5, "easy", 6), run("Recovery jog", 6, "recovery", 4)]);

  const withoutToday = validateRunningWeek(week, base).messages;
  assert.ok(withoutToday.some((m) => m.includes("below this week's floor of 38.3 km")), withoutToday.join("\n"));

  const context: CoachContext = { ...base, todayPlannedRuns: todayPlanned("long", 18) };
  const guardrails = runningGuardrails(context);
  assert.deepEqual(guardrails.today, { source: "planned", distanceKm: 18, elevationM: 60, kinds: ["long"] });
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
  const short = runningWeek([run("Easy aerobic run", 1, "easy", 5), run("Tempo blocks", 3, "tempo", 6), run("Easy aerobic run", 5, "easy", 5), run("Recovery jog", 6, "recovery", 3)]);
  const message = validateRunningWeek(short, context, guardrails).messages.find((m) => m.includes("below this week's floor"));
  assert.ok(message?.includes("19 km") && message.includes("today's 18 km run") && message.includes("37 km"), message);
});

test("a quality run today satisfies the quality floor, and tomorrow is no hard run", () => {
  const today = { completedAt: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString(), distanceKm: 9, movingSeconds: 2700, elevationGainM: 60, kind: "intervals" };
  const context: CoachContext = {
    ...contextWith({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), today] }),
    // The run done today wins over the one planned for today: no double count.
    todayPlannedRuns: todayPlanned("tempo", 10)
  };
  const guardrails = runningGuardrails(context);
  assert.deepEqual(guardrails.today, { source: "done", distanceKm: 9, elevationM: 60, kinds: ["intervals"] });
  assert.equal(guardrails.floors.qualityRun.required, false);
  assert.match(guardrails.floors.qualityRun.reason, /today's intervals run/);

  const allEasy = runningWeek([run("Easy aerobic run", 1, "easy", 8), run("Easy aerobic run", 3, "easy", 8), run("Long trail run", 5, "long", 18), run("Recovery jog", 6, "recovery", 6)]);
  assert.deepEqual(validateRunningWeek(allEasy, context, guardrails), { accepted: true, messages: [] });

  const hardTomorrow = runningWeek([run("Tempo blocks", 1, "tempo", 8), run("Easy aerobic run", 3, "easy", 8), run("Long trail run", 5, "long", 18), run("Recovery jog", 6, "recovery", 6)]);
  const messages = validateRunningWeek(hardTomorrow, context, guardrails).messages;
  assert.ok(messages.some((m) => m.startsWith("Run 1 (Tempo blocks) is a tempo run on offset 1, the day after today's intervals run")), messages.join("\n"));
});

test("after a hard run today, tomorrow cannot hold the week's quality run", () => {
  // Monday, Tuesday and Thursday-Saturday free, long run Saturday: after today's
  // long run, Tuesday (offset 1) is out, so Thursday (offset 3) takes the quality run.
  const context: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), runningDays: ["tuesday", "thursday", "friday", "saturday"], runningDayOffsets: [1, 3, 4, 5] }),
    todayPlannedRuns: todayPlanned("long", 16)
  };
  assert.equal(runningGuardrails(context).floors.qualityRun.required, true);

  // Only Tuesday is away from the long run: after today's long run it is out too.
  const onlyTomorrow: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), runningDays: ["tuesday", "friday", "saturday", "sunday"], runningDayOffsets: [1, 4, 5, 6] }),
    todayPlannedRuns: todayPlanned("long", 16)
  };
  const floors = runningGuardrails(onlyTomorrow).floors;
  assert.equal(floors.qualityRun.required, false);
  assert.match(floors.qualityRun.reason, /the day after today's hard run/);
});

// Both read the same days before local midnight, and the floor's training km
// are part of the cap's km, so the floor stays under the cap.
test("the weekly-km floor never exceeds the 7-day cap", () => {
  const histories: Array<[string, RunSummary[]]> = [
    ["steady", steadyWeeks([45, 45, 45, 45])],
    ["rising", steadyWeeks([20, 30, 40, 50])],
    ["falling", steadyWeeks([50, 40, 30, 20])],
    ["one big week", steadyWeeks([10, 10, 10, 60])],
    ["sparse", [runSummary(3, 12, "long"), runSummary(20, 6, "easy")]]
  ];
  for (const [name, runs] of histories) {
    const guardrails = runningGuardrails(contextWith({ recentRuns: runs }), { now: new Date(Date.parse(WEEK_START) + 15 * 60 * 60 * 1000) });
    const cap = guardrails.weeklyVolume.kind === "capped" ? guardrails.weeklyVolume.capKm : Number.POSITIVE_INFINITY;
    assert.ok((guardrails.floors.weeklyKm.minKm ?? 0) <= cap, `${name}: floor ${guardrails.floors.weeklyKm.minKm} km, cap ${cap} km`);
  }
});

test("on race day the race does not use up the week's budget", () => {
  const context: CoachContext = { ...postRaceContext(0, 54), todayPlannedRuns: todayPlanned("long", 54) };
  const guardrails = runningGuardrails(context);

  assert.equal(guardrails.today, null, "the race is not a training run");
  const week = runningWeek([run("Recovery jog", 3, "recovery", 4), run("Easy run", 5, "easy", 5)]);
  assert.deepEqual(validateRunningWeek(week, context, guardrails), { accepted: true, messages: [] });
});

// Plan-owner decision: free text never relaxes a floor (no phrase list is
// precise for open-ended notes). The note is context for the planner; logged
// pain (4 or more) lowers the plan through readiness, until the app has a
// structured pain field.
test("a profile note never relaxes the running floors", () => {
  const base = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const context: CoachContext = { ...base, profile: { ...base.profile, profileNotes: "knie doet pijn bij afdalen" } };
  const guardrails = runningGuardrails(context);

  assert.deepEqual(guardrails.relaxations, []);
  assert.equal(guardrails.floors.weeklyKm.minKm, 38.3);
  assert.equal(guardrails.floors.qualityRun.required, true);
  const threeRuns = runningWeek([run("Easy aerobic run", 1, "easy", 6), run("Tempo blocks", 3, "tempo", 6), run("Long trail run", 5, "long", 12)]);
  const messages = validateRunningWeek(threeRuns, context, guardrails).messages;
  assert.ok(messages.some((m) => m.includes("too sparse")), "the run-count floor stays");
  assert.ok(messages.some((m) => m.includes("below this week's floor of 38.3 km")), "the km floor stays");
  const allEasy = runningWeek([run("Easy aerobic run", 1, "easy", 10), run("Easy aerobic run", 3, "easy", 9), run("Long trail run", 5, "long", 18), run("Easy aerobic run", 6, "easy", 8)]);
  assert.ok(validateRunningWeek(allEasy, context, guardrails).messages.some((m) => m.includes("needs at least one quality session")), "the quality floor stays");
});

// One rule for the hard-run spacing, shared by the quality floor, the
// validator and the continuity estimate.
test("after a hard run today, the next day is no hard run", () => {
  const today = (kinds: string[]): TodayRun => ({ source: "planned", distanceKm: 10, elevationM: 0, kinds });
  assert.equal(todayHardKind(today(["easy"])), null);
  assert.equal(todayHardKind(today(["easy", "tempo"])), "tempo");
  assert.equal(todayHardKind(null), null);
  assert.equal(followsTodayHardRun(1, today(["long"])), true);
  assert.equal(followsTodayHardRun(2, today(["long"])), false);
  assert.equal(followsTodayHardRun(1, today(["recovery"])), false);
});

test("a quality day is away from the long run, other hard runs, today's hard run and a wellness gate", () => {
  const all = [1, 2, 3, 4, 5, 6];
  const hardToday: TodayRun = { source: "done", distanceKm: 16, elevationM: 0, kinds: ["long"] };
  assert.deepEqual(qualityRunDays(all, { longRunDayOffset: 5, today: null }), [1, 2, 3]);
  assert.deepEqual(qualityRunDays(all, { longRunDayOffset: 5, today: hardToday }), [2, 3]);
  assert.deepEqual(qualityRunDays(all, { longRunDayOffset: 5, today: null, hardRunOffsets: [2] }), []);
  assert.deepEqual(qualityRunDays(all, { longRunDayOffset: 5, today: null, gatedOffsets: [1, 2] }), [3]);
  // No long-run day this week (it is today or past): only the other rules apply.
  assert.deepEqual(qualityRunDays([0, ...all, 7], { longRunDayOffset: undefined, today: hardToday }), [2, 3, 4, 5, 6]);
});

// Review finding: a tune-up race done today (kind race, not on the race date)
// was left out as a race, so today's planned easy run counted instead and
// the next day could hold a hard run.
test("a tune-up race done today counts as today's run, and as a hard one", () => {
  const tuneUp = { completedAt: new Date(Date.parse(WEEK_START) + 9 * 60 * 60 * 1000).toISOString(), distanceKm: 21, movingSeconds: 7200, elevationGainM: 400, kind: "race" };
  const context: CoachContext = { ...contextWith({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), tuneUp] }), todayPlannedRuns: todayPlanned("easy", 10) };
  const guardrails = runningGuardrails(context, { now: new Date(Date.parse(WEEK_START) + 15 * 60 * 60 * 1000) });

  assert.deepEqual(guardrails.today, { source: "done", distanceKm: 21, elevationM: 400, kinds: ["race"] });
  const week = runningWeek([run("Tempo blocks", 1, "tempo", 7), run("Easy aerobic run", 3, "easy", 6), run("Long trail run", 5, "long", 12), run("Recovery jog", 6, "recovery", 4)]);
  const messages = validateRunningWeek(week, context, guardrails).messages;
  assert.ok(messages.some((m) => m.startsWith("Run 1 (Tempo blocks) is a tempo run on offset 1, the day after today's race")), messages.join("\n"));
});

// The planner is told to name the reason a floor is lifted, so the reason
// reads as plain words, never as a snake_case code.
test("a lifted floor names its computed reasons in plain words", () => {
  const recovery = runningGuardrails(recoveryContext()).floors;
  assert.equal(recovery.qualityRun.reason, "lifted by a planned recovery week");
  assert.equal(recovery.weeklyKm.reason, "lifted by a planned recovery week");

  const runs = steadyWeeks([45, 45, 45, 45]);
  runs[runs.length - 1] = { ...runs[runs.length - 1], feelScore: 2 };
  const base = contextWith({ recentRuns: runs });
  // Two reasons (a strength-only overreaching state is none: Task 8).
  const tired = runningGuardrails({ ...base, readiness: { state: "recovery_needed", riskFlags: ["recent_pain_level_4_or_higher"] } }).floors;
  assert.equal(tired.qualityRun.reason, "lifted by readiness (recovery needed) and a recent run rated feel 1-2");
  assert.ok(!/[a-z]_[a-z]/.test(tired.weeklyKm.reason), tired.weeklyKm.reason);
});

// Task 8: overreaching is computed from strength logs only (effort flags and
// goal results below plan), and running load does not cause it, so it no
// longer eases the running week. Logged pain or very weak feedback
// (recovery_needed), a wellness gate and a distressed run still do.
test("strength-only overreaching does not relax running floors", () => {
  const base = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
  const overreaching = runningGuardrails({ ...base, readiness: { state: "overreaching", riskFlags: ["recent_effort_above_plan"], reason: "Two push-up sessions rated 2 above plan, and a result below plan." } });
  const normal = runningGuardrails(base);

  assert.deepEqual(overreaching.relaxations, []);
  assert.deepEqual(overreaching.floors, normal.floors);
  assert.equal(overreaching.floors.qualityRun.required, true);
  assert.equal(typeof overreaching.floors.weeklyKm.minKm, "number");
  assert.deepEqual(overreaching.frequency, normal.frequency);

  const allEasy = runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Easy aerobic run", 3, "easy", 8),
    run("Long trail run", 5, "long", 18),
    run("Recovery jog", 6, "recovery", 6)
  ]);
  const messages = validateRunningWeek(allEasy, { ...base, readiness: { state: "overreaching", riskFlags: ["recent_effort_above_plan"] } }, overreaching).messages;
  assert.ok(messages.some((m) => m.includes("needs at least one quality session")), messages.join("\n"));

  const recovery = runningGuardrails({ ...base, readiness: { state: "recovery_needed", riskFlags: ["recent_pain_level_4_or_higher"] } });
  assert.deepEqual(recovery.relaxations.map((relaxation) => relaxation.code), ["readiness_recovery_needed"]);
  assert.equal(recovery.floors.qualityRun.required, false);
  assert.equal(recovery.floors.weeklyKm.minKm, null);
});

// Plan-owner decision: a race is the quality stimulus of its week, so a race
// in the 7 days (a tune-up race done or planned today, or the race itself on
// a day of the week) asks for no extra tempo, interval or hill run.
test("a race this week is the week's quality session", () => {
  const tuneUp = { completedAt: new Date(Date.parse(WEEK_START) + 9 * 60 * 60 * 1000).toISOString(), distanceKm: 21, movingSeconds: 7200, elevationGainM: 400, kind: "race" };
  const allEasy = runningWeek([run("Easy aerobic run", 2, "easy", 6), run("Long trail run", 5, "long", 12), run("Easy aerobic run", 6, "easy", 6)]);

  const done: CoachContext = contextWith({ recentRuns: [...steadyWeeks([45, 45, 45, 45]), tuneUp], runningDays: ["wednesday", "saturday", "sunday"], runningDayOffsets: [2, 5, 6] });
  const doneFloors = runningGuardrails(done, { now: new Date(Date.parse(WEEK_START) + 15 * 60 * 60 * 1000) });
  assert.equal(doneFloors.floors.qualityRun.required, false);
  assert.equal(doneFloors.floors.qualityRun.reason, "today's race is this week's quality session");
  assert.ok(!validateRunningWeek(allEasy, done, doneFloors).messages.some((m) => m.includes("quality session")));

  const planned: CoachContext = {
    ...contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) }),
    todayPlannedRuns: [{ dayOffset: 0, title: "Tune-up race", kind: "race", distanceKm: 21, elevationMeters: 300, target: null }]
  };
  assert.equal(runningGuardrails(planned).floors.qualityRun.required, false);

  // The race itself on a day of the week: the race window takes over from the floors.
  const raceWeek = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), raceGoal: { name: "Ridge Ultra 60K", raceDate: new Date(Date.parse(WEEK_START) + 5 * DAY_MS).toISOString(), distanceKm: 60, elevationGainM: 2400 }, weeksToRace: 1 });
  const raceWeekFloors = runningGuardrails(raceWeek).floors;
  assert.deepEqual([raceWeekFloors.qualityRun.required, raceWeekFloors.weeklyKm.minKm], [false, null]);
  assert.match(raceWeekFloors.qualityRun.reason, /race-window/);
});
