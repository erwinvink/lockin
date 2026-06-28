import assert from "node:assert/strict";
import test from "node:test";
import { validateWeeklyPlan } from "./validate-week-plan";
import type { CoachContext, WeeklyPlan } from "./types";

const baseContext: CoachContext = {
  profile: {
    baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
    goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: "2026-05-11T00:00:00Z",
    weeklySessions: 4,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar", "yogaMat"],
    targetDate: "2027-05-11T00:00:00Z"
  },
  history: {
    last5Logs: [],
    rpeCalibration: {
      recentPlannedLogCount: 0,
      averageDeltaLast5: null,
      abovePlanBy2Count: 0,
      belowPlanBy2Count: 0,
      latestSummary: null
    },
    currentPartialMonth: emptyMonth("2026-05", true),
    lastFullMonth: emptyMonth("2026-04", false),
    previousFullMonth: emptyMonth("2026-03", false),
    twoFullMonthTrend: {
      pullUpsDelta: null,
      pushUpsDelta: null,
      plankSecondsDelta: null,
      logCountDelta: 0,
      label: "insufficient_history"
    },
    bestRecentTests: { pullUps: 5, pushUps: 20, plankSeconds: 60 }
  },
  adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
  plannedWork: {
    recentGoalTargets: {
      pullUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
      pushUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
      plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
    }
  },
  readiness: { state: "insufficient_history", riskFlags: [] }
};

test("accepts a balanced four-session plan with mixed exposure", () => {
  const result = validateWeeklyPlan(balancedPlan(), baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects strength sessions with running titles", () => {
  const plan = balancedPlan();
  plan.sessions[0] = { ...plan.sessions[0], title: "Easy Run" };

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("looks like a running session")));
});

test("rejects all-light normal weeks without safety explanation", () => {
  const plan = balancedPlan();
  plan.sessions = plan.sessions.map((session, index) => ({
    ...session,
    title: `Light only ${index + 1}`,
    plannedEffort: effort("light", 3, "technique", 6),
    exercises: session.exercises.map((exercise) => ({
      ...exercise,
      plannedEffort: effort("light", 3, "technique", 6)
    }))
  }));
  plan.contextState = "building";

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("cannot be all light")));
});

test("rejects hard goal work below the useful stimulus floor", () => {
  const plan = balancedPlan();
  plan.contextState = "building";
  const strongPushContext: CoachContext = {
    ...baseContext,
    history: {
      ...baseContext.history,
      bestRecentTests: { ...baseContext.history.bestRecentTests, pushUps: 40 }
    }
  };

  const result = validateWeeklyPlan(plan, strongPushContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("push-up goal work is below")));
});

test("rejects static pull and push prescriptions after clean flat recent work", () => {
  const plan = balancedPlan();
  const context: CoachContext = {
    ...baseContext,
    history: {
      ...baseContext.history,
      last5Logs: cleanRecentLogs(),
      rpeCalibration: {
        recentPlannedLogCount: 2,
        averageDeltaLast5: -1,
        abovePlanBy2Count: 0,
        belowPlanBy2Count: 1,
        latestSummary: "RPE - Planned 7 | Actual 6"
      }
    },
    adherence: { planned: 6, completed: 6, missed: 0, deload: 0 },
    plannedWork: {
      recentGoalTargets: {
        pullUps: { latestTarget: 3, latestVolume: 12, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        pushUps: { latestTarget: 10, latestVolume: 30, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      }
    }
  };

  const result = validateWeeklyPlan(plan, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("pull-up work repeats")));
  assert.ok(result.messages.some((message) => message.includes("push-up work repeats")));
});

test("accepts flat recent targets when the new plan progresses volume", () => {
  const plan = balancedPlan();
  plan.sessions[1].exercises[0] = { ...plan.sessions[1].exercises[0], reps: 4 };
  plan.sessions[0].exercises[1] = { ...plan.sessions[0].exercises[1], sets: 4 };
  const context: CoachContext = {
    ...baseContext,
    history: {
      ...baseContext.history,
      last5Logs: cleanRecentLogs()
    },
    adherence: { planned: 6, completed: 6, missed: 0, deload: 0 },
    plannedWork: {
      recentGoalTargets: {
        pullUps: { latestTarget: 3, latestVolume: 12, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        pushUps: { latestTarget: 10, latestVolume: 30, flatCount: 3, latestDate: "2026-05-08T00:00:00Z" },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      }
    }
  };

  const result = validateWeeklyPlan(plan, context);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects max output unless it is a test", () => {
  const plan = balancedPlan();
  plan.sessions[0].plannedEffort = effort("max_output", 10, "strength", 0);

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("max_output effort is only allowed")));
});

test("rejects invalid or unordered day offsets", () => {
  const plan = balancedPlan();
  plan.sessions[2] = { ...plan.sessions[2], dayOffset: 1 };

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("strictly later")));
});

