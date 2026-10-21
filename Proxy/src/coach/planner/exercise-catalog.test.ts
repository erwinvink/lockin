import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { EXERCISE_CATALOG, EXERCISE_KINDS, exerciseLadder, missingEquipment } from "./exercise-catalog";
import { validateWeeklyPlan } from "./validate-week-plan";
import type { CoachContext, WeeklyPlan } from "./types";

const skillRoot = join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner", "references");

test("the library, the plan schema, the validator catalog and the app's ExerciseKind list the same exact names", async () => {
  const library = JSON.parse(await readFile(join(skillRoot, "exercise-library.json"), "utf8")) as {
    exercises: Record<string, { title: string; requiredEquipment: string[]; anyOfEquipment?: string[] }>;
  };
  const schema = JSON.parse(await readFile(join(skillRoot, "weekly-plan.schema.json"), "utf8"));
  const schemaNames: string[] = schema.properties.sessions.items.properties.exercises.items.properties.exercise.enum;
  const swift = await readFile(join(process.cwd(), "..", "FitnessApp", "AppModels.swift"), "utf8");
  const enumBody = swift.slice(swift.indexOf("enum ExerciseKind"), swift.indexOf("var id: String", swift.indexOf("enum ExerciseKind")));
  const appNames = [...enumBody.matchAll(/^\s*case (\w+)\s*$/gm)].map((match) => match[1]);

  const sorted = (names: string[]) => [...names].sort();
  assert.deepEqual(sorted(Object.keys(library.exercises)), sorted(EXERCISE_KINDS));
  assert.deepEqual(sorted(schemaNames), sorted(EXERCISE_KINDS));
  assert.deepEqual(sorted(appNames), sorted(EXERCISE_KINDS));
  for (const name of EXERCISE_KINDS) {
    const entry = library.exercises[name];
    assert.equal(entry.title, EXERCISE_CATALOG[name].title, name);
    assert.deepEqual(entry.requiredEquipment, EXERCISE_CATALOG[name].requiredEquipment, name);
    assert.deepEqual(entry.anyOfEquipment ?? [], EXERCISE_CATALOG[name].anyOfEquipment ?? [], name);
    assert.ok(swift.includes(`case .${name}: "${EXERCISE_CATALOG[name].title}"`), `the app shows ${name} as ${EXERCISE_CATALOG[name].title}`);
  }
});

test("equipment needs are checked only when the athlete listed equipment", () => {
  assert.equal(missingEquipment("bandAssistedPullUp", ["pullUpBar"]), "Band-assisted pull-up needs a resistance band");
  assert.equal(missingEquipment("weightedPullUp", ["pullUpBar"]), "Weighted pull-up needs dumbbells or a loaded backpack");
  assert.equal(missingEquipment("weightedPullUp", ["pullUpBar", "backpack"]), null);
  assert.equal(missingEquipment("negativePullUp", ["yogaMat"]), "Negative pull-up needs a pull-up bar");
  assert.equal(missingEquipment("negativePullUp", []), null, "an empty list was never filled in");
});

test("the ladder step follows the current max and the equipment", () => {
  const ladder = (pullUps: number, pushUps: number, plankSeconds: number, equipment: string[]) =>
    exerciseLadder({ pullUps, pushUps, plankSeconds }, equipment);

  const beginner = ladder(2, 8, 25, ["pullUpBar", "resistanceBand"]);
  assert.match(beginner.pullUps, /negativePullUp, bandAssistedPullUp, invertedRow/);
  assert.match(beginner.pushUps, /inclinePushUp and kneePushUp/);
  assert.match(beginner.plankSeconds, /short plank holds/);
  assert.match(ladder(5, 20, 60, ["pullUpBar"]).pullUps, /submaximal pullUp sets inside the cap, negativePullUp as a finisher/);
  const strong = ladder(15, 45, 150, ["pullUpBar", "backpack"]);
  assert.match(strong.pullUps, /weightedPullUp, archerPullUp or lSitPullUp/);
  assert.match(strong.pushUps, /declinePushUp, deficitPushUp, archerPushUp or weightedPushUp/);
  assert.match(strong.plankSeconds, /longLeverPlank, rkcPlank or weightedPlank instead of longer holds/);
  assert.match(ladder(15, 45, 150, ["yogaMat"]).pullUps, /No pull-up bar: invertedRow/);
});

test("the validator rejects an unknown exercise name and missing equipment with the reason", () => {
  const context = {
    profile: { equipment: ["pullUpBar"], trainingDays: [], trainingDayOffsets: [], weeklySessions: 3, weekStart: "2026-05-11T00:00:00Z" },
    history: { bestRecentTests: { pullUps: 10, pushUps: 30, plankSeconds: 90 } },
    adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
    plannedWork: { todaySessions: [], recentGoalTargets: {} },
    readiness: { state: "recovery_needed", riskFlags: [] }
  } as unknown as CoachContext;
  const effort = { label: "medium", targetRPE: 6, targetRIR: 4, stimulus: "volume", reason: "Support work." };
  const plan = {
    summary: "Restore: support work.",
    contextState: "recovery_needed",
    safetyFlags: [],
    sessions: [{
      title: "Pull support",
      dayOffset: 2,
      focus: "pull",
      plannedEffort: effort,
      purpose: "Support.",
      estimatedDurationMinutes: 30,
      progressionRationale: "Support work.",
      safetyNotes: [],
      loggingFieldsRequired: [],
      exercises: [
        { exercise: "bandAssistedPullUp", sets: 3, reps: 5, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: effort },
        { exercise: "muscleUp", sets: 3, reps: 2, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: effort },
        { exercise: "invertedRow", sets: 3, reps: 10, seconds: 0, restSeconds: 75, intensity: "Medium", plannedEffort: effort }
      ]
    }]
  } as unknown as WeeklyPlan;

  const messages = validateWeeklyPlan(plan, context).messages;

  assert.ok(messages.some((m) => m.includes("Session 1 uses bandAssistedPullUp: Band-assisted pull-up needs a resistance band, which the athlete's equipment (pullUpBar) does not include")));
  assert.ok(messages.some((m) => m.includes("Session 1 has an unknown exercise \"muscleUp\"; use an exact name from exercise-library.json")));
  assert.ok(!messages.some((m) => m.includes("uses invertedRow")), "inverted rows need no listed equipment");
});
