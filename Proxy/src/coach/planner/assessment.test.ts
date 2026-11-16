import assert from "node:assert/strict";
import test from "node:test";
import { runStrengthWeekPipeline, type StrengthPlannerGuidance } from "../plan-pipeline";
import { ASSESSMENT_LIMITS, ASSESSMENT_PROTOCOL, ASSESSMENT_PROTOCOL_AFTER_HARD_WORK, ASSESSMENT_PROTOCOL_TAIL, assessmentFor } from "./assessment";
import { buildCoachContext } from "./build-coach-context";
import { clampWeeklyPlan, strengthGuardrailsForPrompt, strengthProgressionPlan, strengthWeek } from "./strength-guardrails";
import { isBlocked } from "./strength-limits";
import { STRENGTH_PHASE_LIMITS } from "./strength-phase";
import { validateCombinedWeek } from "./validate-combined-week";
import { validateWeeklyPlan } from "./validate-week-plan";
import type { CoachContext, CoachRequest, EffortLabel, EffortStimulus, PlannedEffort, PlannedSession, RunKind, RunningWeek, TrainingLog, WeeklyPlan } from "./types";

// Assessment due (14 Nov audit): code schedules the test that the working
// caps wait for. A goal metric is due 42 days after its last test (or the
// plan block's baseline), or 28 days when its progression is blocked at the
// cap and the set limit or session budget (or readiness is plateau).

