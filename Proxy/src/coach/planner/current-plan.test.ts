import assert from "node:assert/strict";
import test from "node:test";
import { runCombinedWeekPipeline, type RunningPlannerGuidance } from "../plan-pipeline";
import { buildCoachContext } from "./build-coach-context";
import { keepRunningContinuity, strengthContinuityNotes, withStoredCurrentPlan } from "./current-plan";
import type { CoachRequest, PlannedSession, RunKind, RunningWeek, RunSummary, TrainingLog, WeeklyPlan } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_START = "2026-05-12T00:00:00.000Z"; // a Tuesday; the plan was made last night
const NOW = new Date("2026-05-12T01:30:00.000Z");
const GENERATED_AT = "2026-05-11T01:30:00.000Z";

function at(dayOffset: number, hour = 0): string {
  return new Date(Date.parse(WEEK_START) + dayOffset * DAY_MS + hour * 60 * 60 * 1000).toISOString();
}

function plannedRun(id: string, dayOffset: number, kind: RunKind, distanceKm: number, status = "planned"): PlannedSession {
  return {
    id,
    scheduledDate: at(dayOffset),
    title: `${kind} run`,
    focus: "mixed",
    status,
    exercises: [],
    discipline: "running",
    runKind: kind,
    distanceKm,
    elevationMeters: 100,
    target: { type: "hr", low: 132, high: 145 }
  };
}

function plannedStrength(id: string, dayOffset: number, status = "planned"): PlannedSession {
  return {
    id,
    scheduledDate: at(dayOffset),
    title: "Pull strength",
    focus: "pull",
    status,
    exercises: [{ exercise: "pullUp", sets: 4, targetReps: 7, targetSeconds: 0, plannedEffortLabel: "hard", plannedEffortStimulus: "strength" }]
  };
}

/** Four steady 45 km weeks, ending two days ago (nothing new since the plan). */
function steadyRuns(): RunSummary[] {
  const runs: RunSummary[] = [];
  for (let week = 0; week < 4; week += 1) {
    for (const [daysAgo, km, kind] of [[2, 8, "easy"], [4, 10, "tempo"], [6, 20, "long"], [7, 7, "recovery"]] as Array<[number, number, string]>) {
      runs.push({
        completedAt: at(-(week * 7 + daysAgo), 7),
        distanceKm: km,
        movingSeconds: km * 360,
        elevationGainM: 100,
        averageHr: 140,
        kind
      });
    }
  }
  return runs;
}

function request(overrides: Partial<CoachRequest> = {}): CoachRequest {
  return {
    model: "test-model",
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
    currentPlanGeneratedAt: GENERATED_AT,
    plannedSessions: [
      plannedRun("r1", 1, "easy", 8),
      plannedStrength("s2", 2),
      plannedRun("r3", 3, "tempo", 10),
      plannedRun("r5", 5, "long", 20),
      plannedRun("past", -3, "easy", 8, "completed")
    ],
    running: {
      raceGoal: { name: "Trail 75K", raceDate: "2026-08-15T00:00:00Z", distanceKm: 75, elevationGainM: 3000 },
      baselineWeeklyKm: 45,
      longestRecentRunKm: 20,
      runningDays: [],
      runningDayOffsets: [],
      recentRuns: steadyRuns()
    },
    ...overrides
  };
}

