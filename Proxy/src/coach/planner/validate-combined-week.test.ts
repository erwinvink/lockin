import assert from "node:assert/strict";
import test from "node:test";
import { fixedRunningLoadSupportsStrengthMaintenance, strengthMaintenanceReason, validateCombinedWeek } from "./validate-combined-week";
import type { CoachContext, EffortLabel, PlannedEffort, RunKind, RunningWeek, WeeklyPlan } from "./types";

const hardRunKinds: RunKind[] = ["long", "tempo", "intervals", "hills"];

test("flags a very_hard strength session stacked on each hard run kind", () => {
  for (const kind of hardRunKinds) {
    const running = runningWeek([run("Quality run", 3, kind)]);
    const strength = strengthWeek([strengthSession("Heavy pull day", 3, "very_hard")]);

    const messages = validateCombinedWeek(running, strength);

    assert.equal(messages.length, 1, `expected one message for run kind ${kind}`);
    assert.ok(messages[0].includes("Heavy pull day"));
    assert.ok(messages[0].includes("very_hard"));
    assert.ok(messages[0].includes("offset 3"));
  }
});

test("flags a max_output strength session stacked on a hard run day", () => {
  const running = runningWeek([run("Long trail run", 5, "long")]);
  const strength = strengthWeek([strengthSession("Pull-up test", 5, "max_output")]);

  const messages = validateCombinedWeek(running, strength);

  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes("max_output"));
  assert.ok(messages[0].includes("Lower the effort, or move it to another selected training day."));
});

test("flags hard strength stacked on a long run day", () => {
  const messages = validateCombinedWeek(
    runningWeek([run("Long trail run", 5, "long")]),
    strengthWeek([strengthSession("Hard pull day", 5, "hard")])
  );

  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes("hard effort"));
});

test("accepts hard strength on an easy run day", () => {
  const running = runningWeek([run("Easy aerobic run", 2, "easy")]);
  const strength = strengthWeek([strengthSession("Pull strength", 2, "hard")]);

  assert.deepEqual(validateCombinedWeek(running, strength), []);
});

test("accepts very_hard strength on a day without a hard run", () => {
  const running = runningWeek([run("Easy aerobic run", 1, "easy"), run("Long trail run", 5, "long")]);
  const strength = strengthWeek([strengthSession("Heavy pull day", 2, "very_hard")]);

  assert.deepEqual(validateCombinedWeek(running, strength), []);
});

test("accepts an empty running week", () => {
  const running = runningWeek([]);
  const strength = strengthWeek([
    strengthSession("Heavy pull day", 1, "very_hard"),
    strengthSession("Pull-up test", 4, "max_output")
  ]);

  assert.deepEqual(validateCombinedWeek(running, strength), []);
});

test("collects one message per stacked strength session", () => {
  const running = runningWeek([run("Tempo blocks", 2, "tempo"), run("Long trail run", 5, "long")]);
  const strength = strengthWeek([
    strengthSession("Heavy pull day", 2, "very_hard"),
    strengthSession("Easy core day", 3, "light"),
    strengthSession("Pull-up test", 5, "max_output")
  ]);

  const messages = validateCombinedWeek(running, strength);

  assert.equal(messages.length, 2);
  assert.ok(messages[0].includes("Heavy pull day"));
  assert.ok(messages[1].includes("Pull-up test"));
});

test("rejects a combined week that occupies all six future offsets", () => {
  const running = runningWeek([
    run("Easy one", 1, "easy"),
    run("Tempo", 2, "tempo"),
    run("Easy three", 3, "easy"),
    run("Long run", 4, "long"),
    run("Recovery", 5, "recovery")
  ]);
  const strength = strengthWeek([strengthSession("Light core", 6, "light")]);

  const messages = validateCombinedWeek(running, strength);

  assert.ok(messages.some((message) => message.includes("complete rest day")));
});

// Finding: any normal build week (1 hard run at baseline km, or 2 hard runs at
// 60%) used to waive strength progression. Only a genuinely heavy week does now.
test("a normal build week no longer waives strength progression", () => {
  const context = maintenanceContext({ weeksToRace: 10, baselineWeeklyKm: 30 });
  const normalBuild = runningWeek([
    { ...run("Tempo", 2, "tempo"), distanceKm: 10 },
    { ...run("Long run", 5, "long"), distanceKm: 18 },
    { ...run("Easy run", 3, "easy"), distanceKm: 4 }
  ]);

  assert.equal(strengthMaintenanceReason(normalBuild, context), null);
  assert.equal(fixedRunningLoadSupportsStrengthMaintenance(normalBuild, context), false);
});

