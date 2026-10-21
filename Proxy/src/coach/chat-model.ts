import type { OpenAIResponseFetchResult } from "../openai-telemetry";
import {
  COACH_CHAT_INTENTS,
  COACH_CHAT_MAX_TEXT_LENGTH,
  buildCoachChatResponse,
  formatGeneratedAt,
  latestUserQuestion,
  normalizeCoachChatMessages,
  summarizeEarlierQuestions,
  truncateText,
  type BuildCoachChatInput,
  type CoachChatIntent,
  type CoachChatResponse
} from "./chat";
import { buildCoachChatModelInput } from "./chat-prompt";
import type { CoachRequest } from "./planner/types";

/** The model gets this long; the app waits 60 s for the whole route. */
export const DEFAULT_COACH_CHAT_TIMEOUT_MS = 45_000;
/** Room for low-effort reasoning plus a 180-word answer, evidence and follow-ups. */
export const COACH_CHAT_MAX_OUTPUT_TOKENS = 2_000;
export const COACH_CHAT_MAX_EVIDENCE = 4;
export const COACH_CHAT_MAX_EVIDENCE_LENGTH = 120;
export const COACH_CHAT_MAX_FOLLOW_UPS = 3;
export const COACH_CHAT_MAX_FOLLOW_UP_LENGTH = 80;

/** Sends one Responses API request. Injected so tests never touch the network. */
export type CoachChatModelCall = (
  body: Record<string, unknown>,
  options: { timeoutMs: number }
) => Promise<OpenAIResponseFetchResult>;

export type CoachChatFallbackReason =
  | "no_api_key"
  | "model_http_error"
  | "model_timeout"
  | "model_call_failed"
  | "model_output_incomplete"
  | "model_output_unreadable"
  | "model_output_invalid";

export type AnswerCoachChatInput = BuildCoachChatInput & {
  request: CoachRequest;
  model: string;
  /** null when the proxy has no OpenAI key: the template answer is used. */
  callModel: CoachChatModelCall | null;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onFallback?: (reason: CoachChatFallbackReason, details: { status?: number }) => void;
};

export type SanitizedCoachChatOutput = {
  answer: string;
  evidence: string[];
  followUpPrompts: string[];
  answerKind: CoachChatIntent;
};

export const coachChatOutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "evidence", "followUpPrompts", "answerKind"],
  properties: {
    answer: { type: "string" },
    evidence: { type: "array", items: { type: "string" } },
    followUpPrompts: { type: "array", items: { type: "string" } },
    answerKind: { type: "string", enum: [...COACH_CHAT_INTENTS] }
  }
} satisfies Record<string, unknown>;

/**
 * Answers a coach-chat turn with the coach model, falling back to the
 * built-in template answer (usedModel: false) when there is no key, the call
 * fails or times out, or the output cannot be used.
 */
export async function answerCoachChat(input: AnswerCoachChatInput): Promise<CoachChatResponse> {
  const messages = normalizeCoachChatMessages(input.messages);
  const generatedAt = input.generatedAt ?? new Date();
  const fallback = (reason: CoachChatFallbackReason, details: { status?: number } = {}): CoachChatResponse => {
    input.onFallback?.(reason, details);
    return buildCoachChatResponse({ ...input, messages, generatedAt });
  };

  if (!input.callModel) {
    return fallback("no_api_key");
  }

  const timeoutMs = input.timeoutMs ?? coachChatTimeoutMs(input.env);
  const body = buildCoachChatRequestBody({ ...input, messages, now: generatedAt });

  let result: OpenAIResponseFetchResult | "timeout";
  try {
    result = await withTimeout(input.callModel(body, { timeoutMs }), timeoutMs);
  } catch {
    return fallback("model_call_failed");
  }
  if (result === "timeout") {
    return fallback("model_timeout");
  }
  if (!result.ok) {
    return fallback(result.status === 504 ? "model_timeout" : "model_http_error", { status: result.status });
  }
  if (responseStatus(result.json) === "incomplete") {
    return fallback("model_output_incomplete");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractResponseText(result.json));
  } catch {
    return fallback("model_output_unreadable");
  }

  const output = sanitizeCoachChatModelOutput(parsed, latestUserQuestion(messages));
  if (!output) {
    return fallback("model_output_invalid");
  }

  return {
    ...output,
    memorySummary: summarizeEarlierQuestions(messages),
    contextState: input.context.readiness.state,
    usedModel: true,
    generatedAt: formatGeneratedAt(generatedAt)
  };
}

