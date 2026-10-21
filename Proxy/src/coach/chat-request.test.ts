import assert from "node:assert/strict";
import test from "node:test";
import { ClientInputError } from "../http-body";
import { COACH_CHAT_MAX_TEXT_LENGTH } from "./chat";
import { chatRequest } from "./chat.fixtures";
import { assertCoachRequestShape, buildCoachContextFromClient, parseCoachChatPayload } from "./chat-request";
import { buildCoachContext } from "./planner/build-coach-context";

const question = [{ role: "user", text: "What should I do today?" }];

test("parses a chat payload into a coach request and normalized turns", () => {
  const parsed = parseCoachChatPayload({
    request: chatRequest(),
    messages: [...question, { role: "coach", text: " Rest. ", createdAt: "2026-06-28T12:00:00Z" }, { role: "user", text: "Why?" }]
  });

  assert.equal(parsed.request.model, "gpt-6.1-sol");
  assert.deepEqual(parsed.messages.map((message) => message.text), ["What should I do today?", "Rest.", "Why?"]);
  assert.equal(parsed.messages[1].createdAt, "2026-06-28T12:00:00Z");
});

test("rejects malformed chat payloads as client input errors", () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /request object is required/],
    [{ messages: question }, /request object is required/],
    [{ request: chatRequest() }, /messages array is required/],
    [{ request: chatRequest(), messages: ["hi"] }, /must be an object/],
    [{ request: chatRequest(), messages: [{ role: "system", text: "hi" }] }, /role must be user or coach/],
    [{ request: chatRequest(), messages: [{ role: "user", text: "  " }] }, /text is required/],
    [{ request: chatRequest(), messages: [{ role: "coach", text: "Hello" }] }, /at least one user chat message/],
    [{ request: chatRequest(), messages: [{ role: "user", text: "x".repeat(COACH_CHAT_MAX_TEXT_LENGTH + 1) }] }, /characters or less/],
    [{ request: { ...chatRequest(), trainingLogs: "none" }, messages: question }, /trainingLogs must be an array/]
  ];

  for (const [payload, message] of cases) {
    assert.throws(() => parseCoachChatPayload(payload), (error: unknown) => {
      assert.ok(error instanceof ClientInputError, `expected a ClientInputError for ${JSON.stringify(payload)?.slice(0, 80)}`);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("checks the coach request fields the context builder relies on", () => {
  assert.doesNotThrow(() => assertCoachRequestShape(chatRequest()));
  assert.doesNotThrow(() => assertCoachRequestShape({ ...chatRequest(), running: undefined, profileNotes: undefined }));

  const broken: Array<[Record<string, unknown>, RegExp]> = [
    [{ ...chatRequest(), baseline: undefined }, /baseline must have numeric/],
    [{ ...chatRequest(), goals: { pullUps: "50", pushUps: 100, plankSeconds: 300 } }, /goals must have numeric/],
    [{ ...chatRequest(), equipment: null }, /equipment must be an array/],
    [{ ...chatRequest(), plannedSessions: [null] }, /must be objects/],
    [{ ...chatRequest(), weekStart: 20260628 }, /weekStart and request.weeklySessions/],
    [{ ...chatRequest(), profileNotes: 7 }, /profileNotes must be a string/],
    [{ ...chatRequest(), running: { raceGoal: {} } }, /recentRuns array/]
  ];
  for (const [request, message] of broken) {
    assert.throws(() => assertCoachRequestShape(request), (error: unknown) => error instanceof ClientInputError && message.test(error.message));
  }
});

test("turns a context-builder crash on bad input into a client error, and rethrows real faults", () => {
  assert.doesNotThrow(() => buildCoachContextFromClient(chatRequest(), (request) => buildCoachContext(request)));
  assert.throws(
    () => buildCoachContextFromClient(chatRequest(), () => { throw new TypeError("Cannot read properties of undefined (reading 'raceDate')"); }),
    (error: unknown) => error instanceof ClientInputError && /could not be read as a coach request/.test(error.message)
  );
  assert.throws(
    () => buildCoachContextFromClient(chatRequest(), () => { throw new Error("disk full"); }),
    (error: unknown) => !(error instanceof ClientInputError) && error instanceof Error && error.message === "disk full"
  );
});
