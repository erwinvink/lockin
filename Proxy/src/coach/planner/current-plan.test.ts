import assert from "node:assert/strict";
import test from "node:test";
import { runCombinedWeekPipeline, type RunningPlannerGuidance } from "../plan-pipeline";
import { buildCoachContext } from "./build-coach-context";
import { continuityState, keepRunningContinuity, startsFreshPlan, strengthContinuityNotes, withoutCurrentPlan, withStoredCurrentPlan } from "./current-plan";
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
  assert.deepEqual(plan.strengthSessions[0].goalWork, [{ exercise: "pullUp", sets: 4, target: 7, effort: "hard", stimulus: "strength" }]);
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

// The plan was made while the pain flag held (recovery needed); with readiness
// normal again the exit signal releases it (Task 8; it used to read "Readiness
// is clear again", which now stays for a flag clearing into overreaching).
test("a pain flag that cleared since the plan is a change signal too", () => {
  const cleared = request({
    trainingLogs: [log("2026-05-09T10:00:00.000Z", { painLevel: 5 }), log(at(-1, 18), { painLevel: 0 })]
  });

  assert.deepEqual(buildCoachContext(cleared, NOW).currentPlan?.changeSignals, [
    "Readiness is back to normal: return to the full plan."
  ]);
});

// Task 8 (audit Q4): leaving a reduced state used to create no change signal,
// so continuity kept the eased plan ("nothing in your training changed").
// Three sessions done as planned and rated 2 above plan, all within 14 days
// when the plan was made last night: overreaching (the effort persists). By
// tonight the oldest is 15 days old, so it no longer persists: normal again.
const EFFORT_ABOVE_PLAN_LOGS = ["2026-04-27T12:00:00.000Z", "2026-05-02T12:00:00.000Z", "2026-05-06T12:00:00.000Z"]
  .map((day) => log(day, { rpe: 8, plannedRPE: 6, rpeDelta: 2 }));

test("leaving overreaching adds a back-to-normal change signal", async () => {
  const context = buildCoachContext(request({ trainingLogs: EFFORT_ABOVE_PLAN_LOGS }), NOW);
  const madeThen = buildCoachContext(request({ trainingLogs: EFFORT_ABOVE_PLAN_LOGS, weekStart: "2026-05-11T00:00:00.000Z" }), new Date(GENERATED_AT));

  assert.equal(madeThen.readiness.state, "overreaching", "the state when the plan was made");
  assert.notEqual(context.readiness.state, "overreaching");
  assert.deepEqual(context.currentPlan?.changeSignals, ["Readiness is back to normal: return to the full plan."]);
  assert.equal(context.currentPlan?.keepUnlessChanged, false);

  // Continuity is released for both planners.
  const continuity: Array<{ stage: string; keep: boolean | undefined }> = [];
  await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (guidance) => {
      continuity.push({ stage: "running", keep: guidance.continuity?.keepUnlessChanged });
      return { ok: true, value: { summary: "Back to the full plan.", safetyFlags: [], sessions: [run("Easy", 1, "easy", 8), run("Tempo", 3, "tempo", 10), run("Long", 5, "long", 20), run("Easy", 6, "easy", 6)] } };
    },
    generateStrength: async (guidance) => {
      continuity.push({ stage: "strength", keep: guidance.continuity?.keepUnlessChanged });
      return { ok: true, value: { summary: "Build: back to the full plan.", contextState: context.readiness.state, safetyFlags: [], sessions: [] } };
    },
    recordValidationFailure: async () => {}
  });
  assert.deepEqual(continuity.slice(0, 2), [{ stage: "running", keep: false }, { stage: "strength", keep: false }]);
});

// Code review: the readiness signals come from the two computed states only
// (when the plan was made, and now). A pain flag that clears while effort
// above plan persists leaves readiness overreaching, not "clear again".
test("a pain flag clearing into overreaching says so, not that readiness is clear", () => {
  const above = (day: string, overrides: Partial<TrainingLog> = {}) => log(day, { rpe: 8, plannedRPE: 6, rpeDelta: 2, ...overrides });
  const context = buildCoachContext(request({
    trainingLogs: [
      above("2026-05-02T12:00:00.000Z"),
      above("2026-05-06T12:00:00.000Z"),
      above("2026-05-09T12:00:00.000Z", { painLevel: 5 }),
      above(at(-1, 18))
    ]
  }), NOW);

  assert.equal(context.readiness.state, "overreaching");
  assert.ok(context.currentPlan?.changeSignals.includes("Readiness changed from recovery needed to overreaching."), JSON.stringify(context.currentPlan?.changeSignals));
  assert.ok(!context.currentPlan?.changeSignals.some((signal) => signal.startsWith("Readiness is clear again")));
});