test("rejects a plan that creates a new session for today", () => {
  const plan = balancedPlan();
  plan.sessions[0] = { ...plan.sessions[0], dayOffset: 0 };

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("dayOffset 0 is today")));
});

test("rejects sessions outside selected future training day offsets", () => {
  const plan = balancedPlan();
  const context: CoachContext = {
    ...baseContext,
    profile: {
      ...baseContext.profile,
      weeklySessions: 3,
      trainingDays: ["monday", "wednesday", "friday"],
      trainingDayOffsets: [1, 3, 5]
    }
  };
  plan.sessions = [
    mixedSession("Monday work", 1),
    mixedSession("Rest-day leak", 4),
    mixedSession("Friday work", 5)
  ];

  const result = validateWeeklyPlan(plan, context);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("selected future training days")));
});

test("rejects non-renderable exercise values", () => {
  const plan = balancedPlan();
  plan.sessions[0].exercises[0] = { ...plan.sessions[0].exercises[0], sets: 0, reps: -1 };

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("set count")));
  assert.ok(result.messages.some((message) => message.includes("invalid reps")));
});

function balancedPlan(): WeeklyPlan {
  return {
    summary: "Balanced AI week",
    contextState: "insufficient_history",
    safetyFlags: [],
    sessions: [
      mixedSession("Full-body base", 1),
      {
        title: "Pull emphasis",
        dayOffset: 3,
        focus: "pull",
        purpose: "Build strict pull-up capacity with core support.",
        plannedEffort: effort("hard", 7, "strength", 3),
        estimatedDurationMinutes: 35,
        progressionRationale: "Pull volume stays below the strict cap.",
        safetyNotes: ["Stop before form breaks."],
        loggingFieldsRequired: ["pullUps", "plankSeconds"],
        exercises: [
          { exercise: "pullUp", sets: 4, reps: 3, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: effort("hard", 7, "strength", 3) },
          { exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Medium", plannedEffort: effort("medium", 6, "volume", 4) }
        ]
      },
      mixedSession("Full-body practice", 5),
      {
        title: "Core and push support",
        dayOffset: 6,
        focus: "core",
        purpose: "Keep trunk endurance moving while adding light push support.",
        plannedEffort: effort("medium", 6, "volume", 4),
        estimatedDurationMinutes: 30,
        progressionRationale: "Core work is submaximal and supported by easy push volume.",
        safetyNotes: ["Keep breathing steady."],
        loggingFieldsRequired: ["pushUps", "plankSeconds"],
        exercises: [
          { exercise: "plank", sets: 4, reps: 0, seconds: 30, restSeconds: 90, intensity: "Medium", plannedEffort: effort("medium", 6, "volume", 4) },
          { exercise: "pushUp", sets: 3, reps: 8, seconds: 0, restSeconds: 75, intensity: "Light", plannedEffort: effort("light", 4, "technique", 5) }
        ]
      }
    ]
  };
}

function mixedSession(title: string, dayOffset: number): WeeklyPlan["sessions"][number] {
  return {
    title,
    dayOffset,
    focus: "mixed",
    purpose: "Train pull, push, and core without chasing failure.",
    plannedEffort: effort("hard", 7, "volume", 3),
    estimatedDurationMinutes: 40,
    progressionRationale: "All goal movements stay below current working caps.",
    safetyNotes: ["Leave clean reps in reserve."],
    loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
    exercises: [
      { exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: effort("hard", 7, "strength", 3) },
      { exercise: "pushUp", sets: 3, reps: 10, seconds: 0, restSeconds: 90, intensity: "Medium", plannedEffort: effort("medium", 6, "volume", 4) },
      { exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Medium", plannedEffort: effort("medium", 6, "volume", 4) }
    ]
  };
}

function effort(
  label: WeeklyPlan["sessions"][number]["plannedEffort"]["label"],
  targetRPE: number,
  stimulus: WeeklyPlan["sessions"][number]["plannedEffort"]["stimulus"],
  targetRIR: number
): WeeklyPlan["sessions"][number]["plannedEffort"] {
  return {
    label,
    targetRPE,
    targetRIR,
    stimulus,
    reason: `${label} ${stimulus} work`
  };
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

function cleanRecentLogs(): CoachContext["history"]["last5Logs"] {
  return [
    {
      id: "log-1",
      sessionId: "session-1",
      completedAt: "2026-05-05T00:00:00Z",
      pullUps: 5,
      pushUps: 20,
      plankSeconds: 60,
      loggedPullUps: true,
      loggedPushUps: true,
      loggedPlankSeconds: true,
      rpe: 6,
      painLevel: 0,
      fatigueLevel: 5,
      notes: ""
    },
    {
      id: "log-2",
      sessionId: "session-2",
      completedAt: "2026-05-08T00:00:00Z",
      pullUps: 5,
      pushUps: 20,
      plankSeconds: 60,
      loggedPullUps: true,
      loggedPushUps: true,
      loggedPlankSeconds: true,
      rpe: 6,
      painLevel: 0,
      fatigueLevel: 5,
      notes: ""
    }
  ];
}
