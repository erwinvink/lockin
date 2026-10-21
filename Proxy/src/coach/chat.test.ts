import assert from "node:assert/strict";
import test from "node:test";
import {
  COACH_CHAT_MAX_MESSAGES,
  COACH_CHAT_MAX_TEXT_LENGTH,
  buildCoachChatResponse,
  classifyCoachChatQuestion,
  normalizeCoachChatMessages,
  type CoachChatMessage
} from "./chat";
import { NOW, context, evaluation, signals } from "./chat.fixtures";

test("answers five connected coach questions with conversation memory and training evidence", () => {
  const messages: CoachChatMessage[] = [];
  const questions = [
    "Am I working well?",
    "Am I on schedule for the Eiger Ultra?",
    "What is my biggest improvement point?",
    "What can you say about fatigue?",
    "What about shoulder pain?"
  ];
  const answers: string[] = [];

  for (const question of questions) {
    messages.push({ role: "user", text: question });
    const response = buildCoachChatResponse({
      messages,
      context: context(),
      signals: signals(),
      evaluation: evaluation(),
      generatedAt: NOW
    });
    messages.push({ role: "coach", text: response.answer });
    answers.push(response.answer);

    assert.ok(response.evidence.some((item) => item.includes("Adherence is 86%")));
    assert.ok(response.evidence.some((item) => item.includes("Eiger Ultra 51K")));
  }

  assert.match(answers[0], /working well/i);
  assert.match(answers[1], /Earlier you asked about whether your work is on track/i);
  assert.match(answers[2], /Earlier you asked about whether your work is on track and your long-term schedule/i);
  assert.match(answers[3], /long-term schedule, and your biggest improvement point/i);
  assert.match(answers[4], /Earlier you asked about your long-term schedule, your biggest improvement point, and fatigue/i);
  assert.match(answers[4], /recent pain up to 4\/10/i);
  assert.match(answers[4], /Keep shoulders warm/i);
});

test("normalizes coach chat messages to a bounded recent transcript", () => {
  const messages: CoachChatMessage[] = Array.from({ length: COACH_CHAT_MAX_MESSAGES + 3 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "coach",
    text: ` turn ${index} `,
    createdAt: `2026-06-28T12:${String(index).padStart(2, "0")}:00Z`
  }));

  const normalized = normalizeCoachChatMessages(messages);

  assert.equal(normalized.length, COACH_CHAT_MAX_MESSAGES);
  assert.equal(normalized[0].text, "turn 3");
  assert.equal(normalized.at(-1)?.text, `turn ${COACH_CHAT_MAX_MESSAGES + 2}`);
});

test("rejects empty or oversized coach chat transcripts before answering", () => {
  assert.throws(
    () => normalizeCoachChatMessages([{ role: "coach", text: "What do you need?" }]),
    /at least one user chat message/i
  );
  assert.throws(
    () => normalizeCoachChatMessages([{ role: "user", text: "x".repeat(COACH_CHAT_MAX_TEXT_LENGTH + 1) }]),
    /characters or less/i
  );
});

test("matches chat intents on whole words, not inside other words (S9)", () => {
  assert.notEqual(classifyCoachChatQuestion("How is my training going?"), "unsupported");
  assert.equal(classifyCoachChatQuestion("Should I skip training today?"), "today");
  assert.equal(classifyCoachChatQuestion("Is my knee strain a problem?"), "pain");
  assert.notEqual(classifyCoachChatQuestion("What can I train around safely?"), "unsupported");
  assert.notEqual(classifyCoachChatQuestion("I just got back from Spain"), "pain");
  assert.notEqual(classifyCoachChatQuestion("I know the plan"), "today");
  assert.notEqual(classifyCoachChatQuestion("How is my relationship with lifting?"), "pain");
});

test("still recognises weather questions and word variants (S9)", () => {
  assert.equal(classifyCoachChatQuestion("Will it rain on Saturday?"), "unsupported");
  assert.equal(classifyCoachChatQuestion("Is it raining at the trailhead?"), "unsupported");
  assert.equal(classifyCoachChatQuestion("How windy will it be?"), "unsupported");
  assert.equal(classifyCoachChatQuestion("My calf is painful after the long run"), "pain");
  assert.equal(classifyCoachChatQuestion("My shoulder hurts"), "pain");
  assert.equal(classifyCoachChatQuestion("I feel so tired"), "fatigue");
});