test("staying overreaching, or never leaving normal, adds no back-to-normal signal", () => {
  const stillOverreaching = request({ trainingLogs: [...EFFORT_ABOVE_PLAN_LOGS.slice(1), log("2026-05-09T12:00:00.000Z", { rpe: 8, plannedRPE: 6, rpeDelta: 2 })] });
  const steady = request({ trainingLogs: [log("2026-05-06T12:00:00.000Z"), log("2026-05-09T12:00:00.000Z")] });

  assert.equal(buildCoachContext(stillOverreaching, NOW).readiness.state, "overreaching");
  assert.ok(!(buildCoachContext(stillOverreaching, NOW).currentPlan?.changeSignals ?? []).some((signal) => signal.startsWith("Readiness is back to normal")));
  assert.deepEqual(buildCoachContext(steady, NOW).currentPlan?.changeSignals, []);
});

test("the race window and a recovery week starting are change signals", () => {
  const nearRace = request({ running: { ...request().running!, raceGoal: { ...request().running!.raceGoal, raceDate: "2026-05-30T00:00:00Z" } } });
  assert.deepEqual(buildCoachContext(nearRace, NOW).currentPlan?.changeSignals, ["Race window: 18 days to the race, so the limits move day by day."]);

  // Block start three weeks ago today: block week 4 starts today and is a recovery week.
  const recovery = request({ planBlockStartedAt: new Date(Date.parse(WEEK_START) - 21 * DAY_MS).toISOString() });
  const context = buildCoachContext(recovery, NOW);
  assert.equal(context.periodization?.recoveryWeekDue, true);
  assert.deepEqual(context.currentPlan?.changeSignals, ["A planned recovery week starts (block week 4)."]);
});

// Final review item 7: "The recovery week is over." fired after any lighter
// week, such as the post-race weeks. It now follows a planned recovery week only.
test("the recovery week is over only after a planned recovery week, not after the post-race weeks", () => {
  // Day 15 after a 54 km race; block week 3 starts today, block week 2 held post-race days 8-14.
  const afterPostRace = buildCoachContext({ ...lastWindowDayRequest(), planBlockStartedAt: new Date(Date.parse(WEEK_START) - 14 * DAY_MS).toISOString() }, NOW);
  assert.equal(afterPostRace.periodization?.lastUnloadingWeek?.blockWeek, 2);
  assert.equal(afterPostRace.periodization?.lastUnloadingWeek?.classification, "taper_or_race");
  const postRaceSignals = afterPostRace.currentPlan?.changeSignals ?? [];
  assert.ok(!postRaceSignals.includes("The recovery week is over."), JSON.stringify(postRaceSignals));

  // Eight steady weeks; block week 5 starts today and block week 4 was the planned recovery week (3:1), run lighter.
  const weekStart = Date.parse(WEEK_START);
  const eightWeeks = [...steadyRuns(), ...steadyRuns().map((run) => ({ ...run, completedAt: new Date(Date.parse(run.completedAt) - 28 * DAY_MS).toISOString() }))]
    .map((run) => (Date.parse(run.completedAt) >= weekStart - 7 * DAY_MS ? { ...run, distanceKm: Math.round(run.distanceKm * 0.6) } : run));
  const afterRecovery = buildCoachContext(request({
    planBlockStartedAt: new Date(weekStart - 28 * DAY_MS).toISOString(),
    running: { ...request().running!, recentRuns: eightWeeks }
  }), NOW);
  assert.equal(afterRecovery.periodization?.recoveryWeekDue, false);
  assert.equal(afterRecovery.periodization?.lastUnloadingWeek?.blockWeek, 4);
  assert.ok(afterRecovery.currentPlan?.changeSignals.includes("The recovery week is over."), JSON.stringify(afterRecovery.currentPlan?.changeSignals));
});

