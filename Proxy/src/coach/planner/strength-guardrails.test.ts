import assert from "node:assert/strict";
import test from "node:test";
import { ASSESSMENT_LIMITS } from "./assessment";
import { RECOVERY_CYCLE } from "./periodization";
import { sessionBudget } from "./session-budget";
import { clampWeeklyPlan, maxStrengthSessions, minStrengthSessions, strengthGuardrailsForPrompt, strengthProgressionPlan } from "./strength-guardrails";
import { isBlocked, progressionStep, usefulFloor, workingCap } from "./strength-limits";
import { POST_RACE_STRENGTH_TEXT } from "./season";
import { STRENGTH_PHASE_LIMITS } from "./strength-phase";
import { validateWeeklyPlan } from "./validate-week-plan";
import type { CoachContext, EffortLabel, EffortStimulus, PlannedEffort, RecentGoalPerformance, WeeklyPlan } from "./types";

const WEEK_START = "2026-05-11T00:00:00Z";

test("working caps are 85/75/80% of the best recent value, never below one rep or 10 s", () => {
  assert.equal(workingCap("pullUps", 12), 10);
  assert.equal(workingCap("pullUps", 1), 1);
  assert.equal(workingCap("pushUps", 40), 30);
  assert.equal(workingCap("plankSeconds", 90), 72);
  assert.equal(workingCap("plankSeconds", 10), 10);
  assert.equal(workingCap("pushUps", null), null);
});

// Final review item 3: the 45% useful floor applies from a best of 2 reps, so
// a pull-up best of 8 starts at 4 (not 1) and a hold band can never lock at
// 1-1. The plank keeps its floor from a best of 10 s (its working minimum is
// 10 s, so a floor of a few seconds would mean nothing).
test("the useful floor applies from a best of 2 reps; the plank keeps it from 10 s", () => {
  assert.equal(usefulFloor("pullUps", 1), null);
  assert.equal(usefulFloor("pullUps", 2), 1);
  assert.equal(usefulFloor("pullUps", 8), 4);
  assert.equal(usefulFloor("pushUps", 5), 3);
  assert.equal(usefulFloor("pushUps", 40), 18);
  assert.equal(usefulFloor("plankSeconds", 9), null);
  assert.equal(usefulFloor("plankSeconds", 10), 5);
  assert.equal(usefulFloor("plankSeconds", 90), 41);
  for (const metric of ["pullUps", "pushUps", "plankSeconds"] as const) {
    for (let best = 1; best <= 200; best += 1) {
      const floor = usefulFloor(metric, best);
      if (floor !== null) assert.ok(floor <= workingCap(metric, best)!, `${metric} best ${best}: floor ${floor} within the cap`);
    }
  }
});

test("a pull-up best of 8: the fresh band starts at the floor and 3 x 1 is sent back", () => {
  const base = hybridContext();
  const context: CoachContext = { ...base, history: { ...base.history, bestRecentTests: { pullUps: 8, pushUps: 40, plankSeconds: 90 } } };

  const pull = strengthProgressionPlan(context).pullUps;
  assert.equal(pull.status, "free");
  assert.deepEqual(pull.target, { min: 4, max: 6 });
  assert.equal(pull.floor, 4);

  const plan = hybridPlan({ pullReps: 1, pullSets: 3 });
  for (const block of plan.sessions.flatMap((s) => s.exercises)) if (block.exercise === "pullUp") block.reps = 1;
  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("pull-up goal work is below the useful stimulus floor (1 < 4)")), messages.join("\n"));
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pullReps: 6, pullSets: 3 }), context), { accepted: true, messages: [] });

  // A previous prescription of 3 x 1 never holds the band at 1-1: it is raised to the floor.
  const held: CoachContext = {
    ...context,
    plannedWork: {
      ...context.plannedWork,
      recentGoalTargets: {
        ...context.plannedWork.recentGoalTargets,
        pullUps: { latestTarget: 1, latestVolume: 3, flatCount: 1, latestDate: "2026-05-07T08:00:00Z", latestWorkingTarget: 1, latestWorkingSets: 3, latestWorkingDate: "2026-05-07T08:00:00Z" }
      }
    }
  };
  const hold = strengthProgressionPlan(held).pullUps;
  assert.equal(hold.status, "hold");
  assert.deepEqual(hold.target, { min: 4, max: 4 });
});

test("progression steps scale with the metric and the current level", () => {
  assert.deepEqual(progressionStep("pullUps", 8), { min: 1, max: 1 });
  assert.deepEqual(progressionStep("pushUps", 12), { min: 1, max: 1 });
  assert.deepEqual(progressionStep("pushUps", 20), { min: 1, max: 2 });
  assert.deepEqual(progressionStep("pushUps", 40), { min: 1, max: 3 });
  assert.deepEqual(progressionStep("plankSeconds", 45), { min: 5, max: 10 });
  assert.deepEqual(progressionStep("plankSeconds", 90), { min: 5, max: 15 });
});

test("rejects working reps above the cap with the cap, the ratio and the best", () => {
  const plan = hybridPlan({ pushReps: 35 });

  const result = validateWeeklyPlan(plan, hybridContext());

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.includes("prescribes 35 reps per set; the working cap is 30 (75% of the best recent 40)")));
});

test("clamp lowers over-cap goal work to the cap but leaves tests alone", () => {
  const plan = hybridPlan({ pushReps: 35 });
  plan.sessions[1].exercises.push(exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0)));
  plan.sessions[1].plannedEffort = effort("max_output", 10, "test", 0);

  const { plan: clamped, adjustments } = clampWeeklyPlan(plan, hybridContext());

  assert.equal(clamped.sessions[0].exercises[1].reps, 30);
  assert.equal(clamped.sessions[1].exercises.at(-1)?.reps, 12);
  assert.ok(adjustments.some((a) => a.includes("35 lowered to the working cap of 30 reps")));
  assert.equal(plan.sessions[0].exercises[1].reps, 35, "input is not mutated");
});

test("a strength clamp notes the new numbers in the session rationale so the text never quotes the old reps", () => {
  const plan = hybridPlan({ pushReps: 35 });
  plan.sessions[0].progressionRationale = "Push-ups move to 35 reps per set.";

  const { plan: clamped } = clampWeeklyPlan(plan, hybridContext());

  assert.equal(
    clamped.sessions[0].progressionRationale,
    "Push-ups move to 35 reps per set. Adjusted to the plan limits: Push-ups 35 -> 30 reps per set (working cap)."
  );
  assert.equal(clamped.sessions[1].progressionRationale, plan.sessions[1].progressionRationale, "untouched sessions keep their text");
  assert.equal(plan.sessions[0].progressionRationale, "Push-ups move to 35 reps per set.", "input is not mutated");
});

test("without earned progression the top target stays in the hold band; clamp lowers an unearned increase", () => {
  const context = hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } });
  const plan = hybridPlan({ pushReps: 27 });

  const result = validateWeeklyPlan(plan, context);
  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.includes("push-up progression is not earned this week: keep the top working target between 22 and 24 reps (previous 24); got 27")));

  const { plan: clamped, adjustments } = clampWeeklyPlan(plan, context);
  assert.equal(clamped.sessions[0].exercises[1].reps, 24);
  assert.ok(adjustments.some((a) => a.includes("progression not earned")));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