const WEEK_START = "2026-11-16T00:00:00.000Z"; // a Monday
const NOW = new Date("2026-11-16T01:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

type Goal = "pullUps" | "pushUps" | "plankSeconds";
type GoalExercise = "pullUp" | "pushUp" | "plank";
const EXERCISE: Record<Goal, GoalExercise> = { pullUps: "pullUp", pushUps: "pushUp", plankSeconds: "plank" };
const BEST: Record<Goal, number> = { pullUps: 8, pushUps: 40, plankSeconds: 90 };
const GOALS: Goal[] = ["pullUps", "pushUps", "plankSeconds"];

const daysAgo = (days: number) => new Date(Date.parse(WEEK_START) - days * DAY_MS).toISOString();

type Part = { session: PlannedSession; log: TrainingLog };

function logOf(sessionId: string, days: number, values: Partial<Record<Goal, number>>, rpe: number, plannedRPE: number): TrainingLog {
  return {
    sessionId,
    completedAt: new Date(Date.parse(daysAgo(days)) + 17 * 60 * 60 * 1000).toISOString(),
    pullUps: values.pullUps ?? 0,
    pushUps: values.pushUps ?? 0,
    plankSeconds: values.plankSeconds ?? 0,
    loggedPullUps: values.pullUps !== undefined,
    loggedPushUps: values.pushUps !== undefined,
    loggedPlankSeconds: values.plankSeconds !== undefined,
    rpe,
    plannedRPE,
    painLevel: 0,
    fatigueLevel: 5,
    notes: ""
  };
}

/** A goal test `days` before the week start, done, with the athlete's max logged. */
function tested(metric: Goal, days: number): Part {
  const id = `test-${metric}-${days}`;
  const plank = metric === "plankSeconds";
  return {
    session: {
      id, scheduledDate: daysAgo(days), title: "Assessment", focus: "mixed", status: "completed",
      exercises: [{ exercise: EXERCISE[metric], sets: 1, targetReps: plank ? 0 : BEST[metric], targetSeconds: plank ? BEST[metric] : 0, plannedEffortLabel: "max_output", plannedEffortStimulus: "test" }]
    },
    log: logOf(id, days, { [metric]: BEST[metric] }, 10, 10)
  };
}

/** A working session `days` ago, done as planned: sets x target per goal metric, rated `rpe` against 7. */
function worked(days: number, work: Partial<Record<Goal, [sets: number, target: number]>>, rpe = 7): Part {
  const id = `work-${days}`;
  const metrics = GOALS.filter((metric) => work[metric]);
  return {
    session: {
      id, scheduledDate: daysAgo(days), title: "Strength", focus: "mixed", status: "completed",
      exercises: metrics.map((metric) => ({
        exercise: EXERCISE[metric],
        sets: work[metric]![0],
        targetReps: metric === "plankSeconds" ? 0 : work[metric]![1],
        targetSeconds: metric === "plankSeconds" ? work[metric]![1] : 0,
        plannedEffortLabel: "hard" as const,
        plannedEffortStimulus: "strength" as const
      }))
    },
    log: logOf(id, days, Object.fromEntries(metrics.map((metric) => [metric, work[metric]![1]])), rpe, 7)
  };
}

/** Last week: pull-ups 4 then 5, push-ups 22 then 24, plank 55 then 60 s, all as planned (hold bands). */
const USUAL_WEEK: Part[] = [
  worked(6, { pullUps: [3, 4], pushUps: [3, 22], plankSeconds: [3, 55] }),
  worked(3, { pullUps: [3, 5], pushUps: [3, 24], plankSeconds: [3, 60] })
];

/** The athlete (8 pull-ups, 40 push-ups, 90 s plank): each metric last tested `testDays` days ago, then `history`. */
function request(testDays: Record<Goal, number>, overrides: Partial<CoachRequest> = {}, history: Part[] = USUAL_WEEK): CoachRequest {
  const parts = [...GOALS.map((metric) => tested(metric, testDays[metric])), ...history];
  return {
    model: "test-model",
    baseline: { ...BEST },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: WEEK_START,
    weeklySessions: 3,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar"],
    targetDate: "2027-11-01T00:00:00Z",
    planBlockStartedAt: "2026-06-01T00:00:00.000Z",
    plannedSessions: parts.map((part) => part.session),
    trainingLogs: parts.map((part) => part.log),
    ...overrides
  };
}

const contextOf = (req: CoachRequest) => buildCoachContext(req, NOW);
const assessmentOf = (context: CoachContext, options: Parameters<typeof assessmentFor>[2] = {}) =>
  assessmentFor(context, strengthProgressionPlan(context), options);

function effort(label: EffortLabel, targetRPE: number, stimulus: EffortStimulus, targetRIR: number): PlannedEffort {
  return { label, targetRPE, targetRIR, stimulus, reason: `${label} ${stimulus} work` };
}

type PlanExercise = WeeklyPlan["sessions"][number]["exercises"][number];
const work = (exercise: GoalExercise, sets: number, value: number, label: "medium" | "hard" = "medium"): PlanExercise => ({
  exercise, sets, reps: exercise === "plank" ? 0 : value, seconds: exercise === "plank" ? value : 0, restSeconds: 90,
  intensity: label, plannedEffort: label === "hard" ? effort("hard", 7, "strength", 3) : effort("medium", 6, "volume", 4)
});
const maxTest = (exercise: GoalExercise): PlanExercise => ({
  exercise, sets: 1, reps: exercise === "plank" ? 0 : 40, seconds: exercise === "plank" ? 90 : 0, restSeconds: 240,
  intensity: "Max", plannedEffort: effort("max_output", 10, "test", 0)
});
/** The usual working day inside last week's hold bands. */
const USUAL_DAY: PlanExercise[] = [work("pullUp", 3, 5, "hard"), work("pushUp", 3, 24), work("plank", 3, 60)];

function day(dayOffset: number, exercises: PlanExercise[], title = "Full-body strength"): WeeklyPlan["sessions"][number] {
  const hasTest = exercises.some((exercise) => exercise.plannedEffort.stimulus === "test");
  const hard = exercises.some((exercise) => exercise.plannedEffort.label === "hard");
  return {
    title,
    dayOffset,
    focus: "mixed",
    plannedEffort: hasTest ? effort("max_output", 10, "test", 0) : hard ? effort("hard", 7, "strength", 3) : effort("medium", 6, "volume", 4),
    purpose: "Goal work.",
    estimatedDurationMinutes: 40,
    progressionRationale: "Holds the standard.",
    safetyNotes: [],
    loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
    exercises
  };
}

function plan(sessions: WeeklyPlan["sessions"], summary = "Build: steady week.", contextState: WeeklyPlan["contextState"] = "building"): WeeklyPlan {
  return { summary, contextState, safetyFlags: [], sessions };
}

/** Push-ups tested 42+ days ago is the usual case below; pull-ups and plank were tested 10 days ago. */
const PUSH_UPS_DUE: Record<Goal, number> = { pullUps: 10, pushUps: 45, plankSeconds: 10 };

test("a metric 42 days after its last test is due", () => {
  const at = (days: number) => assessmentOf(contextOf(request({ pullUps: 10, pushUps: days, plankSeconds: 10 })));

  assert.equal(at(41).metrics.pushUps.due, false, "41 days and progression is not blocked");
  assert.equal(at(42).metrics.pushUps.due, true);
  assert.equal(at(42).metrics.pushUps.daysSinceTest, ASSESSMENT_LIMITS.dueAfterDays);
  assert.deepEqual(at(42).due, ["pushUps"]);
  assert.deepEqual(at(42).testDayOffsets, [1, 2, 3, 4, 5, 6]);
  assert.equal(at(42).metrics.pullUps.due, false);
});

test("a capped metric is due after 28 days", () => {
  // Two clean completions at 30 x 4: 31 passes the cap (30) and 5 x 30 passes the session budget (140).
  const capped = [worked(6, { pushUps: [4, 30] }), worked(3, { pushUps: [4, 30] })];
  const at = (days: number) => assessmentOf(contextOf(request({ pullUps: 10, pushUps: days, plankSeconds: 10 }, {}, capped)));

  assert.equal(at(27).metrics.pushUps.blocked, true);
  assert.equal(at(27).metrics.pushUps.due, false);
  assert.equal(at(28).metrics.pushUps.due, true);
  assert.match(at(28).metrics.pushUps.reason, /blocked/);
});

// Task 7 ties in: the budget stops the set route, which blocks the metric.
test("the set route stops at the budget and the metric becomes test-due after 28 days", () => {
  const fromThree = [worked(6, { pushUps: [3, 30] }), worked(3, { pushUps: [3, 30] })];
  const fromFour = [worked(6, { pushUps: [4, 30] }), worked(3, { pushUps: [4, 30] })];
  const at = (history: Part[]) => contextOf(request({ pullUps: 10, pushUps: 30, plankSeconds: 10 }, {}, history));

  const three = strengthProgressionPlan(at(fromThree)).pushUps;
  assert.deepEqual(three.setRoute, { target: 30, sets: 4 }, "4 x 30 = 120 fits the budget of 140");
  assert.equal(assessmentOf(at(fromThree)).metrics.pushUps.due, false, "still progressing by sets: due at 42 days");

  const four = strengthProgressionPlan(at(fromFour)).pushUps;
  assert.equal(four.setRoute, null, "5 x 30 = 150 is over the budget");
  assert.ok(isBlocked(four));
  assert.deepEqual(assessmentOf(at(fromFour)).due, ["pushUps"]);
});

test("no test is due in the taper, in transition week 1, or mid recovery week", () => {
  const running = (raceDate: string, distanceKm = 54): Partial<CoachRequest> => ({
    running: {
      raceGoal: { name: "Trail 54K", raceDate, distanceKm, elevationGainM: 1400 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  });
  const longAgo: Record<Goal, number> = { pullUps: 60, pushUps: 60, plankSeconds: 60 };

  const taper = assessmentOf(contextOf(request(longAgo, running(new Date(Date.parse(WEEK_START) + 15 * DAY_MS).toISOString()))));
  assert.deepEqual(taper.due, []);
  assert.match(taper.reason, /taper/);

  // Transition week 1 is judged per planned day (post-race days 1-7 take no test).
  const dayAfterRace = assessmentOf(contextOf(request(longAgo, running(daysAgo(1)))));
  assert.deepEqual(dayAfterRace.due, []);
  assert.match(dayAfterRace.reason, /first week after the race/);
  const threeDaysAfter = assessmentOf(contextOf(request(longAgo, running(daysAgo(3)))));
  assert.deepEqual(threeDaysAfter.testDayOffsets, [5, 6], "post-race days 8 and 9 only");
  const sevenDaysAfter = assessmentOf(contextOf(request(longAgo, running(daysAgo(7)))));
  assert.deepEqual(sevenDaysAfter.testDayOffsets, [1, 2, 3, 4, 5, 6], "the week starts on day 7: every planned day is day 8 or later");
  const transitionWeek2 = assessmentOf(contextOf(request(longAgo, running(daysAgo(8)))));
  assert.deepEqual(transitionWeek2.due, ["pullUps", "pushUps", "plankSeconds"], "from day 8 a due test is back");

  // A recovery week takes a test only on its last 2 days; on its last day nothing is left.
  const startOfRecovery = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE)), 0);
  assert.deepEqual(assessmentOf(startOfRecovery).testDayOffsets, [5, 6]);
  assert.deepEqual(assessmentOf(startOfRecovery).due, ["pushUps"]);
  const lastDayOfRecovery = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE)), 6);
  assert.deepEqual(lastDayOfRecovery.periodization?.recoveryWeekDue, true);
  assert.deepEqual(assessmentOf(lastDayOfRecovery).due, []);
  assert.deepEqual(assessmentOf(lastDayOfRecovery).waiting, ["pushUps"]);
});

