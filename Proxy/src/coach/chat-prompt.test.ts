import assert from "node:assert/strict";
import test from "node:test";
import { NOW, POST_RACE_STRENGTH, chatRequest, context, evaluation, signals } from "./chat.fixtures";
import { buildCoachChatContextPayload, COACH_CHAT_SYSTEM_PROMPT } from "./chat-prompt";
import { buildCoachContext } from "./planner/build-coach-context";

function payloadText(overrides: { context?: ReturnType<typeof context> } = {}): string {
  return JSON.stringify(
    buildCoachChatContextPayload({
      messages: [{ role: "user", text: "What is next?" }],
      context: overrides.context ?? context(),
      signals: signals(),
      evaluation: evaluation(),
      request: chatRequest(),
      now: NOW
    })
  );
}

test("a planned run's prescription reaches the chat: kind, distance, climb, target and zone", () => {
  assert.ok(payloadText().includes("tempo run, 8 km, 60 m climb, pace 5:00-5:15 per km, Zone 3"));
});

test("the chat system prompt promises running toward a race only while one is planned", () => {
  assert.ok(!COACH_CHAT_SYSTEM_PROMPT.includes("running toward that race"));
  assert.match(COACH_CHAT_SYSTEM_PROMPT, /race\.seasonNote/);
});

test("the chat reads the race through the computed season", () => {
  const racePayload = (raced: ReturnType<typeof context>, raceSignals: ReturnType<typeof signals>["race"]) => (buildCoachChatContextPayload({
    messages: [{ role: "user", text: "Am I on schedule?" }],
    context: raced,
    signals: { ...signals(), race: raceSignals },
    evaluation: evaluation(),
    request: chatRequest(),
    now: NOW
  }) as { race: Record<string, unknown> }).race;

  // 98 days to the race: base phase, counted down in days and weeks.
  const upcoming = racePayload(context(), signals().race);
  assert.deepEqual([upcoming.daysToRace, upcoming.weeksToRace, upcoming.phase], [98, 14, "base"]);
  assert.equal(upcoming.seasonNote, "Eiger Ultra 51K is in 98 days: base phase, running and strength balanced.");

  // 3 days after the race: how long ago it was, never "0 weeks out" or in taper.
  const base = context();
  const raced = { ...base, running: { ...base.running!, raceGoal: { ...base.running!.raceGoal, raceDate: "2026-06-25T00:00:00Z" }, weeksToRace: 0 } };
  const past = racePayload(raced, { daysToRace: null, daysSinceRace: 3, weeksToRace: 0, taperStatus: "post-race" });
  assert.deepEqual([past.daysSinceRace, past.daysToRace, past.weeksToRace, past.phase], [3, undefined, undefined, "transition"]);
  assert.equal(past.seasonNote, `Eiger Ultra 51K was 3 days ago: post-race transition until day 13 after the race, running recovers first while ${POST_RACE_STRENGTH}.`);

  // A blank race name is left out; the season calls it "your race".
  const unnamed = racePayload({ ...base, running: { ...base.running!, raceGoal: { ...base.running!.raceGoal, name: "  " } } }, signals().race);
  assert.equal(unnamed.name, undefined);
  assert.match(String(unnamed.seasonNote), /^Your race is in 98 days: /);
});

test("a planned recovery week reaches the chat in plain words", () => {
  const withRecovery = context();
  withRecovery.periodization = {
    cycle: "3:1",
    blockWeek: 4,
    loadingWeeksSinceRecovery: 3,
    lastUnloadingWeek: null,
    recoveryWeekDue: true,
    recoveryWeekReason: "3 loading weeks since the block start: block week 4 is a planned recovery week (3:1).",
    recoveryWeek: null,
    recentWeeks: []
  };

  assert.ok(payloadText({ context: withRecovery }).includes(
    "\"plannedRecoveryWeek\":\"3 loading weeks since the block start: block week 4 is a planned recovery week (3:1).\""
  ));
});

// Athlete report: he did 38 push-ups on an easy day that asked for 10, rated
// it hard, and the coach told him the plan was too hard. The chat sees what
// was delivered against the plan, and over-delivery is not "above plan" effort.
test("the chat sees work done beyond the plan as more than planned, not as effort above plan", () => {
  const request = {
    ...chatRequest(),
    plannedSessions: [
      ...chatRequest().plannedSessions,
      ...["2026-06-24", "2026-06-26"].map((day) => ({
        id: `easy-${day}`,
        scheduledDate: `${day}T00:00:00Z`,
        title: "Easy push",
        focus: "push" as const,
        status: "completed",
        exercises: [{ exercise: "pushUp" as const, sets: 2, targetReps: 10, targetSeconds: 0, plannedEffortLabel: "medium" as const, plannedEffortStimulus: "volume" as const }]
      }))
    ],
    trainingLogs: ["2026-06-24", "2026-06-26"].map((day, index) => ({
      sessionId: `easy-${day}`,
      completedAt: `${day}T17:00:00Z`,
      pullUps: 0,
      pushUps: 35 + index * 3,
      plankSeconds: 0,
      loggedPullUps: false,
      loggedPushUps: true,
      loggedPlankSeconds: false,
      rpe: 8,
      plannedRPE: 5,
      painLevel: 0,
      fatigueLevel: 3,
      notes: ""
    }))
  };
  const payload = buildCoachChatContextPayload({
    messages: [{ role: "user", text: "Was that too much?" }],
    context: buildCoachContext(request, NOW),
    signals: signals(),
    evaluation: evaluation(),
    request,
    now: NOW
  }) as { strength: { effortVsPlan: Record<string, unknown>; recentLogs: Array<Record<string, unknown>> } };

  assert.equal(payload.strength.effortVsPlan.sessionsWithMoreThanPlanned, 2);
  assert.equal(payload.strength.effortVsPlan.sessionsTwoOrMoreAbovePlan, 0);
  assert.equal(payload.strength.recentLogs[0].deliveredVsPlan, "more than planned: 38 push-ups against 10 planned");
});

// Final review item 9: "Do not add training beyond the plan" contradicted the
// athlete's core principle that doing more than planned counts. The chat
// never prescribes extra sessions, but extra work on a good day is fine,
// counts, and the coach plans from it; the safety half stays.
test("the chat never prescribes extra sessions, but counts extra work done on a good day", () => {
  assert.ok(!COACH_CHAT_SYSTEM_PROMPT.includes("Do not add training beyond the plan"));
  assert.match(COACH_CHAT_SYSTEM_PROMPT, /Never prescribe extra sessions beyond the plan/);
  assert.match(COACH_CHAT_SYSTEM_PROMPT, /does more than planned on a day they feel good, that is fine and it counts/);
  assert.match(COACH_CHAT_SYSTEM_PROMPT, /plans from it/);
  assert.match(COACH_CHAT_SYSTEM_PROMPT, /When readiness or pain says back off, say back off\./);
});
