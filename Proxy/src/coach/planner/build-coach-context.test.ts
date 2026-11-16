import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import { evaluateCoachRead } from "./evaluate-coach-read";
import { clampWeeklyPlan, minGoalSets, minStrengthSessions, strengthGuardrailsForPrompt, strengthProgressionPlan } from "./strength-guardrails";
import { isCalibrationHold, workingCap } from "./strength-limits";
import { STRENGTH_PHASE_LIMITS } from "./strength-phase";
import { validateWeeklyPlan } from "./validate-week-plan";
import type { CoachRequest, EffortLabel, EffortStimulus, RunningRequest, RunSummary, TrainingLog, WeeklyPlan } from "./types";

test("keeps insufficient history when both completed-month and current evidence are sparse", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "insufficient_history");
  assert.ok(context.readiness.riskFlags.includes("insufficient_training_history"));
});

test("uses current-month logs as early evidence for building when readiness is clear", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 7, fatigueLevel: 2 }),
      trainingLog("2026-05-11T10:00:00Z", { rpe: 7, fatigueLevel: 5 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "building");
  assert.ok(!context.readiness.riskFlags.includes("insufficient_training_history"));
});

test("carries profile notes and recent workout notes into the context", () => {
  const request = baseRequest({
    profileNotes: "Left elbow feels sensitive after high pull volume.",
    trainingLogs: [
      trainingLog("2026-04-04T10:00:00Z", { notes: "Easy session." }),
      trainingLog("2026-04-11T10:00:00Z", { notes: "Shoulder tight near the end." }),
      trainingLog("2026-03-18T10:00:00Z", { notes: "Grip felt stable." })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.profile.profileNotes, "Left elbow feels sensitive after high pull volume.");
  assert.ok(context.history.last5Logs.some((log) => log.notes === "Shoulder tight near the end."));
});

test("adds Garmin-style self-evaluation labels to recent logs", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 8, fatigueLevel: 8 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));
  const latestLog = context.history.last5Logs.at(-1);

  assert.equal(latestLog?.perceivedEffort, 8);
  assert.equal(latestLog?.howYouFeltScore, 2);
  assert.equal(latestLog?.howYouFelt, "weak");
});

test("summarizes planned-vs-actual RPE calibration", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", {
        rpe: 4,
        plannedRPE: 7,
        plannedEffortLabel: "hard",
        plannedEffortReason: "Goal stimulus.",
        rpeSummary: "RPE - Planned 7 | Actual 4"
      })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));
  const latestLog = context.history.last5Logs.at(-1);

  assert.equal(latestLog?.actualRPE, 4);
  assert.equal(latestLog?.plannedRPE, 7);
  assert.equal(latestLog?.rpeDelta, -3);
  assert.equal(latestLog?.rpeSummary, "RPE - Planned 7 | Actual 4");
  assert.equal(context.history.rpeCalibration.recentPlannedLogCount, 1);
  assert.equal(context.history.rpeCalibration.averageDeltaLast5, -3);
  assert.equal(context.history.rpeCalibration.belowPlanBy2Count, 1);
  assert.equal(context.history.rpeCalibration.abovePlanBy2Count, 0);
  assert.equal(context.history.rpeCalibration.latestSummary, "RPE - Planned 7 | Actual 4");
});

test("matches a clean push-up best of 20 to the prescribed 17", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-17", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-17",
      pushUps: 20,
      loggedPullUps: false,
      loggedPushUps: true,
      loggedPlankSeconds: false,
      plannedRPE: 7,
      actualRPE: 8,
      rpe: 8,
      painLevel: 0,
      fatigueLevel: 5
    })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.deepEqual(context.plannedWork.recentGoalPerformance?.pushUps, {
    latestLoggedBest: 20,
    prescribedTarget: 17,
    prescribedSets: 3,
    delta: 3,
    clean: true,
    overDelivered: true,
    consecutiveCleanCompletionsAtStandard: 1,
    completedAt: "2026-07-10T09:00:00Z",
    latestTestDate: null
  });
});

test("requires two clean completions when performance only meets the standard", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [
      plannedGoalSession("push-a", "2026-07-08T08:00:00Z", "completed", "pushUp", 3, 17),
      plannedGoalSession("push-b", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)
    ],
    trainingLogs: [
      trainingLog("2026-07-08T09:00:00Z", {
        sessionId: "push-a", pushUps: 17, loggedPullUps: false, loggedPlankSeconds: false, plannedRPE: 7, rpe: 7
      }),
      trainingLog("2026-07-10T09:00:00Z", {
        sessionId: "push-b", pushUps: 17, loggedPullUps: false, loggedPlankSeconds: false, plannedRPE: 7, rpe: 7
      })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.delta, 0);
  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.consecutiveCleanCompletionsAtStandard, 2);
});

test("records the latest past assessment date per goal", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [
      plannedGoalSession("old-test", "2026-05-01T08:00:00Z", "completed", "pullUp", 1, 8, "test"),
      plannedGoalSession("new-test", "2026-06-15T08:00:00Z", "completed", "pullUp", 1, 9, "test"),
      plannedGoalSession("future-test", "2026-07-20T08:00:00Z", "planned", "pullUp", 1, 10, "test")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.plannedWork.recentGoalPerformance?.pullUps.latestTestDate, "2026-06-15T08:00:00Z");
});

test("does not mark painful or excessive-effort performance as clean progression", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-hard", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-hard",
      pushUps: 20,
      loggedPullUps: false,
      loggedPlankSeconds: false,
      plannedRPE: 7,
      rpe: 9,
      painLevel: 4
    })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.delta, 3);
  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.clean, false);
  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.consecutiveCleanCompletionsAtStandard, 0);
});

test("does not classify a partial onboarding month comparison as overreaching", () => {
  const mayLogs = Array.from({ length: 5 }, (_, index) => trainingLog(`2026-05-${String(27 + index).padStart(2, "0")}T10:00:00Z`));
  const juneLogs = Array.from({ length: 12 }, (_, index) => trainingLog(`2026-06-${String(1 + index).padStart(2, "0")}T10:00:00Z`));

  const context = buildCoachContext(baseRequest({ trainingLogs: [...mayLogs, ...juneLogs] }), new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.readiness.state, "building");
  assert.ok(!context.readiness.riskFlags.includes("sudden_monthly_volume_increase"));
});

// Effort above plan that persists (3 of the last 5, within 14 days) is
// overreaching; two such sessions alone only calibrate (readiness-ladder tests below).
test("keeps a real volume increase as a watch flag and overreaches on repeated excessive effort", () => {
  const mayLogs = Array.from({ length: 10 }, (_, index) => trainingLog(`2026-05-${String(1 + index).padStart(2, "0")}T10:00:00Z`));
  const juneLogs = Array.from({ length: 16 }, (_, index) => trainingLog(`2026-06-${String(1 + index).padStart(2, "0")}T10:00:00Z`, {
    plannedRPE: 7,
    rpe: 7
  }));
  const julyLogs = ["07-06", "07-08", "07-10"].map((day) => trainingLog(`2026-${day}T10:00:00Z`, { plannedRPE: 5, rpe: 8 }));

  const context = buildCoachContext(baseRequest({ trainingLogs: [...mayLogs, ...juneLogs, ...julyLogs] }), new Date("2026-07-13T12:00:00Z"));

  assert.ok(context.readiness.riskFlags.includes("sudden_monthly_volume_increase"));
  assert.ok(context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.equal(context.readiness.state, "overreaching");
});

test("keeps a volume increase without negative recovery evidence in building", () => {
  const mayLogs = Array.from({ length: 10 }, (_, index) => trainingLog(`2026-05-${String(1 + index).padStart(2, "0")}T10:00:00Z`));
  const juneLogs = Array.from({ length: 16 }, (_, index) => trainingLog(`2026-06-${String(1 + index).padStart(2, "0")}T10:00:00Z`));

  const context = buildCoachContext(baseRequest({ trainingLogs: [...mayLogs, ...juneLogs] }), new Date("2026-07-13T12:00:00Z"));

  assert.ok(context.readiness.riskFlags.includes("sudden_monthly_volume_increase"));
  assert.equal(context.readiness.state, "building");
});

// Two ratings above plan are a calibration (hold what those sessions trained),
// not overreaching: that needs a second marker within 14 days.
test("flags repeated actual effort above plan and holds the metrics those sessions trained", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 8, plannedRPE: 5 }),
      trainingLog("2026-05-11T10:00:00Z", { rpe: 8, plannedRPE: 5 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "building");
  assert.ok(context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.deepEqual(context.readiness.calibration?.metrics, ["pullUps", "pushUps", "plankSeconds"]);
  assert.equal(context.history.rpeCalibration.averageDeltaLast5, 3);
  assert.equal(context.history.rpeCalibration.abovePlanBy2Count, 2);
});

test("carries running request through with computed weeksToRace", () => {
  const running = runningRequest({ longRunDayOffset: 5 });
  const request = baseRequest({ running });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  // weekStart 2026-05-25 to raceDate 2026-08-03 is exactly 70 days -> 10 weeks.
  // The pre-taper week is only read in the weeks after a post-race transition.
  assert.deepEqual(context.running, { ...running, weeksToRace: 10, preTaperTrainingWeekKm: null });
  assert.equal(context.running?.longRunDayOffset, 5);
});

