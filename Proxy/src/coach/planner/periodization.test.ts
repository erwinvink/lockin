import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./build-coach-context";
import { computePeriodization } from "./periodization";
import type { CoachRequest, PlannedSession, RunSummary, TrainingLog } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const BLOCK_START = "2026-07-06T00:00:00.000Z"; // a Monday

/** Local midnight of block day `day` (1-based) of block week `week`. */
function blockDay(week: number, day: number): string {
  return new Date(Date.parse(BLOCK_START) + ((week - 1) * 7 + (day - 1)) * DAY_MS).toISOString();
}

/** A week of four runs (easy, tempo, long, easy) totalling `km`; weeks <= 0 are before the block. */
function weekOfRuns(week: number, km: number): RunSummary[] {
  const parts: Array<[number, number, string]> = [
    [1, 0.2, "easy"],
    [3, 0.25, "tempo"],
    [5, 0.4, "long"],
    [6, 0.15, "easy"]
  ];
  return parts.map(([day, share, kind]) => ({
    completedAt: new Date(Date.parse(blockDay(week, day)) + 8 * 60 * 60 * 1000).toISOString(),
    distanceKm: Math.round(km * share * 10) / 10,
    movingSeconds: Math.round(km * share * 360),
    elevationGainM: 100,
    kind
  }));
}

function runsFor(weeklyKm: Record<number, number>): RunSummary[] {
  return Object.entries(weeklyKm).flatMap(([week, km]) => weekOfRuns(Number(week), km));
}

function request(options: {
  weekStart: string;
  weeklyKm?: Record<number, number>;
  raceDate?: string;
  planBlockStartedAt?: string | null;
  trainingLogs?: TrainingLog[];
  plannedSessions?: PlannedSession[];
  running?: boolean;
}): CoachRequest {
  return {
    model: "test-model",
    baseline: { pullUps: 8, pushUps: 30, plankSeconds: 90 },
    goals: { pullUps: 20, pushUps: 60, plankSeconds: 180 },
    profileNotes: "",
    weekStart: options.weekStart,
    weeklySessions: 3,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar"],
    targetDate: "2027-07-01T00:00:00Z",
    trainingLogs: options.trainingLogs ?? [],
    plannedSessions: options.plannedSessions ?? [],
    ...(options.planBlockStartedAt === null ? {} : { planBlockStartedAt: options.planBlockStartedAt ?? BLOCK_START }),
    running: options.running === false
      ? undefined
      : {
          raceGoal: { name: "Trail 75K", raceDate: options.raceDate ?? "2026-12-12T00:00:00Z", distanceKm: 75, elevationGainM: 3000 },
          baselineWeeklyKm: 40,
          longestRecentRunKm: 20,
          runningDays: [],
          runningDayOffsets: [],
          recentRuns: runsFor(options.weeklyKm ?? {})
        }
  };
}

function periodization(req: CoachRequest) {
  const now = new Date(Date.parse(req.weekStart) + 2 * 60 * 60 * 1000);
  const context = buildCoachContext(req, now);
  assert.ok(context.periodization);
  return context.periodization;
}

const STEADY = { [-3]: 40, [-2]: 40, [-1]: 40, 0: 40, 1: 42, 2: 45, 3: 48 };

test("three loading weeks since the block start make block week 4 a planned recovery week", () => {
  const result = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY }));

  assert.equal(result.blockWeek, 4);
  assert.equal(result.loadingWeeksSinceRecovery, 3);
  assert.equal(result.recoveryWeekDue, true);
  assert.match(result.recoveryWeekReason, /3 loading weeks since the block start: block week 4 is a planned recovery week/);
  assert.deepEqual(result.recentWeeks.map((week) => week.classification), ["loading", "loading", "loading"]);
  // The four block weeks before week 4 (weeks 0-3) average 43.75 km.
  assert.equal(result.recoveryWeek?.referenceWeeklyKm, 43.8);
  assert.equal(result.recoveryWeek?.weeklyKmCap, 32.9, "75% of 43.8 km");
  assert.deepEqual(result.recoveryWeek?.targetWeeklyKm, { low: 26.3, high: 32.9 });
  assert.equal(result.recoveryWeek?.longRunCapKm, 13.4, "70% of the 19.2 km long run");
  assert.equal(result.recoveryWeek?.maxQualityRuns, 1);
  assert.equal(result.recoveryWeek?.startsAt, BLOCK_START.replace("07-06", "07-27"));
});

