import assert from "node:assert/strict";
import test from "node:test";
import { COACH_CHAT_MAX_TEXT_LENGTH, buildCoachChatResponse, type CoachChatMessage } from "./chat";
import { NOW, chatRequest, context, evaluation, signals } from "./chat.fixtures";
import {
  COACH_CHAT_MAX_OUTPUT_TOKENS,
  answerCoachChat,
  buildCoachChatRequestBody,
  coachChatReasoning,
  sanitizeCoachChatModelOutput,
  type CoachChatFallbackReason,
  type CoachChatModelCall
} from "./chat-model";
import { COACH_CHAT_SYSTEM_PROMPT } from "./chat-prompt";
import type { OpenAIResponseFetchResult } from "../openai-telemetry";

const modelAnswer = {
  answer: "Do today's session as written: 3x8 pull-ups at medium effort. Your last log hit 8 pull-ups at RPE 8 against a planned 6, so keep the reps clean and stop a rep early if form slips.",
  evidence: ["8 pull-ups on 26 Jun at RPE 8 (planned 6)", "Readiness: building"],
  followUpPrompts: ["How hard should it feel?", "What about my long run on Saturday?"],
  answerKind: "today"
};

function okResponse(payload: unknown): OpenAIResponseFetchResult {
  return {
    ok: true,
    status: 200,
    json: {
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        { type: "message", content: [{ type: "output_text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] }
      ]
    }
  };
}

function recordingCaller(result: OpenAIResponseFetchResult): { call: CoachChatModelCall; bodies: Array<Record<string, unknown>>; timeouts: number[] } {
  const bodies: Array<Record<string, unknown>> = [];
  const timeouts: number[] = [];
  return {
    bodies,
    timeouts,
    call: async (body, options) => {
      bodies.push(body);
      timeouts.push(options.timeoutMs);
      return result;
    }
  };
}

function chatInput(messages: CoachChatMessage[], callModel: CoachChatModelCall | null, extra: Partial<Parameters<typeof answerCoachChat>[0]> = {}) {
  return {
    messages,
    context: context(),
    signals: signals(),
    evaluation: evaluation(),
    request: chatRequest(),
    model: "gpt-6.1-sol",
    callModel,
    generatedAt: NOW,
    env: {},
    ...extra
  };
}

const conversation: CoachChatMessage[] = [
  { role: "user", text: "Am I on schedule for the Eiger Ultra?" },
  { role: "coach", text: "Yes, with one caveat: the long run is still the limiter at 16.4 km." },
  { role: "user", text: "What should I do today?" }
];

test("answers from the coach model and fills the server-side fields", async () => {
  const caller = recordingCaller(okResponse(modelAnswer));

  const response = await answerCoachChat(chatInput(conversation, caller.call));

  assert.equal(caller.bodies.length, 1);
  assert.equal(response.usedModel, true);
  assert.equal(response.answer, modelAnswer.answer);
  assert.deepEqual(response.evidence, modelAnswer.evidence);
  assert.deepEqual(response.followUpPrompts, modelAnswer.followUpPrompts);
  assert.equal(response.answerKind, "today");
  assert.equal(response.contextState, "building");
  assert.equal(response.memorySummary, "Earlier you asked about your long-term schedule");
  assert.equal(response.generatedAt, "2026-06-28T12:00:00Z");
});

test("sends the system prompt, a compact athlete summary, and the conversation", async () => {
  const caller = recordingCaller(okResponse(modelAnswer));
  await answerCoachChat(chatInput(conversation, caller.call));

  const body = caller.bodies[0];
  const input = body.input as Array<{ role: string; content: string }>;
  assert.equal(input[0].role, "system");
  assert.equal(input[0].content, COACH_CHAT_SYSTEM_PROMPT);
  assert.equal(input[1].role, "system");

  const data = input[1].content;
  for (const expected of [
    "Eiger Ultra 51K", // race goal
    "\"date\":\"2026-10-04\"", // race date
    "\"daysToRace\":98",
    "\"pullUps\":50", // strength goals
    "Keep shoulders warm before pull work.", // profile note
    "\"status\":\"On track\"", // coach read
    "\"completedPct\":86",
    "Complete the next planned session as written and log the result.", // next action
    "recent pain level 4 or higher", // risk flag, in words
    "Today Simulation", // today's session
    "pull-ups 3x8 medium",
    "Tempo run 8 km", // upcoming sessions
    "push-ups 4x26 hard",
    "pull-ups 3x7 hard, push-ups 3x24 medium, plank 3x95s medium", // prescription behind a log
    "pull-ups 8, push-ups 28, plank 95s", // what was logged
    "RPE 8 (planned 6)",
    "\"last7DaysKm\":24.6", // training signals
    "\"pacePerKm\":\"6:35\"", // recent run
    "\"sleepScore\":82" // Garmin wellness
  ]) {
    assert.ok(data.includes(expected), `athlete data should include ${expected}`);
  }
  assert.ok(!data.includes("recent_pain_level_4_or_higher"), "raw flags stay out of the prompt");
  assert.ok(data.length < 6_000, `athlete data is ${data.length} characters`);

  assert.deepEqual(input.slice(2), [
    { role: "user", content: "Am I on schedule for the Eiger Ultra?" },
    { role: "assistant", content: "Yes, with one caveat: the long run is still the limiter at 16.4 km." },
    { role: "user", content: "What should I do today?" }
  ]);
});

test("asks for strict structured output with a bounded, fast, unstored response", async () => {
  const caller = recordingCaller(okResponse(modelAnswer));
  await answerCoachChat(chatInput(conversation, caller.call, { timeoutMs: 12_345 }));

  const body = caller.bodies[0];
  assert.equal(body.model, "gpt-6.1-sol");
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.max_output_tokens, COACH_CHAT_MAX_OUTPUT_TOKENS);
  assert.equal(body.store, false);
  const format = (body.text as { format: Record<string, unknown> }).format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.strict, true);
  const schema = format.schema as { required: string[]; properties: Record<string, { enum?: string[] }> };
  assert.deepEqual(schema.required, ["answer", "evidence", "followUpPrompts", "answerKind"]);
  assert.ok(schema.properties.answerKind.enum?.includes("pain"));
  assert.deepEqual(caller.timeouts, [12_345]);
});

