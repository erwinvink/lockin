import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ASSESSMENT_LIMITS } from "./assessment";
import { buildCoachContext } from "./build-coach-context";
import { EFFORT_LIMITS } from "./effort-flags";
import { coachReferencePointsFor } from "./compute-training-signals";
import { computeSeason, SEASON_LIMITS } from "./season";
import { strengthGuardrailsForPrompt, strengthProgressionPlan } from "./strength-guardrails";
import { percent, STRENGTH_LIMITS } from "./strength-limits";
import { STRENGTH_PHASE_LIMITS, strengthPhaseForPrompt } from "./strength-phase";

// The strength planner skill and its progression policy, from where the proxy
// loads them (server.ts).
const ROOT = join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner");
const TEXTS: Array<[file: string, text: string]> = [
  ["SKILL.md", readFileSync(join(ROOT, "SKILL.md"), "utf8")],
  ["progression-policy.md", readFileSync(join(ROOT, "references", "progression-policy.md"), "utf8")]
];

// Plan-owner decision: free text never lowers the session minimum; logged pain
// (4 or more) does, through readiness.
test("the strength skill lowers the session minimum for logged pain, never for a pain note", () => {
  for (const [file, text] of TEXTS) {
    assert.ok(!/with a pain note/i.test(text), `${file}: a pain note does not lower the minimum`);
    assert.match(text, /logged pain/i, file);
  }
});

// The readiness ladder, assessment, session budget, exposures and ladders the
// proxy enforces (14 Nov audit), stated in the skill and the policy with the
// code's numbers; the contradicted old rules are gone.
test("the strength skill and policy state the readiness ladder, due tests, budget and exposures the proxy enforces", () => {
  const { responseDays, hardSetRatio, hardSetCutUpTo } = STRENGTH_PHASE_LIMITS.overreaching;
  const rest = ASSESSMENT_LIMITS.restBetweenTestsMinutes;
  for (const [file, text] of TEXTS) {
    const ladder = ["calibrate", "overreaching", "recovery_needed"].map((word) => text.indexOf(word));
    assert.ok(ladder.every((index) => index >= 0), `${file}: names calibrate, overreaching and recovery_needed`);
    for (const expected of [
      `${EFFORT_LIMITS.abovePlanLogs} of the last ${EFFORT_LIMITS.window}`,
      `within ${EFFORT_LIMITS.coSignalDays} days`,
      `${EFFORT_LIMITS.persistentLogs} of the last ${EFFORT_LIMITS.window}`,
      `${responseDays.min}-${responseDays.max} days`,
      `${percent(1 - hardSetRatio)}-${percent(hardSetCutUpTo)}%`,
      `${ASSESSMENT_LIMITS.dueAfterDays} days`,
      `${ASSESSMENT_LIMITS.blockedDueAfterDays} days`,
      `last ${STRENGTH_PHASE_LIMITS.recovery.testDays} days`,
      `${rest.min}-${rest.max} min`,
      `${STRENGTH_LIMITS.sessionBudgetRatio.pullUps.toFixed(1)}x`,
      `${STRENGTH_LIMITS.sessionBudgetRatio.pushUps.toFixed(1)}x`,
      `at least ${STRENGTH_LIMITS.minSessionsPerGoalExercise} sessions`
    ]) {
      assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    }
    for (const gone of ["reduce as needed", "keep one high-rep", "instead of longer holds", "near-max (RPE 9+) on planned work"]) {
      assert.ok(!text.includes(gone), `${file} no longer says: ${gone}`);
    }
  }
  const [, skill] = TEXTS[0];
  for (const field of ["assessment.protocol", "formStandard", `${rest.min}-${rest.max} minutes`]) {
    assert.ok(skill.includes(field), `SKILL.md's test protocol names ${field}`);
  }
  for (const field of ["strengthGuardrails.assessment", "testDayOffsets", "sessionBudget", "goalExposures", "readiness.calibration", "`reduce`", "two push-up goal days", "two plank holds a week", "two pull-up volume days"]) {
    assert.ok(skill.includes(field), `SKILL.md names ${field}`);
  }
});