test("an unexplained drop of more than one step is rejected unless sessions were recently missed", () => {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } } });
  const plan = hybridPlan({ pullReps: 6 });

  const result = validateWeeklyPlan(plan, context);
  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.includes("pull-up target dropped more than one step") && m.includes("between 7 and 8 reps")));

  const missed = { ...context, adherence: { ...context.adherence, missedLast14Days: 2 } };
  assert.deepEqual(validateWeeklyPlan(plan, missed), { accepted: true, messages: [] });
});

test("a previous prescription older than three weeks does not anchor the hold band", () => {
  const context = hybridContext({ previous: { pushUps: { target: 20, sets: 3, date: "2026-04-10T08:00:00Z" } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 26 }), context), { accepted: true, messages: [] });
});

// Final review item 1: repeated misses open the hold band down to the useful
// floor (45% of the best), never below it, so the planner is never told a
// target the useful-floor check then rejects. The calibration hold uses the
// same band.
test("two missed sessions open the hold band down to the useful floor, not to 1, and a week at the floor validates", () => {
  const missed = (context: CoachContext): CoachContext => ({ ...context, adherence: { ...context.adherence, missedLast14Days: 2 } });
  const context = missed(hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } }));

  const push = strengthProgressionPlan(context).pushUps;
  assert.equal(push.status, "hold");
  assert.deepEqual(push.target, { min: 18, max: 24 }, "best 40: useful floor 18");
  assert.ok(push.note.includes("between 18 and 24 reps"), push.note);
  const prompt = strengthGuardrailsForPrompt(context) as { progression: { pushUps: { allowedTopTarget: unknown } } };
  assert.deepEqual(prompt.progression.pushUps.allowedTopTarget, { min: 18, max: 24 });
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 18 }), context), { accepted: true, messages: [] });
  const tooLow = hybridPlan({ pushReps: 10 });
  for (const block of tooLow.sessions.flatMap((s) => s.exercises)) if (block.exercise === "pushUp") block.reps = 10;
  const below = validateWeeklyPlan(tooLow, context).messages;
  assert.ok(below.some((m) => m.includes("below the useful level") && m.includes("between 18 and 24 reps")), below.join("\n"));
  assert.ok(!below.some((m) => m.includes("without a computed reason")), "missed sessions are a computed reason");

  const calibrated: CoachContext = { ...context, readiness: { ...context.readiness, calibration: { metrics: ["pushUps"], reason: "effort above plan" } } };
  const held = strengthProgressionPlan(calibrated).pushUps;
  assert.equal(held.status === "hold" && held.reason, "calibration");
  assert.deepEqual(held.target, { min: 18, max: 24 });
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 18 }), calibrated), { accepted: true, messages: [] });
});

test("sets may rise by one without earned progression, not by two", () => {
  const context = hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 24, pushSets: 4 }), context), { accepted: true, messages: [] });
  const tooMany = validateWeeklyPlan(hybridPlan({ pushReps: 24, pushSets: 5 }), context);
  assert.ok(tooMany.messages.some((m) => m.includes("push-up sets can rise by at most one per week: at most 4 sets (previous 3); got 5")));
});

// Code review I1, made safer in the final review: useful goal work has a
// value. A working block written without one (0 reps) is sent back; the clamp
// fills it only when the metric has a band (hold, earned, maintenance,
// reduce), and never above the bottom of that band.
test("a working goal block written without reps is sent back, and the clamp gives it the band's bottom", () => {
  const context = hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } });
  const plan = hybridPlan({ pushReps: 0 });

  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("pushUp") && m.includes("0 reps")), messages.join("\n"));
  const rule = (strengthGuardrailsForPrompt(context) as { workingCapRule: string }).workingCapRule;
  assert.ok(rule.includes("without a number") && rule.includes("allowedTopTarget"), "the prompt states the rule");
  const clamped = clampWeeklyPlan(plan, context).plan;
  assert.equal(clamped.sessions[0].exercises[1].reps, 22, "the hold band is 22-24");
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

// Final review (probe H2): in a recovery_needed (pain) week push-ups are free
// (only the caps apply), so an empty working block is never filled to the
// working cap; the validator sends it back instead.
test("an empty working block in a pain week is sent back, not filled to the cap (probe H2)", () => {
  const context: CoachContext = { ...hybridContext(), readiness: { state: "recovery_needed", riskFlags: ["recent_pain_level_4_or_higher"] } };
  const plan: WeeklyPlan = { ...hybridPlan({}), summary: "Restore: shoulder pain.", contextState: "recovery_needed", safetyFlags: ["Shoulder pain."] };
  plan.sessions = [{ ...plan.sessions[1], exercises: [exercise("pushUp", 3, 0, 0, effort("medium", 6, "volume", 4))] }];

  assert.equal(strengthProgressionPlan(context).pushUps.status, "free");
  const clamped = clampWeeklyPlan(plan, context).plan;
  assert.deepEqual([clamped.sessions[0].exercises[0].reps, clamped.sessions[0].exercises[0].sets], [0, 3]);
  const messages = validateWeeklyPlan(clamped, context).messages;
  assert.ok(messages.some((m) => m.includes("pushUp") && m.includes("0 reps")), messages.join("\n"));
});

test("an unexplained drop of more than one step is rejected unless sessions were recently missed", () => {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } } });
  const plan = hybridPlan({ pullReps: 6 });

  const result = validateWeeklyPlan(plan, context);
  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((m) => m.includes("pull-up target dropped more than one step") && m.includes("between 7 and 8 reps")));

  const missed = { ...context, adherence: { ...context.adherence, missedLast14Days: 2 } };
  assert.deepEqual(validateWeeklyPlan(plan, missed), { accepted: true, messages: [] });
});

test("a previous prescription older than three weeks does not anchor the hold band", () => {
  const context = hybridContext({ previous: { pushUps: { target: 20, sets: 3, date: "2026-04-10T08:00:00Z" } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 26 }), context), { accepted: true, messages: [] });
});

test("sets may rise by one without earned progression, not by two", () => {
  const context = hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 24, pushSets: 4 }), context), { accepted: true, messages: [] });
  const tooMany = validateWeeklyPlan(hybridPlan({ pushReps: 24, pushSets: 5 }), context);
  assert.ok(tooMany.messages.some((m) => m.includes("push-up sets can rise by at most one per week: at most 4 sets (previous 3); got 5")));
});

test("earned push-up progression from 24 allows +1 to +2 reps or one more set", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 3 } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 26 }), context), { accepted: true, messages: [] });
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 24, pushSets: 4 }), context), { accepted: true, messages: [] });

  const tooBig = validateWeeklyPlan(hybridPlan({ pushReps: 27 }), context);
  assert.ok(tooBig.messages.some((m) => m.includes("push-up progression must be +1 to +2 repetitions from 24") && m.includes("got +3")));

  const held = validateWeeklyPlan(hybridPlan({ pushReps: 24 }), context);
  assert.ok(held.messages.some((m) => m.includes("earned push-up progression") && m.includes("prescribe 25-26 reps") && m.includes("or keep 24 reps and use 4 sets")));
});