test("summarizes planned sessions scheduled today for coach read rules", () => {
  const request = baseRequest({
    weekStart: "2026-06-28T00:00:00Z",
    plannedSessions: [
      plannedSession("past", "2026-06-27T08:00:00Z", "completed"),
      plannedSession("today", "2026-06-28T18:00:00Z", "planned"),
      plannedSession("future", "2026-06-29T08:00:00Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T12:00:00Z"));

  assert.deepEqual(context.plannedWork.todaySessions, [
    {
      id: "today",
      title: "Today session",
      status: "planned",
      focus: "mixed",
      scheduledDate: "2026-06-28T18:00:00Z"
    }
  ]);
});

test("reports no planned sessions today when the plan only has future work", () => {
  const request = baseRequest({
    weekStart: "2026-06-28T00:00:00Z",
    plannedSessions: [
      plannedSession("future", "2026-06-29T08:00:00Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T12:00:00Z"));

  assert.deepEqual(context.plannedWork.todaySessions, []);
});

test("excludes future sessions from adherence scoring", () => {
  const request = baseRequest({
    weekStart: "2026-06-28T00:00:00Z",
    plannedSessions: [
      plannedSession("past-done", "2026-06-27T08:00:00Z", "completed"),
      plannedSession("past-missed", "2026-06-27T18:00:00Z", "missed"),
      plannedSession("later-today", "2026-06-28T18:00:00Z", "planned"),
      plannedSession("future", "2026-06-29T08:00:00Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T12:00:00Z"));

  assert.equal(context.adherence.planned, 4);
  assert.equal(context.adherence.due, 2);
  assert.equal(context.adherence.future, 2);
  assert.equal(context.adherence.completed, 1);
  assert.equal(context.adherence.missed, 1);
  assert.equal(context.adherence.missedLast14Days, 1);
  assert.equal(context.adherence.adherenceScorePct, 50);
});

test("today's session at local midnight is pending, not due, all day (S4)", () => {
  // Amsterdam, Sunday 28 June 08:00. The app stores sessions at local midnight.
  const request = baseRequest({
    weekStart: "2026-06-27T22:00:00.000Z",
    timeZone: "Europe/Amsterdam",
    plannedSessions: [
      plannedSession("thu", "2026-06-24T22:00:00.000Z", "completed"),
      plannedSession("fri", "2026-06-25T22:00:00.000Z", "completed"),
      plannedSession("sat", "2026-06-26T22:00:00.000Z", "completed"),
      plannedSession("today", "2026-06-27T22:00:00.000Z", "planned"),
      plannedSession("tomorrow", "2026-06-28T22:00:00.000Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T06:00:00Z"));

  assert.equal(context.adherence.due, 3);
  assert.equal(context.adherence.completed, 3);
  assert.equal(context.adherence.pending, 0);
  assert.equal(context.adherence.pendingToday, 1);
  assert.equal(context.adherence.future, 2);
  assert.equal(context.adherence.adherenceScorePct, 100);
  assert.deepEqual(context.plannedWork.todaySessions.map((session) => session.id), ["today"]);
  const evaluation = evaluateCoachRead(context, null);
  assert.equal(evaluation.adherence.band, "excellent");
  assert.equal(evaluation.adherence.missedSessions, 0);
});

test("an unfinished session from before today still counts against adherence (S4)", () => {
  const request = baseRequest({
    weekStart: "2026-06-27T22:00:00.000Z",
    plannedSessions: [
      plannedSession("sat", "2026-06-26T22:00:00.000Z", "planned"),
      plannedSession("today", "2026-06-27T22:00:00.000Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T06:00:00Z"));

  assert.equal(context.adherence.due, 1);
  assert.equal(context.adherence.pending, 1);
  assert.equal(context.adherence.pendingToday, 1);
  assert.equal(context.adherence.adherenceScorePct, 0);
});

test("a session finished today counts toward adherence right away (S4)", () => {
  const request = baseRequest({
    weekStart: "2026-06-27T22:00:00.000Z",
    timeZone: "Europe/Amsterdam",
    plannedSessions: [
      plannedSession("sat", "2026-06-26T22:00:00.000Z", "missed"),
      plannedSession("today-run", "2026-06-27T22:00:00.000Z", "completed"),
      plannedSession("today-strength", "2026-06-27T22:00:00.000Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-06-28T10:00:00Z"));

  assert.equal(context.adherence.due, 2);
  assert.equal(context.adherence.completed, 1);
  assert.equal(context.adherence.missed, 1);
  assert.equal(context.adherence.pendingToday, 1);
  assert.equal(context.adherence.adherenceScorePct, 50);
});

test("on the spring-forward day tomorrow's session is not today (S15)", () => {
  // Sunday 28 March 2027 in Amsterdam has 23 hours.
  const request = baseRequest({
    weekStart: "2027-03-27T23:00:00.000Z",
    timeZone: "Europe/Amsterdam",
    plannedSessions: [
      plannedSession("sunday", "2027-03-27T23:00:00.000Z", "planned"),
      plannedSession("monday", "2027-03-28T22:00:00.000Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2027-03-28T08:00:00Z"));

  assert.deepEqual(context.plannedWork.todaySessions.map((session) => session.id), ["sunday"]);
});

test("on the fall-back day the 25th hour is still today (S15)", () => {
  // Sunday 25 October 2026 in Amsterdam has 25 hours; 22:30Z is 23:30 local.
  const request = baseRequest({
    weekStart: "2026-10-24T22:00:00.000Z",
    timeZone: "Europe/Amsterdam",
    plannedSessions: [
      plannedSession("late", "2026-10-25T22:30:00.000Z", "planned"),
      plannedSession("monday", "2026-10-25T23:00:00.000Z", "planned")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-10-25T08:00:00Z"));

  assert.deepEqual(context.plannedWork.todaySessions.map((session) => session.id), ["late"]);
});

test("separates old misses from repeated misses in the latest 14 days", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [
      plannedSession("old-miss", "2026-06-01T08:00:00Z", "missed"),
      plannedSession("recent-miss-a", "2026-07-05T08:00:00Z", "missed"),
      plannedSession("recent-miss-b", "2026-07-10T08:00:00Z", "missed")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.adherence.missed, 3);
  assert.equal(context.adherence.missedLast14Days, 2);
});

test("rounds partial weeks to race up", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Trail 50", raceDate: "2026-08-05T00:00:00Z", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  // 72 days -> 72 / 7 = 10.28... -> ceil 11.
  assert.equal(context.running?.weeksToRace, 11);
});

test("reports zero weeksToRace when the race date equals week start", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Race day", raceDate: "2026-05-25T00:00:00Z", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running?.weeksToRace, 0);
});

test("reports one week to race when the race is one day after week start", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Tomorrow race", raceDate: "2026-05-26T00:00:00Z", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running?.weeksToRace, 1);
});

test("reports one week to race when the race is exactly seven days after week start", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Next week race", raceDate: "2026-06-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running?.weeksToRace, 1);
});

test("clamps weeksToRace to zero when the race date has passed", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Past race", raceDate: "2026-05-18T00:00:00Z", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running?.weeksToRace, 0);
});

test("clamps weeksToRace to zero when the race date is unparseable", () => {
  const request = baseRequest({
    running: runningRequest({
      raceGoal: { name: "Broken race", raceDate: "not-a-date", distanceKm: 50, elevationGainM: 2000 }
    })
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running?.weeksToRace, 0);
});

test("the context carries the computed season, with or without a race", () => {
  const now = new Date("2026-05-27T12:00:00Z");
  // weekStart 2026-05-25 to the 100 km race on 2026-08-03: 70 days.
  const upcoming = buildCoachContext(baseRequest({ running: runningRequest() }), now).season;
  assert.deepEqual(
    [upcoming?.raceState, upcoming?.raceName, upcoming?.daysToRace, upcoming?.phase, upcoming?.emphasis, upcoming?.postRaceDays],
    ["upcoming", "Mozart 100", 70, "build", "balanced", 25]
  );

  // A past race keeps weeksToRace at 0 for older readers; the season says how long ago.
  const past = buildCoachContext(baseRequest({
    running: runningRequest({ raceGoal: { name: "Past race", raceDate: "2026-05-18T00:00:00Z", distanceKm: 50, elevationGainM: 2000 } })
  }), now);
  assert.equal(past.running?.weeksToRace, 0);
  assert.deepEqual([past.season?.raceState, past.season?.daysSinceRace, past.season?.phase], ["recent", 7, "transition"]);

  const strengthOnly = buildCoachContext(baseRequest(), now).season;
  assert.deepEqual(
    [strengthOnly?.raceState, strengthOnly?.raceName, strengthOnly?.phase, strengthOnly?.emphasis],
    ["none", null, "general_preparation", "strength_led"]
  );
});

test("caps recentRuns to the most recent 30 sorted ascending by completedAt", () => {
  // 30 runs at 3-4 runs/week spans roughly the 90-day activity lookback.
  const runs = Array.from({ length: 35 }, (_, index) =>
    new Date(Date.UTC(2026, 2, 1 + index, 8)).toISOString().replace(".000Z", "Z")
  ).map((date) => runSummary(date));
  const request = baseRequest({ running: runningRequest({ recentRuns: [...runs].reverse() }) });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  const completedDates = context.running?.recentRuns.map((run) => run.completedAt) ?? [];
  assert.equal(completedDates.length, 30);
  assert.equal(completedDates[0], "2026-03-06T08:00:00Z");
  assert.equal(completedDates.at(-1), "2026-04-04T08:00:00Z");
  assert.deepEqual(completedDates, [...completedDates].sort());
});

test("leaves running context undefined when the payload has no running request", () => {
  const context = buildCoachContext(baseRequest(), new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.running, undefined);
});

function baseRequest(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    model: "gpt-6.1-sol",
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-05-25T00:00:00Z",
    weeklySessions: 4,
    equipment: ["pullUpBar"],
    targetDate: "2027-05-25T00:00:00Z",
    trainingLogs: [],
    plannedSessions: [],
    ...overrides
  };
}

function runningRequest(overrides: Partial<RunningRequest> = {}): RunningRequest {
  return {
    raceGoal: { name: "Mozart 100", raceDate: "2026-08-03T00:00:00Z", distanceKm: 100, elevationGainM: 5000 },
    baselineWeeklyKm: 45,
    longestRecentRunKm: 28,
    runningDays: ["tuesday", "thursday", "saturday"],
    runningDayOffsets: [1, 3, 5],
    longRunDay: "saturday",
    longRunDayOffset: 5,
    recentRuns: [runSummary("2026-05-20T08:00:00Z"), runSummary("2026-05-23T08:00:00Z")],
    ...overrides
  };
}

function runSummary(completedAt: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    completedAt,
    distanceKm: 12,
    movingSeconds: 4200,
    elevationGainM: 180,
    averageHr: 142,
    rpe: 5,
    kind: "easy",
    ...overrides
  };
}

function plannedSession(id: string, scheduledDate: string, status: string): CoachRequest["plannedSessions"][number] {
  return {
    id,
    scheduledDate,
    title: `${id[0].toUpperCase()}${id.slice(1)} session`,
    focus: "mixed",
    status,
    exercises: []
  };
}

function plannedGoalSession(
  id: string,
  scheduledDate: string,
  status: string,
  exercise: "pullUp" | "pushUp" | "plank",
  sets: number,
  target: number,
  stimulus: "volume" | "strength" | "test" = "strength"
): CoachRequest["plannedSessions"][number] {
  return {
    ...plannedSession(id, scheduledDate, status),
    exercises: [{
      exercise,
      sets,
      targetReps: exercise === "plank" ? 0 : target,
      targetSeconds: exercise === "plank" ? target : 0,
      plannedEffortLabel: stimulus === "test" ? "max_output" : "hard",
      plannedEffortStimulus: stimulus
    }]
  };
}

function trainingLog(completedAt: string, overrides: Partial<TrainingLog> = {}): TrainingLog {
  return {
    sessionId: `session-${completedAt}`,
    completedAt,
    pullUps: 5,
    pushUps: 20,
    plankSeconds: 60,
    loggedPullUps: true,
    loggedPushUps: true,
    loggedPlankSeconds: true,
    rpe: 7,
    painLevel: 0,
    fatigueLevel: 5,
    notes: "",
    ...overrides
  };
}

// Finding: `clean` required a stored plannedRPE, so manually logged or legacy
// sessions could never earn progression. A missing planned RPE now falls back
// to the planned effort label, else 7.
// Delivered stays within the over-delivery margin (18 against 17), so the
// effort is judged against the plan.
test("a log without planned RPE is judged against a default planned RPE of 7", () => {
  const request = (rpe: number) => baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-legacy", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-legacy", pushUps: 18, loggedPullUps: false, loggedPlankSeconds: false, rpe
    })]
  });

  const atEight = buildCoachContext(request(8), new Date("2026-07-13T12:00:00Z"));
  const atNine = buildCoachContext(request(9), new Date("2026-07-13T12:00:00Z"));

  assert.equal(atEight.plannedWork.recentGoalPerformance?.pushUps.clean, true);
  assert.equal(atEight.plannedWork.recentGoalPerformance?.pushUps.delta, 1);
  assert.equal(atNine.plannedWork.recentGoalPerformance?.pushUps.clean, false);
  // The calibration summary still only uses real planned RPE values.
  assert.equal(atEight.history.rpeCalibration.recentPlannedLogCount, 0);
});

test("a missing planned RPE uses the logged planned effort label when there is one", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-medium", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-medium", pushUps: 18, loggedPullUps: false, loggedPlankSeconds: false, rpe: 8, plannedEffortLabel: "medium"
    })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T12:00:00Z"));

  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.clean, false, "medium plans RPE 6, so actual 8 is not clean");
});

