import assert from "node:assert/strict";
import test from "node:test";
import { clampWeeklyPlan, progressionStep, strengthProgressionPlan, workingCap } from "./strength-guardrails";
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
  // Best 12 -> cap 10. Two clean completions at 10 earn progression, but 11 > cap.
  const context = hybridContext({ earned: { pullUps: { logged: 10, target: 10, sets: 3, consecutive: 2 } } });

  const held = validateWeeklyPlan(hybridPlan({ pullReps: 10, pullSets: 3 }), context);
  assert.ok(held.messages.some((m) => m.includes("would exceed the working cap of 10: keep 10 reps and use 4 sets")));
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pullReps: 10, pullSets: 4 }), context), { accepted: true, messages: [] });
});

test("earned plank progression from 60 s allows +5 to +15 s inside the cap", () => {
  const context = hybridContext({ earned: { plankSeconds: { logged: 70, target: 60, sets: 3 } } });

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ plankSeconds: 72 }), context), { accepted: true, messages: [] });
  const tooBig = validateWeeklyPlan(hybridPlan({ plankSeconds: 80 }), context);
  assert.ok(tooBig.messages.some((m) => m.includes("plank progression must be +5 to +15 seconds from 60") || m.includes("working cap is 72")));
});

test("maintenance may hold earned progression but not regress below it", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 3 } } });
  const options = { allowProgressionHoldForRunning: true };

  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pushReps: 24 }), context, options), { accepted: true, messages: [] });
  const regressed = validateWeeklyPlan(hybridPlan({ pushReps: 22 }), context, options);
  assert.ok(regressed.messages.some((m) => m.includes("Maintenance week: hold push-up work at 24 reps or more") && m.includes("got 22")));
  assert.equal(strengthProgressionPlan(context, { maintenance: true }).pushUps.status, "maintenance");
});

test("goal work uses 2-6 sets; clamp brings 7 sets down to 6", () => {
  const plan = hybridPlan({ pushSets: 7 });

  const result = validateWeeklyPlan(plan, hybridContext());
  assert.ok(result.messages.some((m) => m.includes("has 7 working sets; goal work uses 2-6 sets")));

  const { plan: clamped } = clampWeeklyPlan(plan, hybridContext());
  assert.equal(clamped.sessions[0].exercises[1].sets, 6);
});

test("caps hard strength sessions at two alongside running and three without", () => {
  const plan = hybridPlan({});
  plan.sessions[1] = { ...plan.sessions[1], plannedEffort: effort("hard", 7, "strength", 3) };
  plan.sessions.push(session("Third hard day", 6, "hard"));

  const withRunning = validateWeeklyPlan(plan, hybridContext());
  assert.ok(withRunning.messages.some((m) => m.includes("3 hard strength sessions") && m.includes("weekly cap is 2 alongside the running week")));

  const strengthOnly = { ...hybridContext(), running: undefined };
  assert.ok(!validateWeeklyPlan(plan, strengthOnly).messages.some((m) => m.includes("hard strength sessions")));
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
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0))]
  };

  assert.ok(validateWeeklyPlan(plan, recentTest).messages.some((m) => m.includes("fewer than 28 days ago")));

  const dueTest = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } }, latestPullTest: "2026-03-30T08:00:00Z" });
  assert.deepEqual(validateWeeklyPlan(plan, dueTest), { accepted: true, messages: [] });
});

test("a baseline set at a recent plan block start counts as a fresh test for the 28-day spacing", () => {
  const plan = hybridPlan({});
  plan.sessions[1] = {
    ...session("Pull-up assessment", 4, "max_output", "test"),
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0))]
  };
  const withBaselineAt = (baselineSetAt: string) => {
    const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 } } });
    context.plannedWork.recentGoalPerformance!.pullUps.baselineSetAt = baselineSetAt;
    return context;
  };

  const messages = validateWeeklyPlan(plan, withBaselineAt("2026-05-04T00:00:00Z")).messages;
  assert.ok(messages.some((m) => m.includes("pull-up baseline was set at the plan block start on 2026-05-04, fewer than 28 days ago")));
  assert.deepEqual(validateWeeklyPlan(plan, withBaselineAt("2026-03-01T00:00:00Z")), { accepted: true, messages: [] });
});

