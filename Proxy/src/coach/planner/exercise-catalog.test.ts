import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  EXERCISE_CATALOG,
  EXERCISE_KINDS,
  exerciseLadder,
  LEGACY_EXERCISE_KINDS,
  missingEquipment,
  schemaForExercises,
  supportedExercisesFor
} from "./exercise-catalog";
import { buildCoachContext } from "./build-coach-context";
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
    exerciseLadder({ pullUps, pushUps, plankSeconds }, equipment)!;

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

// Older app versions reject plans with exercise names they do not know, so
// a request that does not list supportedExercises gets the legacy nine only.
test("a client that does not list supported exercises is planned with the legacy nine", async () => {
  assert.deepEqual(supportedExercisesFor(undefined), LEGACY_EXERCISE_KINDS);
  assert.deepEqual(supportedExercisesFor(["pullUp", "negativePullUp", "muscleUp"]), ["pullUp", "negativePullUp"]);
  assert.deepEqual(supportedExercisesFor([]), LEGACY_EXERCISE_KINDS);
  assert.equal(exerciseLadder({ pullUps: 2, pushUps: 8, plankSeconds: 20 }, [], LEGACY_EXERCISE_KINDS), null);

  const schema = JSON.parse(await readFile(join(skillRoot, "weekly-plan.schema.json"), "utf8"));
  const narrowed = schemaForExercises(schema, LEGACY_EXERCISE_KINDS) as typeof schema;
  assert.deepEqual(
    [...narrowed.properties.sessions.items.properties.exercises.items.properties.exercise.enum].sort(),
    [...LEGACY_EXERCISE_KINDS].sort()
  );
  assert.equal(schema.properties.sessions.items.properties.exercises.items.properties.exercise.enum.length, EXERCISE_KINDS.length, "the loaded schema is not mutated");

  const base = {
    model: "m", baseline: { pullUps: 2, pushUps: 8, plankSeconds: 20 }, goals: { pullUps: 10, pushUps: 30, plankSeconds: 90 },
    profileNotes: "", weekStart: "2026-05-11T00:00:00Z", weeklySessions: 3, equipment: ["pullUpBar"], targetDate: "2027-01-01T00:00:00Z",
    trainingLogs: [], plannedSessions: []
  };
  assert.deepEqual(buildCoachContext(base, new Date("2026-05-11T08:00:00Z")).profile.supportedExercises, LEGACY_EXERCISE_KINDS);
  assert.deepEqual(buildCoachContext({ ...base, supportedExercises: [...EXERCISE_KINDS] }, new Date("2026-05-11T08:00:00Z")).profile.supportedExercises, EXERCISE_KINDS);
});

test("the validator rejects a known exercise the client cannot show", () => {
  const context = {
    profile: { equipment: [], trainingDays: [], trainingDayOffsets: [], weeklySessions: 3, weekStart: "2026-05-11T00:00:00Z", supportedExercises: LEGACY_EXERCISE_KINDS },
    history: { bestRecentTests: { pullUps: 2, pushUps: 8, plankSeconds: 20 } },
    adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
    plannedWork: { todaySessions: [], recentGoalTargets: {} },
    readiness: { state: "recovery_needed", riskFlags: [] }
  } as unknown as CoachContext;
  const effort = { label: "light", targetRPE: 3, targetRIR: 5, stimulus: "technique", reason: "Technique." };
  const plan = {
    summary: "Restore: technique.", contextState: "recovery_needed", safetyFlags: [],
    sessions: [{
      title: "Pull technique", dayOffset: 2, focus: "pull", plannedEffort: effort, purpose: "Technique.", estimatedDurationMinutes: 20,
      progressionRationale: "Technique.", safetyNotes: [], loggingFieldsRequired: [],
      exercises: [{ exercise: "negativePullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 90, intensity: "Light", plannedEffort: effort }]
    }]
  } as unknown as WeeklyPlan;

  assert.ok(validateWeeklyPlan(plan, context).messages.some((m) => m.includes("Session 1 uses negativePullUp, which this app version cannot show")));
});
