import assert from "node:assert/strict";
import test from "node:test";
import { validateCombinedWeek } from "./validate-combined-week";
import type { EffortLabel, PlannedEffort, RunKind, RunningWeek, WeeklyPlan } from "./types";

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
