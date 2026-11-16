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
import type { CoachRequest, EffortLabel, EffortStimulus, PlannedEffort, PlannedSession, RunKind, RunningWeek, RunSummary, WeeklyPlan } from "./planner/types";

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
  // Code review M7: the typed session maximum the payload builder reads is the guardrails' own.
  assert.equal(strengthCalls[0].maxSessionsThisWeek, strengthCalls[0].guardrails.maxSessionsThisWeek);
  assert.equal(strengthCalls[0].trainingSignals?.running.last7DaysKm, 45);
  // The clamped running week (51 km) is more than 10% above the 45 km average;
  // running load never holds upper-body progression (Task 8: no maintenance).
  assert.equal(strengthCalls[0].guardrails.maintenance, undefined);
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
  // Two strength days: both attempts plan two sessions, so only the combined-week rule fails.
  const context = buildCoachContext({ ...hybridRequest(), weeklySessions: 2 }, NOW);
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
        // Medium work on the easy-run day keeps offset 4 a full rest day.
        return ok(strengthWeek([strengthSession("Pull day", 1, "medium"), strengthSession("Full-body strength", 2, "hard")]));
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

// Review finding: one 5 km run 20 days ago made the cap 4.3 km while a
// starter week needs 3 runs of at least 3 km, so no week could pass.
test("a sparse run history (one short run) still produces a passable starter week", async () => {
  const request = hybridRequest();
  request.running = {
    ...request.running!,
    baselineWeeklyKm: 1.3,
    longestRecentRunKm: 5,
    runningDays: ["tuesday", "thursday", "saturday"],
    runningDayOffsets: [1, 3, 5],
    longRunDay: "saturday",
    longRunDayOffset: 5,
    recentRuns: [{
      completedAt: new Date(Date.parse(WEEK_START) - 20 * DAY_MS + 8 * 60 * 60 * 1000).toISOString(),
      distanceKm: 5,
      movingSeconds: 1800,
      elevationGainM: 40,
      kind: "easy"
    }]
  };
  const context = buildCoachContext(request, NOW);
  const runningCalls: RunningPlannerGuidance[] = [];
  const recorded: string[] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (guidance) => {
      runningCalls.push(guidance);
      return ok(runningWeek([run("Easy run", 1, "easy", 3), run("Easy run", 3, "easy", 3), run("Long easy run", 5, "long", 5)]));
    },
    generateStrength: async () => ok(strengthWeek([strengthSession("Full-body strength", 2, "hard")])),
    recordValidationFailure: async (phase) => {
      recorded.push(phase);
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(recorded, [], "no repair needed");
  const weeklyVolume = runningCalls[0].guardrails.weeklyVolume as { capKm: number; basis: string };
  assert.equal(weeklyVolume.capKm, 20);
  assert.match(weeklyVolume.basis, /only 1 run in the last 6 weeks/);
});

test("a due recovery week reaches both planners and a loading-style answer is clamped into one", async () => {
  // Block start three weeks ago with steady 45 km weeks: block week 4 is a planned recovery week.
  // Two strength days: the loading-style answer below has two sessions.
  const request = { ...hybridRequest(), weeklySessions: 2, planBlockStartedAt: new Date(Date.parse(WEEK_START) - 21 * DAY_MS).toISOString() };
  const context = buildCoachContext(request, NOW);
  const runningCalls: RunningPlannerGuidance[] = [];
  const strengthCalls: StrengthPlannerGuidance[] = [];
  const recorded: string[] = [];

  assert.equal(context.periodization?.recoveryWeekDue, true, context.periodization?.recoveryWeekReason);

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (guidance) => {
      runningCalls.push(guidance);
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
      return ok(strengthWeek([strengthSession("Full-body strength", 1, "hard"), strengthSession("Heavy pull day", 4, "hard")]));
    },
    recordValidationFailure: async (phase) => {
      recorded.push(phase);
    }
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(recorded, [], "clamped, no repair needed");
  const recoveryGuidance = runningCalls[0].guardrails.recoveryWeek as { weeklyKmCap: number; longRunCapKm: number };
  assert.equal(recoveryGuidance.weeklyKmCap, 33.8);
  assert.equal(recoveryGuidance.longRunCapKm, 14);
  assert.ok(result.runningWeek.sessions.reduce((sum, session) => sum + session.distanceKm, 0) <= 33.8);
  assert.ok(result.runningWeek.sessions.every((session) => session.distanceKm <= 14));
  assert.ok((strengthCalls[0].guardrails.phase as { recoveryWeek: unknown }).recoveryWeek);
  assert.match(result.strengthWeek.summary, /^Offload: /);
  assert.equal(result.strengthWeek.sessions.filter((session) => session.plannedEffort.label === "hard").length, 1);
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
    // One strength day a week, so the one-session fixture strength weeks meet the session minimum.
    weeklySessions: 1,
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

// The strength minimum (3 in a normal week) never takes the week's full rest
// day: with strength days Tue, Fri, Sun and runs on Wed, Thu, Sat, Sun, two
// strength sessions is the most that leaves a rest day.
test("the strength session minimum leaves a full rest day around the fixed runs", async () => {
  const context = buildCoachContext({
    ...hybridRequest(),
    weeklySessions: 3,
    trainingDays: ["tuesday", "friday", "sunday"],
    trainingDayOffsets: [1, 4, 6]
  }, NOW);
  const strengthCalls: StrengthPlannerGuidance[] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async () => ok(runningWeek([
      run("Easy aerobic run", 2, "easy", 8),
      run("Tempo blocks", 3, "tempo", 10),
      run("Long trail run", 5, "long", 20),
      run("Recovery jog", 6, "recovery", 7)
    ])),
    generateStrength: async (guidance) => {
      strengthCalls.push(guidance);
      return ok(strengthWeek([strengthSession("Full-body strength", 1, "hard"), strengthSession("Easy full-body strength", 6, "medium")]));
    },
    recordValidationFailure: async () => {}
  });

  assert.equal(strengthCalls[0].guardrails.minSessionsThisWeek, 2);
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Review finding: the day after a race an empty strength week failed twice
// (count, then all light) and the athlete got no plan. The repair is told the
// whole requirement, and a repair that follows it passes. The week after a
// race is a normal strength week (Task 8): 3 sessions, not 2.
test("the day after a race, a repair that follows the session message produces a plan", async () => {
  const context = buildCoachContext({
    ...hybridRequest(),
    weeklySessions: 3,
    running: { ...hybridRequest().running!, raceGoal: { ...hybridRequest().running!.raceGoal, raceDate: "2026-05-10T00:00:00Z" } }
  }, NOW);
  const repairMessages: string[][] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    // The first week after the race caps running hard: one short recovery jog.
    generateRunning: async () => ok(runningWeek([run("Recovery jog", 2, "recovery", 3.5)])),
    generateStrength: async (_guidance, repair) => {
      if (!repair) {
        return ok({ ...strengthWeek([]), summary: "Restore: rest after the race.", safetyFlags: ["Rest after the race."] });
      }
      repairMessages.push(repair.messages);
      // Two sessions keep their hard goal sets (post-race days 4 and 6); the third stays medium (2 hard sessions a week).
      const easy = strengthSession("Easy full-body strength", 6, "medium");
      easy.exercises = easy.exercises.map((exercise) => ({ ...exercise, intensity: "Medium", plannedEffort: effort("medium", 6, "volume") }));
      return ok(strengthWeek([strengthSession("Upper-body strength", 3, "medium"), strengthSession("Mobility and core", 5, "light"), easy]));
    },
    recordValidationFailure: async () => {}
  });

  assert.ok(repairMessages[0]?.some((m) => m.includes("at least 3 strength sessions") && m.includes("at least one at medium effort or harder")), JSON.stringify(repairMessages));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// The nightly plan covers offsets 1-6 (today is locked), while the running
// floors are weekly. A steady 40 km week, by UTC weekday: Tuesday intervals,
// Wednesday and Thursday easy, Saturday long, Sunday easy; Monday and Friday rest.
const STEADY_WEEK: Partial<Record<number, { kind: RunKind; km: number }>> = {
  2: { kind: "intervals", km: 8 },
  3: { kind: "easy", km: 6 },
  4: { kind: "easy", km: 6 },
  6: { kind: "long", km: 14 },
  0: { kind: "easy", km: 6 }
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Weeks of 34, 46, 38, 44 and 36 km around the steady 40 km plan, by calendar week. */
const UNEVEN_WEEKS = (week: number) => [0.85, 1.15, 0.95, 1.1, 0.9][((week % 5) + 5) % 5];
const A_MONDAY = Date.parse("2026-01-05T00:00:00Z");

/**
 * The 01:30 re-plan on `weekStart` (local midnight): five weeks run as
 * planned (each run scaled by `weeklyScale` of its calendar week, for an
 * uneven history), yesterday's plan (it covered yesterday through offset 5
 * of today, never offset 6), and a race far ahead (general preparation). The
 * only strength day is today, so no strength is left.
 */
function steadyNight(
  weekStart: string,
  week: Partial<Record<number, { kind: RunKind; km: number }>> = STEADY_WEEK,
  runningDays = ["tuesday", "wednesday", "thursday", "saturday", "sunday"],
  weeklyScale: (calendarWeek: number) => number = () => 1
) {
  const start = Date.parse(weekStart);
  const dayOf = (offset: number) => new Date(start + offset * DAY_MS);
  // Midday after local midnight is on the local calendar day (a 23:00Z start included).
  const midday = (offset: number) => start + offset * DAY_MS + 12 * 60 * 60 * 1000;
  const weekdayOf = (offset: number) => new Date(midday(offset)).getUTCDay();
  const entry = (offset: number) => week[weekdayOf(offset)];
  const recentRuns: RunSummary[] = [];
  for (let offset = -35; offset <= -1; offset += 1) {
    const planned = entry(offset);
    if (!planned) continue;
    const scale = weeklyScale(Math.floor((midday(offset) - A_MONDAY) / (7 * DAY_MS)));
    recentRuns.push({
      completedAt: new Date(start + offset * DAY_MS + 7 * 60 * 60 * 1000).toISOString(),
      distanceKm: Math.round(planned.km * scale * 10) / 10,
      movingSeconds: planned.km * (planned.kind === "intervals" ? 300 : 370),
      elevationGainM: 100,
      averageHr: planned.kind === "intervals" ? 160 : 140,
      kind: planned.kind
    });
  }
  const plannedSessions: PlannedSession[] = [];
  for (let offset = -7; offset <= 5; offset += 1) {
    const planned = entry(offset);
    if (!planned) continue;
    plannedSessions.push({
      id: `run${offset}`,
      scheduledDate: dayOf(offset).toISOString(),
      title: `${planned.kind} run`,
      focus: "mixed",
      status: offset < 0 ? "completed" : "planned",
      exercises: [],
      discipline: "running",
      runKind: planned.kind,
      distanceKm: planned.km,
      elevationMeters: 100,
      target: { type: "hr", low: 132, high: 145 }
    });
  }
  const offsets = [1, 2, 3, 4, 5, 6].filter((offset) => runningDays.includes(WEEKDAYS[weekdayOf(offset)]));
  const request: CoachRequest = {
    ...hybridRequest(),
    weekStart,
    trainingDays: [WEEKDAYS[weekdayOf(0)]],
    trainingDayOffsets: [],
    plannedSessions,
    currentPlanGeneratedAt: new Date(start - 22.5 * 60 * 60 * 1000).toISOString(),
    running: {
      raceGoal: { name: "Spring Trail", raceDate: "2027-05-01T00:00:00Z", distanceKm: 50, elevationGainM: 2000 },
      baselineWeeklyKm: 40,
      longestRecentRunKm: 14,
      runningDays,
      runningDayOffsets: offsets,
      longRunDay: "saturday",
      longRunDayOffset: offsets.find((offset) => weekdayOf(offset) === 6),
      recentRuns
    }
  };
  return { request, now: new Date(start + 1.5 * 60 * 60 * 1000), offsets, entry };
}

async function replan(request: CoachRequest, now: Date, sessions: RunningWeek["sessions"]) {
  const context = buildCoachContext(request, now);
  const calls: RunningPlannerGuidance[] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now,
    generateRunning: async (guidance) => {
      calls.push(guidance);
      return ok(runningWeek(sessions.map((session) => ({ ...session, notes: [...session.notes] }))));
    },
    generateStrength: async () => ok({ ...strengthWeek([]), summary: "Build: no strength day left this week.", safetyFlags: ["The week's only strength day is today."] }),
    recordValidationFailure: async () => {}
  });
  return { result, calls };
}

/** The same steady week again for offsets 1-6 (the new offset 6 included), as continuity asks. */
function sameWeek(night: ReturnType<typeof steadyNight>): RunningWeek["sessions"] {
  return night.offsets
    .filter((offset) => night.entry(offset))
    .map((offset) => run(`${night.entry(offset)!.kind} run`, offset, night.entry(offset)!.kind, night.entry(offset)!.km));
}

test("a steady 40 km week replans on each of the 7 nights without extra volume or a second quality day", async () => {
  for (let day = 0; day < 7; day += 1) {
    // Amsterdam in winter: local midnight is 23:00Z the day before (Monday 16 November first).
    // The weeks before ran 34-46 km around the 40 km plan.
    const weekStart = new Date(Date.parse("2026-11-15T23:00:00Z") + day * DAY_MS).toISOString();
    const night = steadyNight(weekStart, STEADY_WEEK, undefined, UNEVEN_WEEKS);
    const { result, calls } = await replan(night.request, night.now, sameWeek(night));

    assert.equal(result.ok, true, `${weekStart}: ${JSON.stringify(result)}`);
    if (!result.ok) return;
    assert.equal(calls.length, 1, `${weekStart}: no repair`);
    assert.equal(calls[0].continuity?.keepUnlessChanged, true, `${weekStart}: ${calls[0].continuity?.changeSignals.join(" ")}`);
    const today = night.entry(0);
    assert.equal(result.runningWeek.sessions.reduce((sum, session) => sum + session.distanceKm, 0) + (today?.km ?? 0), 40, `${weekStart}: the same 40 km`);
    const quality = [...result.runningWeek.sessions.map((session) => session.kind), today?.kind].filter((kind) => kind === "intervals").length;
    assert.equal(quality, 1, `${weekStart}: one quality session`);
  }
});

// Review finding: on Saturday night the kept runs reached 29.9 km at most
// (26 km planned, +15%) against a 34 km floor, so the plan failed.
test("the Saturday-night replan counts today's long run toward the floor", async () => {
  const night = steadyNight("2026-11-21T00:00:00Z");
  const { result, calls } = await replan(night.request, night.now, sameWeek(night));

  assert.equal(calls[0].continuity?.keepUnlessChanged, true, JSON.stringify(calls[0].continuity));
  assert.equal(calls.length, 1, "no repair");
  assert.equal(result.ok, true, JSON.stringify(result));
});

// The continuity change signals for the running floors (continuity-floors.ts).
const KM_FLOOR_SIGNAL = "The planned week is below the running floor";
const QUALITY_FLOOR_SIGNAL = "The planned week has no tempo, interval or hill run";

// Yesterday's plan was eased while a run rated feel 2 still relaxed the week;
// that run is now eight days old, so the floors apply again without any change
// signal. Kept within 15%, the eased plan cannot reach the floor.
test("continuity yields to the floor when the kept plan cannot reach it", async () => {
  const night = steadyNight("2026-11-18T00:00:00Z"); // a Wednesday
  const eased: Record<string, number> = { run0: 4, run1: 4, run3: 8, run4: 4, run6: 5 };
  night.request.plannedSessions = night.request.plannedSessions.map((session) =>
    session.id in eased ? { ...session, distanceKm: eased[session.id] } : session
  );
  night.request.running!.recentRuns = night.request.running!.recentRuns.map((entry) =>
    entry.completedAt.startsWith("2026-11-10") ? { ...entry, feelScore: 2 } : entry
  );

  const { result, calls } = await replan(night.request, night.now, sameWeek(night));

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith(KM_FLOOR_SIGNAL)), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("continuity also yields when the kept plan holds no quality run the floor needs", async () => {
  // Yesterday's plan made Tuesday's intervals an easy run while a relaxation applied.
  const night = steadyNight("2026-11-16T00:00:00Z"); // a Monday
  night.request.plannedSessions = night.request.plannedSessions.map((session) =>
    session.id === "run1" ? { ...session, runKind: "easy" } : session
  );

  const { result, calls } = await replan(night.request, night.now, sameWeek(night));

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith(QUALITY_FLOOR_SIGNAL)), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Review finding: the floor signal assumed every kept run could grow 15%, but
// the kept 16 km long run cannot pass the 16.1 km long-run cap, so continuity
// held and the plan failed. Mon-Thu and Saturday runner, 40 km.
test("continuity yields when the kept long run cannot grow past its cap", async () => {
  const week: Partial<Record<number, { kind: RunKind; km: number }>> = {
    1: { kind: "easy", km: 8 }, 2: { kind: "intervals", km: 8 }, 3: { kind: "easy", km: 6 }, 4: { kind: "easy", km: 4 }, 6: { kind: "long", km: 14 }
  };
  const night = steadyNight("2027-01-18T00:00:00Z", week, ["monday", "tuesday", "wednesday", "thursday", "saturday"]); // a Monday
  // Last night's plan was light while a relaxation applied; the long run sits at 16 km.
  const light: Record<string, number> = { run0: 4, run1: 4, run2: 4, run3: 3, run5: 16 };
  night.request.plannedSessions = night.request.plannedSessions.map((session) =>
    session.id in light ? { ...session, distanceKm: light[session.id] } : session
  );
  const context = buildCoachContext(night.request, night.now);
  const calls: RunningPlannerGuidance[] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now: night.now,
    // Kept, every run stretches by 15% (the long run is clamped to the cap); released, the normal week.
    generateRunning: async (guidance) => {
      calls.push(guidance);
      return ok(runningWeek(guidance.continuity?.keepUnlessChanged
        ? [run("Intervals", 1, "intervals", 4.6), run("Easy", 2, "easy", 4.6), run("Easy", 3, "easy", 3.5), run("Long", 5, "long", 18.4)]
        : sameWeek(night)));
    },
    generateStrength: async () => ok({ ...strengthWeek([]), summary: "Build: no strength day left this week.", safetyFlags: ["The week's only strength day is today."] }),
    recordValidationFailure: async () => {}
  });

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith(KM_FLOOR_SIGNAL)), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Review finding: with runs rounded down to 0.5 km, a kept plan whose most
// reached the floor by a few tenths still missed it. Continuity is released
// below the floor plus a margin (continuity-floors.test.ts has the numbers).
test("continuity yields when the kept plan reaches the floor by less than 0.5 km", async () => {
  // Saturday: today's eased long run (10 km) plus 21 km kept reach 34.2 km at most (floor 34 km).
  const night = steadyNight("2026-11-21T00:00:00Z");
  const eased: Record<string, number> = { run0: 10, run1: 5, run3: 6, run4: 5, run5: 5 };
  night.request.plannedSessions = night.request.plannedSessions.map((session) =>
    session.id in eased ? { ...session, distanceKm: eased[session.id] } : session
  );
  const context = buildCoachContext(night.request, night.now);
  const calls: RunningPlannerGuidance[] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now: night.now,
    // Kept, every run grows 15% and is rounded down to 0.5 km: 33 km over the 7 days.
    generateRunning: async (guidance) => {
      calls.push(guidance);
      return ok(runningWeek(guidance.continuity?.keepUnlessChanged
        ? [run("Easy", 1, "easy", 5.5), run("Intervals", 3, "intervals", 6.5), run("Easy", 4, "easy", 5.5), run("Easy", 5, "easy", 5.5)]
        : sameWeek(night)));
    },
    generateStrength: async () => ok({ ...strengthWeek([]), summary: "Build: no strength day left this week.", safetyFlags: ["The week's only strength day is today."] }),
    recordValidationFailure: async () => {}
  });

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith(KM_FLOOR_SIGNAL)), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// A run's most is rounded down to 0.5 km in the estimate: unrounded, these
// kept runs reach 35.2 km (above the floor plus margin), rounded only 33.5 km.
test("continuity yields when the kept runs, rounded down to 0.5 km, cannot reach the floor", async () => {
  const night = steadyNight("2026-11-21T00:00:00Z"); // a Saturday
  const kept: Record<string, number> = { run0: 11, run1: 6, run3: 6, run4: 6, run5: 3 };
  night.request.plannedSessions = night.request.plannedSessions.map((session) =>
    session.id in kept ? { ...session, distanceKm: kept[session.id] } : session
  );
  const context = buildCoachContext(night.request, night.now);
  const calls: RunningPlannerGuidance[] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now: night.now,
    // Kept, every run grows 15% and is rounded down to 0.5 km: 33.5 km over the 7 days.
    generateRunning: async (guidance) => {
      calls.push(guidance);
      return ok(runningWeek(guidance.continuity?.keepUnlessChanged
        ? [run("Easy", 1, "easy", 6.5), run("Intervals", 3, "intervals", 6.5), run("Easy", 4, "easy", 6.5), run("Easy", 5, "easy", 3)]
        : sameWeek(night)));
    },
    generateStrength: async () => ok({ ...strengthWeek([]), summary: "Build: no strength day left this week.", safetyFlags: ["The week's only strength day is today."] }),
    recordValidationFailure: async () => {}
  });

  assert.equal(calls[0].continuity?.keepUnlessChanged, false, JSON.stringify(calls[0].continuity));
  assert.ok(calls[0].continuity?.changeSignals.some((signal) => signal.startsWith(KM_FLOOR_SIGNAL)), JSON.stringify(calls[0].continuity));
  assert.equal(result.ok, true, JSON.stringify(result));
});