test("uses the athlete's chosen model and only sends reasoning effort to reasoning models", () => {
  const body = buildCoachChatRequestBody({ ...chatInput(conversation, null), model: "gpt-5-mini" });
  assert.equal(body.model, "gpt-5-mini");
  assert.deepEqual(body.reasoning, { effort: "low" });

  assert.deepEqual(coachChatReasoning("gpt-6.1-sol", {}), { effort: "low" });
  assert.equal(coachChatReasoning("gpt-4.1", {}), undefined);
  assert.deepEqual(coachChatReasoning("gpt-5.5", { COACH_CHAT_REASONING_EFFORT: "minimal" }), { effort: "minimal" });
  assert.equal(coachChatReasoning("gpt-5.5", { COACH_CHAT_REASONING_EFFORT: "off" }), undefined);
});

test("drops coach turns after the latest question so the model answers the athlete", async () => {
  const caller = recordingCaller(okResponse(modelAnswer));
  await answerCoachChat(chatInput([
    { role: "user", text: "What should I do today?" },
    { role: "coach", text: "Stale answer that never reached the athlete." }
  ], caller.call));

  const input = caller.bodies[0].input as Array<{ role: string; content: string }>;
  assert.deepEqual(input.at(-1), { role: "user", content: "What should I do today?" });
  assert.equal(input.length, 3);
});

async function fallbackFor(callModel: CoachChatModelCall | null, extra: Partial<Parameters<typeof answerCoachChat>[0]> = {}) {
  const reasons: CoachChatFallbackReason[] = [];
  const response = await answerCoachChat(chatInput(conversation, callModel, {
    onFallback: (reason) => reasons.push(reason),
    ...extra
  }));
  return { response, reasons };
}

const templateAnswer = () => buildCoachChatResponse({
  messages: conversation,
  context: context(),
  signals: signals(),
  evaluation: evaluation(),
  generatedAt: NOW
});

test("falls back to the template answer when there is no API key", async () => {
  const { response, reasons } = await fallbackFor(null);
  assert.deepEqual(reasons, ["no_api_key"]);
  assert.equal(response.usedModel, false);
  assert.deepEqual(response, templateAnswer());
});

test("falls back when the model call errors, throws, or times out", async () => {
  const cases: Array<[CoachChatFallbackReason, CoachChatModelCall, number?]> = [
    ["model_http_error", async () => ({ ok: false, status: 500, body: "{\"error\":\"boom\"}" })],
    ["model_timeout", async () => ({ ok: false, status: 504, body: "{\"error\":\"timed out\"}" })],
    ["model_call_failed", async () => { throw new Error("socket hang up"); }],
    ["model_timeout", () => new Promise<OpenAIResponseFetchResult>(() => undefined), 20]
  ];

  for (const [reason, call, timeoutMs] of cases) {
    const { response, reasons } = await fallbackFor(call, timeoutMs ? { timeoutMs } : {});
    assert.deepEqual(reasons, [reason]);
    assert.equal(response.usedModel, false);
    assert.equal(response.answer, templateAnswer().answer);
  }
});