// Spec review fixes, stated with the code's numbers: the overreaching hard-set
// cap, the budget giving way on second blocks, the end of a calibration, the
// taper phase versus the 10-day strength taper, post-race days per day, and
// the session maximum around the rest day.
test("the strength skill and policy state the spec-review rules", () => {
  const { hardSetRatio, maxFreeGoalSets } = STRENGTH_PHASE_LIMITS.overreaching;
  for (const [file, text] of TEXTS) {
    for (const expected of [
      `${Math.round(hardSetRatio * 100)}% of the last loading week`,
      `at most ${maxFreeGoalSets} sets`,
      "light technique work",
      "done as planned",
      "clearly more than planned",
      `last ${SEASON_LIMITS.phaseUntilDays.taper} days before the race`,
      `last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days`,
      `post-race days 1-${ASSESSMENT_LIMITS.postRaceNoTestDays}`
    ]) {
      assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    }
    assert.ok(!text.includes("overreaching week cannot be all light") && !/all-light week in a normal, maintenance or overreaching week/.test(text), `${file}: an all-light overreaching week is allowed`);
  }
  const [, skill] = TEXTS[0];
  for (const field of ["maxSessionsThisWeek", "strengthGuardrails.overreaching", "top block of each goal exercise"]) {
    assert.ok(skill.includes(field), `SKILL.md names ${field}`);
  }
});

// Code review M1: the numbers in the code-written prompt text come from the
// constants the rules enforce, so a changed limit changes its text too.
test("the strength prompt states the numbers of the constants it enforces", () => {
  const context = buildCoachContext({
    model: "test-model", baseline: { pullUps: 8, pushUps: 40, plankSeconds: 90 }, goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "", weekStart: "2026-11-16T00:00:00Z", weeklySessions: 3, trainingDays: [], trainingDayOffsets: [], equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z", plannedSessions: [], trainingLogs: []
  }, new Date("2026-11-16T01:30:00Z"));
  const guardrails = strengthGuardrailsForPrompt(context) as Record<string, string>;
  const { overreaching, recovery, race } = STRENGTH_PHASE_LIMITS;
  const expectations: Array<[text: string, expected: string[]]> = [
    [guardrails.assessmentRule, [
      `${ASSESSMENT_LIMITS.dueAfterDays} days`, `${ASSESSMENT_LIMITS.blockedDueAfterDays} days`, `last ${SEASON_LIMITS.phaseUntilDays.taper} days before the race`,
      `${race.lightWithinDays}-day strength taper`, `post-race days 1-${ASSESSMENT_LIMITS.postRaceNoTestDays}`, `last ${recovery.testDays} days`,
      `at least ${ASSESSMENT_LIMITS.spacingDays} days apart`
    ]],
    [guardrails.sessionBudgetRule, [`${STRENGTH_LIMITS.sessionBudgetRatio.pullUps.toFixed(1)}x`, `${STRENGTH_LIMITS.sessionBudgetRatio.pushUps.toFixed(1)}x`]],
    [guardrails.sessionCountRule, [`${STRENGTH_LIMITS.minSessions.normalWeek} in a normal week whatever the running week`]],
    [guardrails.hardSessionRule, [`more than ${STRENGTH_LIMITS.maxConsecutiveHardDays} consecutive days`]],
    [overreachingNote(), [`next ${overreaching.responseDays.min}-${overreaching.responseDays.max} days`, `${percent(1 - overreaching.hardSetRatio)}-${percent(overreaching.hardSetCutUpTo)}%`]],
    [recoveryRule(), [`${percent(1 - recovery.hardSetRatio)}-${percent(recovery.hardSetCutUpTo)}%`, `about ${percent(recovery.hardSetRatio)}%`, `last ${recovery.testDays} days`]]
  ];
  for (const [text, expected] of expectations) {
    for (const part of expected) assert.ok(text.includes(part), `${part} in: ${text}`);
  }
});

