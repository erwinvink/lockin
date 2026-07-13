import assert from "node:assert/strict";
import test from "node:test";
import {
  COACH_CHAT_MAX_MESSAGES,
  COACH_CHAT_MAX_TEXT_LENGTH,
  buildCoachChatResponse,
  normalizeCoachChatMessages,
  type CoachChatMessage
} from "./chat";
import type { CoachContext } from "./planner/types";
import type { TrainingSignals } from "./planner/compute-training-signals";
import type { CoachEvaluation, CoachSnapshot } from "./planner/types";

const NOW = new Date("2026-06-28T12:00:00Z");

test("answers five connected coach questions with conversation memory and training evidence", () => {
  const messages: CoachChatMessage[] = [];
  const questions = [
    "Am I working well?",
    "Am I on schedule for the Eiger Ultra?",
    "What is my biggest improvement point?",
    "What can you say about fatigue?",
    "What about shoulder pain?"
  ];
  const answers: string[] = [];

  for (const question of questions) {
    messages.push({ role: "user", text: question });
    const response = buildCoachChatResponse({
      messages,
      context: context(),
      signals: signals(),
      evaluation: evaluation(),
      generatedAt: NOW
    });
    messages.push({ role: "coach", text: response.answer });
    answers.push(response.answer);

    assert.ok(response.evidence.some((item) => item.includes("Adherence is 86%")));
    assert.ok(response.evidence.some((item) => item.includes("Eiger Ultra 51K")));
  }

  assert.match(answers[0], /working well/i);
  assert.match(answers[1], /Earlier you asked about whether your work is on track/i);
  assert.match(answers[2], /Earlier you asked about whether your work is on track and your long-term schedule/i);
  assert.match(answers[3], /long-term schedule, and your biggest improvement point/i);
  assert.match(answers[4], /Earlier you asked about your long-term schedule, your biggest improvement point, and fatigue/i);
  assert.match(answers[4], /recent pain up to 4\/10/i);
  assert.match(answers[4], /Keep shoulders warm/i);
});

test("normalizes coach chat messages to a bounded recent transcript", () => {
  const messages: CoachChatMessage[] = Array.from({ length: COACH_CHAT_MAX_MESSAGES + 3 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "coach",
    text: ` turn ${index} `,
    createdAt: `2026-06-28T12:${String(index).padStart(2, "0")}:00Z`
  }));

  const normalized = normalizeCoachChatMessages(messages);

  assert.equal(normalized.length, COACH_CHAT_MAX_MESSAGES);
  assert.equal(normalized[0].text, "turn 3");
  assert.equal(normalized.at(-1)?.text, `turn ${COACH_CHAT_MAX_MESSAGES + 2}`);
});

test("rejects empty or oversized coach chat transcripts before answering", () => {
  assert.throws(
    () => normalizeCoachChatMessages([{ role: "coach", text: "What do you need?" }]),
    /at least one user chat message/i
  );
  assert.throws(
    () => normalizeCoachChatMessages([{ role: "user", text: "x".repeat(COACH_CHAT_MAX_TEXT_LENGTH + 1) }]),
    /characters or less/i
  );
});

test("answers unsupported weather or test prompts without repeating training state", () => {
  const response = buildCoachChatResponse({
    messages: [
      { role: "user", text: "Test" },
      { role: "coach", text: "The clean read is: watch." },
      { role: "user", text: "Ok new question, what's the weather today?" }
    ],
    context: context(),
    signals: signals(),
    evaluation: evaluation(),
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "unsupported");
  assert.equal(response.memorySummary, "");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /do not have live weather/i);
  assert.doesNotMatch(response.answer, /For today, follow the current plan/i);
  assert.doesNotMatch(response.answer, /The clean read is/i);
});

test("answers motivation requests like a coach instead of a metrics panel", () => {
  const response = buildCoachChatResponse({
    messages: [
      { role: "user", text: "How am I doing?" },
      { role: "coach", text: "The clean read is: on track." },
      { role: "user", text: "Can you motivate me?" }
    ],
    context: context(),
    signals: signals(),
    evaluation: evaluation(),
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "motivation");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /Keep going/i);
  assert.match(response.answer, /showing up/i);
  assert.match(response.answer, /one more honest/i);
  assert.doesNotMatch(response.answer, /The clean read is/i);
  assert.doesNotMatch(response.answer, /Readiness is/i);
  assert.doesNotMatch(response.answer, /Latest strength log/i);
});

