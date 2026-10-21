import assert from "node:assert/strict";
import test from "node:test";
import { NOW, chatRequest, context, evaluation, signals } from "./chat.fixtures";
import { buildCoachChatContextPayload } from "./chat-prompt";

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
