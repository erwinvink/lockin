import assert from "node:assert/strict";
import test from "node:test";
import { estimateOpenAICostUSD, extractOpenAIUsage, summarizeOpenAIRequestBody } from "./openai-telemetry";

test("extracts Responses API usage including cached and reasoning tokens", () => {
  const usage = extractOpenAIUsage({
    usage: {
      input_tokens: 12_000,
      input_tokens_details: { cached_tokens: 9_000 },
      output_tokens: 70_000,
      output_tokens_details: { reasoning_tokens: 62_000 },
      total_tokens: 82_000
    }
  });

  assert.deepEqual(usage, {
    inputTokens: 12_000,
    cachedInputTokens: 9_000,
    outputTokens: 70_000,
    reasoningTokens: 62_000,
    totalTokens: 82_000
  });
});

test("falls back to Chat Completions-style usage fields", () => {
  const usage = extractOpenAIUsage({
    usage: {
      prompt_tokens: 500,
      prompt_tokens_details: { cached_tokens: 128 },
      completion_tokens: 250,
      completion_tokens_details: { reasoning_tokens: 100 },
      total_tokens: 750
    }
  });

  assert.deepEqual(usage, {
    inputTokens: 500,
    cachedInputTokens: 128,
    outputTokens: 250,
    reasoningTokens: 100,
    totalTokens: 750
  });
});

test("estimates model cost using cached input discount and output token price", () => {
  const estimate = estimateOpenAICostUSD("gpt-5-mini", {
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 10,
    totalTokens: 120
  });

  assert.deepEqual(estimate, { usd: 0.000056, model: "gpt-5-mini" });
});

test("summarizes request shape without logging prompt contents", () => {
  const summary = summarizeOpenAIRequestBody({
    model: "gpt-5-mini",
    input: [
      { role: "system", content: "static instructions" },
      { role: "user", content: JSON.stringify({ coachContext: { readiness: "building" } }) }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "weekly_training_plan",
        strict: true,
        schema: { type: "object" }
      }
    }
  });

  assert.equal(summary.inputMessageCount, 2);
  assert.equal(summary.systemContentChars, "static instructions".length);
  assert.equal(summary.userContentChars, JSON.stringify({ coachContext: { readiness: "building" } }).length);
  assert.equal(summary.schemaName, "weekly_training_plan");
  assert.ok(summary.bodyBytes > summary.systemContentChars + summary.userContentChars);
  assert.ok((summary.schemaBytes ?? 0) > 0);
});