/** The overreaching rule as the prompt states it (a hand-built overreaching context). */
function overreachingNote(): string {
  const context = buildCoachContext({
    model: "test-model", baseline: { pullUps: 8, pushUps: 40, plankSeconds: 90 }, goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "", weekStart: "2026-11-16T00:00:00Z", weeklySessions: 3, trainingDays: [], trainingDayOffsets: [], equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z", plannedSessions: [], trainingLogs: []
  }, new Date("2026-11-16T01:30:00Z"));
  const overreaching = {
    ...context,
    readiness: { ...context.readiness, state: "overreaching" as const },
    periodization: { ...context.periodization!, lastLoadingWeekHardSets: 10 }
  };
  return `${(strengthGuardrailsForPrompt(overreaching) as { overreaching: { rule: string } }).overreaching.rule} ${strengthProgressionPlan(overreaching).pushUps.note}`;
}

/** The recovery-week rule as the prompt states it. */
function recoveryRule(): string {
  const phase = strengthPhaseForPrompt({
    recoveryWeek: { reason: "3:1", hardSetCap: 6, referenceHardSets: 10, maxHardSessions: 1, maxGoalSets: 3, testDayOffsets: [5, 6] },
    raceTaper: null,
    postRace: null
  }) as { recoveryWeek: { rule: string } };
  return phase.recoveryWeek.rule;
}

// Task 8: upper-body goal work never enters maintenance (running load, hard
// runs and the weeks after a race never hold it or lower the 3-session
// minimum), and the days after a race cap strength effort per day. The skill
// and policy say so with the code's numbers; the old maintenance wording is gone.
test("the strength skill and policy drop the upper-body maintenance week and state the post-race rule", () => {
  const { noHardThroughDay, atMostHardThroughDay } = STRENGTH_PHASE_LIMITS.postRace;
  for (const [file, text] of TEXTS) {
    for (const gone of [
      "the two weeks after the race",
      "2 in a heavy running week",
      "strengthGuardrails.maintenance",
      "maintenance.allowed",
      "`Maintenance`",
      "maintenance weeks included",
      "normal or maintenance week",
      "running load is the priority and blocks a safe strength increase"
    ]) {
      assert.ok(!text.includes(gone), `${file} no longer says: ${gone}`);
    }
    for (const expected of [
      `${STRENGTH_LIMITS.minSessions.normalWeek} strength sessions`,
      `post-race days 1-${noHardThroughDay}`,
      `days ${noHardThroughDay + 1}-${atMostHardThroughDay}`,
      `from day ${atMostHardThroughDay + 1}`,
      "never holds upper-body progression"
    ]) {
      assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    }
  }
  const [, skill] = TEXTS[0];
  assert.ok(skill.includes("phase.postRace"), "SKILL.md names phase.postRace");
});

// Task 8: the planner cannot prescribe heavy leg strength or plyometrics yet
// (Part 2), so the coach read no longer promises them.
test("the coach read reference points make no heavy-strength or plyometrics claim", () => {
  const race = { name: "Ridge Ultra", raceDate: "2026-12-19T00:00:00Z", distanceKm: 54 };
  for (const weekStart of ["2026-11-16T00:00:00Z", "2027-03-01T00:00:00Z", "2026-12-10T00:00:00Z"]) {
    for (const point of coachReferencePointsFor(computeSeason(race, weekStart))) {
      assert.ok(!/1RM|plyometric|ultra build/i.test(point), `${weekStart}: ${point}`);
    }
  }
});