test("truncates an over-long coach message in history instead of breaking the chat (S10)", () => {
  const normalized = normalizeCoachChatMessages([
    { role: "user", text: "What about my knee pain?" },
    { role: "coach", text: "y".repeat(COACH_CHAT_MAX_TEXT_LENGTH + 100) },
    { role: "user", text: "And what should I do today?" }
  ]);

  assert.equal(normalized.length, 3);
  assert.ok(normalized[1].text.length <= COACH_CHAT_MAX_TEXT_LENGTH);
});

test("keeps a pain answer that quotes a long profile note under the limit (S10)", () => {
  // Profile notes are capped at 800 characters in the coach context.
  const longNote = `Old knee injury from 2019, ${"physio says load it gradually and avoid deep flexion under fatigue; ".repeat(11)}`.slice(0, 800);
  const base = context();
  const response = buildCoachChatResponse({
    messages: [
      { role: "user", text: "Am I working well?" },
      { role: "coach", text: "Yes." },
      { role: "user", text: "Am I on schedule for the race?" },
      { role: "coach", text: "Mostly." },
      { role: "user", text: "What is my biggest improvement point?" },
      { role: "coach", text: "Long runs." },
      { role: "user", text: "What about my knee pain?" }
    ],
    context: { ...base, profile: { ...base.profile, profileNotes: longNote } },
    signals: signals(),
    evaluation: evaluation(),
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "pain");
  assert.ok(response.answer.length <= COACH_CHAT_MAX_TEXT_LENGTH, `answer is ${response.answer.length} characters`);
  assert.match(response.answer, /Old knee injury from 2019/);
  assert.doesNotThrow(() => normalizeCoachChatMessages([
    { role: "user", text: "What about my knee pain?" },
    { role: "coach", text: response.answer },
    { role: "user", text: "Should I skip today's session?" }
  ]));
});

test("answers unsupported weather or test prompts without repeating training state", () => {
  const response = buildCoachChatResponse({
    messages: [
      { role: "user", text: "Test" },
      { role: "coach", text: "The clean read is: watch." },
      { role: "user", text: "Ok new question, what's the weather today?" }
    ],
    context: context(),
    signals: signals(),
    evaluation: evaluation(),
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "unsupported");
  assert.equal(response.memorySummary, "");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /do not have live weather/i);
  assert.doesNotMatch(response.answer, /For today, follow the current plan/i);
  assert.doesNotMatch(response.answer, /The clean read is/i);
});

test("answers motivation requests like a coach instead of a metrics panel", () => {
  const response = buildCoachChatResponse({
    messages: [
      { role: "user", text: "How am I doing?" },
      { role: "coach", text: "The clean read is: on track." },
      { role: "user", text: "Can you motivate me?" }
    ],
    context: context(),
    signals: signals(),
    evaluation: evaluation(),
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "motivation");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /Keep going/i);
  assert.match(response.answer, /showing up/i);
  assert.match(response.answer, /one more honest/i);
  assert.doesNotMatch(response.answer, /The clean read is/i);
  assert.doesNotMatch(response.answer, /Readiness is/i);
  assert.doesNotMatch(response.answer, /Latest strength log/i);
});

test("keeps recovery motivation human instead of leaking dashboard status labels", () => {
  const recovering = evaluation();
  recovering.status = "needs_recovery";
  recovering.statusLabel = "Needs recovery";
  recovering.readiness.state = "recovery_needed";
  recovering.progress.state = "declining";

  const response = buildCoachChatResponse({
    messages: [{ role: "user", text: "Can you motivate me?" }],
    context: context(),
    signals: signals(),
    evaluation: recovering,
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "motivation");
  assert.deepEqual(response.evidence, []);
  assert.match(response.answer, /not where we want it yet/i);
  assert.match(response.answer, /holding back a little/i);
  assert.doesNotMatch(response.answer, /Needs recovery does not mean perfect/i);
  assert.doesNotMatch(response.answer, /Readiness is/i);
});

test("does not suggest extra work when no session is planned today", () => {
  const noTodayContext = context();
  noTodayContext.plannedWork.todaySessions = [];
  const noTodayEvaluation = evaluation();
  noTodayEvaluation.nextAction = "Rest today and be ready for the next planned session.";

  const response = buildCoachChatResponse({
    messages: [{ role: "user", text: "What should I do today?" }],
    context: noTodayContext,
    signals: signals(),
    evaluation: noTodayEvaluation,
    generatedAt: NOW
  });

  assert.equal(response.answerKind, "today");
  assert.match(response.answer, /do not add extra work/i);
  assert.match(response.answer, /I do not see a planned session today/i);
  assert.doesNotMatch(response.answer, /follow the current plan/i);
});
