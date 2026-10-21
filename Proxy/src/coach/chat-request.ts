import { ClientInputError, parseJSONBody } from "../http-body";
import { normalizeCoachChatMessages, type CoachChatMessage } from "./chat";
import { buildCoachContext } from "./planner/build-coach-context";
import type { CoachContext, CoachRequest } from "./planner/types";

export type CoachChatPayload = { request: CoachRequest; messages: CoachChatMessage[] };

/** Validates a /coach-chat body: a coach request plus the recent chat turns. */
export function parseCoachChatPayload(value: unknown): CoachChatPayload {
  if (!isRecord(value) || !isRecord(value.request)) {
    throw new ClientInputError("request object is required");
  }
  if (!Array.isArray(value.messages)) {
    throw new ClientInputError("messages array is required");
  }

  const messages: CoachChatMessage[] = value.messages.map((message): CoachChatMessage => {
    if (!isRecord(message)) {
      throw new ClientInputError("each chat message must be an object");
    }
    const role = cleanString(message.role);
    if (role !== "user" && role !== "coach") {
      throw new ClientInputError("chat message role must be user or coach");
    }
    const text = cleanString(message.text);
    if (!text) {
      throw new ClientInputError("chat message text is required");
    }
    return {
      role,
      text,
      createdAt: cleanString(message.createdAt) || undefined
    };
  });

  assertCoachRequestShape(value.request);
  let normalized: CoachChatMessage[];
  try {
    normalized = normalizeCoachChatMessages(messages);
  } catch (error) {
    throw new ClientInputError(error instanceof Error ? error.message : "chat messages are invalid");
  }
  return { request: value.request, messages: normalized };
}

/** A coach request body (/coach-verdict, /generate-week, /generate-week-plan): 400 for invalid JSON or shape. */
export function parseCoachRequestBody(text: string): CoachRequest {
  const value = parseJSONBody(text);
  assertCoachRequestShape(value);
  return value;
}

/**
 * The fields buildCoachContext reads without guarding. A request missing one
 * of them is a client mistake (400), not a proxy crash (500).
 */
export function assertCoachRequestShape(value: unknown): asserts value is CoachRequest {
  if (!isRecord(value)) {
    throw new ClientInputError("request object is required");
  }
  for (const key of ["baseline", "goals"] as const) {
    const metrics = value[key];
    if (!isRecord(metrics) || !["pullUps", "pushUps", "plankSeconds"].every((metric) => typeof metrics[metric] === "number")) {
      throw new ClientInputError(`request.${key} must have numeric pullUps, pushUps, and plankSeconds`);
    }
  }
  for (const key of ["trainingLogs", "plannedSessions", "equipment"] as const) {
    if (!Array.isArray(value[key])) {
      throw new ClientInputError(`request.${key} must be an array`);
    }
  }
  if (!(value.trainingLogs as unknown[]).every(isRecord) || !(value.plannedSessions as unknown[]).every(isRecord)) {
    throw new ClientInputError("request training logs and planned sessions must be objects");
  }
  if (typeof value.weekStart !== "string" || typeof value.weeklySessions !== "number") {
    throw new ClientInputError("request.weekStart and request.weeklySessions are required");
  }
  if (value.profileNotes !== undefined && typeof value.profileNotes !== "string") {
    throw new ClientInputError("request.profileNotes must be a string");
  }
  if (value.running !== undefined && value.running !== null) {
    const running = value.running;
    if (!isRecord(running) || !isRecord(running.raceGoal) || !Array.isArray(running.recentRuns) || !running.recentRuns.every(isRecord)) {
      throw new ClientInputError("request.running must have a raceGoal and a recentRuns array");
    }
  }
}

/**
 * buildCoachContext for a client-supplied request: a malformed value deep in
 * the request (a TypeError or RangeError while reading it) is a 400.
 */
export function buildCoachContextFromClient(
  request: CoachRequest,
  build: (request: CoachRequest) => CoachContext = buildCoachContext
): CoachContext {
  try {
    return build(request);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new ClientInputError("request could not be read as a coach request");
    }
    throw error;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