test("clamp drops the set increase when the earned target already rose", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 3 } } });
  const plan = hybridPlan({ pushReps: 25, pushSets: 4 });

  assert.ok(validateWeeklyPlan(plan, context).messages.some((m) => m.includes("cannot increase sets and the target in the same step")));
  const { plan: clamped } = clampWeeklyPlan(plan, context);
  assert.equal(clamped.sessions[0].exercises[1].sets, 3);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

test("when the working cap blocks a rep step, earned progression must add a set", () => {
  // Best 40 -> cap 30. Two clean completions at 30 earn progression, but 31 > cap;
  // 4 x 30 stays inside the session budget of 140 (pull-ups at 3 x 10 of 12 would not: 40 > 36).
  const context = hybridContext({ earned: { pushUps: { logged: 30, target: 30, sets: 3, consecutive: 2 } } });

  const held = validateWeeklyPlan(hybridPlan({ pushReps: 30, pushSets: 3 }), context);
  assert.ok(held.messages.some((m) => m.includes("would exceed the working cap of 30: keep 30 reps and use 4 sets")), held.messages.join("\n"));
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 30, pushSets: 4 }), context), { accepted: true, messages: [] });
});

test("earned plank progression from 60 s allows +5 to +15 s inside the cap", () => {
  const context = hybridContext({ earned: { plankSeconds: { logged: 70, target: 60, sets: 3 } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ plankSeconds: 72 }), context), { accepted: true, messages: [] });
  const tooBig = validateWeeklyPlan(hybridPlan({ plankSeconds: 80 }), context);
  assert.ok(tooBig.messages.some((m) => m.includes("plank progression must be +5 to +15 seconds from 60") || m.includes("working cap is 72")));
});

// Task 8: upper-body goal work has no maintenance week (running load does not
// limit it), so holding earned progression is sent back in a hybrid week too;
// it used to be allowed as a "maintenance hold".
test("earned progression is required in a hybrid week: holding it is sent back", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 3 } } });

  assert.equal(strengthProgressionPlan(context).pushUps.status, "earned");
  const held = validateWeeklyPlan(hybridPlan({ pushReps: 24 }), context);
  assert.ok(held.messages.some((m) => m.includes("earned push-up progression") && m.includes("Got 24 reps")), held.messages.join("\n"));
  assert.ok(!held.messages.some((m) => /maintenance/i.test(m)), held.messages.join("\n"));
});

test("goal work in a normal week uses 3-6 sets; clamp brings 7 sets down to 6", () => {
  // 6 x 20 stays inside the push-up session budget (140), so only the set limit applies.
  const plan = hybridPlan({ pushReps: 20, pushSets: 7 });

  const result = validateWeeklyPlan(plan, hybridContext());
  assert.ok(result.messages.some((m) => m.includes("has 7 working sets; goal work uses 3-6 sets this week")));

  const { plan: clamped } = clampWeeklyPlan(plan, hybridContext());
  assert.equal(clamped.sessions[0].exercises[1].sets, 6);
});

test("caps hard strength sessions at two alongside running and three without", () => {
  const plan = hybridPlan({});
  plan.sessions[1] = { ...plan.sessions[1], plannedEffort: effort("hard", 7, "strength", 3) };
  plan.sessions.push(session("Third hard day", 6, "hard"));
  // Three strength days, so the three-session plan is about the hard cap only.
  const threeDays = (context: CoachContext): CoachContext => ({ ...context, profile: { ...context.profile, weeklySessions: 3 } });

  const withRunning = validateWeeklyPlan(plan, threeDays(hybridContext()));
  assert.ok(withRunning.messages.some((m) => m.includes("3 hard strength sessions") && m.includes("weekly cap is 2 alongside the running week")));

  const strengthOnly = validateWeeklyPlan(plan, threeDays({ ...hybridContext(), running: undefined })).messages;
  assert.ok(!strengthOnly.some((m) => m.includes("hard strength sessions")), strengthOnly.join("\n"));
  assert.ok(!strengthOnly.some((m) => m.includes("future sessions") || m.includes("strength sessions;")), strengthOnly.join("\n"));
});

test("rejects hard strength on more than two consecutive days", () => {
  const plan = hybridPlan({});
  plan.sessions = [session("Day one", 1, "hard"), session("Day two", 2, "hard"), session("Day three", 3, "hard")];
  const strengthOnly = { ...hybridContext(), running: undefined };

  const result = validateWeeklyPlan(plan, strengthOnly);

  assert.ok(result.messages.some((m) => m.includes("3 consecutive days (offsets 1-3)")));
});

test("a goal test within 28 days of the last one is rejected; a due test skips the progression band", () => {
  const recentTest = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } }, latestPullTest: "2026-04-30T08:00:00Z" });
  const plan = hybridPlan({});
  plan.sessions[1] = {
    ...session("Pull-up assessment", 4, "max_output", "test"),
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0)), ...secondDayPushAndPlank()]
  };

  assert.ok(validateWeeklyPlan(plan, recentTest).messages.some((m) => m.includes(`fewer than ${ASSESSMENT_LIMITS.spacingDays} days ago`)));

  const dueTest = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } }, latestPullTest: "2026-03-30T08:00:00Z" });
  assert.deepEqual(validateWeeklyPlan(plan, dueTest), { accepted: true, messages: [] });
});

test("a baseline set at a recent plan block start counts as a fresh test for the 28-day spacing", () => {
  const plan = hybridPlan({});
  plan.sessions[1] = {
    ...session("Pull-up assessment", 4, "max_output", "test"),
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0)), ...secondDayPushAndPlank()]
  };
  const withBaselineAt = (baselineSetAt: string) => {
    const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } } });
    context.plannedWork.recentGoalPerformance!.pullUps.baselineSetAt = baselineSetAt;
    return context;
  };

  const messages = validateWeeklyPlan(plan, withBaselineAt("2026-05-04T00:00:00Z")).messages;
  assert.ok(messages.some((m) => m.includes(`pull-up baseline was set at the plan block start on 2026-05-04, fewer than ${ASSESSMENT_LIMITS.spacingDays} days ago`)));
  assert.deepEqual(validateWeeklyPlan(plan, withBaselineAt("2026-03-01T00:00:00Z")), { accepted: true, messages: [] });
});

// Review finding: after a 1-set prescription (a legacy plan, or an
// Assessment matched as the standard), earned progression clamped 25 x 3 to
// 25 x 1 and then failed the goal-set range. It continues at the week's
// minimum: 3 sets in a normal week.
test("progression from a 1-set prescription continues from the week's minimum sets and never clamps below it", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 1 } } });
  const progression = strengthProgressionPlan(context);

  assert.equal(progression.pushUps.previousSets, 3);
  assert.match(progression.pushUps.note, /with at most 3 sets/);

  const { plan: clamped, adjustments } = clampWeeklyPlan(hybridPlan({ pushReps: 25, pushSets: 4 }), context);
  assert.equal(clamped.sessions[0].exercises[1].sets, 3);
  assert.ok(adjustments.some((a) => a.includes("sets lowered from 4 to 3")));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });

  const single = clampWeeklyPlan(hybridPlan({ pushReps: 25, pushSets: 1 }), context).plan;
  assert.equal(single.sessions[0].exercises[1].sets, 3, "a single working set is raised to the normal-week 3-set minimum");
  assert.deepEqual(validateWeeklyPlan(single, context), { accepted: true, messages: [] });
});