test("the previous working prescription is the top target of the latest week, tests excluded", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [
      plannedGoalSession("old", "2026-06-29T08:00:00Z", "completed", "pushUp", 3, 30),
      plannedGoalSession("mon", "2026-07-06T08:00:00Z", "completed", "pushUp", 4, 24),
      plannedGoalSession("thu", "2026-07-09T08:00:00Z", "completed", "pushUp", 3, 26, "volume"),
      plannedGoalSession("test", "2026-07-11T08:00:00Z", "completed", "pushUp", 1, 45, "test")
    ]
  });

  const trend = buildCoachContext(request, new Date("2026-07-13T12:00:00Z")).plannedWork.recentGoalTargets.pushUps;

  assert.equal(trend.latestWorkingTarget, 26);
  assert.equal(trend.latestWorkingSets, 3);
  assert.equal(trend.latestWorkingDate, "2026-07-09T08:00:00Z");
  assert.equal(trend.latestTarget, 45, "latestTarget keeps its old meaning");
});

// Readiness is time-based: a pain >= 4 log counts for 7 days (14 while no
// log followed it) and a later clean log (pain <= 2) clears it early.
test("a clean pain-free log after a pain 5 log clears recovery_needed", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-07-01T10:00:00Z"),
      trainingLog("2026-07-05T10:00:00Z"),
      trainingLog("2026-07-10T10:00:00Z", { painLevel: 5 }),
      trainingLog("2026-07-12T10:00:00Z", { painLevel: 0, fatigueLevel: 5 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.ok(!context.readiness.riskFlags.includes("recent_pain_level_4_or_higher"));
  assert.notEqual(context.readiness.state, "recovery_needed");
});

test("pain stays a recovery flag until a log at pain 2 or lower follows it", () => {
  const withLater = (painLevel: number) => baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-07-10T10:00:00Z", { painLevel: 5 }),
      trainingLog("2026-07-12T10:00:00Z", { painLevel })
    ]
  });
  const now = new Date("2026-07-13T08:00:00Z");

  assert.equal(buildCoachContext(withLater(3), now).readiness.state, "recovery_needed", "pain 3 is not a clean log");
  assert.notEqual(buildCoachContext(withLater(2), now).readiness.state, "recovery_needed");
  const alone = baseRequest({ trainingLogs: [trainingLog("2026-07-10T10:00:00Z", { painLevel: 5 })] });
  assert.equal(buildCoachContext(alone, now).readiness.state, "recovery_needed");
});

test("a pain log ages out after 7 days once training resumed, or 14 days without any later log", () => {
  const now = new Date("2026-07-20T08:00:00Z");
  const resumed = baseRequest({
    trainingLogs: [
      trainingLog("2026-07-10T10:00:00Z", { painLevel: 5 }),
      trainingLog("2026-07-12T10:00:00Z", { painLevel: 3 })
    ]
  });
  assert.ok(!buildCoachContext(resumed, now).readiness.riskFlags.includes("recent_pain_level_4_or_higher"), "10 days old, training resumed");

  const silent = (completedAt: string) => baseRequest({ trainingLogs: [trainingLog(completedAt, { painLevel: 6 })] });
  assert.ok(buildCoachContext(silent("2026-07-10T10:00:00Z"), now).readiness.riskFlags.includes("recent_pain_level_4_or_higher"),
    "10 days old and nothing logged since: still unconfirmed");
  assert.ok(!buildCoachContext(silent("2026-07-05T10:00:00Z"), now).readiness.riskFlags.includes("recent_pain_level_4_or_higher"),
    "15 days old: aged out");
});

test("a pain flag from last month alone is a watch item, not recovery_needed", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-06-03T10:00:00Z", { painLevel: 5 }),
      trainingLog("2026-06-10T10:00:00Z"),
      trainingLog("2026-06-17T10:00:00Z"),
      trainingLog("2026-07-02T10:00:00Z"),
      trainingLog("2026-07-09T10:00:00Z")
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));
  const evaluation = evaluateCoachRead(context, null);

  assert.ok(context.readiness.riskFlags.includes("last_full_month_pain_flag"));
  assert.notEqual(context.readiness.state, "recovery_needed");
  assert.equal(evaluation.readiness.painOrFatigueFlag, false);
});

test("very weak feedback is cleared by a later normal-feeling log", () => {
  const request = (fatigueLevel: number) => baseRequest({
    trainingLogs: [
      trainingLog("2026-07-10T10:00:00Z", { fatigueLevel: 10 }),
      trainingLog("2026-07-12T10:00:00Z", { fatigueLevel })
    ]
  });
  const now = new Date("2026-07-13T08:00:00Z");

  assert.equal(buildCoachContext(request(8), now).readiness.state, "recovery_needed", "weak is not yet clean");
  assert.notEqual(buildCoachContext(request(5), now).readiness.state, "recovery_needed");
});

// Plateau and decline come from rolling 3-week windows (best of the last 21
// days vs the 21 before), not from two full calendar months.
test("flat bests across two rolling 3-week windows read as a plateau within six weeks", () => {
  const dates = ["06-02", "06-06", "06-10", "06-14", "06-18", "06-24", "06-28", "07-02", "07-06", "07-10"];
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: dates.map((day) => trainingLog(`2026-${day}T10:00:00Z`, { pullUps: 8, pushUps: 30, plankSeconds: 90 })),
    plannedSessions: dates.map((day, index) => plannedSession(`s${index}`, `2026-${day}T08:00:00Z`, "completed"))
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.equal(context.history.twoFullMonthTrend.label, "insufficient_history", "May is empty, so the month view cannot tell yet");
  assert.equal(context.history.rollingTrend?.label, "flat");
  assert.equal(context.readiness.state, "plateau");
});

// A decline needs results below the plan: the recent sessions planned 9 pull-ups
// and 34 push-ups and fell short (unplanned lower numbers are no decline).
test("lower bests in the last three weeks than the three before read as declining", () => {
  const days: Array<[string, number, number, number, number]> = [
    ["06-05", 10, 35, 10, 35],
    ["06-12", 10, 36, 10, 36],
    ["06-19", 9, 34, 9, 34],
    ["06-26", 9, 34, 8, 30],
    ["07-03", 9, 34, 8, 31],
    ["07-10", 9, 34, 7, 30]
  ];
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: days.map(([day, pull, push]) => ({
      ...plannedSession(`s-${day}`, `2026-${day}T08:00:00Z`, "completed"),
      exercises: [
        { exercise: "pullUp" as const, sets: 3, targetReps: pull, targetSeconds: 0, plannedEffortLabel: "hard" as const, plannedEffortStimulus: "strength" as const },
        { exercise: "pushUp" as const, sets: 3, targetReps: push, targetSeconds: 0, plannedEffortLabel: "hard" as const, plannedEffortStimulus: "strength" as const }
      ]
    })),
    trainingLogs: days.map(([day, , , pullUps, pushUps]) =>
      trainingLog(`2026-${day}T10:00:00Z`, { sessionId: `s-${day}`, pullUps, pushUps, loggedPlankSeconds: false }))
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.equal(context.history.rollingTrend?.label, "declining");
  assert.equal(context.history.rollingTrend?.pullUpsDelta, -2);
  assert.equal(context.readiness.state, "overreaching");
  assert.match(context.readiness.reason ?? "", /pull-ups and push-ups of the last 3 weeks are below/);
});

test("lower bests without results below a plan are not a decline", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-06-05T10:00:00Z", { pullUps: 10, pushUps: 35 }),
      trainingLog("2026-06-12T10:00:00Z", { pullUps: 10, pushUps: 36 }),
      trainingLog("2026-06-26T10:00:00Z", { pullUps: 8, pushUps: 30 }),
      trainingLog("2026-07-10T10:00:00Z", { pullUps: 7, pushUps: 30 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.notEqual(context.history.rollingTrend?.label, "declining");
  assert.deepEqual(context.history.rollingTrend?.lowerNumbersWithoutRepeatedShortfall, ["pullUps", "pushUps"]);
  assert.notEqual(context.readiness.state, "overreaching");
});

test("the rolling trend needs two logs of a metric in each window", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-06-12T10:00:00Z", { pullUps: 10 }),
      trainingLog("2026-06-26T10:00:00Z", { pullUps: 7 }),
      trainingLog("2026-07-08T10:00:00Z", { pullUps: 7 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.equal(context.history.rollingTrend?.label, "insufficient_history");
  assert.notEqual(context.readiness.state, "overreaching");
});

test("a lower retest at a new plan block is not read as a decline against the old block", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    planBlockStartedAt: "2026-07-01T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-06-08T10:00:00Z", { pullUps: 12 }),
      trainingLog("2026-06-15T10:00:00Z", { pullUps: 12 }),
      trainingLog("2026-07-03T10:00:00Z", { pullUps: 8 }),
      trainingLog("2026-07-10T10:00:00Z", { pullUps: 8 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.equal(context.history.rollingTrend?.label, "insufficient_history");
  assert.notEqual(context.readiness.state, "overreaching");
});

// After "Start a new plan" with a lower retest, the current level is the new
// baseline plus logs since the block start; older bests are context only.
test("a lower retest at a new block sets the current level; the older best stays as context", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    planBlockStartedAt: "2026-07-08T00:00:00Z",
    baseline: { pullUps: 8, pushUps: 30, plankSeconds: 70 },
    plannedSessions: [
      plannedGoalSession("old-pull", "2026-06-29T08:00:00Z", "completed", "pullUp", 4, 10),
      plannedGoalSession("new-pull", "2026-07-10T08:00:00Z", "completed", "pullUp", 3, 6)
    ],
    trainingLogs: [
      trainingLog("2026-06-20T10:00:00Z", { pullUps: 12, pushUps: 45, plankSeconds: 120 }),
      trainingLog("2026-06-29T10:00:00Z", { sessionId: "old-pull", pullUps: 12, loggedPushUps: false, loggedPlankSeconds: false }),
      trainingLog("2026-07-10T10:00:00Z", { sessionId: "new-pull", pullUps: 9, loggedPushUps: false, loggedPlankSeconds: false })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.deepEqual(context.history.bestRecentTests, { pullUps: 9, pushUps: 30, plankSeconds: 70 });
  assert.equal(context.history.bestBeforeBlock?.pullUps, 12);
  assert.equal(context.history.bestBeforeBlock?.pushUps, 45);
  assert.equal(context.history.bestBeforeBlock?.plankSeconds, 120);
  assert.equal(workingCap("pullUps", context.history.bestRecentTests.pullUps), 7, "85% of 9, not of 12");
  const pull = context.plannedWork.recentGoalTargets.pullUps;
  assert.equal(pull.latestWorkingTarget, 6, "the old block's 4 x 10 no longer anchors continuity");
  assert.equal(context.plannedWork.recentGoalPerformance?.pullUps.prescribedTarget, 6);
  assert.equal(context.plannedWork.recentGoalPerformance?.pullUps.baselineSetAt, "2026-07-08T00:00:00.000Z");
});

test("right after a new block the progression band starts fresh inside the new caps", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    planBlockStartedAt: "2026-07-12T00:00:00Z",
    baseline: { pullUps: 8, pushUps: 30, plankSeconds: 70 },
    plannedSessions: [plannedGoalSession("old-pull", "2026-07-06T08:00:00Z", "completed", "pullUp", 4, 10)],
    trainingLogs: [trainingLog("2026-07-06T10:00:00Z", { sessionId: "old-pull", pullUps: 13 })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));
  const progression = strengthProgressionPlan(context);

  assert.equal(context.history.bestRecentTests.pullUps, 8);
  assert.equal(progression.pullUps.status, "free");
  // Final review item 3: the band starts at the useful floor (45% of 8 = 4), not at 1.
  assert.deepEqual(progression.pullUps.target, { min: 4, max: 6 }, "from the useful floor to the cap of 85% of 8, not 85% of 13");
});