export function buildCoachChatRequestBody(
  input: Omit<AnswerCoachChatInput, "callModel"> & { now?: Date }
): Record<string, unknown> {
  const reasoning = coachChatReasoning(input.model, input.env);
  return {
    model: input.model,
    input: buildCoachChatModelInput({
      messages: input.messages,
      context: input.context,
      signals: input.signals,
      evaluation: input.evaluation,
      request: input.request,
      now: input.now
    }),
    ...(reasoning ? { reasoning } : {}),
    max_output_tokens: COACH_CHAT_MAX_OUTPUT_TOKENS,
    // Health data: do not keep the exchange on OpenAI's side for later retrieval.
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "coach_chat_answer",
        strict: true,
        schema: coachChatOutputSchema
      }
    }
  };
}

/**
 * Low reasoning effort keeps a chat turn fast on reasoning models.
 * COACH_CHAT_REASONING_EFFORT overrides the effort; "off" omits the parameter.
 */
export function coachChatReasoning(model: string, env: NodeJS.ProcessEnv = process.env): { effort: string } | undefined {
  const configured = (env.COACH_CHAT_REASONING_EFFORT ?? "").trim().toLowerCase();
  if (configured === "off") return undefined;
  if (!/^(gpt-5|gpt-6|o\d)/i.test(model)) return undefined;
  return { effort: configured || "low" };
}

export function coachChatTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.COACH_CHAT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_COACH_CHAT_TIMEOUT_MS;
}

/** Trims and bounds what the model wrote; null when there is no usable answer. */
export function sanitizeCoachChatModelOutput(raw: unknown, latestQuestion = ""): SanitizedCoachChatOutput | null {
  if (!isRecord(raw) || typeof raw.answer !== "string") return null;
  const answer = cleanAnswer(raw.answer);
  if (!answer) return null;

  const evidence = uniqueStrings(stringItems(raw.evidence).map((item) =>
    // The app stores evidence joined by "|", so a pipe would split one item in two.
    truncateText(oneLine(item).replaceAll("|", "/"), COACH_CHAT_MAX_EVIDENCE_LENGTH)
  )).slice(0, COACH_CHAT_MAX_EVIDENCE);

  const asked = oneLine(latestQuestion).toLowerCase();
  const followUpPrompts = uniqueStrings(stringItems(raw.followUpPrompts).map(oneLine))
    // A cut-off question reads worse than no chip, so long ones are dropped.
    .filter((item) => item.length <= COACH_CHAT_MAX_FOLLOW_UP_LENGTH && item.toLowerCase() !== asked)
    .slice(0, COACH_CHAT_MAX_FOLLOW_UPS);

  const answerKind = COACH_CHAT_INTENTS.find((intent) => intent === raw.answerKind) ?? "general";
  return { answer, evidence, followUpPrompts, answerKind };
}

/** The text of a Responses API result (`output_text`, or the first output_text part). */
export function extractResponseText(response: unknown): string {
  if (!isRecord(response)) throw new Error("response is not an object");
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text;
  }
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string" && part.text.trim()) {
        return part.text;
      }
    }
  }
  throw new Error("response has no output text");
}

function cleanAnswer(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    // The app shows plain text: markdown markers would show up literally.
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned ? truncateText(cleaned, COACH_CHAT_MAX_TEXT_LENGTH) : "";
}

function stringItems(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (!item || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function responseStatus(response: unknown): string | null {
  return isRecord(response) && typeof response.status === "string" ? response.status : null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  promise.catch(() => undefined); // a late rejection after the timeout is expected
  try {
    return await Promise.race([promise, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