// Task 8: upper-body strength never enters maintenance. Running load does not
// limit upper-body adaptation, and the weeks after a race (running at its
// lowest, the upper body undamaged) are the best window for upper-body
// progress. Two clean push-up sessions at 3 x 20 earn progression.
function withEarnedPushUps(request: CoachRequest): CoachRequest {
  const days = [6, 3].map((daysAgo) => new Date(Date.parse(WEEK_START) - daysAgo * DAY_MS).toISOString());
  return {
    ...request,
    weeklySessions: 3,
    plannedSessions: days.map((day, index) => ({
      id: `push-${index}`,
      scheduledDate: day,
      title: "Push strength",
      focus: "push",
      status: "completed",
      exercises: [{ exercise: "pushUp", sets: 3, targetReps: 20, targetSeconds: 0, plannedEffortLabel: "hard", plannedEffortStimulus: "strength" }]
    })),
    trainingLogs: days.map((day, index) => ({
      sessionId: `push-${index}`,
      completedAt: new Date(Date.parse(day) + 17 * 60 * 60 * 1000).toISOString(),
      pullUps: 0,
      pushUps: 20,
      plankSeconds: 0,
      loggedPullUps: false,
      loggedPushUps: true,
      loggedPlankSeconds: false,
      rpe: 7,
      plannedRPE: 7,
      painLevel: 0,
      fatigueLevel: 5,
      notes: ""
    }))
  };
}

