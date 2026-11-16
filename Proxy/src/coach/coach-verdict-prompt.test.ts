import assert from "node:assert/strict";
import test from "node:test";
import { context } from "./chat.fixtures";
import { coachVerdictReferencePoints, coachVerdictSystemPrompt } from "./coach-verdict-prompt";
import { contextSeason, hybridCoachReadLens, SEASON_READ_RULE } from "./planner/season";

const RACE_POINTS = /^(Taper|Race readiness):/;

// At the nightly plan the Garmin values are usually yesterday's.
test("the read names the day of each Garmin value", () => {
  const prompt = coachVerdictSystemPrompt(context());
  for (const field of ["hrvDate", "sleepScoreDate", "trainingReadinessDate", "restingHrDate"]) assert.ok(prompt.includes(field), field);
  assert.match(prompt, /Early in the day, before the watch syncs, that is usually yesterday/);
  assert.match(prompt, /never present it as today's/);
});

test("a strength-only read gets the strength coach voice, no race lens and no reference points", () => {
  const strengthOnly = { ...context(), running: undefined };
  const prompt = coachVerdictSystemPrompt(strengthOnly);

  assert.match(prompt, /Write like an experienced strength coach/);
  assert.doesNotMatch(prompt, /ultra-endurance|coachContext\.season/);
  assert.equal(coachVerdictReferencePoints(strengthOnly), undefined);
});

test("a hybrid read counts down while the race is ahead", () => {
  // The fixture race is 98 days out.
  const prompt = coachVerdictSystemPrompt(context());

  assert.ok(prompt.includes(hybridCoachReadLens(contextSeason(context()))));
  assert.match(prompt, /the race countdown lead the read/);
  assert.ok(prompt.includes(SEASON_READ_RULE));
  assert.ok(coachVerdictReferencePoints(context())?.some((point) => RACE_POINTS.test(point)));
});

test("after the race the season leads the hybrid read and the race points drop out", () => {
  const base = context();
  // 27 days before the week start: past the 51 km race's 13-day window.
  const raced = { ...base, running: { ...base.running!, raceGoal: { ...base.running!.raceGoal, raceDate: "2026-06-01T00:00:00Z" } } };
  const prompt = coachVerdictSystemPrompt(raced);

  assert.doesNotMatch(prompt, /race countdown lead/);
  assert.match(prompt, /the season leads the read/);
  assert.doesNotMatch(prompt, /Eiger Ultra 51K/, "the race name stays out of the system message");
  const points = coachVerdictReferencePoints(raced) ?? [];
  assert.ok(points.length > 0);
  assert.ok(!points.some((point) => RACE_POINTS.test(point)), points.join("\n"));
});
