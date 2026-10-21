import assert from "node:assert/strict";
import test from "node:test";
import { buildCoachContext } from "./planner/build-coach-context";
import {
  runCombinedWeekPipeline,
  runStrengthWeekPipeline,
  type RepairInput,
  type RunningPlannerGuidance,
  type StrengthPlannerGuidance
} from "./plan-pipeline";
import type { CoachRequest, EffortLabel, EffortStimulus, PlannedEffort, RunKind, RunningWeek, RunSummary, WeeklyPlan } from "./planner/types";

const NOW = new Date("2026-05-11T09:00:00Z");
const WEEK_START = "2026-05-11T00:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

test("feeds both planners the computed signals and guardrails, and clamps instead of repairing", async () => {
  const context = buildCoachContext(hybridRequest(), NOW);
  const runningCalls: RunningPlannerGuidance[] = [];
  const strengthCalls: StrengthPlannerGuidance[] = [];
  const recorded: string[] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (guidance) => {
      runningCalls.push(guidance);
      // 61 km against a 51.8 km cap: easy runs can absorb it.
      return ok(runningWeek([
        run("Easy aerobic run", 1, "easy", 10),
        run("Tempo blocks", 3, "tempo", 12),
        run("Easy aerobic run", 4, "easy", 8),
        run("Long trail run", 5, "long", 22),
        run("Recovery jog", 6, "recovery", 9)
      ]));
    },
    generateStrength: async (guidance) => {
      strengthCalls.push(guidance);
      return ok(strengthWeek([strengthSession("Full-body strength", 1, "hard")]));
    },
    recordValidationFailure: async (phase) => {
      recorded.push(phase);
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.repairs, 0);
  assert.deepEqual(recorded, []);
  assert.ok(result.adjustments.some((a) => a.includes("51.8 km cap")));
  assert.ok(result.runningWeek.sessions.reduce((sum, s) => sum + s.distanceKm, 0) <= 51.8);

  assert.equal(runningCalls.length, 1);
  assert.equal(runningCalls[0].trainingSignals?.running.fourWeekAvgKm, 45);
  assert.deepEqual((runningCalls[0].guardrails.weeklyVolume as { capKm: number }).capKm, 51.8);
  assert.ok(runningCalls[0].guardrails.easyReference);

  assert.equal(strengthCalls.length, 1);
  assert.equal(strengthCalls[0].plannedRuns?.length, 5);
  assert.equal(strengthCalls[0].trainingSignals?.running.last7DaysKm, 45);
  // The clamped running week (51 km) is more than 10% above the 45 km average,
  // so earned strength progression may hold this week.
  assert.match(result.maintenanceReason ?? "", /more than 10% above the 4-week average \(45 km\)/);
  assert.equal((strengthCalls[0].guardrails.maintenance as { allowed: boolean }).allowed, true);
});