test("an unearned week after a 1-set prescription holds at the week's minimum sets or more", () => {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 1 } } });
  const progression = strengthProgressionPlan(context);

  assert.equal(progression.pullUps.previousSets, 3);
  assert.equal(progression.pullUps.maxSets, 4);
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pullReps: 8, pullSets: 3 }), context), { accepted: true, messages: [] });
});

// Task 8: the strength side had no post-race rule, so very_hard strength the
// day after an ultra passed. Judged per planned day from the race date:
// post-race days 1-2 light or medium only, days 3-7 at most hard (no
// very_hard or max_output, so no tests), from day 8 normal progression.
function postRaceContext(raceDate: string): CoachContext {
  const context = hybridContext();
  return { ...context, running: { ...context.running!, raceGoal: { ...context.running!.raceGoal, raceDate } } };
}

/** hybridPlan with its hard session on `dayOffset` and its pull-ups at `label` (a test for max_output). */
function hardDayPlan(dayOffset: number, label: "hard" | "very_hard" | "max_output"): WeeklyPlan {
  const plan = hybridPlan({});
  const day = plan.sessions[0];
  day.dayOffset = dayOffset;
  plan.sessions[1].dayOffset = dayOffset === 4 ? 5 : 4;
  const rpe = { hard: 7, very_hard: 9, max_output: 10 }[label];
  day.plannedEffort = effort(label, rpe, label === "max_output" ? "test" : "strength", label === "max_output" ? 0 : label === "very_hard" ? 1 : 3);
  day.exercises[0] = label === "max_output"
    ? exercise("pullUp", 1, 0, 0, effort("max_output", 10, "test", 0))
    : exercise("pullUp", 4, 8, 0, effort(label, rpe, "strength", label === "very_hard" ? 1 : 3));
  return plan;
}

const postRaceMessages = (messages: string[]) => messages.filter((message) => message.includes("after Ridge Ultra 60K"));

test("very_hard strength the day after a race is lowered or rejected; days 3-7 allow hard but not very_hard; day 8 normal", () => {
  // The race was yesterday: offset 1 is post-race day 2, offset 2 day 3, offset 6 day 7.
  const context = postRaceContext("2026-05-10T00:00:00Z");

  const dayTwo = hardDayPlan(1, "very_hard");
  assert.ok(postRaceMessages(validateWeeklyPlan(dayTwo, context).messages).some((m) => m.includes("day 2 after Ridge Ultra 60K") && m.includes("Lower it to medium or light")), validateWeeklyPlan(dayTwo, context).messages.join("\n"));
  const dayTwoClamped = clampWeeklyPlan(dayTwo, context).plan;
  assert.deepEqual(dayTwoClamped.sessions[0].exercises.map((e) => e.plannedEffort.label), ["medium", "medium", "medium"]);
  assert.equal(dayTwoClamped.sessions[0].plannedEffort.label, "medium");
  assert.match(dayTwoClamped.sessions[0].progressionRationale, /Pull-ups very hard -> medium effort/);
  assert.ok(dayTwoClamped.safetyFlags.includes(`After Ridge Ultra 60K, ${POST_RACE_STRENGTH_TEXT}.`), dayTwoClamped.safetyFlags.join("\n"));
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(dayTwoClamped, context).messages), []);

  // Day 3: hard is fine, very_hard is lowered to hard.
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(hardDayPlan(2, "hard"), context).messages), []);
  const dayThree = hardDayPlan(2, "very_hard");
  assert.ok(postRaceMessages(validateWeeklyPlan(dayThree, context).messages).some((m) => m.includes("day 3 after Ridge Ultra 60K") && m.includes("at most hard")));
  const dayThreeClamped = clampWeeklyPlan(dayThree, context).plan;
  assert.deepEqual(dayThreeClamped.sessions[0].exercises.map((e) => e.plannedEffort.label), ["hard", "hard", "medium"]);
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(dayThreeClamped, context).messages), []);

  // Day 7: no very_hard and no test.
  assert.ok(postRaceMessages(validateWeeklyPlan(hardDayPlan(6, "very_hard"), context).messages).some((m) => m.includes("day 7 after")));
  const test = hardDayPlan(6, "max_output");
  assert.ok(postRaceMessages(validateWeeklyPlan(test, context).messages).some((m) => m.includes("is a test") && m.includes("day 7 after")));
  const noTest = clampWeeklyPlan(test, context).plan;
  assert.notEqual(noTest.sessions[0].exercises[0].plannedEffort.stimulus, "test", "the test became working or technique sets");
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(noTest, context).messages), []);

  // Day 8 and later: normal progression, very_hard allowed.
  const later = postRaceContext("2026-05-04T00:00:00Z");
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(hardDayPlan(1, "very_hard"), later).messages), []);
  assert.equal(clampWeeklyPlan(hardDayPlan(1, "very_hard"), later).plan.sessions[0].exercises[0].plannedEffort.label, "very_hard");
});

// The race inside the week (offset 3) or on the week start: the days after it
// are post-race days, though the season still reads the race as upcoming.
test("the post-race rule also covers the days after a race inside the week or on the week start", () => {
  const raceThisWeek = postRaceContext("2026-05-14T00:00:00Z");
  assert.ok(postRaceMessages(validateWeeklyPlan(hardDayPlan(4, "hard"), raceThisWeek).messages).some((m) => m.includes("day 1 after")));

  const raceToday = postRaceContext("2026-05-11T00:00:00Z");
  assert.ok(postRaceMessages(validateWeeklyPlan(hardDayPlan(1, "hard"), raceToday).messages).some((m) => m.includes("day 1 after")));
  assert.deepEqual(postRaceMessages(validateWeeklyPlan(hardDayPlan(3, "hard"), raceToday).messages), []);
});

test("the post-race rule reaches the prompt with its numbers and keeps the week a normal week", () => {
  const context = postRaceContext("2026-05-10T00:00:00Z");
  const guardrails = strengthGuardrailsForPrompt(context) as {
    phase: { postRace: { rule: string; noHardDayOffsets: number[]; atMostHardDayOffsets: number[] } } | null;
    minSessionsThisWeek: number;
    goalSetsPerExercise: { min: number };
  };
  const { noHardThroughDay, atMostHardThroughDay } = STRENGTH_PHASE_LIMITS.postRace;

  assert.deepEqual(guardrails.phase?.postRace.noHardDayOffsets, [1]);
  assert.deepEqual(guardrails.phase?.postRace.atMostHardDayOffsets, [2, 3, 4, 5, 6]);
  for (const part of [`post-race days 1-${noHardThroughDay}`, `days ${noHardThroughDay + 1}-${atMostHardThroughDay}`, `from day ${atMostHardThroughDay + 1}`]) {
    assert.ok(guardrails.phase?.postRace.rule.includes(part), `${part} in: ${guardrails.phase?.postRace.rule}`);
  }
  assert.equal(guardrails.minSessionsThisWeek, 2, "the normal minimum (2 free strength days here)");
  assert.equal(guardrails.goalSetsPerExercise.min, 3, "normal-week goal sets");
  assert.equal(ASSESSMENT_LIMITS.postRaceNoTestDays, atMostHardThroughDay);
});