test("without a block start the current level still uses every log and the baseline", () => {
  const request = baseRequest({
    baseline: { pullUps: 8, pushUps: 30, plankSeconds: 70 },
    trainingLogs: [trainingLog("2026-06-20T10:00:00Z", { pullUps: 12, pushUps: 25, plankSeconds: 50 })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.deepEqual(context.history.bestRecentTests, { pullUps: 12, pushUps: 30, plankSeconds: 70 });
  assert.equal(context.history.bestBeforeBlock, undefined);
});

test("a block that started long ago (the profile's creation) keeps all logs in the current level", () => {
  const request = baseRequest({
    planBlockStartedAt: "2026-01-05T00:00:00Z",
    baseline: { pullUps: 4, pushUps: 15, plankSeconds: 40 },
    trainingLogs: [trainingLog("2026-06-20T10:00:00Z", { pullUps: 12, pushUps: 35, plankSeconds: 90 })]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.deepEqual(context.history.bestRecentTests, { pullUps: 12, pushUps: 35, plankSeconds: 90 });
});

// Review finding: a matched Assessment (1 x max) became the standard the next
// week continued from, so progression demanded "at most 1 sets".
test("a goal test is not matched as the working prescription", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [
      plannedGoalSession("work", "2026-07-06T08:00:00Z", "completed", "pushUp", 3, 24),
      plannedGoalSession("test", "2026-07-10T08:00:00Z", "completed", "pushUp", 1, 40, "test")
    ],
    trainingLogs: [
      trainingLog("2026-07-06T09:00:00Z", { sessionId: "work", pushUps: 24, loggedPullUps: false, loggedPlankSeconds: false, plannedRPE: 7 }),
      trainingLog("2026-07-10T09:00:00Z", { sessionId: "test", pushUps: 42, loggedPullUps: false, loggedPlankSeconds: false, plannedRPE: 10, rpe: 10 })
    ]
  });

  const performance = buildCoachContext(request, new Date("2026-07-13T08:00:00Z")).plannedWork.recentGoalPerformance?.pushUps;

  assert.equal(performance?.prescribedTarget, 24);
  assert.equal(performance?.prescribedSets, 3);
  assert.equal(performance?.completedAt, "2026-07-06T09:00:00Z");
  assert.equal(performance?.latestTestDate, "2026-07-10T08:00:00Z", "the test still sets the test spacing");
});

// Review finding: pull-ups 8 x 4 last week, then "Start a new plan" with a
// retest of 5. The old prescription anchored the band (nothing below 7) while
// the old best kept the caps high, so the new plan could never pass.
test("after a lower retest at a new block, a plan at the new level validates", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    planBlockStartedAt: "2026-07-12T00:00:00Z",
    // One training day a week, so the one-session plan meets the session minimum.
    weeklySessions: 1,
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    plannedSessions: [
      plannedGoalSession("old-1", "2026-07-06T08:00:00Z", "completed", "pullUp", 4, 8),
      plannedGoalSession("old-2", "2026-07-09T08:00:00Z", "completed", "pullUp", 4, 8)
    ],
    trainingLogs: [
      trainingLog("2026-07-06T09:00:00Z", { sessionId: "old-1", pullUps: 9, loggedPushUps: false, loggedPlankSeconds: false }),
      trainingLog("2026-07-09T09:00:00Z", { sessionId: "old-2", pullUps: 9, loggedPushUps: false, loggedPlankSeconds: false })
    ]
  });
  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));
  const effort = (label: "hard" | "medium", rpe: number) => ({ label, targetRPE: rpe, targetRIR: label === "hard" ? 2 : 4, stimulus: "strength" as const, reason: "Fresh start at the retested level." });
  const plan: WeeklyPlan = {
    summary: "Build: restart from the retest.",
    contextState: context.readiness.state,
    safetyFlags: [],
    sessions: [{
      title: "Pull and push strength",
      dayOffset: 2,
      focus: "mixed",
      plannedEffort: effort("hard", 7),
      purpose: "Rebuild pull-up volume from the retest.",
      estimatedDurationMinutes: 35,
      progressionRationale: "Working sets at the new level.",
      safetyNotes: [],
      loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
      // The week's only session holds every goal exercise (exposure rule).
      exercises: [
        { exercise: "pullUp", sets: 4, reps: 4, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: effort("hard", 7) },
        { exercise: "pushUp", sets: 3, reps: 12, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: effort("medium", 6) },
        { exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 90, intensity: "Medium", plannedEffort: effort("medium", 6) }
      ]
    }]
  };

  assert.equal(context.history.bestRecentTests.pullUps, 5);
  assert.deepEqual(validateWeeklyPlan(plan, context), { accepted: true, messages: [] });
});

// Finding (athlete report): on an easy day that asked for 10 push-ups he did
// 38 and honestly rated it hard; the coach read "effort above plan" as
// overreaching and made the next week easier. Effort is judged against the
// work actually delivered: more than planned explains the higher effort.
test("doing clearly more than planned and rating it hard is not read as overreaching", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-10-20", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7 },
    { day: "2026-10-23", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7 },
    { day: "2026-11-06", planned: 10, label: "medium", stimulus: "volume", delivered: 35, rpe: 8, plannedRPE: 5 },
    { day: "2026-11-10", planned: 10, label: "medium", stimulus: "volume", delivered: 38, rpe: 8, plannedRPE: 5 }
  ]), new Date("2026-11-13T09:00:00Z"));

  assert.ok(!context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.notEqual(context.readiness.state, "overreaching");
});

test("near-max effort on sessions the athlete chose to extend is not repeated excessive effort", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 10, label: "medium", stimulus: "volume", delivered: 30, rpe: 9 },
    { day: "2026-11-06", planned: 10, label: "medium", stimulus: "volume", delivered: 34, rpe: 9 },
    { day: "2026-11-10", planned: 12, label: "medium", stimulus: "volume", delivered: 38, rpe: 9 }
  ]), new Date("2026-11-13T09:00:00Z"));

  assert.ok(!context.readiness.riskFlags.includes("repeated_high_perceived_effort"));
  assert.notEqual(context.readiness.state, "overreaching");
});

// Unlike more than planned, work done as planned but rated much harder is a
// warning: the push-ups those sessions trained hold (a calibration).
test("work done exactly as planned that felt much harder than planned is still a warning sign", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-06", planned: 10, label: "medium", stimulus: "volume", delivered: 10, rpe: 8, plannedRPE: 5 },
    { day: "2026-11-10", planned: 10, label: "medium", stimulus: "volume", delivered: 10, rpe: 8, plannedRPE: 5 }
  ]), new Date("2026-11-13T09:00:00Z"));
  const push = strengthProgressionPlan(context).pushUps;

  assert.ok(context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.equal(push.status, "hold");
  assert.ok(isCalibrationHold(push));
  assert.equal(push.status === "hold" && push.reason, "calibration");
});

type DeliveredDay = {
  day: string;
  planned: number;
  label: "light" | "medium" | "hard" | "max_output";
  stimulus: "technique" | "volume" | "strength" | "test";
  delivered: number;
  rpe: number;
  plannedRPE?: number;
  sets?: number;
};

/** Push-up sessions with their logs: what was planned, and what the athlete delivered. */
function deliveredWorkRequest(days: DeliveredDay[], overrides: Partial<CoachRequest> = {}): CoachRequest {
  return baseRequest({
    weekStart: "2026-11-12T23:00:00Z",
    planBlockStartedAt: "2026-06-01T00:00:00Z",
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    plannedSessions: days.map((entry) => ({
      ...plannedSession(`s-${entry.day}`, `${entry.day}T00:00:00Z`, "completed"),
      exercises: [{
        exercise: "pushUp",
        sets: entry.sets ?? 2,
        targetReps: entry.planned,
        targetSeconds: 0,
        plannedEffortLabel: entry.label,
        plannedEffortStimulus: entry.stimulus
      }]
    })),
    trainingLogs: days.map((entry) => trainingLog(`${entry.day}T17:00:00Z`, {
      sessionId: `s-${entry.day}`,
      pushUps: entry.delivered,
      loggedPullUps: false,
      loggedPlankSeconds: false,
      rpe: entry.rpe,
      plannedRPE: entry.plannedRPE,
      plannedEffortLabel: entry.label
    })),
    ...overrides
  });
}

test("a set clearly above the plan counts as clean even when it was rated harder than planned", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-10", planned: 20, label: "hard", stimulus: "strength", delivered: 30, rpe: 9, plannedRPE: 7, sets: 3 }
  ]), new Date("2026-11-13T09:00:00Z"));
  const push = context.plannedWork.recentGoalPerformance?.pushUps;

  assert.equal(push?.delta, 10);
  assert.equal(push?.clean, true);
});

test("38 push-ups on an easy technique day is progression evidence against the 10 that were planned", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 8, plannedRPE: 4 }
  ]), new Date("2026-11-13T09:00:00Z"));
  const push = context.plannedWork.recentGoalPerformance?.pushUps;

  assert.equal(push?.latestLoggedBest, 38);
  assert.equal(push?.prescribedTarget, 10);
  assert.equal(push?.delta, 28);
  assert.equal(push?.clean, true);
});

test("easy work done as planned is still not progression evidence", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 10, rpe: 4, plannedRPE: 4 }
  ]), new Date("2026-11-13T09:00:00Z"));
  const push = context.plannedWork.recentGoalPerformance?.pushUps;

  assert.equal(push?.prescribedTarget, 20);
  assert.equal(push?.latestLoggedBest, 20);
});

// Finding: after the race taper the logged numbers followed the lighter plan
// (2x10 instead of 3x20), the rolling trend read that as a decline, and the
// coach went into overreaching with no lower limits. Lower numbers that meet a
// lighter plan are not a decline; falling short of the plan is.
const BUILD_WEEKS: DeliveredDay[] = ["2026-10-06", "2026-10-09", "2026-10-13", "2026-10-16", "2026-10-20"].map((day) => ({
  day, planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3
}));

test("lower numbers that meet a lighter plan are not read as a decline", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    ...BUILD_WEEKS,
    { day: "2026-10-23", planned: 15, label: "medium", stimulus: "volume", delivered: 15, rpe: 6, plannedRPE: 6 },
    { day: "2026-10-27", planned: 12, label: "medium", stimulus: "volume", delivered: 12, rpe: 6, plannedRPE: 6 },
    { day: "2026-11-04", planned: 10, label: "medium", stimulus: "volume", delivered: 10, rpe: 6, plannedRPE: 6 },
    { day: "2026-11-11", planned: 9, label: "medium", stimulus: "volume", delivered: 9, rpe: 6, plannedRPE: 6 }
  ]), new Date("2026-11-13T09:00:00Z"));

  assert.notEqual(context.history.rollingTrend?.label, "declining");
  assert.deepEqual(context.history.rollingTrend?.lowerNumbersFollowLighterPlan, ["pushUps"]);
  // Review finding: with push-ups the only compared metric, ignoring it read as
  // "not enough history" for an athlete with six weeks of logs. It holds.
  assert.equal(context.history.rollingTrend?.label, "flat");
  assert.equal(context.history.rollingTrend?.pushUpsDelta, 0);
  assert.notEqual(context.readiness.state, "overreaching");
});

test("falling short of the plan in the recent weeks is still a decline", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    ...BUILD_WEEKS,
    { day: "2026-10-27", planned: 20, label: "hard", stimulus: "strength", delivered: 16, rpe: 8, plannedRPE: 7, sets: 3 },
    { day: "2026-11-04", planned: 20, label: "hard", stimulus: "strength", delivered: 15, rpe: 8, plannedRPE: 7, sets: 3 },
    { day: "2026-11-07", planned: 20, label: "hard", stimulus: "strength", delivered: 15, rpe: 8, plannedRPE: 7, sets: 3 }
  ]), new Date("2026-11-13T09:00:00Z"));

  assert.equal(context.history.rollingTrend?.label, "declining");
  assert.equal(context.readiness.state, "overreaching");
});

