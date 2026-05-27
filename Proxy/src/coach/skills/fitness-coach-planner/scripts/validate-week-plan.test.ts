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
    equipment: ["pullUpBar", "yogaMat"],
    targetDate: "2027-05-11T00:00:00Z"
  },
  history: {
    last5Logs: [],
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
  readiness: { state: "insufficient_history", riskFlags: [] }
};

test("accepts a balanced four-session plan with mixed exposure", () => {
  const result = validateWeeklyPlan(balancedPlan(), baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("accepts coach-policy decisions when the technical shape is valid", () => {
  const plan = balancedPlan();
  plan.sessions = plan.sessions.map((session, index) => ({
    ...session,
    title: `Pull only ${index + 1}`,
    focus: "pull",
    loggingFieldsRequired: ["pullUps"],
    exercises: [
      { exercise: "pullUp", sets: 12, reps: 25, seconds: 0, restSeconds: 120, intensity: "Max" },
      { exercise: "deadHang", sets: 2, reps: 0, seconds: 20, restSeconds: 60, intensity: "Support" }
    ]
  }));

  const result = validateWeeklyPlan(plan, baseContext);

  assert.deepEqual(result, { accepted: true, messages: [] });
});

test("rejects invalid or unordered day offsets", () => {
  const plan = balancedPlan();
  plan.sessions[2] = { ...plan.sessions[2], dayOffset: 1 };

  const result = validateWeeklyPlan(plan, baseContext);

  assert.equal(result.accepted, false);
  assert.ok(result.messages.some((message) => message.includes("strictly later")));
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
      mixedSession("Full-body base", 0),
      {
        title: "Pull emphasis",
        dayOffset: 2,
        focus: "pull",
        purpose: "Build strict pull-up capacity with core support.",
        estimatedDurationMinutes: 35,
        progressionRationale: "Pull volume stays below the strict cap.",
        safetyNotes: ["Stop before form breaks."],
        loggingFieldsRequired: ["pullUps", "plankSeconds"],
        exercises: [
          { exercise: "pullUp", sets: 4, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate" },
          { exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Support" }
        ]
      },
      mixedSession("Full-body practice", 4),
      {
        title: "Core and push support",
        dayOffset: 6,
        focus: "core",
        purpose: "Keep trunk endurance moving while adding light push support.",
        estimatedDurationMinutes: 30,
        progressionRationale: "Core work is submaximal and supported by easy push volume.",
        safetyNotes: ["Keep breathing steady."],
        loggingFieldsRequired: ["pushUps", "plankSeconds"],
        exercises: [
          { exercise: "plank", sets: 4, reps: 0, seconds: 30, restSeconds: 90, intensity: "Moderate" },
          { exercise: "pushUp", sets: 3, reps: 8, seconds: 0, restSeconds: 75, intensity: "Support" }
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
    estimatedDurationMinutes: 40,
    progressionRationale: "All goal movements stay below current working caps.",
    safetyNotes: ["Leave clean reps in reserve."],
    loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
    exercises: [
      { exercise: "pullUp", sets: 3, reps: 3, seconds: 0, restSeconds: 120, intensity: "Moderate" },
      { exercise: "pushUp", sets: 3, reps: 10, seconds: 0, restSeconds: 90, intensity: "Moderate" },
      { exercise: "plank", sets: 3, reps: 0, seconds: 30, restSeconds: 75, intensity: "Moderate" }
    ]
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