// Planned recovery week: hard strength volume cut 40-60%, one hard session,
// no tests, at most 3 sets per goal exercise, no progression requirement.
function recoveryWeekContext(): CoachContext {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 }, pushUps: { target: 24, sets: 3 } } });
  // Three strength days: the loading-style plans below use three sessions.
  context.profile = { ...context.profile, weeklySessions: 3 };
  context.periodization = {
    cycle: "3:1",
    blockWeek: 4,
    loadingWeeksSinceRecovery: 3,
    lastUnloadingWeek: null,
    recoveryWeekDue: true,
    recoveryWeekReason: "3 loading weeks since the block start: block week 4 is a planned recovery week (3:1).",
    recoveryWeek: {
      startsAt: WEEK_START,
      endsAt: "2026-05-18T00:00:00Z",
      referenceWeeklyKm: 45,
      weeklyKmCap: 33.8,
      targetWeeklyKm: { low: 27, high: 33.8 },
      longRunCapKm: 14,
      maxQualityRuns: 1,
      referenceHardStrengthSets: 14,
      hardStrengthSetCap: 8,
      maxHardStrengthSessions: 1,
      maxGoalSetsPerExercise: 3
    },
    recentWeeks: []
  };
  return context;
}

// Task 8 review: the Maintenance phase is gone, but a model that still writes
// "Maintenance:" should not spend the one repair on the summary prefix. The
// clamp renames it to the week's phase: Offload in a planned recovery week or
// a reactive state (overreaching, recovery needed), else Build.
test("a Maintenance: summary is renamed by the clamp and then passes", () => {
  const normal = hybridContext();
  const plan = { ...hybridPlan({}), summary: "Maintenance: easy upper body after the race." };
  const { plan: clamped, adjustments } = clampWeeklyPlan(plan, normal);
  assert.equal(clamped.summary, "Build: easy upper body after the race.");
  assert.ok(adjustments.some((a) => a.includes("Maintenance") && a.includes("Build:")), adjustments.join("\n"));
  assert.ok(!validateWeeklyPlan(clamped, normal).messages.some((m) => m.includes("summary")), validateWeeklyPlan(clamped, normal).messages.join("\n"));
  assert.ok(validateWeeklyPlan(plan, normal).messages.some((m) => m.includes("summary must start")), "unclamped, the validator still names the phases");

  const recovery = recoveryWeekContext();
  const lighter = clampWeeklyPlan({ ...loadingStylePlan(), summary: "Maintenance: lighter week." }, recovery).plan;
  assert.equal(lighter.summary, "Offload: lighter week.");

  const overreaching: CoachContext = { ...normal, readiness: { state: "overreaching", riskFlags: [], reason: "Effort above plan twice, and a result below plan." } };
  assert.equal(clampWeeklyPlan({ ...plan, contextState: "overreaching" }, overreaching).plan.summary, "Offload: easy upper body after the race.");

  // The race taper is a lighter phase too (code review).
  const taper = hybridContext();
  taper.running = { ...taper.running!, raceGoal: { ...taper.running!.raceGoal, raceDate: "2026-05-17T00:00:00Z" } };
  assert.equal(clampWeeklyPlan(plan, taper).plan.summary, "Offload: easy upper body after the race.");
});

// The test sits mid-week (offset 4): a recovery week takes a test only on its
// last 2 days (offsets 5 and 6 here; assessment.test.ts covers those).
function loadingStylePlan(): WeeklyPlan {
  const plan = hybridPlan({ pullReps: 9, pullSets: 4, pushReps: 24, pushSets: 4 });
  plan.sessions.push({
    ...session("Pull-up assessment", 4, "max_output", "test"),
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0))]
  });
  plan.sessions[1] = { ...plan.sessions[1], dayOffset: 3, plannedEffort: effort("hard", 7, "volume", 3) };
  plan.sessions[1].exercises[0] = exercise("pullUp", 4, 7, 0, effort("hard", 7, "volume", 3));
  return plan;
}

test("a planned recovery week rejects a loading-style plan with the limit and value in each message", () => {
  const context = recoveryWeekContext();
  const messages = validateWeeklyPlan(loadingStylePlan(), context).messages;

  for (const expected of [
    "This is a planned recovery week: the summary must start with Offload:.",
    "Session 3 (Pull-up assessment) pullUp is a test, but planned recovery week: no tests before its last 2 days (offset 5 or 6).",
    "Session 1 (Full-body strength) pullUp has 4 sets; planned recovery week: at most 3 sets per goal exercise.",
    "the weekly cap is 1 in a planned recovery week",
    "The recovery week has 13 hard strength sets (hard, very_hard, max_output); the cap is 8, 60% of the 14 hard sets in the last loading week.",
    "pull-up work must not progress this week"
  ]) {
    assert.ok(messages.some((m) => m.includes(expected)), `expected: ${expected}\n${messages.join("\n")}`);
  }
  assert.equal(strengthProgressionPlan(context).pullUps.status, "offload");
});

test("the clamp turns a loading-style plan into a valid recovery week and says so", () => {
  const context = recoveryWeekContext();
  const { plan: clamped, adjustments } = clampWeeklyPlan(loadingStylePlan(), context);

  assert.match(clamped.summary, /^Offload: /);
  assert.ok(clamped.safetyFlags.includes(`This is a planned recovery week: lighter on purpose after ${RECOVERY_CYCLE.loadingWeeksBeforeRecovery} loading weeks.`), clamped.safetyFlags.join("\n"));
  assert.equal(clamped.sessions[2].exercises[0].plannedEffort.label, "medium", "the test became working sets");
  assert.equal(clamped.sessions[2].exercises[0].sets, 2);
  assert.ok(clamped.sessions[2].exercises[0].reps <= 8, "inside the no-progression band");
  assert.equal(clamped.sessions.filter((s) => [s.plannedEffort.label, ...s.exercises.map((e) => e.plannedEffort.label)].some((l) => l === "hard")).length, 1);
  assert.ok(clamped.sessions.every((s) => s.exercises.every((e) => !["pullUp", "pushUp", "plank"].includes(e.exercise) || e.sets <= 3)));
  assert.ok(adjustments.some((a) => a.includes("trimmed to")) || adjustments.some((a) => a.includes("lowered to medium")));
  assert.match(clamped.sessions[0].progressionRationale, /Adjusted to the plan limits: /);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

test("an all-light or held recovery week is accepted without progression", () => {
  const context = recoveryWeekContext();
  const plan = hybridPlan({ pullReps: 6, pullSets: 2, pushReps: 18, pushSets: 2 });
  plan.summary = "Offload: planned recovery week, fewer sets.";
  plan.sessions[0] = { ...plan.sessions[0], plannedEffort: effort("medium", 6, "volume", 4) };
  plan.sessions[0].exercises = plan.sessions[0].exercises.map((e) => ({ ...e, plannedEffort: effort("medium", 6, "volume", 4) }));

  assert.deepEqual(validateWeeklyPlan(plan, context), { accepted: true, messages: [] });
});

test("in the last 10 days strength stays light and nothing is hard within 4 days of the race", () => {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } }, earned: { pushUps: { logged: 27, target: 24, sets: 3 } } });
  context.running = { ...context.running!, raceGoal: { ...context.running!.raceGoal, raceDate: "2026-05-17T00:00:00Z" }, weeksToRace: 1 };
  const plan = hybridPlan({});
  plan.sessions[1] = { ...plan.sessions[1], dayOffset: 3, plannedEffort: effort("hard", 7, "strength", 3) };
  plan.sessions[1].exercises[0] = exercise("pullUp", 3, 6, 0, effort("hard", 7, "strength", 3));
  plan.sessions[0].exercises[0] = exercise("pullUp", 3, 8, 0, effort("very_hard", 9, "strength", 1));

  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("Session 1 (Full-body strength) pullUp is very_hard; 4 days before Ridge Ultra 60K")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("Session 2 (Pull and core) session is hard; 3 days before Ridge Ultra 60K: nothing hard within 4 days of the race")));
  assert.ok(!messages.some((m) => m.includes("earned push-up progression")), "no progression requirement this close to the race");

  const { plan: clamped } = clampWeeklyPlan(plan, context);
  assert.equal(clamped.sessions[1].plannedEffort.label, "medium");
  assert.ok(clamped.safetyFlags.some((flag) => flag.startsWith("Ridge Ultra 60K is ") && flag.includes(`-day strength taper; strength stays light, and nothing hard within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days`)), clamped.safetyFlags.join("\n"));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