// Review finding: after a 1-set prescription (a legacy plan, or an
// Assessment matched as the standard), earned progression clamped 25 x 3 to
// 25 x 1 and then failed "goal work uses 2-6 sets".
test("progression from a 1-set prescription continues from 2 sets and never clamps below 2", () => {
  const context = hybridContext({ earned: { pushUps: { logged: 26, target: 24, sets: 1 } } });
  const progression = strengthProgressionPlan(context);

  assert.equal(progression.pushUps.previousSets, 2);
  assert.match(progression.pushUps.note, /with at most 2 sets/);

  const { plan: clamped, adjustments } = clampWeeklyPlan(hybridPlan({ pushReps: 25, pushSets: 3 }), context);
  assert.equal(clamped.sessions[0].exercises[1].sets, 2);
  assert.ok(adjustments.some((a) => a.includes("sets lowered from 3 to 2")));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });

  const single = clampWeeklyPlan(hybridPlan({ pushReps: 25, pushSets: 1 }), context).plan;
  assert.equal(single.sessions[0].exercises[1].sets, 2, "a single working set is raised to the 2-set minimum");
  assert.deepEqual(validateWeeklyPlan(single, context), { accepted: true, messages: [] });
});

test("an unearned week after a 1-set prescription holds at 2 sets or more", () => {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 1 } } });
  const progression = strengthProgressionPlan(context);

  assert.equal(progression.pullUps.previousSets, 2);
  assert.equal(progression.pullUps.maxSets, 3);
  assert.deepEqual(validateWeeklyPlan(hybridPlan({ pullReps: 8, pullSets: 3 }), context), { accepted: true, messages: [] });
});

// Planned recovery week: hard strength volume cut 40-60%, one hard session,
// no tests, at most 3 sets per goal exercise, no progression requirement.
function recoveryWeekContext(): CoachContext {
  const context = hybridContext({ previous: { pullUps: { target: 8, sets: 4 }, pushUps: { target: 24, sets: 3 } } });
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

function loadingStylePlan(): WeeklyPlan {
  const plan = hybridPlan({ pullReps: 9, pullSets: 4, pushReps: 24, pushSets: 4 });
  plan.sessions.push({
    ...session("Pull-up assessment", 6, "max_output", "test"),
    exercises: [exercise("pullUp", 1, 12, 0, effort("max_output", 10, "test", 0))]
  });
  plan.sessions[1] = { ...plan.sessions[1], plannedEffort: effort("hard", 7, "volume", 3) };
  plan.sessions[1].exercises[0] = exercise("pullUp", 4, 7, 0, effort("hard", 7, "volume", 3));
  return plan;
}

test("a planned recovery week rejects a loading-style plan with the limit and value in each message", () => {
  const context = recoveryWeekContext();
  const messages = validateWeeklyPlan(loadingStylePlan(), context).messages;

  for (const expected of [
    "This is a planned recovery week: the summary must start with Offload:.",
    "Session 3 (Pull-up assessment) pullUp is a test, but planned recovery week: no tests.",
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
  assert.ok(clamped.safetyFlags.includes("Planned recovery week: lighter on purpose after three loading weeks."));
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
  assert.ok(messages.some((m) => m.includes("Session 1 (Full-body strength) pullUp is very_hard; 4 day(s) before Ridge Ultra 60K")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("Session 2 (Pull and core) session is hard; 3 day(s) before Ridge Ultra 60K: nothing hard within 4 days of the race")));
  assert.ok(!messages.some((m) => m.includes("earned push-up progression")), "no progression requirement this close to the race");

  const { plan: clamped } = clampWeeklyPlan(plan, context);
  assert.equal(clamped.sessions[1].plannedEffort.label, "medium");
  assert.ok(clamped.safetyFlags.some((flag) => flag.startsWith("Race taper:")));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
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
      weeklySessions: 3,
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

/** Two sessions: a hard mixed day (pull, push, plank) and a medium pull day. */
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
          exercise("pullUp", 3, Math.max(1, pullReps - 2), 0, effort("medium", 6, "volume", 4)),
          exercise("hollowHold", 3, 0, 30, effort("medium", 5, "volume", 4))
        ]
      }
    ]
  };
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