test("keeps recovery motivation human instead of leaking dashboard status labels", () => {
  const recovering = evaluation();
  recovering.status = "needs_recovery";
  recovering.statusLabel = "Needs recovery";
  recovering.readiness.state = "recovery_needed";
  recovering.progress.state = "declining";

  const response = buildCoachChatResponse({
    messages: [{ role: "user", text: "Can you motivate me?" }],
    context: context(),
    signals: signals(),
    evaluation: recovering,
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "motivation");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /not where we want it yet/i);
  assert.match(response.answer, /holding back a little/i);
  assert.doesNotMatch(response.answer, /Needs recovery does not mean perfect/i);
  assert.doesNotMatch(response.answer, /Readiness is/i);
});

test("does not suggest extra work when no session is planned today", () => {
  const noTodayContext = context();
  noTodayContext.plannedWork.todaySessions = [];
  const noTodayEvaluation = evaluation();
  noTodayEvaluation.nextAction = "Rest today and be ready for the next planned session.";

  const response = buildCoachChatResponse({
    messages: [{ role: "user", text: "What should I do today?" }],
    context: noTodayContext,
    signals: signals(),
    evaluation: noTodayEvaluation,
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "today");
  assert.match(response.answer, /do not add extra work/i);
  assert.match(response.answer, /I do not see a planned session today/i);
  assert.doesNotMatch(response.answer, /follow the current plan/i);
});

function context(): CoachContext {
  return {
    profile: {
      baseline: { pullUps: 5, pushUps: 20, plankSeconds: 60 },
      goals: { pullUps: 50, pushUps: 100, plankSeconds: 300 },
      profileNotes: "Keep shoulders warm before pull work.",
      weekStart: "2026-06-28T00:00:00Z",
      weeklySessions: 4,
      trainingDays: ["monday", "wednesday", "friday", "saturday"],
      trainingDayOffsets: [1, 3, 5, 6],
      equipment: ["pullUpBar"],
      targetDate: "2027-06-28T00:00:00Z"
    },
    history: {
      last5Logs: [
        log("2026-06-17T19:00:00Z", { painLevel: 0, fatigueLevel: 6, pullUps: 5, pushUps: 22, plankSeconds: 72 }),
        log("2026-06-21T19:00:00Z", { painLevel: 4, fatigueLevel: 8, pullUps: 6, pushUps: 22, plankSeconds: 72 }),
        log("2026-06-23T19:00:00Z", { painLevel: 0, fatigueLevel: 5, pullUps: 7, pushUps: 24, plankSeconds: 78 }),
        log("2026-06-24T19:00:00Z", { painLevel: 0, fatigueLevel: 5, pullUps: 7, pushUps: 26, plankSeconds: 88 }),
        log("2026-06-26T19:00:00Z", { painLevel: 0, fatigueLevel: 6, pullUps: 8, pushUps: 28, plankSeconds: 95 })
      ],
      rpeCalibration: {
        recentPlannedLogCount: 5,
        averageDeltaLast5: 1,
        abovePlanBy2Count: 1,
        belowPlanBy2Count: 0,
        latestSummary: "RPE - Planned 6 | Actual 8"
      },
      currentPartialMonth: month("2026-06", true),
      lastFullMonth: month("2026-05", false),
      previousFullMonth: month("2026-04", false),
      twoFullMonthTrend: {
        pullUpsDelta: 3,
        pushUpsDelta: 8,
        plankSecondsDelta: 35,
        logCountDelta: 2,
        label: "improving"
      },
      bestRecentTests: { pullUps: 8, pushUps: 28, plankSeconds: 95 }
    },
    adherence: {
      planned: 9,
      due: 7,
      future: 2,
      completed: 6,
      partial: 0,
      missed: 1,
      deload: 0,
      pending: 0,
      adherenceScorePct: 86
    },
    plannedWork: {
      todaySessions: [{ id: "today", title: "Today Simulation", status: "planned", focus: "mixed", scheduledDate: "2026-06-28T09:00:00Z" }],
      recentGoalTargets: {
        pullUps: { latestTarget: 7, latestVolume: 21, flatCount: 1, latestDate: "2026-06-26T09:00:00Z" },
        pushUps: { latestTarget: 24, latestVolume: 72, flatCount: 1, latestDate: "2026-06-26T09:00:00Z" },
        plankSeconds: { latestTarget: 95, latestVolume: 285, flatCount: 1, latestDate: "2026-06-26T09:00:00Z" }
      }
    },
    readiness: {
      state: "building",
      riskFlags: ["recent_pain_level_4_or_higher"]
    },
    running: {
      raceGoal: { name: "Eiger Ultra 51K", raceDate: "2026-10-04T00:00:00Z", distanceKm: 51, elevationGainM: 3100 },
      baselineWeeklyKm: 35,
      longestRecentRunKm: 16.4,
      runningDays: ["tuesday", "thursday", "saturday"],
      runningDayOffsets: [2, 4, 6],
      longRunDay: "saturday",
      longRunDayOffset: 6,
      recentRuns: [],
      weeksToRace: 14
    }
  };
}

function signals(): TrainingSignals {
  return {
    running: {
      last7DaysKm: 24.6,
      prior7DaysKm: 8.2,
      fourWeekAvgKm: 18,
      volumeVsFourWeekPct: 37,
      last7DaysAscentM: 540,
      last7DaysDescentM: 0,
      longestRunLast6WeeksKm: 16.4,
      recentLongRunsKm: [16.4],
      easyShareLast4Weeks: 0.67,
      runCountLast7Days: 2
    },
    race: { daysToRace: 98, weeksToRace: 14, taperStatus: "training" },
    wellness: { latestDate: "2026-06-27", hrvStatus: "BALANCED", hrvGate: "ok-for-hard", sleepScore: 82, trainingReadiness: 74, restingHr: 47 },
    lastRun: { completedAt: "2026-06-26T10:00:00Z", distanceKm: 16.4, paceSecPerKm: 395, elevationGainM: 420, averageHr: 149, rpe: 6, feelScore: 4, kind: "long" }
  };
}

function evaluation(): CoachEvaluation & { snapshot: CoachSnapshot } {
  return {
    status: "on_track",
    statusLabel: "On track",
    adherence: {
      standardPct: 80,
      band: "on_track",
      completedPct: 86,
      dueSessions: 7,
      completedSessions: 6,
      partialSessions: 0,
      deloadSessions: 0,
      missedSessions: 1,
      futureSessionsExcluded: 2,
      rationale: "86% meets the 80% adherence standard. 2 future sessions excluded."
    },
    readiness: {
      state: "building",
      painOrFatigueFlag: false,
      hrvGate: "ok-for-hard",
      trainingReadiness: 74,
      riskFlags: ["recent_pain_level_4_or_higher"],
      rationale: "No current readiness gate is blocking normal work."
    },
    progress: {
      state: "improving",
      trendLabel: "improving",
      flatGoalMetrics: [],
      rationale: "Recent pull-up, push-up, and plank numbers are improving."
    },
    planDecision: {
      action: "keep_plan",
      shouldUpdatePlan: false,
      rationale: "The current plan is still the right structure; execution is the lever."
    },
    nextAction: "Complete the next planned session as written and log the result.",
    snapshot: {
      version: 1,
      generatedAt: NOW.toISOString(),
      status: "on_track",
      statusLabel: "On track",
      adherencePct: 86,
      readinessState: "building",
      planDecision: "keep_plan",
      shouldUpdatePlan: false,
      nextAction: "Complete the next planned session as written and log the result.",
      facts: ["Adherence 86%", "Readiness building"]
    }
  };
}

function log(
  completedAt: string,
  options: { pullUps: number; pushUps: number; plankSeconds: number; painLevel: number; fatigueLevel: number }
): CoachContext["history"]["last5Logs"][number] {
  return {
    id: completedAt,
    sessionId: completedAt,
    completedAt,
    pullUps: options.pullUps,
    pushUps: options.pushUps,
    plankSeconds: options.plankSeconds,
    loggedPullUps: true,
    loggedPushUps: true,
    loggedPlankSeconds: true,
    rpe: 8,
    painLevel: options.painLevel,
    fatigueLevel: options.fatigueLevel,
    perceivedEffort: 8,
    plannedRPE: 6,
    actualRPE: 8,
    rpeDelta: 2,
    rpeSummary: "RPE - Planned 6 | Actual 8",
    plannedEffortLabel: "medium",
    plannedEffortReason: "Repeatable work.",
    howYouFeltScore: 3,
    howYouFelt: "normal",
    notes: ""
  };
}

function month(monthName: string, isPartial: boolean): CoachContext["history"]["currentPartialMonth"] {
  return {
    month: monthName,
    isPartial,
    logCount: 5,
    pullUps: { count: 5, best: 8, latest: 8 },
    pushUps: { count: 5, best: 28, latest: 28 },
    plankSeconds: { count: 5, best: 95, latest: 95 },
    averageRPE: 7,
    averagePerceivedEffort: 7,
    maxPain: 4,
    maxFatigue: 8,
    worstHowYouFelt: "normal"
  };
}