test("sends unclampable problems to one repair with the clamped plan and exact messages", async () => {
  const context = buildCoachContext(hybridRequest(), NOW);
  const repairs: Array<RepairInput<RunningWeek>> = [];
  const recorded: string[] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (_guidance, repair) => {
      if (repair) {
        repairs.push(repair);
        return ok(runningWeek([
          run("Easy aerobic run", 1, "easy", 8),
          run("Tempo blocks", 3, "tempo", 10),
          run("Long trail run", 5, "long", 22),
          run("Recovery jog", 6, "recovery", 6)
        ]));
      }
      return ok(runningWeek([
        { ...run("Easy aerobic run", 1, "easy", 8), target: { type: "pace", low: 0, high: 0 } },
        run("Tempo blocks", 4, "tempo", 10),
        run("Long trail run", 5, "long", 22),
        run("Recovery jog", 6, "recovery", 6)
      ]));
    },
    generateStrength: async () => ok(strengthWeek([strengthSession("Full-body strength", 2, "hard")])),
    recordValidationFailure: async (phase) => {
      recorded.push(phase);
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(repairs.length, 1);
  assert.ok(repairs[0].messages.some((m) => m.includes("consecutive days")));
  assert.notDeepEqual(repairs[0].previousPlan.sessions[0].target, { type: "pace", low: 0, high: 0 }, "repair sees the clamped target");
  assert.deepEqual(recorded, ["running_initial_validation"]);
  if (result.ok) assert.equal(result.repairs, 1);
});

test("rejects after one failed repair with both message sets", async () => {
  const context = buildCoachContext(hybridRequest(), NOW);
  const recorded: string[] = [];
  const hardHeavy = runningWeek([
    run("Hill repeats", 1, "hills", 8),
    run("Tempo blocks", 3, "tempo", 10),
    run("Long trail run", 5, "long", 22),
    run("Recovery jog", 6, "recovery", 6)
  ]);
  hardHeavy.safetyFlags = ["Deliberately hard week."];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async () => ok(hardHeavy),
    generateStrength: async () => ok(strengthWeek([])),
    recordValidationFailure: async (phase) => {
      recorded.push(phase);
    }
  });

  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "validation") return;
  assert.equal(result.stage, "running");
  assert.ok(result.messages.some((m) => m.includes("hard running is capped at 2")));
  assert.deepEqual(result.firstAttemptMessages, result.messages);
  assert.deepEqual(recorded, ["running_initial_validation", "running_repair_validation"]);
});

test("passes an upstream model failure straight through", async () => {
  const result = await runCombinedWeekPipeline({
    context: buildCoachContext(hybridRequest(), NOW),
    now: NOW,
    generateRunning: async () => ({ ok: false, status: 429, body: "{\"error\":\"rate limited\"}" }),
    generateStrength: async () => ok(strengthWeek([])),
    recordValidationFailure: async () => {}
  });

  assert.deepEqual(result, { ok: false, reason: "upstream", status: 429, body: "{\"error\":\"rate limited\"}" });
});

test("strength repair receives the combined-week message for a test the day before the long run", async () => {
  const context = buildCoachContext(hybridRequest(), NOW);
  const strengthRepairs: Array<RepairInput<WeeklyPlan>> = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async () => ok(runningWeek([
      run("Easy aerobic run", 1, "easy", 8),
      run("Tempo blocks", 3, "tempo", 10),
      run("Long trail run", 5, "long", 22),
      run("Recovery jog", 6, "recovery", 6)
    ])),
    generateStrength: async (_guidance, repair) => {
      if (repair) {
        strengthRepairs.push(repair);
        return ok(strengthWeek([strengthSession("Full-body strength", 2, "hard")]));
      }
      return ok(strengthWeek([strengthSession("Full-body strength", 2, "hard"), strengthSession("Heavy pull day", 4, "very_hard")]));
    },
    recordValidationFailure: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(strengthRepairs.length, 1);
  assert.ok(strengthRepairs[0].messages.some((m) => m.includes("day before the long run on offset 5")));
});

