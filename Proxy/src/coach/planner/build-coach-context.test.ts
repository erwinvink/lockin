import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import { evaluateCoachRead } from "./evaluate-coach-read";
import type { CoachRequest, RunningRequest, RunSummary, TrainingLog } from "./types";

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

test("keeps a real volume increase as a watch flag and overreaches on repeated excessive effort", () => {
  const mayLogs = Array.from({ length: 10 }, (_, index) => trainingLog(`2026-05-${String(1 + index).padStart(2, "0")}T10:00:00Z`));
  const juneLogs = Array.from({ length: 16 }, (_, index) => trainingLog(`2026-06-${String(1 + index).padStart(2, "0")}T10:00:00Z`, {
    plannedRPE: index >= 14 ? 5 : 7,
    rpe: index >= 14 ? 8 : 7
  }));

  const context = buildCoachContext(baseRequest({ trainingLogs: [...mayLogs, ...juneLogs] }), new Date("2026-07-13T12:00:00Z"));

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

test("flags repeated actual effort above plan as overreaching", () => {
  const request = baseRequest({
    trainingLogs: [
      trainingLog("2026-05-04T10:00:00Z", { rpe: 8, plannedRPE: 5 }),
      trainingLog("2026-05-11T10:00:00Z", { rpe: 8, plannedRPE: 5 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  assert.equal(context.readiness.state, "overreaching");
  assert.ok(context.readiness.riskFlags.includes("recent_effort_above_plan"));
  assert.equal(context.history.rpeCalibration.averageDeltaLast5, 3);
  assert.equal(context.history.rpeCalibration.abovePlanBy2Count, 2);
});

test("carries running request through with computed weeksToRace", () => {
  const running = runningRequest({ longRunDayOffset: 5 });
  const request = baseRequest({ running });

  const context = buildCoachContext(request, new Date("2026-05-27T12:00:00Z"));

  // weekStart 2026-05-25 to raceDate 2026-08-03 is exactly 70 days -> 10 weeks.
  assert.deepEqual(context.running, { ...running, weeksToRace: 10 });
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
test("a log without planned RPE is judged against a default planned RPE of 7", () => {
  const request = (rpe: number) => baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-legacy", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-legacy", pushUps: 19, loggedPullUps: false, loggedPlankSeconds: false, rpe
    })]
  });

  const atEight = buildCoachContext(request(8), new Date("2026-07-13T12:00:00Z"));
  const atNine = buildCoachContext(request(9), new Date("2026-07-13T12:00:00Z"));

  assert.equal(atEight.plannedWork.recentGoalPerformance?.pushUps.clean, true);
  assert.equal(atEight.plannedWork.recentGoalPerformance?.pushUps.delta, 2);
  assert.equal(atNine.plannedWork.recentGoalPerformance?.pushUps.clean, false);
  // The calibration summary still only uses real planned RPE values.
  assert.equal(atEight.history.rpeCalibration.recentPlannedLogCount, 0);
});

test("a missing planned RPE uses the logged planned effort label when there is one", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    plannedSessions: [plannedGoalSession("push-medium", "2026-07-10T08:00:00Z", "completed", "pushUp", 3, 17)],
    trainingLogs: [trainingLog("2026-07-10T09:00:00Z", {
      sessionId: "push-medium", pushUps: 19, loggedPullUps: false, loggedPlankSeconds: false, rpe: 8, plannedEffortLabel: "medium"
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

test("lower bests in the last three weeks than the three before read as declining", () => {
  const request = baseRequest({
    weekStart: "2026-07-13T00:00:00Z",
    trainingLogs: [
      trainingLog("2026-06-05T10:00:00Z", { pullUps: 10, pushUps: 35 }),
      trainingLog("2026-06-12T10:00:00Z", { pullUps: 10, pushUps: 36 }),
      trainingLog("2026-06-19T10:00:00Z", { pullUps: 9, pushUps: 34 }),
      trainingLog("2026-06-26T10:00:00Z", { pullUps: 8, pushUps: 30 }),
      trainingLog("2026-07-03T10:00:00Z", { pullUps: 8, pushUps: 31 }),
      trainingLog("2026-07-10T10:00:00Z", { pullUps: 7, pushUps: 30 })
    ]
  });

  const context = buildCoachContext(request, new Date("2026-07-13T08:00:00Z"));

  assert.equal(context.history.rollingTrend?.label, "declining");
  assert.equal(context.history.rollingTrend?.pullUpsDelta, -2);
  assert.equal(context.readiness.state, "overreaching");
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