// Finding: progression stepped +1 rep from the previous (easy) prescription,
// so 38 push-ups on a day that asked for 10 earned "11 next week". A coach
// plans from the level the athlete showed, and a normal week never sits below
// the useful floor (45% of the current best).
test("after doing far more than planned, next week plans from the level shown, not +1 on the easy target", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 8, plannedRPE: 4 }
  ]), new Date("2026-11-13T09:00:00Z"));
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(context.history.bestRecentTests.pushUps, 38);
  assert.equal(push.status, "earned");
  // From the real working level (20 x 3), up to what was delivered within the cap.
  assert.deepEqual(push.target, { min: 21, max: 28 });
});

test("earned progression from a prescription far below the athlete's level starts at the useful floor", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-06", planned: 8, label: "medium", stimulus: "volume", delivered: 8, rpe: 6, plannedRPE: 6 },
    { day: "2026-11-10", planned: 8, label: "medium", stimulus: "volume", delivered: 8, rpe: 6, plannedRPE: 6 }
  ], { baseline: { pullUps: 5, pushUps: 40, plankSeconds: 60 } }), new Date("2026-11-13T09:00:00Z"));
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(push.status, "earned");
  assert.deepEqual(push.target, { min: 18, max: 20 });
});

test("a hold week from a prescription far below the athlete's level still starts at the useful floor", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-10", planned: 9, label: "medium", stimulus: "volume", delivered: 9, rpe: 6, plannedRPE: 6 }
  ], { baseline: { pullUps: 5, pushUps: 40, plankSeconds: 60 } }), new Date("2026-11-13T09:00:00Z"));
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(push.status, "hold");
  assert.deepEqual(push.target, { min: 18, max: 18 });
});

test("a target above a re-based band is sent back with that band, not a +1 step", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 8, plannedRPE: 4 }
  ]), new Date("2026-11-13T09:00:00Z"));

  const messages = validateWeeklyPlan(pushOnlyPlan(30, 2), context).messages;

  assert.ok(messages.some((message) => message.includes("plans from the level the athlete showed: 21-28 reps")), messages.join("\n"));
});

test("a hold week below the athlete's useful level is sent back as too low, not as a dropped step", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-10", planned: 9, label: "medium", stimulus: "volume", delivered: 9, rpe: 6, plannedRPE: 6 }
  ], { baseline: { pullUps: 5, pushUps: 40, plankSeconds: 60 } }), new Date("2026-11-13T09:00:00Z"));

  const messages = validateWeeklyPlan(pushOnlyPlan(9, 2), context).messages;

  assert.ok(messages.some((message) => message.includes("below the useful level for the athlete's current best")), messages.join("\n"));
});

function pushOnlyPlan(reps: number, sets: number): WeeklyPlan {
  const effort = { label: "medium" as const, targetRPE: 6, targetRIR: 4, stimulus: "volume" as const, reason: "Push volume." };
  return {
    summary: "Build: push-ups.",
    contextState: "building",
    safetyFlags: [],
    sessions: [{
      title: "Push",
      dayOffset: 1,
      focus: "push",
      purpose: "Push-up volume.",
      plannedEffort: effort,
      estimatedDurationMinutes: 30,
      progressionRationale: "Push-ups.",
      safetyNotes: [],
      loggingFieldsRequired: ["pushUps"],
      exercises: [{ exercise: "pushUp", sets, reps, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: effort }]
    }]
  } as unknown as WeeklyPlan;
}

// Finding: a normal week came back as 2 strength sessions of 2 sets. A coach
// plans a normal week with at least 3 sessions (fewer only when fewer days are
// free) and at least 3 sets of main goal work; recovery weeks, the race taper
// and real recovery needs may go lighter.
const SIX_DAYS: Partial<CoachRequest> = {
  weeklySessions: 6,
  trainingDays: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
  trainingDayOffsets: [1, 2, 3, 4, 5, 6]
};
const NORMAL_WEEK: DeliveredDay[] = [
  { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
  { day: "2026-11-10", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 }
];
const NOW_NOV_13 = new Date("2026-11-13T09:00:00Z");
/** Three of the last sessions done as planned and rated 3 above plan, within 14 days: overreaching. */
const PERSISTENT_EFFORT_ABOVE_PLAN: DeliveredDay[] = ["2026-11-03", "2026-11-06", "2026-11-10"].map((day) => ({
  day, planned: 10, label: "medium", stimulus: "volume", delivered: 10, rpe: 8, plannedRPE: 5
}));

test("a normal week plans at least 3 strength sessions when 3 training days are free", () => {
  const context = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS), NOW_NOV_13);

  assert.equal(minStrengthSessions(context), 3);
  const messages = validateWeeklyPlan(pushOnlyPlan(20, 3), context).messages;
  assert.ok(messages.some((message) => message.includes("at least 3 strength sessions")), messages.join("\n"));
});

test("the session minimum never asks for more days than are free", () => {
  const twoDays = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, { weeklySessions: 2, trainingDays: ["tuesday", "friday"], trainingDayOffsets: [2, 5] }), NOW_NOV_13);
  const sixDays = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS), NOW_NOV_13);

  assert.equal(minStrengthSessions(twoDays), 2);
  // Runs on 2, 3 and 5, strength allowed on 1, 4 and 6: one of those must stay a full rest day.
  const oddDays = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, { weeklySessions: 3, trainingDays: ["monday", "thursday", "saturday"], trainingDayOffsets: [1, 4, 6] }), NOW_NOV_13);
  assert.equal(minStrengthSessions(oddDays, { runOffsets: [2, 3, 5] }), 2);
  assert.equal(minStrengthSessions(sixDays, { runOffsets: [2, 3, 5] }), 3);
});

// A pain note in the profile used to lower the minimum to 0; the note is now
// planner context only (it relaxes no rule). A heavy running week used to
// lower it to 2 (maintenance); running load never lowers it now (Task 8).
test("recovery needs lower the session minimum; a profile note does not", () => {
  const normal = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS), NOW_NOV_13);
  const overreaching = buildCoachContext(deliveredWorkRequest(PERSISTENT_EFFORT_ABOVE_PLAN, SIX_DAYS), NOW_NOV_13);
  const painNote = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, { ...SIX_DAYS, profileNotes: "Left shoulder hurts on push-ups." }), NOW_NOV_13);

  assert.equal(overreaching.readiness.state, "overreaching");
  assert.equal(minStrengthSessions(overreaching), 0);
  assert.equal(minStrengthSessions(normal), 3);
  assert.equal(minStrengthSessions(painNote), 3, "a pain note in the profile keeps the minimum");
  assert.equal(painNote.profile.profileNotes, "Left shoulder hurts on push-ups.", "the note stays planner context");
});

test("main goal work in a normal week uses at least 3 sets; 2-set work is raised", () => {
  const context = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS), NOW_NOV_13);
  const clamped = clampWeeklyPlan(pushOnlyPlan(20, 2), context);

  assert.equal(minGoalSets(context), 3);
  assert.equal(clamped.plan.sessions[0].exercises[0].sets, 3);
  assert.ok(clamped.adjustments.some((line) => line.includes("raised to 3")), clamped.adjustments.join("\n"));
});

test("after doing far more than planned, the re-based target may use the normal 3 sets", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 8, plannedRPE: 4 }
  ]), NOW_NOV_13);

  assert.ok((strengthProgressionPlan(context).pushUps.maxSets ?? 0) >= 3);
});

test("an overreaching week may keep goal work at 2 sets", () => {
  const context = buildCoachContext(deliveredWorkRequest(PERSISTENT_EFFORT_ABOVE_PLAN, SIX_DAYS), NOW_NOV_13);

  assert.equal(minGoalSets(context), 2);
});

// A planned recovery week caps goal work at the previous prescription. When
// that prescription was an easy day the athlete went far beyond, the cap is
// the useful level the athlete has shown: lighter by sets and effort, not by
// an anchor the athlete already passed.
test("a recovery week never caps goal work below the useful level the athlete has shown", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-03", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "medium", stimulus: "volume", delivered: 38, rpe: 8, plannedRPE: 5 }
  ], SIX_DAYS), NOW_NOV_13);
  context.periodization = {
    cycle: "3:1",
    blockWeek: 4,
    loadingWeeksSinceRecovery: 3,
    lastUnloadingWeek: null,
    recoveryWeekDue: true,
    recoveryWeekReason: "Block week 4 is a planned recovery week (3:1).",
    recoveryWeek: {
      startsAt: "2026-11-12T23:00:00Z",
      endsAt: "2026-11-19T23:00:00Z",
      referenceWeeklyKm: 0,
      weeklyKmCap: 0,
      targetWeeklyKm: { low: 0, high: 0 },
      longRunCapKm: 0,
      maxQualityRuns: 0,
      referenceHardStrengthSets: 10,
      hardStrengthSetCap: 6,
      maxHardStrengthSessions: 1,
      maxGoalSetsPerExercise: 3
    },
    recentWeeks: []
  };
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(push.status, "offload");
  assert.deepEqual(push.target, { min: 1, max: 18 });
});

// Review finding: the risk flags ignored over-delivered sessions, but the
// effort calibration the planners and the coach read see still counted them.
test("the effort calibration the planners see leaves out sessions that did more than planned", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-10-20", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7 },
    { day: "2026-10-23", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7 },
    { day: "2026-11-06", planned: 10, label: "medium", stimulus: "volume", delivered: 35, rpe: 8, plannedRPE: 5 },
    { day: "2026-11-10", planned: 10, label: "medium", stimulus: "volume", delivered: 38, rpe: 8, plannedRPE: 5 }
  ]), NOW_NOV_13);
  const calibration = context.history.rpeCalibration;
  const latest = context.history.last5Logs.at(-1);

  assert.equal(calibration.abovePlanBy2Count, 0);
  assert.equal(calibration.averageDeltaLast5, 0);
  assert.equal(calibration.latestSummary, "RPE - Planned 7 | Actual 7");
  assert.equal(latest?.didMoreThanPlanned, true);
  assert.equal(latest?.deliveredVsPlan, "more than planned: 38 push-ups against 10 planned");
});

// Code review M9: a test's max set is the plan, not an effort above plan, so
// the calibration summary leaves test sessions out like the effort flags do
// (even when the stored planned RPE was a working session's 7).
test("the effort calibration the planners see leaves out test sessions", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-10-20", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7 },
    { day: "2026-11-03", planned: 40, label: "max_output", stimulus: "test", delivered: 42, rpe: 10, plannedRPE: 7, sets: 1 },
    { day: "2026-11-10", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 8, plannedRPE: 7 }
  ]), NOW_NOV_13);
  const calibration = context.history.rpeCalibration;

  assert.equal(calibration.recentPlannedLogCount, 2);
  assert.equal(calibration.abovePlanBy2Count, 0);
  assert.equal(calibration.averageDeltaLast5, 0.5);
});

test("a logged goal value that is missing never becomes a result", () => {
  const request = deliveredWorkRequest([
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 0, rpe: 5, plannedRPE: 4 }
  ]);
  request.trainingLogs[0] = { ...request.trainingLogs[0], pushUps: undefined as unknown as number };
  const context = buildCoachContext(request, NOW_NOV_13);

  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.prescribedTarget, null);
  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.latestLoggedBest, null);
});

test("exactly 2 more than planned counts as more than planned, even rated near max", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-10", planned: 17, label: "hard", stimulus: "strength", delivered: 19, rpe: 9, sets: 3 }
  ]), NOW_NOV_13);
  const push = context.plannedWork.recentGoalPerformance?.pushUps;

  assert.equal(push?.overDelivered, true);
  assert.equal(push?.clean, true);
});

