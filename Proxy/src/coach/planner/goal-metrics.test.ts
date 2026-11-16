import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { rpeForLabel, testsAGoal } from "./effort-flags";
import { hardestLabel, isGoalTest, isUsefulGoalEffort, loweredEffort, metricForExercise, topBlock } from "./goal-metrics";
import { HARD_EFFORT_KINDS as RUNNING_HARD_EFFORT_KINDS } from "./running-floors";
import type { PlannedEffort } from "./types";
import { HARD_EFFORT_KINDS, isHardRun } from "./week-schedule";

// Code review I5: one definition of the goal vocabulary every rule shares.

test("a goal test is a test stimulus or a max_output label, nothing else", () => {
  assert.equal(isGoalTest({ label: "max_output", stimulus: "test" }), true);
  assert.equal(isGoalTest({ label: "very_hard", stimulus: "test" }), true, "a test stimulus at another label");
  assert.equal(isGoalTest({ label: "max_output", stimulus: "strength" }), true, "a max set whatever its stimulus");
  assert.equal(isGoalTest({ label: "very_hard", stimulus: "strength" }), false);
  assert.equal(isGoalTest(null), false);
});

test("useful goal work is medium or harder working sets, never light, technique, recovery or a test", () => {
  assert.equal(isUsefulGoalEffort({ label: "medium", stimulus: "volume" }), true);
  assert.equal(isUsefulGoalEffort({ label: "hard", stimulus: "strength" }), true);
  assert.equal(isUsefulGoalEffort({ label: "light", stimulus: "volume" }), false);
  assert.equal(isUsefulGoalEffort({ label: "medium", stimulus: "technique" }), false);
  assert.equal(isUsefulGoalEffort({ label: "medium", stimulus: "recovery" }), false);
  assert.equal(isUsefulGoalEffort({ label: "max_output", stimulus: "strength" }), false, "a max set is a test");
  assert.equal(isUsefulGoalEffort(undefined), false);
});

// Code review M4: lookups read own keys only, so "constructor" or
// "toString" never pass as a goal exercise or an effort label.
test("lookups read own keys only", () => {
  assert.equal(metricForExercise("pushUp"), "pushUps");
  assert.equal(metricForExercise("plank"), "plankSeconds");
  assert.equal(metricForExercise("pikePushUp"), null);
  assert.equal(metricForExercise("constructor"), null);
  assert.equal(metricForExercise("toString"), null);
  assert.equal(rpeForLabel("hard"), 7);
  assert.equal(rpeForLabel("constructor"), undefined);
  assert.equal(testsAGoal([{ exercise: "constructor" as never, sets: 1, targetReps: 1, targetSeconds: 0, plannedEffortLabel: "max_output", plannedEffortStimulus: "test" }]), false);
});

test("the top block is the highest target, then the most sets", () => {
  assert.deepEqual(topBlock([{ target: 20, sets: 4 }, { target: 24, sets: 2 }, { target: 24, sets: 3 }]), { target: 24, sets: 3 });
  assert.equal(topBlock([]), null);
});

test("a session's hard label is its hardest hard, very_hard or max_output effort", () => {
  const effort = (label: PlannedEffort["label"]): PlannedEffort => ({ label, targetRPE: 6, targetRIR: 3, stimulus: "volume", reason: "r" });
  const session = (labels: PlannedEffort["label"][]) => ({ plannedEffort: effort("medium"), exercises: labels.map((label) => ({ plannedEffort: effort(label) })) }) as never;
  assert.equal(hardestLabel(session(["medium", "very_hard", "hard"])), "very_hard");
  assert.equal(hardestLabel(session(["light", "medium"])), null);
});

test("goal-metrics.ts imports no other planner module, so every rule can use it", async () => {
  const source = await readFile(join(__dirname, "goal-metrics.ts"), "utf8");
  const imports = source.split("\n").filter((line) => line.startsWith("import "));
  assert.ok(imports.every((line) => line.startsWith("import type ")), imports.join("\n"));
});

// Final review nit: the strength side keeps its own set of hard run kinds
// (week-schedule.ts, built from running-phase-limits.ts), equal to the
// running floors' set: a race is a hard effort.
test("the strength side's hard run kinds match the running floors', race included", () => {
  assert.deepEqual([...HARD_EFFORT_KINDS].sort(), [...RUNNING_HARD_EFFORT_KINDS].sort());
  assert.equal(isHardRun("race"), true);
  assert.equal(isHardRun("easy"), false);
});

// Final review item 10: "Lowered for readiness is overreaching." read badly.
test("a lowered effort says what it was lowered to and why, in a plain sentence", () => {
  const hard: PlannedEffort = { label: "hard", targetRPE: 7, targetRIR: 2, stimulus: "strength", reason: "Hard pull-up day." };
  assert.equal(loweredEffort(hard, "medium", "readiness is overreaching").reason, "Hard pull-up day. Lowered to medium effort (readiness is overreaching).");
  assert.equal(loweredEffort({ ...hard, reason: "" }, "light", "the session budget").reason, "Planned effort. Lowered to light effort (the session budget).");
  assert.equal(loweredEffort({ ...hard, reason: "hard volume work" }, "medium", "4 days before the race").reason, "hard volume work. Lowered to medium effort (4 days before the race).");
});