// Final review item 10: the race-taper reasons the athlete reads say "1 day", never "day(s)".
test("the strength taper's day count reads as plain words", () => {
  const context = hybridContext();
  context.running = { ...context.running!, raceGoal: { ...context.running!.raceGoal, raceDate: "2026-05-14T00:00:00Z" }, weeksToRace: 1 };
  const plan = hybridPlan({});
  plan.sessions[0] = { ...plan.sessions[0], dayOffset: 2, plannedEffort: effort("hard", 7, "strength", 3) };

  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("1 day before Ridge Ultra 60K")), messages.join("\n"));
  const clamped = clampWeeklyPlan(plan, context);
  const text = JSON.stringify([messages, clamped.plan, clamped.adjustments, strengthGuardrailsForPrompt(context)]);
  assert.ok(!text.includes("(s)"), text.match(/.{60}\(s\).{20}/)?.[0]);
});

// Final review item 8: goalSetsPerExercise always said at most 6 sets, while
// a planned recovery week and the race taper hold at most 3.
test("goal sets per exercise state the phase maximum in a recovery week and the race taper", () => {
  const sets = (context: CoachContext) => (strengthGuardrailsForPrompt(context) as { goalSetsPerExercise: { min: number; max: number } }).goalSetsPerExercise;
  assert.deepEqual(sets(hybridContext()), { min: 3, max: 6 }, "a normal week");
  assert.deepEqual(sets(recoveryWeekContext()), { min: 2, max: STRENGTH_PHASE_LIMITS.recovery.maxGoalSets });
  const taper = hybridContext();
  taper.running = { ...taper.running!, raceGoal: { ...taper.running!.raceGoal, raceDate: "2026-05-17T00:00:00Z" }, weeksToRace: 1 };
  assert.deepEqual(sets(taper), { min: 2, max: STRENGTH_PHASE_LIMITS.race.maxGoalSets });
});

// Plan-owner decision: free text never relaxes a rule; logged pain (4 or more)
// lowers the plan through readiness. A pain note used to drop the minimum to 0.
test("a profile note never lowers the strength session minimum", () => {
  const minimumWith = (profileNotes: string) => {
    const context = hybridContext({});
    context.profile = { ...context.profile, profileNotes };
    return minStrengthSessions(context);
  };

  assert.equal(minimumWith(""), 2);
  assert.equal(minimumWith("knie doet pijn bij afdalen"), 2);
  assert.equal(minimumWith("Left shoulder hurts on push-ups."), 2);
});

// Review finding: a race stored without a name read "...the last 10 days before ."
test("a race without a name reads as your race in the strength taper text", () => {
  const context = hybridContext({});
  context.running = { ...context.running!, raceGoal: { ...context.running!.raceGoal, name: "  ", raceDate: "2026-05-17T00:00:00Z" }, weeksToRace: 1 };
  const plan = hybridPlan({});
  plan.sessions[1] = { ...plan.sessions[1], dayOffset: 3, plannedEffort: effort("hard", 7, "strength", 3) };
  plan.sessions[1].exercises[0] = exercise("pullUp", 3, 6, 0, effort("hard", 7, "strength", 3));

  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("3 days before your race: nothing hard within 4 days")), messages.join("\n"));
  const { plan: clamped } = clampWeeklyPlan(plan, context);
  assert.ok(clamped.safetyFlags.includes(`Your race is 6 days away: this week is inside the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper; strength stays light, and nothing hard within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race.`), clamped.safetyFlags.join("\n"));
});

// Code review: the offload note said "The last 10 days before" the race even
// when only the week's last planned days fall inside the strength taper.
test("a race 16 days out: the offload note says the strength taper starts this week", () => {
  const context = hybridContext({ previous: { pushUps: { target: 24, sets: 3 } } });
  context.running = { ...context.running!, raceGoal: { ...context.running!.raceGoal, raceDate: "2026-05-27T00:00:00Z" } };

  const note = strengthProgressionPlan(context).pushUps.note;
  assert.ok(note.startsWith(`Ridge Ultra 60K is 16 days away: the ${STRENGTH_PHASE_LIMITS.race.lightWithinDays}-day strength taper starts this week. No progression is required`), note);
});

// Session budget per goal exercise (14 Nov audit): useful working sets x
// reps (or seconds) stay at or below 3.0 x best (pull-ups) and 3.5 x best
// (push-ups, plank). Six sets at the cap reached 4.5-4.8 x max.
test("40 push-ups: 6 x 30 is clamped to 4 sets (session budget 140)", () => {
  const { plan: clamped, adjustments } = clampWeeklyPlan(hybridPlan({ pushReps: 30, pushSets: 6 }), hybridContext());
  const push = clamped.sessions[0].exercises[1];

  assert.deepEqual([sessionBudget("pullUps", 12), sessionBudget("pushUps", 40), sessionBudget("plankSeconds", 90)], [36, 140, 315]);
  assert.deepEqual([push.reps, push.sets], [30, 4]);
  assert.ok(adjustments.some((a) => a.includes("6 sets lowered to 4 (session budget of 140 reps)")), adjustments.join("\n"));
  assert.match(clamped.sessions[0].progressionRationale, /Push-ups 6 -> 4 sets \(session budget\)/);
});

test("the session budget never takes goal work below the week's minimum sets", () => {
  const context = hybridContext();
  context.history.bestRecentTests = { ...context.history.bestRecentTests, plankSeconds: 5 };
  // Cap 10 s (the floor of the cap), budget 17 s: 3 x 10 s is over it, but 3 sets is the normal-week minimum.
  const plank = clampWeeklyPlan(hybridPlan({ plankSeconds: 10 }), context).plan.sessions[0].exercises[2];

  assert.deepEqual([plank.seconds, plank.sets], [10, 3]);
});

test("the set route stops at the session budget", () => {
  // Best 40: cap 30, budget 140. From 3 x 30 the set route is 4 x 30 (120); from 4 x 30, 5 x 30 (150) passes the budget.
  const fromThree = strengthProgressionPlan(hybridContext({ earned: { pushUps: { logged: 30, target: 30, sets: 3, consecutive: 2 } } })).pushUps;
  const fromFour = strengthProgressionPlan(hybridContext({ earned: { pushUps: { logged: 30, target: 30, sets: 4, consecutive: 2 } } })).pushUps;

  assert.equal(fromThree.status, "earned");
  assert.deepEqual(fromThree.setRoute, { target: 30, sets: 4 });
  assert.equal(fromFour.status, "hold");
  assert.equal(fromFour.setRoute, null);
  assert.ok(isBlocked(fromFour));
  assert.equal(fromFour.status === "hold" && fromFour.reason, "blocked", "a hold says why it holds");
  assert.match(fromFour.note, /session budget of 140 reps/);
});