test("falls back to the quick answer when a request field has an unexpected type", async () => {
  const base = context();
  assert.ok(base.history.last5Logs.length > 0, "fixture needs at least one log");
  const badContext = {
    ...base,
    history: { ...base.history, last5Logs: base.history.last5Logs.map((log) => ({ ...log, notes: 42 as unknown as string })) }
  };
  const caller = recordingCaller(okResponse(modelAnswer));
  const reasons: CoachChatFallbackReason[] = [];
  const response = await answerCoachChat(chatInput(conversation, caller.call, {
    context: badContext,
    onFallback: (reason) => reasons.push(reason)
  }));

  assert.deepEqual(reasons, ["request_unreadable"]);
  assert.equal(response.usedModel, false);
  assert.equal(caller.bodies.length, 0);
});

test("falls back when the model output is truncated, not JSON, or has no answer", async () => {
  const incomplete: OpenAIResponseFetchResult = { ok: true, status: 200, json: { status: "incomplete", output: [] } };
  const cases: Array<[CoachChatFallbackReason, OpenAIResponseFetchResult]> = [
    ["model_output_incomplete", incomplete],
    ["model_output_unreadable", okResponse("Sure! Here is your answer: do the session.")],
    ["model_output_unreadable", { ok: true, status: 200, json: { status: "completed", output: [] } }],
    ["model_output_invalid", okResponse({ answer: "   ", evidence: [], followUpPrompts: [], answerKind: "today" })],
    ["model_output_invalid", okResponse(["not", "an", "object"])]
  ];

  for (const [reason, result] of cases) {
    const { response, reasons } = await fallbackFor(recordingCaller(result).call);
    assert.deepEqual(reasons, [reason]);
    assert.equal(response.usedModel, false);
  }
});

test("pain questions still get conservative guidance when the model is unavailable", async () => {
  const response = await answerCoachChat(chatInput(
    [{ role: "user", text: "My left knee hurts after the long run" }],
    async () => ({ ok: false, status: 503, body: "" })
  ));

  assert.equal(response.usedModel, false);
  assert.equal(response.answerKind, "pain");
  assert.match(response.answer, /not a diagnosis/i);
  assert.match(response.answer, /Do not push through sharp, worsening/i);
  assert.match(response.answer, /stop and get medical help/i);
});

test("sanitizes model output before it reaches the app", () => {
  const output = sanitizeCoachChatModelOutput({
    answer: `## Today\n\n**Hold the plan.**\r\n\n\n\n${"Easy does it. ".repeat(150)}`,
    evidence: ["  Pain 4/10 | 21 Jun  ", "", "   ", "Pain 4/10 / 21 Jun", "Sleep 82", "RPE 8", "Adherence 86%", "extra"],
    followUpPrompts: [
      "What should I do today?",
      "  How hard should it feel?  ",
      "x".repeat(81),
      "Can I run tomorrow?",
      "Should I skip pull-ups?",
      "One too many?"
    ],
    answerKind: "made_up_kind"
  }, "What should I do today?");

  assert.ok(output);
  assert.ok(output.answer.startsWith("Today\n\nHold the plan.\n\nEasy does it."), output.answer.slice(0, 60));
  assert.ok(output.answer.length <= COACH_CHAT_MAX_TEXT_LENGTH);
  assert.ok(!output.answer.includes("**"));
  assert.deepEqual(output.evidence, ["Pain 4/10 / 21 Jun", "Sleep 82", "RPE 8", "Adherence 86%"]);
  assert.deepEqual(output.followUpPrompts, ["How hard should it feel?", "Can I run tomorrow?", "Should I skip pull-ups?"]);
  assert.equal(output.answerKind, "general");

  assert.equal(sanitizeCoachChatModelOutput(null), null);
  assert.equal(sanitizeCoachChatModelOutput({ answer: 42 }), null);
  assert.deepEqual(sanitizeCoachChatModelOutput({ answer: "Rest today." }), {
    answer: "Rest today.",
    evidence: [],
    followUpPrompts: [],
    answerKind: "general"
  });
});