// Final review item 5: the taper pause is judged per day, like the post-race
// days. A week that starts 22 days out (peak) has its days 1-6 at 21-16 days
// out, inside the taper phase, so none of them may take a test.
test("no test day falls inside the taper phase, even when the week starts before it", () => {
  const running = (daysOut: number): Partial<CoachRequest> => ({
    running: {
      raceGoal: { name: "Trail 54K", raceDate: new Date(Date.parse(WEEK_START) + daysOut * DAY_MS).toISOString(), distanceKm: 54, elevationGainM: 1400 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  });
  const longAgo: Record<Goal, number> = { pullUps: 60, pushUps: 60, plankSeconds: 60 };

  const startsAt22 = assessmentOf(contextOf(request(longAgo, running(22))));
  assert.equal(startsAt22.metrics.pushUps.due, true, "the week itself is peak, not taper");
  assert.deepEqual(startsAt22.due, []);
  assert.deepEqual(startsAt22.testDayOffsets, []);
  assert.deepEqual(startsAt22.waiting, ["pullUps", "pushUps", "plankSeconds"]);
  assert.match(startsAt22.reason, /taper/);

  // 24 days out: offsets 1 and 2 are 23 and 22 days out, before the taper.
  assert.deepEqual(assessmentOf(contextOf(request(longAgo, running(24)))).testDayOffsets, [1, 2]);
});

test("a due metric without a test in the week is sent back; with one it passes", () => {
  const context = contextOf(request(PUSH_UPS_DUE));
  const without = plan([day(1, USUAL_DAY), day(3, USUAL_DAY), day(5, USUAL_DAY)]);
  const withTest = plan([day(1, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"), day(3, USUAL_DAY), day(5, USUAL_DAY)]);

  const messages = validateWeeklyPlan(without, context).messages;
  assert.ok(messages.some((m) => m.includes("A push-up test is due") && m.includes("stimulus test, max_output, 1 set")), messages.join("\n"));
  assert.deepEqual(validateWeeklyPlan(withTest, context), { accepted: true, messages: [] });

  const guardrails = strengthGuardrailsForPrompt(context) as { assessment: { due: string[]; protocol: string; reason: string } };
  assert.deepEqual(guardrails.assessment.due, ["pushUps"]);
  assert.match(guardrails.assessment.protocol, /3-5 min/);
});

test("a test on the last day of a recovery week is kept", () => {
  const context = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE)), 0);
  const easy = [work("pullUp", 2, 4), work("pushUp", 2, 22), work("plank", 2, 50)];
  const recoveryPlan = (testDay: number) => plan(
    [day(2, easy, "Easy strength"), day(testDay, [maxTest("pushUp"), work("plank", 2, 50)], "Push-up test")],
    "Offload: planned recovery week."
  );

  const lastDay = clampWeeklyPlan(recoveryPlan(6), context).plan;
  assert.equal(lastDay.sessions[1].exercises[0].plannedEffort.stimulus, "test");
  assert.equal(lastDay.sessions[1].exercises[0].plannedEffort.label, "max_output");
  assert.deepEqual(validateWeeklyPlan(lastDay, context), { accepted: true, messages: [] });

  const midWeek = clampWeeklyPlan(recoveryPlan(3), context).plan;
  assert.equal(midWeek.sessions[1].exercises[0].plannedEffort.label, "medium", "mid-week the test still becomes working sets");
});

// Plan continuity keeps last night's plan unless a computed signal changed; a
// test that became due is such a signal, so the planner adds it without a repair.
test("a test that became due releases continuity for the strength planner", async () => {
  const req = request(PUSH_UPS_DUE, { currentPlanGeneratedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString() });
  req.plannedSessions.push({ ...worked(-2, { pullUps: [3, 5], pushUps: [3, 24], plankSeconds: [3, 60] }).session, id: "planned-day-2", status: "planned" });
  const withTest = plan([day(1, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"), day(2, USUAL_DAY), day(5, USUAL_DAY)]);
  const calls: StrengthPlannerGuidance[] = [];

  const result = await runStrengthWeekPipeline({
    context: contextOf(req),
    now: NOW,
    generateStrength: async (guidance) => {
      calls.push(guidance);
      return { ok: true, value: withTest };
    },
    recordValidationFailure: async () => {}
  });

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith("A push-up test is due")), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls.length, 1, "no repair");
});

test("a test planned for today counts: nothing else is due this week", () => {
  const req = request(PUSH_UPS_DUE);
  req.plannedSessions.push({ ...tested("pushUps", 0).session, status: "planned" });

  assert.deepEqual(assessmentOf(contextOf(req)).due, []);
});

// Unsatisfiability guard: a due test yields, with a plain reason, wherever it
// cannot fit; where it fits it never collides with the other rules.
test("with one strength day the test shares the day's session with the other goal work", () => {
  const context = contextOf(request(PUSH_UPS_DUE, { weeklySessions: 1 }));
  const oneDay = plan([day(2, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test and strength")]);

  assert.deepEqual(assessmentOf(context).due, ["pushUps"]);
  assert.deepEqual(validateWeeklyPlan(oneDay, context), { accepted: true, messages: [] });
});

test("with two strength days, one on a tempo day, the test takes the other and both hold every goal exercise", () => {
  const context = contextOf(request(PUSH_UPS_DUE, {
    weeklySessions: 2,
    trainingDays: ["tuesday", "thursday"],
    trainingDayOffsets: [1, 3],
    running: {
      raceGoal: { name: "Spring Trail", raceDate: "2027-06-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  }));
  const runs: Array<{ dayOffset: number; kind: RunKind }> = [{ dayOffset: 1, kind: "tempo" }, { dayOffset: 3, kind: "easy" }, { dayOffset: 5, kind: "long" }];
  const mediumDay = [work("pullUp", 3, 5), work("pushUp", 3, 24), work("plank", 3, 60)];
  const week = plan([day(1, mediumDay, "Easy full-body"), day(3, [maxTest("pushUp"), work("pullUp", 3, 5), work("plank", 3, 60)], "Push-up test")]);
  const runningWeek: RunningWeek = {
    summary: "Base week.",
    safetyFlags: [],
    sessions: runs.map((run) => ({
      title: `${run.kind} run`, dayOffset: run.dayOffset, kind: run.kind, purpose: "Aerobic base.", distanceKm: 8, durationMinutes: 50,
      elevationMeters: 100, target: { type: "hr", low: 130, high: 145 }, zone: "Zone 2", notes: []
    }))
  };

  assert.deepEqual(assessmentOf(context, { runs }).testDayOffsets, [3], "not the tempo day");
  assert.deepEqual(validateWeeklyPlan(week, context, { plannedRuns: runs }), { accepted: true, messages: [] });
  assert.deepEqual(validateCombinedWeek(runningWeek, week, context), []);
});

// Spec review: the test should be fresh. Days after a hard run, a long run or
// hard strength are listed only when the week has no fresher legal day, and
// then the reason and the protocol say so.
test("a test prefers a day that does not follow hard work, and says so when none is left", () => {
  const hybrid = (todaySessions: PlannedSession[] = []) => {
    const req = request(PUSH_UPS_DUE, {
      running: {
        raceGoal: { name: "Spring Trail", raceDate: "2027-06-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
        baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
      }
    });
    req.plannedSessions.push(...todaySessions);
    return contextOf(req);
  };
  // Legal: 1, 3 and 6 (2 tempo, 5 long, 4 the day before it); 3 follows the tempo run, 6 the long run.
  const runs = [{ dayOffset: 1, kind: "easy" }, { dayOffset: 2, kind: "tempo" }, { dayOffset: 3, kind: "easy" }, { dayOffset: 5, kind: "long" }];

  const fresh = assessmentOf(hybrid(), { runs });
  assert.deepEqual(fresh.testDayOffsets, [1]);
  assert.equal(fresh.protocol, ASSESSMENT_PROTOCOL);

  // Today's planned tempo run makes day 1 follow hard work too: no fresh day is left.
  const todayTempo: PlannedSession = {
    id: "today-run", scheduledDate: WEEK_START, title: "Tempo run", focus: "mixed", status: "planned", exercises: [],
    discipline: "running", runKind: "tempo", distanceKm: 10
  };
  const tired = assessmentOf(hybrid([todayTempo]), { runs });
  assert.deepEqual(tired.testDayOffsets, [1, 3, 6]);
  assert.match(tired.reason, /every day that can take it follows hard work/);
  assert.equal(tired.protocol, ASSESSMENT_PROTOCOL_AFTER_HARD_WORK);

  // A hard strength session today counts as hard work the day before day 1.
  const todayStrength: PlannedSession = { ...worked(0, { pushUps: [3, 24] }).session, id: "today-strength", status: "planned" };
  assert.deepEqual(assessmentOf(hybrid([todayStrength]), { runs }).testDayOffsets, [1, 3, 6]);
});

test("when the only free strength day is the day before the long run, the test waits", () => {
  const context = contextOf(request(PUSH_UPS_DUE, {
    weeklySessions: 1,
    trainingDays: ["friday"],
    trainingDayOffsets: [4],
    running: {
      raceGoal: { name: "Spring Trail", raceDate: "2027-06-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  }));
  const runs = [{ dayOffset: 1, kind: "easy" }, { dayOffset: 3, kind: "tempo" }, { dayOffset: 5, kind: "long" }];
  const assessment = assessmentOf(context, { runs });

  assert.deepEqual(assessment.due, []);
  assert.deepEqual(assessment.waiting, ["pushUps"]);
  assert.match(assessment.reason, /no day this week can take it/);
  const usual = plan([day(4, USUAL_DAY)]);
  assert.deepEqual(validateWeeklyPlan(usual, context, { plannedRuns: runs }), { accepted: true, messages: [] });
});

test("in a recovery week whose last 2 days are not training days, the test waits", () => {
  const base = contextOf(request(PUSH_UPS_DUE, { weeklySessions: 2, trainingDays: ["tuesday", "thursday"], trainingDayOffsets: [1, 3] }));
  const context = withRecoveryWeek(base, 0);
  const easy = [work("pullUp", 2, 4), work("pushUp", 2, 22), work("plank", 2, 50)];

  assert.deepEqual(assessmentOf(context).waiting, ["pushUps"]);
  assert.deepEqual(validateWeeklyPlan(plan([day(1, easy), day(3, easy)], "Offload: planned recovery week."), context), { accepted: true, messages: [] });
});

test("without a pull-up bar pull-ups are never due", () => {
  const context = contextOf(request({ pullUps: 90, pushUps: 10, plankSeconds: 10 }, { equipment: ["yogaMat"] }));

  assert.equal(assessmentOf(context).metrics.pullUps.due, false);
  assert.deepEqual(assessmentOf(context).due, []);
});

test("a due test and a calibration hold share the week", () => {
  // Push-ups rated 2 above plan twice (calibrate) and last tested 45 days ago.
  const history = [
    worked(6, { pushUps: [3, 24] }, 9),
    worked(4, { pullUps: [3, 5], plankSeconds: [3, 60] }),
    worked(3, { pushUps: [3, 24] }, 9)
  ];
  const context = contextOf(request(PUSH_UPS_DUE, {}, history));
  const week = plan([
    day(1, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"),
    day(3, USUAL_DAY),
    day(5, USUAL_DAY)
  ]);

  assert.deepEqual(context.readiness.calibration?.metrics, ["pushUps"]);
  assert.equal(context.readiness.state, "building");
  assert.deepEqual(assessmentOf(context).due, ["pushUps"]);
  assert.deepEqual(validateWeeklyPlan(week, context), { accepted: true, messages: [] });
});

// Code review I1 (probe B): a test the week cannot hold becomes working sets
// inside the band, also when it was written without a number (an "as many as
// possible" set): it takes the band's top, never 2 x 0. Without a known best
// there is no band or cap, so it becomes light technique work.
test("a test the week cannot hold becomes working sets at the band's top, even without a number", () => {
  const context = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE)), 0);
  const easy = [work("pullUp", 2, 4), work("plank", 2, 50)];
  const week = plan([
    day(2, [{ ...maxTest("pushUp"), reps: 0 }, ...easy], "Push-up test"),
    day(6, [maxTest("pushUp"), work("plank", 2, 50)], "Push-up test")
  ], "Offload: planned recovery week.");

  const clamped = clampWeeklyPlan(week, context).plan;
  const midWeek = clamped.sessions[0].exercises[0];
  assert.deepEqual([midWeek.sets, midWeek.reps, midWeek.plannedEffort.label], [2, 24, "medium"]);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });

  const noPullUpHistory = [worked(6, { pushUps: [3, 22], plankSeconds: [3, 55] }), worked(3, { pushUps: [3, 24], plankSeconds: [3, 60] })];
  const unknown = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE, {}, noPullUpHistory)), 0);
  unknown.history.bestRecentTests.pullUps = null;
  const pullTest = clampWeeklyPlan(plan([day(2, [{ ...maxTest("pullUp"), reps: 0 }, work("plank", 2, 50)])], "Offload: planned recovery week."), unknown).plan;
  const pull = pullTest.sessions[0].exercises[0];
  assert.deepEqual([pull.plannedEffort.label, pull.plannedEffort.stimulus], ["light", "technique"], "no band and no cap: light technique work");
});

// Code review I5: one definition of a goal test everywhere (a test stimulus or
// a max_output label). A max set written with another stimulus is the test it
// stands for, so the clamp marks it a test (one set) instead of turning it
// into 3 max_output working sets; a test written at another label still is the
// due test.
test("a max set written with another stimulus is the test it stands for", () => {
  const context = contextOf(request(PUSH_UPS_DUE));
  const maxSetAsStrength: PlanExercise = { ...maxTest("pushUp"), sets: 3, plannedEffort: effort("max_output", 10, "strength", 0) };
  const week = plan([day(1, [maxSetAsStrength, work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"), day(3, USUAL_DAY), day(5, USUAL_DAY)]);
  week.sessions[0].plannedEffort = effort("max_output", 10, "strength", 0);

  assert.ok(validateWeeklyPlan(week, context).messages.some((m) => m.includes("max_output effort is only allowed with test stimulus")));
  const clamped = clampWeeklyPlan(week, context).plan;
  const pushUps = clamped.sessions[0].exercises[0];
  assert.deepEqual([pushUps.plannedEffort.stimulus, pushUps.plannedEffort.label, pushUps.sets, pushUps.reps], ["test", "max_output", 1, 40]);
  assert.equal(clamped.sessions[0].plannedEffort.stimulus, "test");
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });

  // Final review: a test is one max set, so a test labelled very_hard is sent
  // back; the clamp labels it max_output, and then it is the due test.
  const veryHardTest = plan([
    day(1, [{ ...maxTest("pushUp"), plannedEffort: effort("very_hard", 9, "test", 1) }, work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"),
    day(3, USUAL_DAY),
    day(5, USUAL_DAY)
  ]);
  assert.ok(validateWeeklyPlan(veryHardTest, context).messages.some((m) => m.includes("is a test") && m.includes("max_output")));
  assert.deepEqual(validateWeeklyPlan(clampWeeklyPlan(veryHardTest, context).plan, context), { accepted: true, messages: [] });
});

// Final review (probes H1, J): a test is one max set, so a test stimulus must
// be labelled max_output, and a test counts toward the hard-session cap
// whatever its label.
test("a test must be labelled max_output and counts toward the hard-session cap", () => {
  const running: Partial<CoachRequest> = {
    running: {
      raceGoal: { name: "Spring Trail", raceDate: "2027-06-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  };
  const context = contextOf(request(PUSH_UPS_DUE, running));
  const runs = [{ dayOffset: 2, kind: "easy" }, { dayOffset: 6, kind: "long" }];
  const hardDay = [work("pullUp", 3, 5, "hard"), work("pushUp", 3, 24, "hard"), work("plank", 3, 60)];
  const mediumTest: PlanExercise = { ...maxTest("pushUp"), plannedEffort: effort("medium", 6, "test", 4) };
  const week = plan([day(1, hardDay), day(3, hardDay), day(4, [mediumTest, work("pullUp", 3, 5), work("plank", 3, 60)], "Push-up test")]);
  week.sessions[2].plannedEffort = effort("medium", 6, "volume", 4);

  assert.ok(strengthWeek(context, { plannedRuns: runs }).assessment.testDayOffsets.includes(4));
  const messages = validateWeeklyPlan(week, context, { plannedRuns: runs }).messages;
  assert.ok(messages.some((m) => m.includes("is a test") && m.includes("max_output")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("3 hard strength sessions") && m.includes("the weekly cap is 2")), messages.join("\n"));
  const clamped = clampWeeklyPlan(week, context, { plannedRuns: runs }).plan;
  assert.equal(clamped.sessions[2].exercises[0].plannedEffort.label, "max_output", "the clamp labels the test as the max set it is");
});

// Code review M6: what the clamp changed is shown to the athlete with the
// session, so the notes use plain exercise names and effort words, never the
// plan's field values ("pushUp", "very_hard").
test("the clamp's notes to the athlete use plain exercise names and effort words", () => {
  const context = withRecoveryWeek(contextOf(request(PUSH_UPS_DUE)), 0);
  const veryHard = effort("very_hard", 9, "strength", 1);
  const hardWork = (exercise: string, sets: number, reps: number, planned = effort("hard", 7, "strength", 3)) =>
    ({ exercise, sets, reps, seconds: 0, restSeconds: 90, intensity: "Hard", plannedEffort: planned }) as PlanExercise;
  const week = plan([day(2, [hardWork("pushUp", 3, 22, veryHard), hardWork("pullUp", 3, 4), hardWork("pikePushUp", 3, 8, veryHard)])], "Offload: planned recovery week.");

  const note = clampWeeklyPlan(week, context).plan.sessions[0].progressionRationale;
  assert.match(note, /Push-ups very hard -> hard effort/);
  assert.match(note, /Pike push-up very hard -> hard effort/);
  assert.match(note, /Pike push-up 3 -> 1 hard set\b/);
  assert.match(note, /Pull-ups 3 -> 2 hard sets/);
  assert.doesNotMatch(note, /very_hard|pushUp|pikePushUp|pullUp|set\(s\)/);
});

// Final review (probe I): the phase set limit holds every goal block, as the
// validator counts it: a light 5-set plank in the race taper is lowered to 3
// sets by the clamp instead of being sent back.
test("the race taper's set limit holds every goal block, light work included (probe I)", () => {
  const raceIn9Days: Partial<CoachRequest> = {
    running: {
      raceGoal: { name: "Autumn 30K", raceDate: new Date(Date.parse(WEEK_START) + 9 * DAY_MS).toISOString(), distanceKm: 30, elevationGainM: 500 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  };
  const context = contextOf(request(PUSH_UPS_DUE, raceIn9Days));
  const lightPlank: PlanExercise = { exercise: "plank", sets: 5, reps: 0, seconds: 40, restSeconds: 60, intensity: "Light", plannedEffort: effort("light", 3, "technique", 5) };
  const week = plan([{ ...day(2, [lightPlank], "Core"), plannedEffort: effort("light", 3, "technique", 5) }], "Build: race week.");
  week.safetyFlags = ["Race in 9 days."];

  assert.ok(validateWeeklyPlan(week, context).messages.some((m) => m.includes("plank has 5 sets")));
  const clamped = clampWeeklyPlan(week, context).plan;
  assert.equal(clamped.sessions[0].exercises[0].sets, STRENGTH_PHASE_LIMITS.race.maxGoalSets);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

// Code review M3 (probes D, D2): days since a test are whole calendar days, so a
// daylight-saving change never moves a due date, the due rule and the 28-day
// spacing agree, and a test later today reads as today's (never -1 days).
test("days since the last test are whole calendar days across DST, and a test later today is today's", () => {
  const today = request(PUSH_UPS_DUE);
  today.plannedSessions.push({
    ...tested("pushUps", 0).session, id: "today-test", status: "planned", scheduledDate: new Date(Date.parse(WEEK_START) + 7 * 60 * 60 * 1000).toISOString()
  });
  const todays = assessmentOf(contextOf(today)).metrics.pushUps;
  assert.equal(todays.daysSinceTest, 0);
  assert.equal(todays.due, false);
  assert.doesNotMatch(todays.reason, /-1/);

  // Europe/Amsterdam: summer time starts on 28 March 2027. Local midnights, 42 and 28 calendar days apart.
  const spring = (testedAt: string) => {
    const req = request({ pullUps: 10, pushUps: 10, plankSeconds: 10 }, { weekStart: "2027-04-02T22:00:00.000Z", timeZone: "Europe/Amsterdam" });
    req.plannedSessions.push({ ...tested("pushUps", 0).session, id: "spring-test", scheduledDate: testedAt });
    req.trainingLogs.push({ ...tested("pushUps", 0).log, sessionId: "spring-test", completedAt: new Date(Date.parse(testedAt) + 17 * 60 * 60 * 1000).toISOString() });
    return buildCoachContext(req, new Date("2027-04-03T06:00:00.000Z"));
  };
  const sixWeeks = spring("2027-02-19T23:00:00.000Z");
  assert.equal(assessmentOf(sixWeeks).metrics.pushUps.daysSinceTest, ASSESSMENT_LIMITS.dueAfterDays);
  assert.equal(assessmentOf(sixWeeks).metrics.pushUps.due, true);

  const fourWeeks = spring("2027-03-05T23:00:00.000Z");
  const optionalTest = plan([day(1, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"), day(3, USUAL_DAY), day(5, USUAL_DAY)]);
  const messages = validateWeeklyPlan(optionalTest, fourWeeks).messages;
  assert.ok(!messages.some((m) => m.includes(`fewer than ${ASSESSMENT_LIMITS.spacingDays} days ago`)), messages.join("\n"));
});

// Code review I4: the protocol is athlete-facing (stated in the session), so it
// reads as plain coaching language; the plan's schema (stimulus test,
// max_output, 1 set, formStandard) stays in assessmentRule. Both versions end
// with one shared tail.
test("the test protocol reads as plain coaching language; the schema stays in the rule", () => {
  const { min, max } = ASSESSMENT_LIMITS.restBetweenTestsMinutes;
  for (const protocol of [ASSESSMENT_PROTOCOL, ASSESSMENT_PROTOCOL_AFTER_HARD_WORK]) {
    assert.ok(!/stimulus|max_output|exercise-library|formStandard|metric/.test(protocol), protocol);
    assert.ok(protocol.endsWith(ASSESSMENT_PROTOCOL_TAIL), protocol);
    assert.ok(protocol.includes(`${min}-${max} minutes`), protocol);
  }
  const rule = (strengthGuardrailsForPrompt(contextOf(request(PUSH_UPS_DUE))) as { assessmentRule: string }).assessmentRule;
  for (const field of ["stimulus test", "max_output", "1 set", "assessment.protocol", "formStandard"]) assert.ok(rule.includes(field), field);
});

// Code review I6: the week's facts (progression, due tests and test days, the
// run offsets) are computed once and passed to the prompt, the clamp and the
// validator, so the test days the planner is told are the ones enforced.
test("the prompt and the validator read the week's facts they are given", () => {
  const context = contextOf(request(PUSH_UPS_DUE));
  const runs = [{ dayOffset: 2, kind: "tempo" }, { dayOffset: 4, kind: "easy" }];
  const week = strengthWeek(context, { plannedRuns: runs });
  assert.deepEqual(week.runOffsets, [2, 4]);
  assert.deepEqual(week.assessment.due, ["pushUps"]);
  assert.ok(week.assessment.testDayOffsets.includes(1));

  const moved = { ...week, assessment: { ...week.assessment, testDayOffsets: [6] } };
  const guardrails = strengthGuardrailsForPrompt(context, moved) as { assessment: { testDayOffsets: number[] } };
  assert.deepEqual(guardrails.assessment.testDayOffsets, [6]);
  const testOnDay1 = plan([day(1, [maxTest("pushUp"), work("pullUp", 3, 5, "hard"), work("plank", 3, 60)], "Push-up test"), day(3, USUAL_DAY), day(5, USUAL_DAY)]);
  assert.deepEqual(validateWeeklyPlan(testOnDay1, context, week), { accepted: true, messages: [] });
  const messages = validateWeeklyPlan(testOnDay1, context, moved).messages;
  assert.ok(messages.some((m) => m.includes("A push-up test is due") && m.includes("offset 6")), messages.join("\n"));
});

/** Marks the week a planned recovery week whose first day is `daysIn` days before the week start. */
function withRecoveryWeek(context: CoachContext, daysIn: number): CoachContext {
  const startsAt = daysAgo(daysIn);
  return {
    ...context,
    periodization: {
      cycle: "3:1",
      blockWeek: 4,
      loadingWeeksSinceRecovery: 3,
      lastUnloadingWeek: null,
      recoveryWeekDue: true,
      recoveryWeekReason: "3 loading weeks: block week 4 is a planned recovery week (3:1).",
      recoveryWeek: {
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 7 * DAY_MS).toISOString(),
        referenceWeeklyKm: null,
        weeklyKmCap: null,
        targetWeeklyKm: null,
        longRunCapKm: null,
        maxQualityRuns: 1,
        referenceHardStrengthSets: 10,
        hardStrengthSetCap: 6,
        maxHardStrengthSessions: 1,
        maxGoalSetsPerExercise: 3
      },
      recentWeeks: []
    }
  };
}