// Review finding: after an easy day matched as evidence, the earned band
// started from the easy target and accepted a step back from the real
// working level. It never drops below the previous working prescription.
test("after an easy-day over-delivery the earned band never drops below the real working level", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-06", planned: 24, label: "hard", stimulus: "strength", delivered: 24, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 8, plannedRPE: 4 }
  ]), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(push.status, "earned");
  assert.deepEqual(push.target, { min: 25, max: 28 });
});

// Review finding: 22 against 20 planned (at failure) opened the band to the
// working cap. Over-delivery opens it only as far as what was delivered.
test("a small over-delivery opens the band only as far as what was delivered", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-06", planned: 20, label: "hard", stimulus: "strength", delivered: 20, rpe: 7, plannedRPE: 7, sets: 3 },
    { day: "2026-11-10", planned: 20, label: "hard", stimulus: "strength", delivered: 22, rpe: 10, plannedRPE: 7, sets: 3 }
  ], { baseline: { pullUps: 5, pushUps: 40, plankSeconds: 60 } }), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(push.status, "earned");
  assert.deepEqual(push.target, { min: 21, max: 22 });
});

// Review finding: the skill lets repeated misses reduce frequency, so the
// minimum drops by one after two or more misses in the last 14 days.
test("repeated misses in the last 14 days lower the session minimum by one", () => {
  const request = deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS);
  request.plannedSessions.push(
    plannedSession("missed-1", "2026-11-05T00:00:00Z", "missed"),
    plannedSession("missed-2", "2026-11-08T00:00:00Z", "missed")
  );
  const context = buildCoachContext(request, NOW_NOV_13);

  assert.equal(context.adherence.missedLast14Days, 2);
  assert.equal(minStrengthSessions(context), 2);
});

// This used to be a maintenance week; the earned band (Task 8: no
// maintenance week) names the useful level the same way.
test("an earned band raised to the useful level says so instead of calling it the earned standard", () => {
  const context = buildCoachContext(deliveredWorkRequest([
    { day: "2026-11-06", planned: 8, label: "medium", stimulus: "volume", delivered: 8, rpe: 6, plannedRPE: 6 },
    { day: "2026-11-10", planned: 8, label: "medium", stimulus: "volume", delivered: 8, rpe: 6, plannedRPE: 6 }
  ], { baseline: { pullUps: 5, pushUps: 40, plankSeconds: 60 } }), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;
  const messages = validateWeeklyPlan(pushOnlyPlan(9, 3), context).messages;

  assert.match(push.note, /useful level/);
  assert.ok(messages.some((message) => message.includes("below the useful level for the current best of 40") && message.includes("Got 9 reps")), messages.join("\n"));
});

// Review finding: after a race an empty strength week was sent back only for
// the session count; the repair added two light sessions and then failed
// "cannot be all light", so no plan came out at all. The count message states
// the whole requirement at once (the weeks after a race are normal weeks now).
test("a short week is told the whole requirement at once: enough sessions, one of them at medium effort", () => {
  const context = buildCoachContext(deliveredWorkRequest(NORMAL_WEEK, SIX_DAYS), NOW_NOV_13);
  const empty = { ...pushOnlyPlan(20, 3), safetyFlags: ["Rest after the race."], sessions: [] } as WeeklyPlan;

  const normal = validateWeeklyPlan(empty, context).messages;

  assert.ok(normal.some((m) => m.includes("A normal training week plans at least 3 strength sessions") && m.includes("at least one at medium effort or harder")), normal.join("\n"));
});

// Readiness ladder (14 Nov audit): effort is judged against the plan. Planned
// near-max work (very_hard, tests) rated as planned is the plan; effort above
// plan alone recalibrates the goal exercises it touched (calibrate); readiness
// becomes overreaching only with a second marker within 14 days.
type LadderDay = {
  day: string;
  exercise?: "pullUp" | "pushUp" | "plank";
  planned: number;
  sets?: number;
  label?: EffortLabel;
  stimulus?: EffortStimulus;
  delivered: number;
  rpe: number;
  plannedRPE?: number;
  fatigueLevel?: number;
};
const LADDER_LABEL_RPE: Record<EffortLabel, number> = { light: 4, medium: 6, hard: 7, very_hard: 9, max_output: 10 };

/** One goal exercise per session, logged as the session's best set (push-ups unless named). */
function ladderRequest(days: LadderDay[], overrides: Partial<CoachRequest> = {}): CoachRequest {
  const metricOf = (exercise: LadderDay["exercise"]) => exercise === "pullUp" ? "pullUps" : exercise === "plank" ? "plankSeconds" : "pushUps";
  return baseRequest({
    weekStart: "2026-11-12T23:00:00Z",
    planBlockStartedAt: "2026-06-01T00:00:00Z",
    baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
    plannedSessions: days.map((entry) => {
      const exercise = entry.exercise ?? "pushUp";
      return {
        ...plannedSession(`s-${entry.day}-${exercise}`, `${entry.day}T00:00:00Z`, "completed"),
        exercises: [{
          exercise,
          sets: entry.sets ?? (entry.stimulus === "test" ? 1 : 3),
          targetReps: exercise === "plank" ? 0 : entry.planned,
          targetSeconds: exercise === "plank" ? entry.planned : 0,
          plannedEffortLabel: entry.label ?? "hard",
          plannedEffortStimulus: entry.stimulus ?? "strength"
        }]
      };
    }),
    trainingLogs: days.map((entry) => {
      const metric = metricOf(entry.exercise);
      return trainingLog(`${entry.day}T17:00:00Z`, {
        sessionId: `s-${entry.day}-${entry.exercise ?? "pushUp"}`,
        loggedPullUps: metric === "pullUps",
        loggedPushUps: metric === "pushUps",
        loggedPlankSeconds: metric === "plankSeconds",
        [metric]: entry.delivered,
        rpe: entry.rpe,
        plannedRPE: entry.plannedRPE ?? LADDER_LABEL_RPE[entry.label ?? "hard"],
        plannedEffortLabel: entry.label ?? "hard",
        fatigueLevel: entry.fatigueLevel ?? 5
      });
    }),
    ...overrides
  });
}

const PUSH_24_CLEAN = (day: string): LadderDay => ({ day, planned: 24, delivered: 24, rpe: 7 });

test("a test session at RPE 10 never counts toward repeated high effort", () => {
  const context = buildCoachContext(ladderRequest([
    PUSH_24_CLEAN("2026-10-20"),
    PUSH_24_CLEAN("2026-10-23"),
    { day: "2026-11-03", planned: 40, label: "max_output", stimulus: "test", delivered: 42, rpe: 10 },
    { day: "2026-11-06", exercise: "pullUp", planned: 10, label: "max_output", stimulus: "test", delivered: 11, rpe: 10 },
    { day: "2026-11-10", planned: 26, label: "very_hard", delivered: 26, rpe: 9 }
  ]), NOW_NOV_13);

  assert.ok(!context.readiness.riskFlags.includes("repeated_high_perceived_effort"), context.readiness.riskFlags.join(", "));
  assert.equal(context.readiness.state, "building");
});

test("two sessions rated 2 above plan hold only the metrics they trained", () => {
  const context = buildCoachContext(ladderRequest([
    { day: "2026-11-02", exercise: "pullUp", planned: 6, delivered: 6, rpe: 7 },
    { day: "2026-11-04", planned: 24, delivered: 24, rpe: 9 },
    { day: "2026-11-06", exercise: "pullUp", planned: 6, delivered: 6, rpe: 7 },
    { day: "2026-11-10", planned: 24, delivered: 24, rpe: 9 }
  ]), NOW_NOV_13);
  const progression = strengthProgressionPlan(context);

  assert.ok(context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.equal(context.readiness.state, "building", "a calibration, not overreaching");
  assert.deepEqual(context.readiness.calibration?.metrics, ["pushUps"]);
  assert.equal(progression.pushUps.status, "hold");
  assert.deepEqual(progression.pushUps.target, { min: 22, max: 24 });
  assert.equal(progression.pushUps.maxSets, 3, "no extra set while the effort runs above plan");
  assert.equal(progression.pullUps.status, "earned", "pull-ups were rated as planned");

  const extraSet = { ...pushOnlyPlan(24, 4), sessions: [{ ...pushOnlyPlan(24, 4).sessions[0] }] } as WeeklyPlan;
  const messages = validateWeeklyPlan(extraSet, context).messages;
  assert.ok(messages.some((m) => m.includes("push-up sets stay at 3 this week")), messages.join("\n"));
  const clamped = clampWeeklyPlan(extraSet, context).plan.sessions[0].exercises[0];
  assert.equal(clamped.sets, 3, "the clamp takes the extra set off");
});

test("effort above plan plus a shortfall is overreaching", () => {
  const days = (completedBefore: number): LadderDay[] => [
    { day: "2026-10-30", planned: 24, delivered: completedBefore, rpe: 7 },
    { day: "2026-11-06", planned: 24, delivered: 24, rpe: 9 },
    { day: "2026-11-10", planned: 24, delivered: 21, rpe: 9 }
  ];

  const shortOfACompletedTarget = buildCoachContext(ladderRequest(days(24)), NOW_NOV_13);
  assert.equal(shortOfACompletedTarget.readiness.state, "overreaching");
  assert.match(shortOfACompletedTarget.readiness.reason ?? "", /21 push-ups against 24 planned/);

  const neverCompleted = buildCoachContext(ladderRequest(days(22)), NOW_NOV_13);
  assert.equal(neverCompleted.readiness.state, "building", "24 was never completed cleanly, so falling short of it is no performance drop");
});

test("three of five above plan is overreaching without another marker", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const twice = buildCoachContext(ladderRequest([PUSH_24_CLEAN("2026-10-27"), PUSH_24_CLEAN("2026-10-30"), above("2026-11-06"), above("2026-11-10")]), NOW_NOV_13);
  const three = buildCoachContext(ladderRequest([PUSH_24_CLEAN("2026-10-27"), above("2026-11-03"), above("2026-11-06"), above("2026-11-10")]), NOW_NOV_13);

  assert.equal(twice.readiness.state, "building");
  assert.equal(three.readiness.state, "overreaching");
  assert.ok(!three.readiness.riskFlags.includes("repeated_high_perceived_effort"), "RPE 8 is not near-max");
});

test("effort above plan with two sessions rated weak is overreaching", () => {
  const context = buildCoachContext(ladderRequest([
    PUSH_24_CLEAN("2026-10-30"),
    { day: "2026-11-06", planned: 24, delivered: 24, rpe: 9, fatigueLevel: 8 },
    { day: "2026-11-10", planned: 24, delivered: 24, rpe: 9, fatigueLevel: 8 }
  ]), NOW_NOV_13);

  assert.equal(context.readiness.state, "overreaching");
});

test("overreaching holds or steps back one step, never down to 1 rep", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const context = buildCoachContext(ladderRequest([PUSH_24_CLEAN("2026-10-27"), above("2026-11-03"), above("2026-11-06"), above("2026-11-10")]), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;
  const overreachingPlan = (reps: number, sets: number) => ({ ...pushOnlyPlan(reps, sets), contextState: "overreaching" }) as WeeklyPlan;

  assert.equal(context.readiness.state, "overreaching");
  assert.deepEqual(push.target, { min: 22, max: 24 });
  assert.equal(push.maxSets, 2, "max(2, previous 3 sets - 1)");
  const { responseDays } = STRENGTH_PHASE_LIMITS.overreaching;
  assert.ok(push.note.includes(`${responseDays.min}-${responseDays.max} days`), push.note);
  assert.doesNotMatch(push.note, /reduce as needed/);

  const tooLow = validateWeeklyPlan(overreachingPlan(10, 2), context).messages;
  assert.ok(tooLow.some((m) => m.includes("between 22 and 24 reps")), tooLow.join("\n"));
  assert.deepEqual(validateWeeklyPlan(overreachingPlan(23, 2), context), { accepted: true, messages: [] });

  const clamped = clampWeeklyPlan(overreachingPlan(28, 4), context).plan.sessions[0].exercises[0];
  assert.deepEqual([clamped.reps, clamped.sets], [24, 2]);
});

test("one shortfall in the recent window is not a decline; two are", () => {
  const earlier = ["2026-10-06", "2026-10-09", "2026-10-13", "2026-10-16"].map(PUSH_24_CLEAN);
  const lighter = (day: string): LadderDay => ({ day, planned: 15, label: "medium", delivered: 15, rpe: 6 });

  const once = buildCoachContext(ladderRequest([
    ...earlier,
    { day: "2026-10-27", planned: 24, delivered: 20, rpe: 8 },
    lighter("2026-11-03"),
    lighter("2026-11-07")
  ]), NOW_NOV_13);
  assert.notEqual(once.history.rollingTrend?.label, "declining");
  assert.notEqual(once.readiness.state, "overreaching");

  const twice = buildCoachContext(ladderRequest([
    ...earlier,
    { day: "2026-10-27", planned: 24, delivered: 20, rpe: 8 },
    { day: "2026-11-03", planned: 24, delivered: 21, rpe: 8 },
    lighter("2026-11-07")
  ]), NOW_NOV_13);
  assert.equal(twice.history.rollingTrend?.label, "declining");
  assert.equal(twice.readiness.state, "overreaching");
});

// A test that was done (or is planned for today) is the latest test; a missed
// or overdue one is not. Due tests are enforced (assessment.ts), so today's
// planned test must not make tomorrow's plan ask for a second one, and a
// missed test must not reset the 4-6 week clock.
test("the latest test date counts tests done or planned for today, not missed ones", () => {
  const latest = (sessions: CoachRequest["plannedSessions"]) => buildCoachContext(baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: sessions
  }), new Date("2026-07-13T01:30:00Z")).plannedWork.recentGoalPerformance?.pushUps.latestTestDate;

  const done = plannedGoalSession("done", "2026-06-01T00:00:00Z", "completed", "pushUp", 1, 40, "test");
  assert.equal(latest([done, plannedGoalSession("missed", "2026-07-01T00:00:00Z", "missed", "pushUp", 1, 40, "test")]), "2026-06-01T00:00:00Z");
  assert.equal(latest([done, plannedGoalSession("overdue", "2026-07-08T00:00:00Z", "planned", "pushUp", 1, 40, "test")]), "2026-06-01T00:00:00Z");
  assert.equal(latest([done, plannedGoalSession("today", "2026-07-13T00:00:00Z", "planned", "pushUp", 1, 40, "test")]), "2026-07-13T00:00:00Z");
});