test("maintenance is allowed for a heavy week, three hard runs, peak or taper, or right after the race", () => {
  const base = maintenanceContext({ weeksToRace: 10, baselineWeeklyKm: 30 });
  const heavy = runningWeek([
    { ...run("Long run", 5, "long"), distanceKm: 22 },
    { ...run("Easy run", 2, "easy"), distanceKm: 12 }
  ]);
  const threeHard = runningWeek([run("Tempo", 1, "tempo"), run("Hills", 3, "hills"), run("Long run", 5, "long")]);
  const light = runningWeek([{ ...run("Long run", 5, "long"), distanceKm: 10 }]);

  assert.match(strengthMaintenanceReason(heavy, base) ?? "", /34 km\) is more than 10% above the 4-week average \(30 km/);
  assert.match(strengthMaintenanceReason(threeHard, base) ?? "", /3 hard runs/);
  assert.match(strengthMaintenanceReason(light, maintenanceContext({ weeksToRace: 4, baselineWeeklyKm: 30 })) ?? "", /Peak or taper/);
  assert.match(
    strengthMaintenanceReason(light, maintenanceContext({ weeksToRace: 0, baselineWeeklyKm: 30, raceDate: "2026-05-04T00:00:00Z" })) ?? "",
    /Post-race recovery/
  );
});

test("flags very_hard or max_output strength on the day before a long run or the race", () => {
  const running = runningWeek([run("Easy run", 1, "easy"), run("Long trail run", 5, "long")]);
  const strength = strengthWeek([
    strengthSession("Pull-up test", 4, "max_output"),
    strengthSession("Heavy push day", 2, "very_hard")
  ]);

  const messages = validateCombinedWeek(running, strength);

  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes("Pull-up test") && messages[0].includes("day before the long run on offset 5"));

  const raceContext = maintenanceContext({ weeksToRace: 1, baselineWeeklyKm: 30, raceDate: "2026-05-14T00:00:00Z" });
  const raceMessages = validateCombinedWeek(
    runningWeek([run("Easy shakeout", 1, "easy"), { ...run("Race", 3, "long"), distanceKm: 60 }]),
    strengthWeek([strengthSession("Heavy pull day", 2, "very_hard")]),
    raceContext
  );
  assert.ok(raceMessages.some((message) => message.includes("day before the race on offset 3")));
});

test("hard (not very_hard) strength the day before a long run is fine", () => {
  const running = runningWeek([run("Easy run", 1, "easy"), run("Long trail run", 5, "long")]);
  const strength = strengthWeek([strengthSession("Pull strength", 4, "hard")]);

  assert.deepEqual(validateCombinedWeek(running, strength), []);
});

function maintenanceContext(options: { weeksToRace: number; baselineWeeklyKm: number; raceDate?: string }): CoachContext {
  return {
    profile: { weekStart: "2026-05-11T00:00:00Z" },
    running: {
      raceGoal: { name: "Ridge Ultra", raceDate: options.raceDate ?? "2026-07-20T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
      baselineWeeklyKm: options.baselineWeeklyKm,
      longestRecentRunKm: 20,
      runningDays: [],
      runningDayOffsets: [],
      recentRuns: [],
      weeksToRace: options.weeksToRace
    }
  } as unknown as CoachContext;
}

function runningWeek(sessions: RunningWeek["sessions"]): RunningWeek {
  return {
    summary: "Aerobic base week with one quality session.",
    safetyFlags: [],
    sessions
  };
}

function run(title: string, dayOffset: number, kind: RunKind): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Build durable aerobic capacity for the race.",
    distanceKm: 10,
    durationMinutes: 60,
    elevationMeters: 150,
    target: { type: "pace", low: 330, high: 380 },
    zone: "Zone 2",
    notes: ["Keep the effort conversational."]
  };
}

function strengthWeek(sessions: WeeklyPlan["sessions"]): WeeklyPlan {
  return {
    summary: "Strength week built around the planned runs.",
    contextState: "building",
    safetyFlags: [],
    sessions
  };
}

function strengthSession(title: string, dayOffset: number, label: EffortLabel): WeeklyPlan["sessions"][number] {
  return {
    title,
    dayOffset,
    focus: "mixed",
    plannedEffort: effort(label),
    purpose: "Build pulling strength while respecting the running week.",
    estimatedDurationMinutes: 40,
    progressionRationale: "Holds the recent dose while running volume climbs.",
    safetyNotes: [],
    loggingFieldsRequired: ["pullUps"],
    exercises: []
  };
}

function effort(label: EffortLabel): PlannedEffort {
  const targetRPE: Record<EffortLabel, number> = { light: 3, medium: 5, hard: 7, very_hard: 9, max_output: 10 };
  return {
    label,
    targetRPE: targetRPE[label],
    targetRIR: label === "max_output" ? 0 : 2,
    stimulus: label === "max_output" ? "test" : "strength",
    reason: "Planned effort for the session."
  };
}