test("the race-window signal lasts as long as the race's post-race rules", () => {
  const raced = (daysAgo: number, distanceKm: number) => request({
    running: {
      ...request().running!,
      raceGoal: { name: "Trail race", raceDate: new Date(Date.parse(WEEK_START) - daysAgo * DAY_MS).toISOString(), distanceKm, elevationGainM: 3000 }
    }
  });

  // Day 20 after a 100 km race the post-race limits still move until day 25.
  assert.deepEqual(buildCoachContext(raced(20, 100), NOW).currentPlan?.changeSignals, ["Race window: 20 days after the race, so the limits move day by day."]);
  // Day 20 after a 54 km race its 14-day window is over.
  assert.deepEqual(buildCoachContext(raced(20, 54), NOW).currentPlan?.changeSignals, []);
});

// The plan made on day 14 after a 54 km race was a transition week; on day 15
// the season is general preparation, with its quality and weekly-km floors.
function lastWindowDayRequest(plannedSessions: PlannedSession[] = request().plannedSessions): CoachRequest {
  return request({
    plannedSessions,
    running: {
      ...request().running!,
      raceGoal: { name: "Trail 54K", raceDate: new Date(Date.parse(WEEK_START) - 15 * DAY_MS).toISOString(), distanceKm: 54, elevationGainM: 1400 }
    }
  });
}

test("a season phase change since the plan was made is a change signal", () => {
  assert.deepEqual(buildCoachContext(lastWindowDayRequest(), NOW).currentPlan?.changeSignals, [
    "The season moved from post-race transition to general preparation since the plan was made."
  ]);
});

test("the day the post-race window ends, yesterday's easy week may grow to the new floors", async () => {
  const easyTransitionWeek = [plannedRun("r1", 1, "easy", 5), plannedRun("r3", 3, "easy", 5), plannedRun("r5", 5, "long", 9)];
  const context = buildCoachContext({ ...lastWindowDayRequest(easyTransitionWeek), trainingDays: ["tuesday"], trainingDayOffsets: [] }, NOW);

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async () => ({
      ok: true,
      value: {
        summary: "General preparation starts: back to full volume with one speed session.",
        safetyFlags: [],
        sessions: [run("Easy", 1, "easy", 8), run("Hill intervals", 3, "hills", 8), run("Long", 5, "long", 16), run("Easy", 6, "easy", 7)]
      }
    }),
    generateStrength: async () => ({
      ok: true,
      value: { summary: "Build: no strength day left this week.", contextState: context.readiness.state, safetyFlags: ["The week's only strength day is today."], sessions: [] }
    }),
    recordValidationFailure: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.runningWeek.sessions.map((session) => session.distanceKm), [8, 8, 16, 7], "not clamped back to the transition week");
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
            // 39 km: the base phase's weekly-km floor is 38.3 km (85% of 45 km).
            sessions: [run("Easy", 1, "easy", 8), run("Tempo", 3, "tempo", 10), run("Long", 5, "long", 14), run("Recovery", 6, "recovery", 7)]
          }
        };
      },
      generateStrength: async () => ({
        ok: true,
        value: { summary: "Build: no strength day left this week.", contextState: context.readiness.state, safetyFlags: ["The week's only strength day is today."], sessions: [] }
      }),
      recordValidationFailure: async () => {}
    });
    return { result, calls };
  };

  // The only strength day is today (a Tuesday), so an empty strength week is
  // right; this test is about the running week.
  const noStrengthDayLeft: Partial<CoachRequest> = {
    trainingDays: ["tuesday"],
    trainingDayOffsets: [],
    plannedSessions: request().plannedSessions.filter((session) => session.id !== "s2")
  };
  const unchanged = await regenerate(request(noStrengthDayLeft));
  assert.equal(unchanged.result.ok, true, JSON.stringify(unchanged.result));
  if (!unchanged.result.ok) return;
  assert.equal(unchanged.result.runningWeek.sessions[2].distanceKm, 17, "the long run stays within 15% of 20 km");
  assert.ok(unchanged.result.adjustments.some((a) => a.startsWith("Continuity, offset 5")));
  assert.deepEqual(unchanged.calls[0].continuity, { keepUnlessChanged: true, changeSignals: [], rule: unchanged.calls[0].continuity?.rule });

  const changed = await regenerate(request({ ...noStrengthDayLeft, trainingLogs: [log(at(-1, 18), { rpe: 9 })] }));
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