// Final review item 1: repeated misses open the hold band down to the useful
// floor, never below it; the skill and the policy say exactly that, with the
// code's ratio, and no longer offer a larger change.
test("the strength skill and policy say missed sessions lower the target only down to the useful floor", () => {
  const floor = `down to the useful floor (${percent(STRENGTH_LIMITS.usefulFloorRatio)}% of the current best), never below it`;
  for (const [file, text] of TEXTS) {
    assert.ok(text.includes(floor), `${file} should say: ${floor}`);
    assert.ok(!text.includes("open a larger change"), `${file} no longer says: open a larger change`);
  }
});

// Final review item 3: the useful floor applies from a best of 2 reps (the
// plank from 10 s); the skill and the policy state where it starts.
test("the strength skill and policy say where the useful floor starts", () => {
  const { usefulFloorFromBest } = STRENGTH_LIMITS;
  assert.equal(usefulFloorFromBest.pullUps, usefulFloorFromBest.pushUps, "one rep threshold for pull-ups and push-ups");
  const expected = `from a best of ${usefulFloorFromBest.pushUps} reps (the plank from ${usefulFloorFromBest.plankSeconds} s)`;
  for (const [file, text] of TEXTS) assert.ok(text.includes(expected), `${file} should say: ${expected}`);
});

// Final review item 2: an exposure is useful work at the useful floor (or a
// test); the prompt rule, the skill and the policy all say so.
test("the exposure rule says work below the useful floor does not count", () => {
  const context = buildCoachContext({
    model: "test-model", baseline: { pullUps: 8, pushUps: 40, plankSeconds: 90 }, goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "", weekStart: "2026-11-16T00:00:00Z", weeklySessions: 3, trainingDays: [], trainingDayOffsets: [], equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z", plannedSessions: [], trainingLogs: []
  }, new Date("2026-11-16T01:30:00Z"));
  const rule = (strengthGuardrailsForPrompt(context) as { goalExposures: { rule: string } }).goalExposures.rule;
  assert.ok(rule.includes("progression.<metric>.usefulFloor") && rule.includes("below the useful floor"), rule);
  for (const [file, text] of TEXTS) {
    assert.ok(text.includes("work below the useful floor do not count"), `${file} should say: work below the useful floor do not count`);
  }
});

// Final review item 5: the taper pause is judged per planned day.
test("the strength texts say the taper pause is judged per day", () => {
  const context = buildCoachContext({
    model: "test-model", baseline: { pullUps: 8, pushUps: 40, plankSeconds: 90 }, goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "", weekStart: "2026-11-16T00:00:00Z", weeklySessions: 3, trainingDays: [], trainingDayOffsets: [], equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z", plannedSessions: [], trainingLogs: []
  }, new Date("2026-11-16T01:30:00Z"));
  const expected = "a week that starts before the taper takes no test on its days inside it";
  const rule = (strengthGuardrailsForPrompt(context) as { assessmentRule: string }).assessmentRule;
  assert.ok(rule.includes(expected), rule);
  for (const [file, text] of TEXTS) assert.ok(text.includes(expected), `${file} should say: ${expected}`);
});

// Final review item 8: the set range names the phase maximum.
test("the strength texts state the lighter weeks' set maximum", () => {
  const { recovery, race } = STRENGTH_PHASE_LIMITS;
  assert.equal(recovery.maxGoalSets, race.maxGoalSets, "one maximum for both lighter weeks");
  const expected = `${STRENGTH_LIMITS.goalSets.min}-${recovery.maxGoalSets} in a planned recovery week or the race taper`;
  for (const [file, text] of TEXTS) {
    assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    assert.ok(!text.includes("2-6 in a planned recovery week"), `${file} no longer says: 2-6 in a planned recovery week`);
  }
});

// The last gap of the final review: a session's goal work at medium effort or
// harder below the useful floor is raised to it (clampWeeklyPlan).
test("the strength texts say a session's medium-or-harder goal work below the useful floor is raised to it", () => {
  const expected = "a session whose goal work of an exercise is all below the useful floor at medium effort or harder has its top block raised to the floor";
  for (const [file, text] of TEXTS) assert.ok(text.includes(expected), `${file} should say: ${expected}`);
});