// Plan-owner decision: in an overreaching week the band's lower limit holds
// the TOP block of each goal exercise, whatever its effort label (the main
// prescription cannot be relabelled light to drop to tiny numbers); lighter
// technique or support blocks may sit below it. The upper limit holds every
// block. An all-light week is allowed (zero sessions are too). Tests wait.
test("in an overreaching week the top block holds the band whatever its label; lighter extra blocks may sit below", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const context = buildCoachContext(ladderRequest([PUSH_24_CLEAN("2026-10-27"), above("2026-11-03"), above("2026-11-06"), above("2026-11-10")]), NOW_NOV_13);
  const light = { label: "light" as const, targetRPE: 3, targetRIR: 6, stimulus: "technique" as const, reason: "Easy technique." };
  const medium = { label: "medium" as const, targetRPE: 6, targetRIR: 4, stimulus: "volume" as const, reason: "Push volume." };
  const block = (reps: number, sets: number, effort: typeof light | typeof medium) =>
    ({ exercise: "pushUp" as const, sets, reps, seconds: 0, restSeconds: 90, intensity: effort.label, plannedEffort: effort });
  const week = (blocks: ReturnType<typeof block>[], sessionEffort: typeof light | typeof medium = medium) => {
    const plan = { ...pushOnlyPlan(24, 2), contextState: "overreaching" } as WeeklyPlan;
    plan.sessions[0] = { ...plan.sessions[0], plannedEffort: sessionEffort, exercises: blocks };
    return plan;
  };

  // A top block at the band plus a 2 x 12 technique finisher.
  assert.deepEqual(validateWeeklyPlan(week([block(24, 2, medium), block(12, 2, light)]), context), { accepted: true, messages: [] });
  // The top block relabelled light below the band.
  const relabelled = validateWeeklyPlan(week([block(10, 2, light)], light), context).messages;
  assert.ok(relabelled.some((m) => m.includes("top push-up block") && m.includes("between 22 and 24 reps")), relabelled.join("\n"));
  assert.deepEqual(validateWeeklyPlan(week([block(23, 2, light)], light), context), { accepted: true, messages: [] }, "an all-light week inside the band");
  // A secondary block above the band is lowered.
  const clamped = clampWeeklyPlan(week([block(24, 2, medium), block(30, 2, light)]), context).plan.sessions[0].exercises;
  assert.deepEqual(clamped.map((entry) => [entry.reps, entry.plannedEffort.label]), [[24, "medium"], [24, "light"]]);
  assert.ok(validateWeeklyPlan(week([block(24, 2, medium), block(30, 2, light)]), context).messages.some((m) => m.includes("above 24 reps")));

  const withTest = { ...pushOnlyPlan(23, 2), contextState: "overreaching" } as WeeklyPlan;
  withTest.sessions[0].exercises = [{ ...withTest.sessions[0].exercises[0], sets: 1, reps: 40, plannedEffort: { label: "max_output", targetRPE: 10, targetRIR: 0, stimulus: "test", reason: "Test." } }];
  assert.ok(validateWeeklyPlan(withTest, context).messages.some((m) => m.includes("no tests while readiness is overreaching")));
  const converted = clampWeeklyPlan(withTest, context).plan;
  assert.deepEqual([converted.sessions[0].exercises[0].plannedEffort.label, converted.sessions[0].exercises[0].reps, converted.sessions[0].exercises[0].sets], ["medium", 24, 2]);
  assert.deepEqual(validateWeeklyPlan(converted, context), { accepted: true, messages: [] });
  // Code review I1 (probe B): a test written without a number takes the band's top too.
  withTest.sessions[0].exercises[0].reps = 0;
  const fromZero = clampWeeklyPlan(withTest, context).plan.sessions[0].exercises[0];
  assert.deepEqual([fromZero.plannedEffort.label, fromZero.reps, fromZero.sets], ["medium", 24, 2]);
});

test("an overreaching week keeps hard sets at 70% of the last loading week", () => {
  // Block week of 2-8 November: one hard day of 4 x 6 pull-ups and 4 x 24 push-ups (8 hard sets), then three
  // push-up sessions rated 2 above plan: overreaching, with at most 5 hard sets this week (70% of 8).
  const hardDay: LadderDay[] = [
    { day: "2026-11-02", exercise: "pullUp", planned: 6, sets: 4, delivered: 6, rpe: 7 },
    { day: "2026-11-02", planned: 24, sets: 4, delivered: 24, rpe: 7 }
  ];
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const context = buildCoachContext(ladderRequest([...hardDay, above("2026-11-03"), above("2026-11-05"), above("2026-11-06")]), NOW_NOV_13);
  const hard = { label: "hard" as const, targetRPE: 7, targetRIR: 3, stimulus: "strength" as const, reason: "Hard." };
  const day = (dayOffset: number, push: number) => ({
    ...pushOnlyPlan(push, 2).sessions[0],
    dayOffset,
    plannedEffort: hard,
    exercises: [
      { exercise: "pullUp" as const, sets: 2, reps: 6, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: hard },
      { exercise: "pushUp" as const, sets: 2, reps: push, seconds: 0, restSeconds: 90, intensity: "Hard", plannedEffort: hard }
    ]
  });
  const plan = { ...pushOnlyPlan(24, 2), contextState: "overreaching", sessions: [day(1, 24), day(4, 23)] } as WeeklyPlan;

  assert.equal(context.readiness.state, "overreaching");
  assert.equal(context.periodization?.lastLoadingWeekHardSets, 8);
  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("8 hard strength sets") && m.includes("at most 5") && m.includes("70%")), messages.join("\n"));

  const { plan: clamped, adjustments } = clampWeeklyPlan(plan, context);
  assert.ok(adjustments.some((a) => a.includes("overreaching")), adjustments.join("\n"));
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
  const guardrails = strengthGuardrailsForPrompt(context) as { overreaching: { hardSetCap: number } };
  assert.equal(guardrails.overreaching.hardSetCap, 5);
});

// Code review I5: the overreaching hard-set check counts like the clamp and the
// recovery week (phaseHardSetCount): a test allowed on the recovery week's last
// 2 days stays outside it, so a plan the clamp leaves alone is not sent back.
test("a test allowed at the end of a recovery week stays outside the overreaching hard-set cap", () => {
  const hardDay: LadderDay[] = [
    { day: "2026-11-02", exercise: "pullUp", planned: 6, sets: 4, delivered: 6, rpe: 7 },
    { day: "2026-11-02", planned: 24, sets: 4, delivered: 24, rpe: 7 }
  ];
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const context = buildCoachContext(ladderRequest([...hardDay, above("2026-11-03"), above("2026-11-05"), above("2026-11-06")]), NOW_NOV_13);
  context.periodization = {
    ...context.periodization!,
    recoveryWeekDue: true,
    recoveryWeekReason: "Block week 4 is a planned recovery week (3:1).",
    recoveryWeek: {
      startsAt: "2026-11-12T23:00:00Z", endsAt: "2026-11-19T23:00:00Z",
      referenceWeeklyKm: 0, weeklyKmCap: 0, targetWeeklyKm: { low: 0, high: 0 }, longRunCapKm: 0, maxQualityRuns: 0,
      referenceHardStrengthSets: 8, hardStrengthSetCap: 6, maxHardStrengthSessions: 1, maxGoalSetsPerExercise: 3
    }
  };
  const hard = { label: "hard" as const, targetRPE: 7, targetRIR: 3, stimulus: "strength" as const, reason: "Hard." };
  const holdTest = { label: "max_output" as const, targetRPE: 10, targetRIR: 0, stimulus: "test" as const, reason: "Hold test." };
  const base = pushOnlyPlan(24, 3).sessions[0];
  const plan = {
    ...pushOnlyPlan(24, 3),
    summary: "Offload: planned recovery week.",
    contextState: "overreaching",
    sessions: [
      { ...base, dayOffset: 1, plannedEffort: hard, exercises: [
        { exercise: "pullUp" as const, sets: 2, reps: 6, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: hard },
        { exercise: "pushUp" as const, sets: 3, reps: 24, seconds: 0, restSeconds: 90, intensity: "Hard", plannedEffort: hard }
      ] },
      { ...base, dayOffset: 6, plannedEffort: holdTest, exercises: [
        { exercise: "hollowHold" as const, sets: 1, reps: 0, seconds: 40, restSeconds: 120, intensity: "Max", plannedEffort: holdTest }
      ] }
    ]
  } as WeeklyPlan;

  assert.equal(context.readiness.state, "overreaching");
  assert.equal((strengthGuardrailsForPrompt(context) as { overreaching: { hardSetCap: number } }).overreaching.hardSetCap, 5);
  assert.deepEqual(validateWeeklyPlan(plan, context), { accepted: true, messages: [] });
  assert.deepEqual(validateWeeklyPlan(clampWeeklyPlan(plan, context).plan, context), { accepted: true, messages: [] });
});