type StrengthGuardrailsSeen = {
  minSessionsThisWeek: number;
  maintenance?: unknown;
  progression: Record<string, { status: string }>;
};

async function strengthGuidanceFor(request: CoachRequest, runs: RunningWeek["sessions"]) {
  const context = buildCoachContext(request, NOW);
  const strengthCalls: StrengthPlannerGuidance[] = [];
  const repairs: string[][] = [];
  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async () => ok(runningWeek(runs)),
    generateStrength: async (guidance, repair) => {
      strengthCalls.push(guidance);
      if (repair) repairs.push(repair.messages);
      // Two sessions that hold push-ups at the earned standard (20 x 3).
      const hold = (title: string, dayOffset: number) => {
        const session = strengthSession(title, dayOffset, "medium");
        session.exercises = session.exercises.map((exercise) => exercise.exercise === "pushUp" ? { ...exercise, reps: 20, plannedEffort: effort("medium", 6, "volume") } : { ...exercise, plannedEffort: effort("medium", 6, "volume") });
        return session;
      };
      return ok(strengthWeek([hold("Upper body", 2), hold("Upper body and core", 4)]));
    },
    recordValidationFailure: async () => {}
  });
  return { context, result, guardrails: strengthCalls[0]?.guardrails as unknown as StrengthGuardrailsSeen | undefined, repairs };
}