function log(completedAt: string, overrides: Partial<TrainingLog> = {}): TrainingLog {
  return {
    sessionId: `log-${completedAt}`,
    completedAt,
    pullUps: 8,
    pushUps: 30,
    plankSeconds: 90,
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

test("the planned future sessions reach the context as the current plan", () => {
  const context = buildCoachContext(request(), NOW);
  const plan = context.currentPlan;

  assert.ok(plan);
  assert.deepEqual(plan.runs.map((run) => [run.dayOffset, run.kind, run.distanceKm]), [[1, "easy", 8], [3, "tempo", 10], [5, "long", 20]]);
  assert.deepEqual(plan.strengthSessions.map((session) => [session.dayOffset, session.focus, session.hardestEffort]), [[2, "pull", "hard"]]);
  assert.deepEqual(plan.strengthSessions[0].goalWork, [{ exercise: "pullUp", sets: 4, target: 7, effort: "hard" }]);
  assert.equal(plan.generatedAt, GENERATED_AT);
  assert.deepEqual(plan.changeSignals, []);
  assert.equal(plan.keepUnlessChanged, true);
});

test("new logs, misses, runs off plan, and readiness changes since the plan are change signals", () => {
  const signals = (overrides: Partial<CoachRequest>) => buildCoachContext(request(overrides), NOW).currentPlan?.changeSignals ?? [];

  assert.deepEqual(signals({ trainingLogs: [log(at(-1, 18), { painLevel: 5 })] }), [
    "New log on 2026-05-11: pain 5/10.",
    "Readiness changed to recovery needed."
  ]);
  assert.deepEqual(signals({ trainingLogs: [log(at(-1, 18), { rpe: 8, plannedRPE: 6, rpeDelta: 2 })] }), ["New log on 2026-05-11: effort 2 above plan."]);
  assert.deepEqual(signals({ trainingLogs: [log("2026-05-10T18:00:00.000Z", { painLevel: 5 })] }), [], "an older log was already known");

  const missed = request();
  missed.plannedSessions.push(plannedStrength("y", -1, "missed"));
  assert.deepEqual(buildCoachContext(missed, NOW).currentPlan?.changeSignals, ["Missed session: Pull strength on 2026-05-11."]);

  const longer = request();
  longer.plannedSessions.push(plannedRun("y", -1, "easy", 8, "completed"));
  longer.running!.recentRuns.push({ completedAt: at(-1, 7), distanceKm: 16, movingSeconds: 5800, elevationGainM: 200, kind: "easy" });
  assert.deepEqual(buildCoachContext(longer, NOW).currentPlan?.changeSignals, ["Run on 2026-05-11: 16 km against 8 km planned."]);

  const onPlan = request();
  onPlan.plannedSessions.push(plannedRun("y", -1, "easy", 8, "completed"));
  onPlan.running!.recentRuns.push({ completedAt: at(-1, 7), distanceKm: 8.5, movingSeconds: 3000, elevationGainM: 90, kind: "easy" });
  assert.deepEqual(buildCoachContext(onPlan, NOW).currentPlan?.changeSignals, [], "a run done as planned changes nothing");

  const weak = request();
  weak.running!.recentRuns.push({ completedAt: at(-1, 7), distanceKm: 8, movingSeconds: 3000, elevationGainM: 90, kind: "easy", feelScore: 2 });
  assert.deepEqual(buildCoachContext(weak, NOW).currentPlan?.changeSignals, ["Run on 2026-05-11 felt weak."]);
});

test("a pain flag that cleared since the plan is a change signal too", () => {
  const cleared = request({
    trainingLogs: [log("2026-05-09T10:00:00.000Z", { painLevel: 5 }), log(at(-1, 18), { painLevel: 0 })]
  });

  assert.deepEqual(buildCoachContext(cleared, NOW).currentPlan?.changeSignals, [
    "Readiness is clear again (the pain or very weak flag has cleared)."
  ]);
});

test("the race window and a recovery week starting are change signals", () => {
  const nearRace = request({ running: { ...request().running!, raceGoal: { ...request().running!.raceGoal, raceDate: "2026-05-30T00:00:00Z" } } });
  assert.deepEqual(buildCoachContext(nearRace, NOW).currentPlan?.changeSignals, ["Race window: 18 day(s) to the race, so the limits move day by day."]);

  // Block start three weeks ago today: block week 4 starts today and is a recovery week.
  const recovery = request({ planBlockStartedAt: new Date(Date.parse(WEEK_START) - 21 * DAY_MS).toISOString() });
  const context = buildCoachContext(recovery, NOW);
  assert.equal(context.periodization?.recoveryWeekDue, true);
  assert.deepEqual(context.currentPlan?.changeSignals, ["A planned recovery week starts (block week 4)."]);
});

test("unchanged: a re-planned run keeps its kind and stays within 15% of its distance", () => {
  const context = buildCoachContext(request(), NOW);
  const week: RunningWeek = {
    summary: "Build week.",
    safetyFlags: [],
    sessions: [run("Easy", 1, "easy", 8), run("Tempo", 3, "easy", 10), run("Long", 5, "long", 26), run("Extra", 4, "easy", 6)]
  };

  const { week: kept, adjustments } = keepRunningContinuity(week, context.currentPlan!);

  assert.equal(kept.sessions[2].distanceKm, 23, "26 km back to 115% of the planned 20 km");
  assert.ok(kept.sessions[2].notes.some((note) => note.includes("Kept close to the earlier plan (20 km)")));
  assert.deepEqual(adjustments, [
    "Continuity, offset 3: tempo changed to easy although nothing changed.",
    "Continuity, offset 5: 26 km kept within 15% of the planned 20 km (23 km) because nothing changed.",
    "Continuity, offset 4: a easy run was added although nothing changed."
  ]);
  assert.equal(week.sessions[2].distanceKm, 26, "input is not mutated");
});

test("strength continuity is flagged, not clamped", () => {
  const context = buildCoachContext(request(), NOW);
  const plan = {
    summary: "Build: same week.",
    contextState: "building",
    safetyFlags: [],
    sessions: [{
      title: "Push strength",
      dayOffset: 2,
      focus: "push",
      exercises: [{ exercise: "pullUp", sets: 3, reps: 8, seconds: 0 }]
    }]
  } as unknown as WeeklyPlan;

  assert.deepEqual(strengthContinuityNotes(plan, context.currentPlan!), [
    "Continuity, offset 2: strength focus pull changed to push although nothing changed.",
    "Continuity, offset 2: pullUp 4 x 7 changed to 3 x 8 although nothing changed."
  ]);
});

test("the pipeline keeps yesterday's week when nothing changed, and lets it change when something did", async () => {
  const regenerate = async (req: CoachRequest) => {
    const context = buildCoachContext(req, NOW);
    const calls: RunningPlannerGuidance[] = [];
    const result = await runCombinedWeekPipeline({
      context,
      now: NOW,
      generateRunning: async (guidance) => {
        calls.push(guidance);
        return {
          ok: true,
          value: {
            summary: "Build week.",
            safetyFlags: [],
            sessions: [run("Easy", 1, "easy", 8), run("Tempo", 3, "tempo", 10), run("Long", 5, "long", 14), run("Recovery", 6, "recovery", 6)]
          }
        };
      },
      generateStrength: async () => ({
        ok: true,
        value: { summary: "Build: rest from strength.", contextState: context.readiness.state, safetyFlags: ["Strength rests this week."], sessions: [] }
      }),
      recordValidationFailure: async () => {}
    });
    return { result, calls };
  };

  const unchanged = await regenerate(request());
  assert.equal(unchanged.result.ok, true, JSON.stringify(unchanged.result));
  if (!unchanged.result.ok) return;
  assert.equal(unchanged.result.runningWeek.sessions[2].distanceKm, 17, "the long run stays within 15% of 20 km");
  assert.ok(unchanged.result.adjustments.some((a) => a.startsWith("Continuity, offset 5")));
  assert.deepEqual(unchanged.calls[0].continuity, { keepUnlessChanged: true, changeSignals: [], rule: unchanged.calls[0].continuity?.rule });

  const changed = await regenerate(request({ trainingLogs: [log(at(-1, 18), { rpe: 9 })] }));
  assert.equal(changed.result.ok, true, JSON.stringify(changed.result));
  if (!changed.result.ok) return;
  assert.equal(changed.result.runningWeek.sessions[2].distanceKm, 14, "a new signal lets the plan change");
  assert.deepEqual(changed.calls[0].continuity?.changeSignals, ["New log on 2026-05-11: RPE 9."]);
});

test("a newer plan from the auto-plan store replaces the app's older planned sessions", () => {
  const req = request();
  const context = buildCoachContext(req, NOW);
  const stored = {
    generatedAt: "2026-05-11T20:00:00.000Z",
    weekStart: "2026-05-11T00:00:00.000Z",
    runningWeek: {
      summary: "s",
      safetyFlags: [],
      sessions: [run("Easy", 2, "easy", 9), run("Long", 6, "long", 21)]
    }
  };

  const swapped = withStoredCurrentPlan(context, req, stored, NOW);

  assert.equal(swapped.currentPlan?.source, "auto_plan");
  assert.equal(swapped.currentPlan?.generatedAt, "2026-05-11T20:00:00.000Z");
  assert.deepEqual(swapped.currentPlan?.runs.map((r) => [r.dayOffset, r.kind, r.distanceKm]), [[1, "easy", 9], [5, "long", 21]]);
  const older = withStoredCurrentPlan(context, req, { ...stored, generatedAt: "2026-05-10T20:00:00.000Z" }, NOW);
  assert.equal(older.currentPlan?.source, "app", "the app's own plan is newer");
});

function run(title: string, dayOffset: number, kind: RunKind, distanceKm: number): RunningWeek["sessions"][number] {
  return {
    title,
    dayOffset,
    kind,
    purpose: "Aerobic work.",
    distanceKm,
    durationMinutes: Math.round(distanceKm * 6),
    elevationMeters: 100,
    target: { type: "hr", low: 132, high: 145 },
    zone: "Zone 2",
    notes: []
  };
}
