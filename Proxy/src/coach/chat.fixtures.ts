import type { TrainingSignals } from "./planner/compute-training-signals";
import type { CoachContext, CoachEvaluation, CoachRequest, CoachSnapshot } from "./planner/types";

// Shared coach-chat test data: an athlete four sessions into a strength block
// with an ultra 14 weeks out, a shoulder note, and a 4/10 pain log.

export const NOW = new Date("2026-06-28T12:00:00Z");

export function context(): CoachContext {
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
      recentRuns: [
        { completedAt: "2026-06-23T07:30:00Z", distanceKm: 8.2, movingSeconds: 2952, elevationGainM: 120, averageHr: 141, rpe: 4, kind: "easy" },
        { completedAt: "2026-06-26T10:00:00Z", distanceKm: 16.4, movingSeconds: 6478, elevationGainM: 420, elevationLossM: 410, averageHr: 149, rpe: 6, feelScore: 4, kind: "long" }
      ],
      weeksToRace: 14
    },
    garmin: {
      wellness: [
        { date: "2026-06-26", sleepScore: 71, sleepSeconds: 24_480, hrvStatus: "BALANCED", hrvMs: 58, bodyBattery: 62, trainingReadiness: 66, restingHr: 48 },
        { date: "2026-06-27", sleepScore: 82, sleepSeconds: 27_000, hrvStatus: "BALANCED", hrvMs: 61, bodyBattery: 78, trainingReadiness: 74, restingHr: 47 }
      ]
    }
  };
}

/** The app's request behind context(): planned sessions with prescriptions and the athlete's zone. */
export function chatRequest(): CoachRequest {
  const goalWork = [
    { exercise: "pullUp" as const, sets: 3, targetReps: 7, targetSeconds: 0, plannedEffortLabel: "hard" as const },
    { exercise: "pushUp" as const, sets: 3, targetReps: 24, targetSeconds: 0, plannedEffortLabel: "medium" as const },
    { exercise: "plank" as const, sets: 3, targetReps: 0, targetSeconds: 95, plannedEffortLabel: "medium" as const }
  ];
  const base = context();
  return {
    userId: "athlete-1",
    model: "gpt-6.1-sol",
    timeZone: "UTC",
    baseline: base.profile.baseline,
    goals: base.profile.goals,
    profileNotes: base.profile.profileNotes,
    weekStart: base.profile.weekStart,
    weeklySessions: 4,
    trainingDays: base.profile.trainingDays,
    trainingDayOffsets: base.profile.trainingDayOffsets,
    equipment: base.profile.equipment,
    targetDate: base.profile.targetDate,
    trainingLogs: base.history.last5Logs,
    plannedSessions: [
      ...base.history.last5Logs.map((log) => ({
        id: log.sessionId,
        scheduledDate: log.completedAt.replace(/T.*/, "T00:00:00Z"),
        title: "Pull and core",
        focus: "pull" as const,
        status: "completed",
        exercises: goalWork
      })),
      {
        id: "today",
        scheduledDate: "2026-06-28T09:00:00Z",
        title: "Today Simulation",
        focus: "mixed",
        status: "planned",
        exercises: [{ exercise: "pullUp", sets: 3, targetReps: 8, targetSeconds: 0, plannedEffortLabel: "medium" }]
      },
      { id: "tempo", scheduledDate: "2026-06-30T00:00:00Z", title: "Tempo run 8 km", focus: "mixed", status: "planned", exercises: [] },
      {
        id: "push",
        scheduledDate: "2026-07-01T00:00:00Z",
        title: "Push strength",
        focus: "push",
        status: "planned",
        exercises: [{ exercise: "pushUp", sets: 4, targetReps: 26, targetSeconds: 0, plannedEffortLabel: "hard" }]
      }
    ],
    running: {
      raceGoal: base.running!.raceGoal,
      baselineWeeklyKm: base.running!.baselineWeeklyKm,
      longestRecentRunKm: base.running!.longestRecentRunKm,
      runningDays: base.running!.runningDays,
      runningDayOffsets: base.running!.runningDayOffsets,
      longRunDay: base.running!.longRunDay,
      longRunDayOffset: base.running!.longRunDayOffset,
      recentRuns: base.running!.recentRuns
    }
  };
}

export function signals(): TrainingSignals {
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
      lowIntensityTimeShareLast4Weeks: 0.82,
      runCountLast7Days: 2
    },
    race: { daysToRace: 98, weeksToRace: 14, taperStatus: "training" },
    wellness: { latestDate: "2026-06-27", hrvStatus: "BALANCED", hrvGate: "ok-for-hard", sleepScore: 82, trainingReadiness: 74, restingHr: 47 },
    lastRun: { completedAt: "2026-06-26T10:00:00Z", distanceKm: 16.4, paceSecPerKm: 395, elevationGainM: 420, averageHr: 149, rpe: 6, feelScore: 4, kind: "long" }
  };
}

export function evaluation(): CoachEvaluation & { snapshot: CoachSnapshot } {
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
