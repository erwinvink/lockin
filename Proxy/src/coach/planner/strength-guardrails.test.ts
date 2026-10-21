import assert from "node:assert/strict";
import test from "node:test";
import { clampWeeklyPlan, progressionStep, strengthProgressionPlan, workingCap } from "./strength-guardrails";
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
