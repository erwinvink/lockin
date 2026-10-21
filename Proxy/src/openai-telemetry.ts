import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type OpenAIUsageShape = {
  input_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
  output_tokens?: unknown;
  output_tokens_details?: { reasoning_tokens?: unknown };
  total_tokens?: unknown;
  prompt_tokens?: unknown;
  prompt_tokens_details?: { cached_tokens?: unknown };
  completion_tokens?: unknown;
  completion_tokens_details?: { reasoning_tokens?: unknown };
};

export type OpenAIUsageMetrics = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type OpenAIRequestTelemetry = {
  route: string;
  phase: string;
  model: string;
  userId?: string;
  contextState?: string;
  hasRunning?: boolean;
  hasGarmin?: boolean;
  repairAttempt?: boolean;
};

type OpenAITelemetryEvent = {
  type: "openai_response_start" | "openai_response_finish" | "coach_validation_failure";
  at: string;
  id: string;
  route: string;
  phase: string;
  model: string;
  userHash?: string;
  contextState?: string;
  hasRunning?: boolean;
  hasGarmin?: boolean;
  repairAttempt?: boolean;
  request?: OpenAIRequestSummary;
  durationMs?: number;
  httpStatus?: number;
  ok?: boolean;
  usage?: OpenAIUsageMetrics;
  cacheHitRate?: number | null;
  estimatedCostUSD?: number | null;
  estimatedCostModel?: string | null;
  validationMessages?: string[];
  error?: string;
  errorBodyChars?: number;
};

export type OpenAIResponseFetchResult =
  | { ok: true; status: number; json: unknown }
  | { ok: false; status: number; body: string };

export type OpenAIRequestSummary = {
  bodyBytes: number;
  inputMessageCount: number | null;
  systemContentChars: number;
  userContentChars: number;
  schemaName: string | null;
  schemaBytes: number | null;
};

type ModelPrice = {
  inputPerMillion: number;
  cachedInputPerMillion: number;
  outputPerMillion: number;
};

const defaultModelPrices: Array<[RegExp, string, ModelPrice]> = [
  [/^gpt-5-mini(?:-|$)/, "gpt-5-mini", { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2.0 }],
  [/^gpt-5\.4-mini(?:-|$)/, "gpt-5.4-mini", { inputPerMillion: 0.375, cachedInputPerMillion: 0.0375, outputPerMillion: 2.25 }],
  [/^gpt-5\.4-nano(?:-|$)/, "gpt-5.4-nano", { inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.625 }],
  [/^gpt-5\.4(?:-|$)/, "gpt-5.4", { inputPerMillion: 1.25, cachedInputPerMillion: 0.13, outputPerMillion: 7.5 }],
  [/^gpt-5\.5(?:-|$)/, "gpt-5.5", { inputPerMillion: 2.5, cachedInputPerMillion: 0.25, outputPerMillion: 15.0 }]
];

// One Responses call may not run longer than this (OPENAI_TIMEOUT_MS). The
// auto-plan "stuck in generating" cutoff in coach/auto-plan.ts assumes it.
export const DEFAULT_OPENAI_TIMEOUT_MS = 5 * 60_000;

export type OpenAIFetchOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export function openAITimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OPENAI_TIMEOUT_MS;
}