test("the strength-only pipeline clamps over-cap reps", async () => {
  const context = buildCoachContext({ ...hybridRequest(), running: undefined }, NOW);
  const plan = strengthWeek([strengthSession("Full-body strength", 2, "hard")]);
  plan.sessions[0].exercises[1] = { ...plan.sessions[0].exercises[1], reps: 38 };

  const result = await runStrengthWeekPipeline({
    context,
    now: NOW,
    generateStrength: async () => ok(plan),
    recordValidationFailure: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.strengthWeek.sessions[0].exercises[1].reps, 30);
  assert.ok(result.adjustments.some((a) => a.includes("working cap of 30")));
});

function ok<T>(value: T) {
  return { ok: true as const, value };
}

function hybridRequest(): CoachRequest {
  return {
    model: "gpt-6.1-sol",
    baseline: { pullUps: 10, pushUps: 40, plankSeconds: 90 },
    goals: { pullUps: 20, pushUps: 100, plankSeconds: 300 },
    profileNotes: "",
    weekStart: WEEK_START,
    weeklySessions: 3,
    trainingDays: [],
    trainingDayOffsets: [],
    equipment: ["pullUpBar"],
    targetDate: "2027-05-11T00:00:00Z",
    trainingLogs: [],
    plannedSessions: [],
    running: {
      raceGoal: { name: "Ridge Ultra 60K", raceDate: "2026-07-20T00:00:00Z", distanceKm: 60, elevationGainM: 2400 },
      baselineWeeklyKm: 45,
      longestRecentRunKm: 20,
      runningDays: [],
      runningDayOffsets: [],
      recentRuns: steadyRuns()
    }
  };
}

/** Four 45 km weeks ending yesterday: easy, tempo, long, recovery. */
function steadyRuns(): RunSummary[] {
  const runs: RunSummary[] = [];
  for (let week = 0; week < 4; week += 1) {
    const parts: Array<[number, number, string, number, number]> = [
      [6, 8, "easy", 360, 140],
      [4, 10, "tempo", 290, 160],
      [2, 20, "long", 370, 145],
      [1, 7, "recovery", 380, 132]
    ];
    for (const [daysIntoWeek, km, kind, pace, hr] of parts) {
      const daysAgo = week * 7 + daysIntoWeek;
      runs.push({
        completedAt: new Date(Date.parse(WEEK_START) - daysAgo * DAY_MS + 7 * 60 * 60 * 1000).toISOString(),
        distanceKm: km,
        movingSeconds: km * pace,
        elevationGainM: 100,
        averageHr: hr,
        kind
      });
    }
  }
  return runs;
}

function runningWeek(sessions: RunningWeek["sessions"]): RunningWeek {
  return { summary: "Build week.", safetyFlags: [], sessions };
}

function run(title: string, dayOffset: number, kind: RunKind, distanceKm: number): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Aerobic durability for the race.",
    distanceKm,
    durationMinutes: Math.round(distanceKm * 6),
    elevationMeters: 100,
    target: { type: "hr", low: 132, high: 145 },
    zone: "Zone 2",
    notes: []
  };
}

function strengthWeek(sessions: WeeklyPlan["sessions"]): WeeklyPlan {
  return { summary: "Build: strength around the runs.", contextState: "insufficient_history", safetyFlags: [], sessions };
}

function strengthSession(title: string, dayOffset: number, label: EffortLabel): WeeklyPlan["sessions"][number] {
  const rpe: Record<EffortLabel, number> = { light: 3, medium: 6, hard: 7, very_hard: 9, max_output: 10 };
  return {
    title,
    dayOffset,
    focus: "mixed",
    plannedEffort: effort(label, rpe[label], "strength"),
    purpose: "Strength that serves the race.",
    estimatedDurationMinutes: 40,
    progressionRationale: "Inside the computed band.",
    safetyNotes: [],
    loggingFieldsRequired: ["pullUps", "pushUps", "plankSeconds"],
    exercises: [
      { exercise: "pullUp", sets: 4, reps: 7, seconds: 0, restSeconds: 120, intensity: "Hard", plannedEffort: effort("hard", 7, "strength") },
      { exercise: "pushUp", sets: 3, reps: 24, seconds: 0, restSeconds: 90, intensity: "Hard", plannedEffort: effort("hard", 7, "volume") },
      { exercise: "plank", sets: 3, reps: 0, seconds: 60, restSeconds: 60, intensity: "Medium", plannedEffort: effort("medium", 6, "volume") }
    ]
  };
}

function effort(label: EffortLabel, targetRPE: number, stimulus: EffortStimulus): PlannedEffort {
  return { label, targetRPE, targetRIR: label === "very_hard" ? 1 : 3, stimulus, reason: `${label} ${stimulus}` };
}