test("a regenerate the athlete asks for starts fresh: no earlier plan to keep, today's run stays", () => {
  assert.equal(startsFreshPlan("manual", true), true);
  assert.equal(startsFreshPlan("manual", false), false);
  assert.equal(startsFreshPlan("nightly", true), false);
  assert.equal(startsFreshPlan("app_active", false), false);

  const req = request({ plannedSessions: [...request().plannedSessions, plannedRun("today", 0, "easy", 6)] });
  const stored = {
    generatedAt: "2026-05-11T20:00:00.000Z",
    weekStart: "2026-05-11T00:00:00.000Z",
    runningWeek: { summary: "s", safetyFlags: [], sessions: [run("Easy", 2, "easy", 9), run("Long", 6, "long", 21)] }
  };
  const context = withStoredCurrentPlan(buildCoachContext(req, NOW), req, stored, NOW);
  assert.ok(context.currentPlan);

  const fresh = withoutCurrentPlan(context);

  assert.equal(fresh.currentPlan, undefined);
  assert.deepEqual(fresh.todayPlannedRuns, context.todayPlannedRuns, "today's run is still locked");
  assert.equal(continuityState(fresh), null, "the planners get no continuity rule");
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

// Finding (athlete report): 38 push-ups on an easy day that asked for 10,
// rated hard, reached the planner as "effort 3 above plan" and the plan eased
// off. The change signal names what was delivered: more than planned.
test("a new log that did clearly more than planned reads as more, not as effort above plan", () => {
  const easyPush: PlannedSession = {
    id: "easy-push",
    scheduledDate: "2026-05-11T00:00:00.000Z",
    title: "Easy push",
    focus: "push",
    status: "completed",
    exercises: [{ exercise: "pushUp", sets: 2, targetReps: 10, targetSeconds: 0, plannedEffortLabel: "medium", plannedEffortStimulus: "volume" }]
  };
  const context = buildCoachContext(request({
    plannedSessions: [...request().plannedSessions, easyPush],
    trainingLogs: [log("2026-05-11T18:00:00.000Z", {
      sessionId: "easy-push", pushUps: 38, loggedPullUps: false, loggedPlankSeconds: false, rpe: 8, plannedRPE: 5, rpeDelta: 3
    })]
  }), NOW);
  const signals = context.currentPlan?.changeSignals ?? [];

  assert.ok(signals.some((signal) => signal.includes("did more than planned (38 push-ups against 10 planned)")), signals.join("\n"));
  assert.ok(!signals.some((signal) => signal.includes("above plan")), signals.join("\n"));
});

test("doing more than planned at the planned effort does not claim a higher effort", () => {
  const easyPush: PlannedSession = {
    id: "easy-push",
    scheduledDate: "2026-05-11T00:00:00.000Z",
    title: "Easy push",
    focus: "push",
    status: "completed",
    exercises: [{ exercise: "pushUp", sets: 2, targetReps: 10, targetSeconds: 0, plannedEffortLabel: "medium", plannedEffortStimulus: "volume" }]
  };
  const context = buildCoachContext(request({
    plannedSessions: [...request().plannedSessions, easyPush],
    trainingLogs: [log("2026-05-11T18:00:00.000Z", {
      sessionId: "easy-push", pushUps: 25, loggedPullUps: false, loggedPlankSeconds: false, rpe: 6, plannedRPE: 6, rpeDelta: 0
    })]
  }), NOW);
  const signals = context.currentPlan?.changeSignals ?? [];

  assert.ok(signals.includes("New log on 2026-05-11: did more than planned (25 push-ups against 10 planned)."), signals.join("\n"));
});

// Garmin data arrives after the context is built, so the pipeline adds a
// tripped wellness gate to the change signals: yesterday's week may change.
test("a tripped wellness gate is a continuity change signal", async () => {
  const context = buildCoachContext(request({ trainingDays: ["tuesday"], trainingDayOffsets: [], plannedSessions: request().plannedSessions.filter((session) => session.id !== "s2") }), NOW);
  context.garmin = {
    wellness: [{ date: "2026-05-12", sleepScore: 75, sleepSeconds: 26000, hrvStatus: "LOW", hrvMs: 38, bodyBattery: 50, trainingReadiness: 40, restingHr: 50 }]
  };
  const calls: RunningPlannerGuidance[] = [];

  const result = await runCombinedWeekPipeline({
    context,
    now: NOW,
    generateRunning: async (guidance) => {
      calls.push(guidance);
      return { ok: true, value: { summary: "s", safetyFlags: [], sessions: [run("Easy", 1, "easy", 8), run("Tempo", 3, "tempo", 10), run("Long", 5, "long", 14), run("Recovery", 6, "recovery", 7)] } };
    },
    generateStrength: async () => ({
      ok: true,
      value: { summary: "Build: no strength day left this week.", contextState: context.readiness.state, safetyFlags: ["The week's only strength day is today."], sessions: [] }
    }),
    recordValidationFailure: async () => {}
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(calls[0].continuity?.keepUnlessChanged, false);
  assert.deepEqual(calls[0].continuity?.changeSignals, ["HRV status LOW on 2026-05-12 (below the athlete's baseline)."]);
});

// The nightly plan covers offsets 1-6; today's run (offset 0, locked) counts
// toward the week's running floors, so the context carries it.
test("today's planned run reaches the context, from a newer stored plan when there is one", () => {
  const req = request({ plannedSessions: [...request().plannedSessions, plannedRun("today", 0, "tempo", 9)] });
  const context = buildCoachContext(req, NOW);
  assert.deepEqual(context.todayPlannedRuns?.map((entry) => [entry.dayOffset, entry.kind, entry.distanceKm]), [[0, "tempo", 9]]);
  assert.ok(!context.currentPlan?.runs.some((entry) => entry.dayOffset === 0), "continuity keeps offsets 1-6 only");

  const done = request({ plannedSessions: [...request().plannedSessions, plannedRun("today", 0, "tempo", 9, "completed")] });
  assert.equal(buildCoachContext(done, NOW).todayPlannedRuns, undefined, "a run done today is in recentRuns, not planned");

  const stored = {
    generatedAt: "2026-05-11T20:00:00.000Z",
    weekStart: "2026-05-11T00:00:00.000Z",
    runningWeek: { summary: "s", safetyFlags: [], sessions: [run("Long", 1, "long", 16), run("Easy", 2, "easy", 9)] }
  };
  const swapped = withStoredCurrentPlan(context, req, stored, NOW);
  assert.deepEqual(swapped.todayPlannedRuns?.map((entry) => [entry.dayOffset, entry.kind, entry.distanceKm]), [[0, "long", 16]]);
});

// Effort is judged against the plan (effort-flags.ts): a planned test or a
// very-hard session rated as planned is the plan, not an effort warning. A
// test still changes the plan: it sets a new level.
test("a planned test or very-hard session rated as planned reads as a result, not an effort warning", () => {
  const signals = (session: PlannedSession, logged: Partial<TrainingLog>) =>
    buildCoachContext(request({
      plannedSessions: [...request().plannedSessions, session],
      trainingLogs: [log(at(-1, 18), { sessionId: session.id, loggedPullUps: false, loggedPlankSeconds: false, ...logged })]
    }), NOW).currentPlan?.changeSignals ?? [];
  const pushSession = (id: string, label: "very_hard" | "max_output", target: number): PlannedSession => ({
    id, scheduledDate: at(-1), title: "Push strength", focus: "push", status: "completed",
    exercises: [{ exercise: "pushUp", sets: label === "max_output" ? 1 : 3, targetReps: target, targetSeconds: 0, plannedEffortLabel: label, plannedEffortStimulus: label === "max_output" ? "test" : "strength" }]
  });

  assert.deepEqual(signals(pushSession("test", "max_output", 40), { pushUps: 42, rpe: 10, plannedRPE: 10 }), ["New log on 2026-05-11: test result 42 push-ups."]);
  assert.deepEqual(signals(pushSession("near-max", "very_hard", 26), { pushUps: 26, rpe: 9, plannedRPE: 9 }), []);
});