export async function fetchOpenAIResponse(
  apiKey: string,
  body: Record<string, unknown>,
  telemetry: OpenAIRequestTelemetry,
  options: OpenAIFetchOptions = {}
): Promise<OpenAIResponseFetchResult> {
  const id = randomUUID();
  const startedAt = Date.now();
  const request = summarizeOpenAIRequestBody(body);
  const timeoutMs = options.timeoutMs ?? openAITimeoutMs();
  const fetchImpl = options.fetchImpl ?? fetch;
  await writeTelemetryEvent(baseEvent("openai_response_start", id, telemetry, { request }));

  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // Race the whole exchange (headers and body) against the budget, so a
  // stalled connection can't hold a coach request or an auto-plan forever.
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error("OpenAI request timed out"));
      resolve("timeout");
    }, timeoutMs);
  });
  const exchange = async (): Promise<OpenAIResponseFetchResult> => {
    const response = await fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const responseBody = await response.text();
      await writeTelemetryEvent(
        baseEvent("openai_response_finish", id, telemetry, {
          request,
          durationMs: Date.now() - startedAt,
          httpStatus: response.status,
          ok: false,
          errorBodyChars: responseBody.length
        })
      );
      return { ok: false, status: response.status, body: responseBody };
    }

    const json = await response.json();
    const usage = extractOpenAIUsage(json);
    const cost = estimateOpenAICostUSD(telemetry.model, usage);
    await writeTelemetryEvent(
      baseEvent("openai_response_finish", id, telemetry, {
        request,
        durationMs: Date.now() - startedAt,
        httpStatus: response.status,
        ok: true,
        usage,
        cacheHitRate: cacheHitRate(usage),
        estimatedCostUSD: cost?.usd ?? null,
        estimatedCostModel: cost?.model ?? null
      })
    );

    return { ok: true, status: response.status, json };
  };

  try {
    const exchanging = exchange();
    exchanging.catch(() => undefined); // a late rejection after a timeout is expected
    const outcome = await Promise.race([exchanging, timedOut]);
    if (outcome === "timeout") {
      const message = `OpenAI request timed out after ${Math.round(timeoutMs / 1000)}s.`;
      await writeTelemetryEvent(
        baseEvent("openai_response_finish", id, telemetry, {
          request,
          durationMs: Date.now() - startedAt,
          httpStatus: 504,
          ok: false,
          error: message
        })
      );
      return { ok: false, status: 504, body: JSON.stringify({ error: message }) };
    }
    return outcome;
  } catch (error) {
    await writeTelemetryEvent(
      baseEvent("openai_response_finish", id, telemetry, {
        request,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: error instanceof Error ? error.message : "Unknown OpenAI request error"
      })
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function recordCoachValidationFailure(
  telemetry: OpenAIRequestTelemetry,
  messages: string[]
): Promise<void> {
  await writeTelemetryEvent(
    baseEvent("coach_validation_failure", randomUUID(), telemetry, {
      validationMessages: messages
    })
  );
}

export function extractOpenAIUsage(response: unknown): OpenAIUsageMetrics {
  const usage = isRecord(response) && isRecord(response.usage) ? (response.usage as OpenAIUsageShape) : {};
  return {
    inputTokens: numberOrNull(usage.input_tokens ?? usage.prompt_tokens),
    cachedInputTokens: numberOrNull(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens),
    outputTokens: numberOrNull(usage.output_tokens ?? usage.completion_tokens),
    reasoningTokens: numberOrNull(usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens),
    totalTokens: numberOrNull(usage.total_tokens)
  };
}

export function estimateOpenAICostUSD(
  model: string,
  usage: OpenAIUsageMetrics
): { usd: number; model: string } | null {
  const priceEntry = defaultModelPrices.find(([pattern]) => pattern.test(model));
  if (!priceEntry || usage.inputTokens === null || usage.outputTokens === null) {
    return null;
  }

  const [, priceModel, price] = priceEntry;
  const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);
  const usd =
    (uncachedInputTokens * price.inputPerMillion +
      cachedInputTokens * price.cachedInputPerMillion +
      usage.outputTokens * price.outputPerMillion) /
    1_000_000;

  return { usd: roundUSD(usd), model: priceModel };
}

export function summarizeOpenAIRequestBody(body: Record<string, unknown>): OpenAIRequestSummary {
  const input = Array.isArray(body.input) ? body.input : null;
  const messages = input?.filter(isRecord) ?? [];
  const contentChars = (role: string) =>
    messages
      .filter((message) => message.role === role && typeof message.content === "string")
      .reduce((total, message) => total + String(message.content).length, 0);
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : null;
  const schemaName = typeof format?.name === "string" ? format.name : null;
  const schemaBytes = format ? Buffer.byteLength(JSON.stringify(format), "utf8") : null;

  return {
    bodyBytes: Buffer.byteLength(JSON.stringify(body), "utf8"),
    inputMessageCount: input ? input.length : null,
    systemContentChars: contentChars("system"),
    userContentChars: contentChars("user"),
    schemaName,
    schemaBytes
  };
}

function baseEvent(
  type: OpenAITelemetryEvent["type"],
  id: string,
  telemetry: OpenAIRequestTelemetry,
  extra: Partial<OpenAITelemetryEvent> = {}
): OpenAITelemetryEvent {
  return {
    type,
    at: new Date().toISOString(),
    id,
    route: telemetry.route,
    phase: telemetry.phase,
    model: telemetry.model,
    userHash: telemetry.userId ? hashUserId(telemetry.userId) : undefined,
    contextState: telemetry.contextState,
    hasRunning: telemetry.hasRunning,
    hasGarmin: telemetry.hasGarmin,
    repairAttempt: telemetry.repairAttempt,
    ...extra
  };
}

async function writeTelemetryEvent(event: OpenAITelemetryEvent): Promise<void> {
  if (process.env.OPENAI_TELEMETRY_DISABLED === "1") {
    return;
  }

  const line = `${JSON.stringify(event)}\n`;

  if (process.env.OPENAI_TELEMETRY_STDOUT !== "0") {
    console.log(`openai.telemetry ${JSON.stringify(compactConsoleEvent(event))}`);
  }

  const rawPath = process.env.OPENAI_TELEMETRY_PATH ?? ".data/openai-usage.jsonl";
  if (!rawPath.trim()) {
    return;
  }

  try {
    const telemetryPath = resolve(process.cwd(), rawPath);
    await mkdir(dirname(telemetryPath), { recursive: true });
    await appendFile(telemetryPath, line, "utf8");
  } catch (error) {
    console.warn("openai.telemetry_write_failed", error instanceof Error ? error.message : error);
  }
}

function compactConsoleEvent(event: OpenAITelemetryEvent): Record<string, unknown> {
  return {
    type: event.type,
    id: event.id,
    route: event.route,
    phase: event.phase,
    model: event.model,
    userHash: event.userHash,
    durationMs: event.durationMs,
    ok: event.ok,
    httpStatus: event.httpStatus,
    inputTokens: event.usage?.inputTokens,
    cachedInputTokens: event.usage?.cachedInputTokens,
    outputTokens: event.usage?.outputTokens,
    reasoningTokens: event.usage?.reasoningTokens,
    totalTokens: event.usage?.totalTokens,
    estimatedCostUSD: event.estimatedCostUSD,
    validationMessageCount: event.validationMessages?.length
  };
}

function cacheHitRate(usage: OpenAIUsageMetrics): number | null {
  if (!usage.inputTokens || usage.cachedInputTokens === null) {
    return null;
  }
  return Math.round((usage.cachedInputTokens / usage.inputTokens) * 10_000) / 10_000;
}

function hashUserId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 16);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function roundUSD(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
