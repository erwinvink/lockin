import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
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
    model: "gpt-5-mini",
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