test("two loading weeks are not enough yet", () => {
  const result = periodization(request({ weekStart: blockDay(3, 2), weeklyKm: STEADY }));

  assert.equal(result.loadingWeeksSinceRecovery, 2);
  assert.equal(result.recoveryWeekDue, false);
  assert.equal(result.recoveryWeek, null);
  assert.match(result.recoveryWeekReason, /2 loading week\(s\) since the block start/);
});

test("the decision is the same on every night of the recovery week", () => {
  for (const day of [1, 3, 5, 7]) {
    const weeklyKm = { ...STEADY, 4: 30 };
    const result = periodization(request({ weekStart: blockDay(4, day), weeklyKm }));
    assert.equal(result.recoveryWeekDue, true, `block day ${day}`);
    assert.equal(result.recoveryWeek?.weeklyKmCap, 32.9, `stable cap on block day ${day}`);
  }
});

test("a low-volume week (illness, travel) resets the count", () => {
  const result = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: { ...STEADY, 2: 20 } }));

  assert.deepEqual(result.recentWeeks.map((week) => week.classification), ["loading", "low_volume", "loading"]);
  assert.equal(result.loadingWeeksSinceRecovery, 1);
  assert.equal(result.recoveryWeekDue, false);
  assert.equal(result.lastUnloadingWeek?.blockWeek, 2);
});

test("a reactive offload (pain, very weak feedback or a deloaded session) resets the count", () => {
  const painLog: TrainingLog = {
    sessionId: "s", completedAt: blockDay(2, 3), pullUps: 8, pushUps: 30, plankSeconds: 90,
    loggedPullUps: true, loggedPushUps: true, loggedPlankSeconds: true, rpe: 7, painLevel: 5, fatigueLevel: 5, notes: ""
  };
  const withPain = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY, trainingLogs: [painLog] }));
  assert.equal(withPain.recentWeeks[1].classification, "reactive_offload");
  assert.match(withPain.recentWeeks[1].note, /pain 5\/10/);
  assert.equal(withPain.recoveryWeekDue, false);

  const deloaded: PlannedSession = {
    id: "d", scheduledDate: blockDay(3, 2), title: "Pull strength", focus: "pull", status: "deload",
    exercises: [{ exercise: "pullUp", sets: 2, targetReps: 4, targetSeconds: 0, plannedEffortLabel: "light" }]
  };
  const withDeload = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY, plannedSessions: [deloaded] }));
  assert.equal(withDeload.recentWeeks[2].classification, "reactive_offload");
  assert.equal(withDeload.loadingWeeksSinceRecovery, 0);
});

test("a recovery week that was done resets the cycle; one trained through does not", () => {
  const followed = { ...STEADY, 4: 30, 5: 46, 6: 48, 7: 50 };
  assert.equal(periodization(request({ weekStart: blockDay(7, 1), weeklyKm: followed })).recoveryWeekDue, false);
  const again = periodization(request({ weekStart: blockDay(8, 1), weeklyKm: followed }));
  assert.equal(again.recoveryWeekDue, true);
  assert.match(again.recoveryWeekReason, /since the last unloading week \(block week 4: planned recovery week, done lighter\)/);

  const ignored = periodization(request({ weekStart: blockDay(5, 1), weeklyKm: { ...STEADY, 4: 48 } }));
  assert.equal(ignored.recentWeeks.at(-1)?.note, "planned recovery week trained through (48 km)");
  assert.equal(ignored.loadingWeeksSinceRecovery, 4);
  assert.equal(ignored.recoveryWeekDue, true, "still needs its recovery week");
});