test("a post-race week keeps upper-body progression and a 3-session minimum", async () => {
  // Ten days after a 54 km race: the post-race transition (14 days for 54 km).
  const request = withEarnedPushUps(hybridRequest());
  request.running = { ...request.running!, raceGoal: { name: "Ridge Ultra 54K", raceDate: new Date(Date.parse(WEEK_START) - 10 * DAY_MS).toISOString(), distanceKm: 54, elevationGainM: 2000 } };
  const { context, guardrails, repairs } = await strengthGuidanceFor(request, [
    run("Easy run", 1, "easy", 6),
    run("Easy run", 3, "easy", 6),
    run("Easy long run", 5, "long", 10)
  ]);

  assert.equal(context.season?.raceState, "recent");
  assert.ok(guardrails, "the strength planner was called");
  assert.equal(guardrails!.minSessionsThisWeek, 3);
  assert.equal(guardrails!.progression.pushUps.status, "earned");
  assert.equal(guardrails!.maintenance, undefined, "no maintenance hold to offer");
  assert.ok(repairs[0]?.some((m) => m.includes("at least 3 strength sessions")), JSON.stringify(repairs));
  assert.ok(repairs[0]?.some((m) => m.includes("earned push-up progression")), JSON.stringify(repairs));
});

test("a heavy running week (>1.1 x average, or 3 hard runs) no longer holds upper-body progression", async () => {
  // 51.5 km against a 45 km average (more than 1.1 x), with tempo, hills and the long run.
  const { guardrails, repairs } = await strengthGuidanceFor(withEarnedPushUps(hybridRequest()), [
    run("Easy aerobic run", 1, "easy", 8),
    run("Tempo blocks", 2, "tempo", 10),
    run("Easy aerobic run", 3, "easy", 5.5),
    run("Hill repeats", 4, "hills", 8),
    run("Long trail run", 6, "long", 20)
  ]);

  assert.ok(guardrails, "the strength planner was called");
  assert.equal(guardrails!.minSessionsThisWeek, 3);
  assert.equal(guardrails!.progression.pushUps.status, "earned");
  assert.equal(guardrails!.maintenance, undefined);
  assert.ok(repairs[0]?.some((m) => m.includes("earned push-up progression")), JSON.stringify(repairs));
});