test("an overreaching week without a loading week to compare allows one hard session, and free exercises keep 3 sets", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const context = buildCoachContext(ladderRequest([PUSH_24_CLEAN("2026-10-27"), above("2026-11-03"), above("2026-11-06"), above("2026-11-10")]), NOW_NOV_13);
  const hard = { label: "hard" as const, targetRPE: 7, targetRIR: 3, stimulus: "strength" as const, reason: "Hard." };
  const day = (dayOffset: number, pullSets: number) => ({
    ...pushOnlyPlan(24, 2).sessions[0],
    dayOffset,
    plannedEffort: hard,
    exercises: [
      { exercise: "pushUp" as const, sets: 2, reps: 24, seconds: 0, restSeconds: 90, intensity: "Hard", plannedEffort: hard },
      { exercise: "pullUp" as const, sets: pullSets, reps: 5, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: hard }
    ]
  });
  const plan = { ...pushOnlyPlan(24, 2), contextState: "overreaching", sessions: [day(1, 4), day(4, 3)] } as WeeklyPlan;

  assert.equal(context.periodization?.lastLoadingWeekHardSets, null);
  const pullUps = strengthProgressionPlan(context).pullUps;
  assert.equal(pullUps.status === "free" && pullUps.reason, "overreaching", "no recent pull-up prescription");
  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("2 hard strength sessions") && m.includes("the weekly cap is 1 while readiness is overreaching")), messages.join("\n"));
  assert.ok(messages.some((m) => m.includes("at most 3 sets of pull-up work")), messages.join("\n"));

  const clamped = clampWeeklyPlan(plan, context).plan;
  assert.equal(clamped.sessions[0].exercises[1].sets, 3);
  assert.deepEqual(validateWeeklyPlan(clamped, context), { accepted: true, messages: [] });
});

// Spec review (probe3): delivered work wins over a calibration. The hold on an
// exercise ends as soon as a later log of it was clearly more than planned or
// a clean completion as planned (RPE no more than 1 above plan).
const ABOVE_24 = (day: string): LadderDay => ({ day, planned: 24, label: "medium", stimulus: "volume", delivered: 24, rpe: 8 });

test("clearly more than planned after two sessions above plan re-bases instead of holding (probe3)", () => {
  const context = buildCoachContext(ladderRequest([
    { day: "2026-10-14", planned: 40, label: "max_output", stimulus: "test", delivered: 40, rpe: 10 },
    ABOVE_24("2026-11-03"),
    ABOVE_24("2026-11-06"),
    { day: "2026-11-11", planned: 24, label: "medium", stimulus: "volume", delivered: 32, rpe: 8 }
  ]), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(context.readiness.calibration, undefined);
  assert.equal(push.status, "earned");
  assert.deepEqual(push.target, { min: 25, max: 30 }, "the re-based band, not the 22-24 hold");
});

test("later sessions done as planned end a calibration hold; other exercises' sessions do not", () => {
  const asPlanned = (day: string): LadderDay => ({ day, planned: 24, label: "medium", stimulus: "volume", delivered: 24, rpe: 6 });
  const pull = (day: string): LadderDay => ({ day, exercise: "pullUp", planned: 6, delivered: 6, rpe: 7 });

  const twoLater = buildCoachContext(ladderRequest([ABOVE_24("2026-11-02"), ABOVE_24("2026-11-04"), asPlanned("2026-11-08"), asPlanned("2026-11-11")]), NOW_NOV_13);
  assert.ok(twoLater.readiness.riskFlags.includes("recent_effort_above_plan"), "the flag still reads the last 5");
  assert.equal(twoLater.readiness.calibration, undefined);
  assert.equal(strengthProgressionPlan(twoLater).pushUps.status, "earned");

  const oneLater = buildCoachContext(ladderRequest([ABOVE_24("2026-11-04"), ABOVE_24("2026-11-08"), asPlanned("2026-11-11")]), NOW_NOV_13);
  assert.equal(oneLater.readiness.calibration, undefined, "one clean session as planned is enough");

  const otherExercise = buildCoachContext(ladderRequest([ABOVE_24("2026-11-04"), ABOVE_24("2026-11-08"), pull("2026-11-11")]), NOW_NOV_13);
  assert.deepEqual(otherExercise.readiness.calibration?.metrics, ["pushUps"]);
});

// Code review I3 (probe C): one clean-completion rule. A log without a planned
// RPE is judged against the planned label of that exercise's own block, so
// progression and the calibration hold read the same session the same way.
test("progression and the calibration hold judge a session by one clean-completion rule (probe C)", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", stimulus: "volume", delivered: 24, rpe: 8, plannedRPE: 6 });
  const req = ladderRequest([above("2026-11-04"), above("2026-11-07")]);
  // Push-ups at medium and pull-ups at hard in one session; push-ups done as planned at RPE 8, no planned RPE stored.
  req.plannedSessions.push({
    ...plannedSession("mixed", "2026-11-11T00:00:00Z", "completed"),
    exercises: [
      { exercise: "pushUp", sets: 3, targetReps: 24, targetSeconds: 0, plannedEffortLabel: "medium", plannedEffortStimulus: "volume" },
      { exercise: "pullUp", sets: 3, targetReps: 5, targetSeconds: 0, plannedEffortLabel: "hard", plannedEffortStimulus: "strength" }
    ]
  });
  req.trainingLogs.push(trainingLog("2026-11-11T17:00:00Z", { sessionId: "mixed", loggedPullUps: false, loggedPushUps: true, loggedPlankSeconds: false, pushUps: 24, rpe: 8 }));
  const context = buildCoachContext(req, NOW_NOV_13);

  assert.equal(context.plannedWork.recentGoalPerformance?.pushUps.clean, false, "RPE 8 against the push-ups' own medium (6)");
  assert.deepEqual(context.readiness.calibration?.metrics, ["pushUps"], "the same session does not end the hold");
});

// Code review I3, corrected by the coordinator (the athlete's core rule):
// doing clearly more than planned ends a calibration hold on ANY session,
// light or technique work included ("if I do more than the plan, I want
// more"), and the re-based band applies. Only the as-planned route needs
// working sets: a light technique session merely done as planned does not.
const ABOVE_PLAN_24 = (day: string): LadderDay => ({ day, planned: 24, label: "medium", stimulus: "volume", delivered: 24, rpe: 8, plannedRPE: 6 });

test("clearly more than planned on a light day ends a calibration hold, and the re-based band applies", () => {
  const lightDay: LadderDay = { day: "2026-11-11", planned: 10, label: "light", stimulus: "technique", delivered: 38, rpe: 7 };
  const context = buildCoachContext(ladderRequest([ABOVE_PLAN_24("2026-11-04"), ABOVE_PLAN_24("2026-11-07"), lightDay]), NOW_NOV_13);
  const push = strengthProgressionPlan(context).pushUps;

  assert.equal(context.readiness.calibration, undefined);
  assert.equal(push.status, "earned");
  assert.deepEqual(push.target, { min: 25, max: 30 }, "from the working 24 up to the cap, not the 22-24 hold");
});

test("a light technique session merely done as planned does not end a calibration hold; working sets do", () => {
  const lightAsPlanned: LadderDay = { day: "2026-11-11", planned: 10, sets: 2, label: "light", stimulus: "technique", delivered: 10, rpe: 3 };
  const workingAsPlanned: LadderDay = { day: "2026-11-11", planned: 24, label: "medium", stimulus: "volume", delivered: 24, rpe: 6 };

  const afterLight = buildCoachContext(ladderRequest([ABOVE_PLAN_24("2026-11-04"), ABOVE_PLAN_24("2026-11-07"), lightAsPlanned]), NOW_NOV_13);
  assert.deepEqual(afterLight.readiness.calibration?.metrics, ["pushUps"]);
  const held = strengthProgressionPlan(afterLight).pushUps;
  assert.equal(held.status === "hold" && held.reason, "calibration");
  const afterWork = buildCoachContext(ladderRequest([ABOVE_PLAN_24("2026-11-04"), ABOVE_PLAN_24("2026-11-07"), workingAsPlanned]), NOW_NOV_13);
  assert.equal(afterWork.readiness.calibration, undefined, "working sets done as planned end it");
});

// Spec review (probe1 f): the overreaching co-signal "a shortfall on a target
// completed cleanly before" counts only a clean working-set completion matched
// to a prescription at or above that target, never a test's max set.
test("a shortfall counts as a performance drop only against a working target completed cleanly before", () => {
  const above = (day: string): LadderDay => ({ day, planned: 24, label: "medium", delivered: 24, rpe: 8 });
  const short = { day: "2026-11-10", planned: 24, label: "medium" as const, delivered: 23, rpe: 8 };
  const state = (earlier: LadderDay) => buildCoachContext(ladderRequest([earlier, above("2026-11-06"), short]), NOW_NOV_13).readiness.state;

  assert.equal(state({ day: "2026-10-24", planned: 40, label: "max_output", stimulus: "test", delivered: 42, rpe: 10 }), "building", "a test's max set is no working completion");
  assert.equal(state({ day: "2026-10-31", planned: 22, delivered: 24, rpe: 7 }), "building", "24 reps against 22 planned is not a 24 target completed");
  assert.equal(state({ day: "2026-10-31", planned: 24, delivered: 24, rpe: 7 }), "overreaching", "24 planned and done cleanly");
});

// Code review C1 (probe G): the race-taper rules hold whatever the readiness.
// Overreaching with the race in 5 days: very_hard work 2 days out is lowered
// (or sent back), and goal work keeps at most 3 sets.
test("overreaching in the race taper still keeps the taper rules", () => {
  const sixSets = (day: string, label: EffortLabel, rpe: number): LadderDay => ({ day, planned: 24, sets: 6, label, delivered: 24, rpe });
  const raceIn5Days: Partial<CoachRequest> = {
    running: {
      raceGoal: { name: "Autumn 30K", raceDate: "2026-11-17T23:00:00Z", distanceKm: 30, elevationGainM: 500 },
      baselineWeeklyKm: 40, longestRecentRunKm: 18, runningDays: [], runningDayOffsets: [], recentRuns: []
    }
  };
  const context = buildCoachContext(ladderRequest([
    sixSets("2026-11-01", "hard", 7), sixSets("2026-11-04", "medium", 8), sixSets("2026-11-07", "medium", 8), sixSets("2026-11-10", "medium", 8)
  ], raceIn5Days), NOW_NOV_13);
  const veryHard = { label: "very_hard" as const, targetRPE: 9, targetRIR: 1, stimulus: "strength" as const, reason: "Near max." };
  const plan = { ...pushOnlyPlan(24, 5), contextState: "overreaching" } as WeeklyPlan;
  plan.sessions[0] = { ...plan.sessions[0], dayOffset: 3, plannedEffort: veryHard, exercises: [{ ...plan.sessions[0].exercises[0], sets: 5, reps: 24, plannedEffort: veryHard }] };

  assert.equal(context.readiness.state, "overreaching");
  assert.equal(strengthProgressionPlan(context).pushUps.maxSets, 3, "the taper's 3 sets per goal exercise");
  const messages = validateWeeklyPlan(plan, context).messages;
  assert.ok(messages.some((m) => m.includes("nothing hard within 4 days of the race")), messages.join("\n"));
  const clamped = clampWeeklyPlan(plan, context).plan.sessions[0];
  assert.equal(clamped.exercises[0].plannedEffort.label, "medium");
  assert.ok(clamped.exercises[0].sets <= 3);
  assert.deepEqual(validateWeeklyPlan(clampWeeklyPlan(plan, context).plan, context), { accepted: true, messages: [] });
});
