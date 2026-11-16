import type { CoachContext, RunKind, RunningContext, RunningWeek, RunSummary } from "./types";

/**
 * Shared running fixtures for the guardrail and floor tests: a hand-built
 * coach context (race 10 weeks out, Tuesday/Thursday/Saturday/Sunday running,
 * long run Saturday) and steady run histories ending the day before WEEK_START.
 */

// 2026-05-11 is a Monday; offsets 1-6 are Tuesday-Sunday.
export const WEEK_START = "2026-05-11T00:00:00Z";
export const DAY_MS = 24 * 60 * 60 * 1000;

export function lowHrvDay(date: string): NonNullable<CoachContext["garmin"]>["wellness"][number] {
  return { date, sleepScore: 72, sleepSeconds: 25000, hrvStatus: "LOW", hrvMs: 38, bodyBattery: 40, trainingReadiness: 35, restingHr: 52 };
}

export function withWellness(context: CoachContext, wellness: NonNullable<CoachContext["garmin"]>["wellness"]): CoachContext {
  return { ...context, garmin: { wellness } };
}

export function contextWith(overrides: Partial<RunningContext>): CoachContext {
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
      twoFullMonthTrend: { pullUpsDelta: null, pushUpsDelta: null, plankSecondsDelta: null, logCountDelta: 0, label: "insufficient_history" },
      bestRecentTests: { pullUps: 10, pushUps: 40, plankSeconds: 90 }
    },
    adherence: { planned: 0, completed: 0, missed: 0, deload: 0 },
    plannedWork: {
      todaySessions: [],
      recentGoalTargets: {
        pullUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        pushUps: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null },
        plankSeconds: { latestTarget: null, latestVolume: null, flatCount: 0, latestDate: null }
      }
    },
    readiness: { state: "building", riskFlags: [] },
    running: {
      raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-07-20T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
      baselineWeeklyKm: 45,
      longestRecentRunKm: 20,
      runningDays: ["tuesday", "thursday", "saturday", "sunday"],
      runningDayOffsets: [1, 3, 5, 6],
      longRunDay: "saturday",
      longRunDayOffset: 5,
      recentRuns: [],
      weeksToRace: 10,
      ...overrides
    }
  };
}

export function sixDayContext(overrides: Partial<RunningContext>): CoachContext {
  return contextWith({
    runningDays: ["tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
    runningDayOffsets: [1, 2, 3, 4, 5, 6],
    ...overrides
  });
}

/**
 * Weekly totals oldest first, ending the day before WEEK_START (or `weeksAgo`
 * weeks earlier). Each week: easy 18%, tempo 22%, long 44%, recovery 16%.
 */
export function steadyWeeks(weeklyKm: number[], weeksAgo = 0): RunSummary[] {
  const runs: RunSummary[] = [];
  weeklyKm.forEach((km, index) => {
    const weekEndDaysAgo = (weeklyKm.length - 1 - index + weeksAgo) * 7 + 1;
    const parts: Array<[number, number, string, number]> = [
      [6, 0.18, "easy", 140],
      [4, 0.22, "tempo", 160],
      [2, 0.44, "long", 145],
      [1, 0.16, "recovery", 132]
    ];
    for (const [dayInWeek, share, kind, hr] of parts) {
      const daysAgo = weekEndDaysAgo + dayInWeek - 1;
      const distanceKm = Math.round(km * share * 10) / 10;
      runs.push({ ...runSummary(daysAgo, distanceKm, kind), averageHr: hr, movingSeconds: Math.round(distanceKm * (kind === "tempo" ? 290 : 360)) });
    }
  });
  return runs.sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
}

export function runSummary(daysAgo: number, distanceKm: number, kind: string): RunSummary {
  return {
    completedAt: new Date(Date.parse(WEEK_START) - daysAgo * DAY_MS + 8 * 60 * 60 * 1000).toISOString(),
    distanceKm,
    movingSeconds: Math.round(distanceKm * 360),
    elevationGainM: 80,
    kind
  };
}

export function validFourRunWeek(): RunningWeek {
  return runningWeek([
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 22),
    run("Recovery jog", 6, "recovery", 6)
  ]);
}

export function runningWeek(sessions: RunningWeek["sessions"]): RunningWeek {
  return { summary: "Build week.", safetyFlags: [], sessions };
}

export function run(title: string, dayOffset: number, kind: RunKind, distanceKm: number): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Build durable aerobic capacity for the race.",
    distanceKm,
    durationMinutes: Math.round(distanceKm * 6),
    // Five runs (300 m) stay inside the weekly climbing cap of the fixture
    // histories (steady weeks climb 320 m: cap 400 m; at least 300 m).
    elevationMeters: 60,
    target: { type: "pace", low: 330, high: 380 },
    zone: "Zone 2",
    notes: ["Keep the effort conversational."]
  };
}

export function emptyMonth(month: string, isPartial: boolean): CoachContext["history"]["lastFullMonth"] {
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

// Planned recovery week: running backs off to 75% of the recent average,
// the long run to 70% of the recent longest, and one quality session at most.
export function recoveryContext(): CoachContext {
  const context = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]), longestRecentRunKm: 20 });
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
      referenceHardStrengthSets: 16,
      hardStrengthSetCap: 9,
      maxHardStrengthSessions: 1,
      maxGoalSetsPerExercise: 3
    },
    recentWeeks: []
  };
  return context;
}

// Taper, 12 days out: offsets 1-4 sit 11-8 days out (taper_2w), offsets 5-6
// 7-6 days out (race week). Seven steady 50 km weeks before.
export function taperContext(daysOut: number, runningDayOffsets = [1, 2, 4, 5]): CoachContext {
  const raceDate = new Date(Date.parse(WEEK_START) + daysOut * DAY_MS).toISOString();
  return contextWith({
    recentRuns: steadyWeeks([50, 50, 50, 50, 50, 50, 50]),
    longestRecentRunKm: 22,
    raceGoal: { name: "Trail 75K", raceDate, distanceKm: 75, elevationGainM: 3000 },
    weeksToRace: Math.ceil(daysOut / 7),
    runningDays: ["tuesday", "wednesday", "friday", "saturday"],
    runningDayOffsets,
    longRunDay: "saturday",
    longRunDayOffset: 5
  });
}

// The post-race window scales with the race (season.ts): 14 days after 54 km, 25 after 100 km.
export function postRaceContext(daysAfterRace: number, distanceKm: number, overrides: Partial<RunningContext> = {}): CoachContext {
  const raceDate = new Date(Date.parse(WEEK_START) - daysAfterRace * DAY_MS).toISOString();
  return contextWith({
    // Eleven steady weeks, so the four weeks before the taper are fully on record.
    recentRuns: steadyWeeks(Array(11).fill(50)),
    raceGoal: { name: `Trail ${distanceKm}K`, raceDate, distanceKm, elevationGainM: 3000 },
    weeksToRace: 0,
    ...overrides
  });
}

// The nightly plan covers offsets 1-6 (today is locked) while the floors are
// weekly: today's run counts toward them, done or still planned.
export function todayPlanned(kind: RunKind, distanceKm: number): NonNullable<CoachContext["todayPlannedRuns"]> {
  return [{ dayOffset: 0, title: `${kind} run`, kind, distanceKm, elevationMeters: 60, target: null }];
}