// Code review M10: maxSetsOnTopTarget is counted at the bottom of
// allowedTopTarget; a higher target fits fewer sets inside the session
// budget, so the prompt puts the budget next to it and the rule says so.
test("the prompt states the session budget next to the most sets on the top target", () => {
  // Best 12 pull-ups: budget 36. The hold band 9-10 allows 4 x 9 (36), not 4 x 10 (40).
  const guardrails = strengthGuardrailsForPrompt(hybridContext({ previous: { pullUps: { target: 10, sets: 3 } } })) as {
    progression: Record<string, { allowedTopTarget: { min: number; max: number }; maxSetsOnTopTarget: number; maxPerSession: number }>;
    sessionBudgetRule: string;
  };
  const pull = guardrails.progression.pullUps;

  assert.deepEqual(pull.allowedTopTarget, { min: 9, max: 10 });
  assert.equal(pull.maxSetsOnTopTarget, 4);
  assert.equal(pull.maxPerSession, sessionBudget("pullUps", 12));
  for (const field of ["maxSetsOnTopTarget", "allowedTopTarget.min", "maxPerSession"]) {
    assert.ok(guardrails.sessionBudgetRule.includes(field), `the budget rule names ${field}`);
  }
});

// Code review M8: at the cap the 3.0x budget blocks pull-ups: best 12, cap 10,
// budget 36. After two clean 3 x 10 sessions the rep step passes the cap and
// the set route (4 x 10 = 40) passes the budget, so progression is blocked
// and a test comes due sooner.
test("pull-ups at the cap: 4 x 10 passes the 3.0x budget, so progression is blocked", () => {
  const pull = strengthProgressionPlan(hybridContext({ earned: { pullUps: { logged: 10, target: 10, sets: 3, consecutive: 2 } } })).pullUps;

  assert.equal(pull.cap, 10);
  assert.equal(pull.budget, 36);
  assert.equal(pull.status === "hold" && pull.reason, "blocked");
  assert.deepEqual([pull.target, pull.maxSets, pull.setRoute], [{ min: 10, max: 10 }, 3, null]);
  assert.match(pull.note, /session budget of 36 reps/);
});

// Spec review (probe2): a second push-up block in the session of the earned
// set route made the budget clamp cut the route itself (4 x 30 -> 3 x 30), so a
// valid answer was rejected. The clamp trims the other blocks first and keeps
// the top block; a block that would drop below the minimum sets becomes light
// technique work, which the budget does not count.
test("the session budget trims a second push-up block before the earned set route (probe2)", () => {
  // Best 40: cap 30, budget 140. Earned at 3 x 30, the set route is 4 x 30 (120); a 3 x 15 finisher makes 165.
  const context = hybridContext({ earned: { pushUps: { logged: 30, target: 30, sets: 3, consecutive: 2 } } });
  const plan = hybridPlan({ pushReps: 30, pushSets: 4 });
  plan.sessions[0].exercises.splice(2, 0, exercise("pushUp", 3, 15, 0, effort("medium", 6, "volume", 4)));
  assert.deepEqual(validateWeeklyPlan(plan, context), { accepted: true, messages: [] }, "the model's answer is valid");

  const { plan: clamped, adjustments } = clampWeeklyPlan(plan, context);
  const [main, finisher] = clamped.sessions[0].exercises.filter((entry) => entry.exercise === "pushUp");

  assert.deepEqual([main.sets, main.reps], [4, 30], "the set route stays");
  assert.deepEqual([finisher.plannedEffort.label, finisher.plannedEffort.stimulus], ["light", "technique"]);
  assert.ok(adjustments.some((a) => a.includes("light technique") && a.includes("session budget of 140 reps")), adjustments.join("\n"));
  assert.match(clamped.sessions[0].progressionRationale, /Push-ups 3 x 15 -> light technique sets \(session budget\)/);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

test("a second block that still fits the minimum sets is lowered, not made light", () => {
  // Set route 4 x 30 (120) plus 4 x 6 (24) is 144: the second block is lowered to 3 x 6 (138 in all).
  const context = hybridContext({ earned: { pushUps: { logged: 30, target: 30, sets: 3, consecutive: 2 } } });
  const plan = hybridPlan({ pushReps: 30, pushSets: 4 });
  plan.sessions[0].exercises.splice(2, 0, exercise("pushUp", 4, 6, 0, effort("medium", 6, "volume", 4)));

  const [main, second] = clampWeeklyPlan(plan, context).plan.sessions[0].exercises.filter((entry) => entry.exercise === "pushUp");
  assert.deepEqual([main.sets, second.sets, second.plannedEffort.label], [4, 3, "medium"]);
});

test("a progression message names the session budget when it limits the sets", () => {
  // Earned at 5 x 28 (best 40, budget 140): 5 x 29 = 145 passes the budget and 6 x 28 = 168 too.
  const context = hybridContext({ earned: { pushUps: { logged: 28, target: 28, sets: 5, consecutive: 2 } } });
  const messages = validateWeeklyPlan(hybridPlan({ pushReps: 28, pushSets: 5 }), context).messages;

  assert.ok(messages.some((m) => m.includes("earned push-up progression") && m.includes("session budget of 140 reps")), messages.join("\n"));
});

// Spec review (fuzz): when the only strength day is the week's one run-free
// day, no strength session fits around the full rest day, so earned
// progression carries over like any week with no schedulable session.
test("when every strength day is the week's rest day, no session fits and earned progression carries over", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 3 } } });
  context.profile = { ...context.profile, weeklySessions: 1, trainingDays: ["thursday"], trainingDayOffsets: [4] };
  const runOffsets = [1, 2, 3, 5, 6];
  const empty = { ...hybridPlan({}), sessions: [] } as WeeklyPlan;
  const oneSession = { ...hybridPlan({}), sessions: [{ ...hybridPlan({ pushReps: 26 }).sessions[0], dayOffset: 4 }] } as WeeklyPlan;

  assert.equal(maxStrengthSessions(context, { runOffsets }), 0);
  assert.equal(minStrengthSessions(context, { runOffsets }), 0);
  const plannedRuns = runOffsets.map((dayOffset) => ({ dayOffset, kind: "easy" }));
  assert.deepEqual(validateWeeklyPlan(empty, context, { plannedRuns }), { accepted: true, messages: [] });
  assert.ok(validateWeeklyPlan(oneSession, context, { plannedRuns }).messages.some((m) => m.includes("Expected no more than 0 future sessions")));
});

type PreviousSpec = { target: number; sets: number; date?: string };
type EarnedSpec = { logged: number; target: number; sets: number; consecutive?: number };