test("a recovery week stays recognised when its first day still held a long run", () => {
  // Day 1 of block week 4 was planned the night before, as a loading day.
  const runs = runsFor({ ...STEADY, 5: 46, 6: 47 });
  runs.push(
    { completedAt: `${blockDay(4, 1).slice(0, 10)}T08:00:00.000Z`, distanceKm: 20, movingSeconds: 7200, elevationGainM: 300, kind: "long" },
    { completedAt: `${blockDay(4, 3).slice(0, 10)}T08:00:00.000Z`, distanceKm: 8, movingSeconds: 2900, elevationGainM: 50, kind: "easy" },
    { completedAt: `${blockDay(4, 5).slice(0, 10)}T08:00:00.000Z`, distanceKm: 13, movingSeconds: 4700, elevationGainM: 100, kind: "long" },
    { completedAt: `${blockDay(4, 7).slice(0, 10)}T08:00:00.000Z`, distanceKm: 8, movingSeconds: 2900, elevationGainM: 50, kind: "easy" }
  );
  const req = request({ weekStart: blockDay(7, 1), weeklyKm: {} });
  req.running!.recentRuns = runs;

  const result = periodization(req);

  assert.equal(result.recentWeeks.find((week) => week.blockWeek === 4)?.classification, "recovery", "49 km in total, 29 km after day 1");
  assert.equal(result.recoveryWeekDue, false);
});

test("the taper, the post-race weeks and a reactive state replace the planned recovery week", () => {
  const taper = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY, raceDate: "2026-08-12T00:00:00Z" }));
  assert.equal(taper.recoveryWeekDue, false);
  assert.match(taper.recoveryWeekReason, /the race is 16 day\(s\) away: the taper replaces the recovery week/);

  const painNow: TrainingLog = {
    sessionId: "s", completedAt: new Date(Date.parse(blockDay(4, 1)) - 6 * 60 * 60 * 1000).toISOString(), pullUps: 8, pushUps: 30,
    plankSeconds: 90, loggedPullUps: true, loggedPushUps: true, loggedPlankSeconds: true, rpe: 7, painLevel: 6, fatigueLevel: 5, notes: ""
  };
  // The pain log falls on the last day of week 3, so week 3 is a reactive offload as well.
  const reactive = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY, trainingLogs: [painNow] }));
  assert.equal(reactive.recoveryWeekDue, false);
});

test("without a block start planned recovery weeks are off", () => {
  const result = periodization(request({ weekStart: blockDay(4, 1), weeklyKm: STEADY, planBlockStartedAt: null }));

  assert.equal(result.recoveryWeekDue, false);
  assert.equal(result.blockWeek, null);
  assert.match(result.recoveryWeekReason, /No plan block start/);
});

test("a strength-only athlete's recovery week follows executed hard sets", () => {
  const sessions: PlannedSession[] = [];
  for (const week of [-1, 0, 1, 2, 3]) {
    for (const day of [1, 3, 5]) {
      sessions.push({
        id: `w${week}d${day}`,
        scheduledDate: blockDay(week, day),
        title: "Strength",
        focus: "mixed",
        status: "completed",
        exercises: [
          { exercise: "pullUp", sets: 4, targetReps: 6, targetSeconds: 0, plannedEffortLabel: "hard", plannedEffortStimulus: "strength" },
          { exercise: "pushUp", sets: 4, targetReps: 20, targetSeconds: 0, plannedEffortLabel: "hard", plannedEffortStimulus: "volume" },
          { exercise: "plank", sets: 3, targetReps: 0, targetSeconds: 60, plannedEffortLabel: "medium", plannedEffortStimulus: "volume" }
        ]
      });
    }
  }

  const result = periodization(request({ weekStart: blockDay(4, 1), running: false, plannedSessions: sessions }));

  assert.equal(result.recoveryWeekDue, true);
  assert.equal(result.recoveryWeek?.referenceHardStrengthSets, 24);
  assert.equal(result.recoveryWeek?.hardStrengthSetCap, 14);
  assert.equal(result.recoveryWeek?.weeklyKmCap, null);
});

test("an active reactive state takes the place of the planned recovery week", () => {
  const req = request({ weekStart: blockDay(4, 1), weeklyKm: STEADY });
  const result = computePeriodization({ request: req, readinessState: "overreaching", now: new Date(blockDay(4, 1)) });

  assert.equal(result.loadingWeeksSinceRecovery, 3);
  assert.equal(result.recoveryWeekDue, false);
  assert.match(result.recoveryWeekReason, /readiness is overreaching: the reactive offload already backs off this week/);
});