function hybridContext(options: {
  previous?: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", PreviousSpec>>;
  earned?: Partial<Record<"pullUps" | "pushUps" | "plankSeconds", EarnedSpec>>;
  latestPullTest?: string;
} = {}): CoachContext {
  const trend = (spec?: PreviousSpec) => ({
    latestTarget: spec?.target ?? null,
    latestVolume: spec ? spec.target * spec.sets : null,
    flatCount: spec ? 1 : 0,
    latestDate: spec?.date ?? (spec ? "2026-05-07T08:00:00Z" : null),
    latestWorkingTarget: spec?.target ?? null,
    latestWorkingSets: spec?.sets ?? null,
    latestWorkingDate: spec?.date ?? (spec ? "2026-05-07T08:00:00Z" : null)
  });
  const performance = (spec?: EarnedSpec, latestTestDate: string | null = null): RecentGoalPerformance => ({
    latestLoggedBest: spec?.logged ?? null,
    prescribedTarget: spec?.target ?? null,
    prescribedSets: spec?.sets ?? null,
    delta: spec ? spec.logged - spec.target : null,
    clean: spec ? true : null,
    consecutiveCleanCompletionsAtStandard: spec?.consecutive ?? (spec ? 1 : 0),
    completedAt: spec ? "2026-05-08T09:00:00Z" : null,
    latestTestDate
  });
  return {
    profile: {
      baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
      goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
      profileNotes: "",
      weekStart: WEEK_START,
      // Two strength days a week, so the two-session fixture plans meet the session minimum.
      weeklySessions: 2,
      trainingDays: [],
      trainingDayOffsets: [],
      equipment: ["pullUpBar"],
      targetDate: "2027-05-11T00:00:00Z"
    },
    history: {
      last5Logs: [],
      rpeCalibration: { recentPlannedLogCount: 0, averageDeltaLast5: null, abovePlanBy2Count: 0, belowPlanBy2Count: 0, latestSummary: null },
      currentPartialMonth: emptyMonth("2026-05", true),
      lastFullMonth: emptyMonth("2026-04", false),
      previousFullMonth: emptyMonth("2026-03", false),
      twoFullMonthTrend: { pullUpsDelta: 0, pushUpsDelta: 0, plankSecondsDelta: 0, logCountDelta: 0, label: "flat" },
      bestRecentTests: { pullUps: 12, pushUps: 40, plankSeconds: 90 }
    },
    adherence: { planned: 6, completed: 6, missed: 0, missedLast14Days: 0, deload: 0 },
    plannedWork: {
      todaySessions: [],
      recentGoalTargets: {
        pullUps: trend(options.previous?.pullUps),
        pushUps: trend(options.previous?.pushUps),
        plankSeconds: trend(options.previous?.plankSeconds)
      },
      recentGoalPerformance: {
        pullUps: performance(options.earned?.pullUps, options.latestPullTest ?? null),
        pushUps: performance(options.earned?.pushUps),
        plankSeconds: performance(options.earned?.plankSeconds)
      }
    },
    readiness: { state: "building", riskFlags: [] },
    running: {
      raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-07-20T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
      baselineWeeklyKm: 45,
      longestRecentRunKm: 20,
      runningDays: [],
      runningDayOffsets: [],
      recentRuns: [],
      weeksToRace: 10
    }
  };
}

/**
 * Two sessions: a hard mixed day (pull, push, plank) and a medium pull day
 * that also holds lighter push-up and plank work, so a normal week trains
 * each goal exercise in both sessions (the exposure rule). The second day's
 * push-ups (3 x 18, the useful floor of the best of 40, so they count as an
 * exposure) and plank (3 x 45 s) stay at or below every top target here.
 */
function hybridPlan(options: {
  pullReps?: number;
  pullSets?: number;
  pushReps?: number;
  pushSets?: number;
  plankSeconds?: number;
}): WeeklyPlan {
  const pullReps = options.pullReps ?? 8;
  const pullSets = options.pullSets ?? 4;
  return {
    summary: "Build: hybrid week around the runs.",
    contextState: "building",
    safetyFlags: [],
    sessions: [
      {
        ...session("Full-body strength", 2, "hard"),
        exercises: [
          exercise("pullUp", pullSets, pullReps, 0, effort("hard", 7, "strength", 3)),
          exercise("pushUp", options.pushSets ?? 3, options.pushReps ?? 24, 0, effort("hard", 7, "volume", 3)),
          exercise("plank", 3, 0, options.plankSeconds ?? 60, effort("medium", 6, "volume", 4))
        ]
      },
      {
        ...session("Pull and core", 4, "medium", "volume"),
        exercises: [
          // Two below the top block, but not below 6 (the useful floor of the best of 12), so it stays an exposure.
          exercise("pullUp", 3, Math.min(pullReps, Math.max(6, pullReps - 2)), 0, effort("medium", 6, "volume", 4)),
          ...secondDayPushAndPlank(),
          exercise("hollowHold", 3, 0, 30, effort("medium", 5, "volume", 4))
        ]
      }
    ]
  };
}

/** Lighter push-up and plank work for a second session (exposure rule). */
function secondDayPushAndPlank(): WeeklyPlan["sessions"][number]["exercises"] {
  return [
    exercise("pushUp", 3, 18, 0, effort("medium", 6, "volume", 4)),
    exercise("plank", 3, 0, 45, effort("medium", 6, "volume", 4))
  ];
}

function session(title: string, dayOffset: number, label: EffortLabel, stimulus: EffortStimulus = "strength"): WeeklyPlan["sessions"][number] {
  const targetRPE: Record<EffortLabel, number> = { light: 3, medium: 6, hard: 7, very_hard: 9, max_output: 10 };
  return {
    title,
    dayOffset,
    focus: "mixed",
    plannedEffort: effort(label, targetRPE[label], label === "max_output" ? "test" : stimulus, label === "max_output" ? 0 : 3),
    purpose: "Strength that serves the race.",
    estimatedDurationMinutes: 40,
    progressionRationale: "Follows the computed progression band.",
    safetyNotes: [],
    loggingFieldsRequired: ["pullUps"],
    exercises: []
  };
}

function exercise(
  kind: WeeklyPlan["sessions"][number]["exercises"][number]["exercise"],
  sets: number,
  reps: number,
  seconds: number,
  plannedEffort: PlannedEffort
): WeeklyPlan["sessions"][number]["exercises"][number] {
  return { exercise: kind, sets, reps, seconds, restSeconds: 90, intensity: plannedEffort.label, plannedEffort };
}

function effort(label: EffortLabel, targetRPE: number, stimulus: EffortStimulus, targetRIR: number): PlannedEffort {
  return { label, targetRPE, targetRIR, stimulus, reason: `${label} ${stimulus} work` };
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

test("the strength skill states the recovery-week and taper limits the proxy enforces", async () => {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const text = await readFile(join(process.cwd(), "src", "coach", "skills", "fitness-coach-planner", "SKILL.md"), "utf8");
  for (const expected of [
    `hard sets at most \`hardSetCap\` (${Math.round(STRENGTH_PHASE_LIMITS.recovery.hardSetRatio * 100)}% of the last loading week)`,
    `at most ${STRENGTH_PHASE_LIMITS.recovery.maxHardSessions} hard session`,
    `at most ${STRENGTH_PHASE_LIMITS.recovery.maxGoalSets} sets per goal exercise`,
    `in the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days before the race strength stays light`,
    `within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race`
  ]) {
    assert.ok(text.includes(expected), `SKILL.md should say: ${expected}`);
  }
});
