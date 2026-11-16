import assert from "node:assert/strict";
import test from "node:test";
import { CONTINUITY_FLOOR_LIMITS, floorChangeSignals, keptPlanCanHoldQuality, keptPlanMostKm } from "./continuity-floors";
import { runningGuardrails } from "./running-guardrails";
import { contextWith, lowHrvDay, recoveryContext, sixDayContext, steadyWeeks, todayPlanned, withWellness } from "./running.fixtures";
import type { CoachContext } from "./types";

// The fixture: 45 km weeks, running Tuesday, Thursday, Saturday and Sunday
// (offsets 1, 3, 5, 6), the long run on Saturday (offset 5). The floor is
// 38.3 km, the weekly cap 51.8 km, the long-run cap 22.8 km, at most 4 runs.
const BASE = contextWith({ recentRuns: steadyWeeks([45, 45, 45, 45]) });
// Running every day but Monday (offsets 1-6): at most 5 runs.
const SIX_DAYS = sixDayContext({ recentRuns: steadyWeeks([45, 45, 45, 45]) });

function withPlan(context: CoachContext, runs: Array<[dayOffset: number, kind: string, distanceKm: number]>): CoachContext {
  return {
    ...context,
    currentPlan: {
      generatedAt: null,
      source: "app",
      runs: runs.map(([dayOffset, kind, distanceKm]) => ({ dayOffset, title: `${kind} run`, kind, distanceKm, elevationMeters: 60, target: null })),
      strengthSessions: [],
      changeSignals: [],
      keepUnlessChanged: true,
      rule: ""
    }
  };
}

function estimate(context: CoachContext) {
  const guardrails = runningGuardrails(context);
  return { mostKm: keptPlanMostKm(context, guardrails), quality: keptPlanCanHoldQuality(context, guardrails), signals: floorChangeSignals(context, guardrails) };
}

test("without a current plan there is nothing to keep", () => {
  assert.deepEqual(estimate(BASE), { mostKm: null, quality: true, signals: [] });
});

test("each kept run grows by at most 15%, rounded down to 0.5 km", () => {
  // 6, 6, 12 and 5 km grow to 6.9, 6.9, 13.8 and 5.75 km: 6.5 + 6.5 + 13.5 + 5.5 km.
  const result = estimate(withPlan(BASE, [[1, "easy", 6], [3, "tempo", 6], [5, "long", 12], [6, "easy", 5]]));
  assert.equal(result.mostKm, 32);
  assert.deepEqual(result.signals, ["The planned week is below the running floor: kept within 15% it reaches 32 km over the 7 days, under the 38.3 km floor."]);
});

test("a kept run never grows past its own cap", () => {
  // The 21 km long run stops at the 22.8 km long-run cap (22.5 km rounded down), not 24.15 km.
  assert.equal(estimate(withPlan(BASE, [[1, "easy", 8], [3, "tempo", 8], [5, "long", 21], [6, "easy", 6]])).mostKm, 9 + 9 + 22.5 + 6.5);
  // In a recovery week the long run stops at the week's 14 km long-run cap.
  assert.equal(estimate(withPlan(recoveryContext(), [[1, "easy", 4], [3, "easy", 4], [5, "long", 16], [6, "easy", 4]])).mostKm, 4.5 * 3 + 14);
});

test("free running days add their most: the long-run day the long-run cap, other days never past the kept long run", () => {
  // Saturday is free: it can hold a 22.5 km long run.
  assert.equal(estimate(withPlan(BASE, [[1, "easy", 6], [3, "tempo", 6], [6, "easy", 5]])).mostKm, 6.5 + 6.5 + 5.5 + 22.5);
  // Sunday is free, but no run may be longer than the kept long run (11.5 km at most).
  const shortLong = estimate(withPlan(BASE, [[1, "easy", 6], [3, "tempo", 6], [5, "long", 10]]));
  assert.equal(shortLong.mostKm, 6.5 + 6.5 + 11.5 + 11.5);
  assert.equal(shortLong.signals.length, 1, "36 km is under the floor");
});

test("free days count only while the run count allows another run", () => {
  // Five runs at most: one of the two free days (offsets 2 and 4) counts, at 13.5 km.
  assert.equal(estimate(withPlan(SIX_DAYS, [[1, "easy", 6], [3, "tempo", 6], [5, "long", 12], [6, "easy", 5]])).mostKm, 32 + 13.5);
});

test("today's run counts, and the 7-day cap bounds the estimate", () => {
  const plan: Array<[number, string, number]> = [[1, "easy", 6], [3, "tempo", 6], [5, "long", 12], [6, "easy", 5]];
  const withToday = estimate(withPlan({ ...BASE, todayPlannedRuns: todayPlanned("easy", 8) }, plan));
  assert.equal(withToday.mostKm, 8 + 32);
  assert.deepEqual(withToday.signals, [], "40 km over the 7 days reaches the floor");
  // 11.5 + 11.5 + 20.5 + 20.5 km would be 64 km: the weekly cap holds it at 51.8 km, today's run included.
  const big: Array<[number, string, number]> = [[1, "easy", 10], [3, "tempo", 10], [5, "long", 18]];
  assert.equal(estimate(withPlan(BASE, big)).mostKm, 51.8);
  assert.equal(estimate(withPlan({ ...BASE, todayPlannedRuns: todayPlanned("easy", 10) }, big)).mostKm, 51.8);
});

test(`the kept plan must reach the floor by ${CONTINUITY_FLOOR_LIMITS.marginKm} km`, () => {
  // 8 + 8 + 16 + 6.5 = 38.5 km: above the 38.3 km floor, but inside the margin.
  const close = estimate(withPlan(BASE, [[1, "easy", 7], [3, "tempo", 7], [5, "long", 14], [6, "easy", 6]]));
  assert.equal(close.mostKm, 38.5);
  assert.equal(close.signals.length, 1);
  // 8 + 8 + 16 + 7 = 39 km clears it.
  assert.deepEqual(estimate(withPlan(BASE, [[1, "easy", 7], [3, "tempo", 7], [5, "long", 14], [6, "easy", 6.5]])).signals, []);
});

test("lifted floors give no change signal", () => {
  // A planned recovery week lifts both floors, so a light kept plan stays.
  assert.deepEqual(estimate(withPlan(recoveryContext(), [[1, "easy", 4], [5, "long", 8]])).signals, []);
});

test("a kept quality run counts unless a wellness gate takes its day", () => {
  assert.equal(estimate(withPlan(BASE, [[1, "easy", 6], [3, "tempo", 6], [5, "long", 12], [6, "easy", 5]])).quality, true);
  // The gate keeps offset 1 easy, and no free day is left for the quality run.
  const gated = estimate(withPlan(withWellness(BASE, [lowHrvDay("2026-05-11")]), [[1, "tempo", 8], [3, "easy", 8], [5, "long", 18], [6, "easy", 6]]));
  assert.equal(gated.quality, false);
  assert.deepEqual(gated.signals, ["The planned week has no tempo, interval or hill run, and the running floor needs one."]);
});

test("a free day can take the quality run only away from the long run and the day after a hard run today", () => {
  // Offsets 2 and 3 are free and away from Saturday's long run.
  assert.equal(estimate(withPlan(SIX_DAYS, [[1, "easy", 8], [5, "long", 18], [6, "easy", 6]])).quality, true);
  // Offset 1 is the only free day away from the long run (offset 4 is next to it) ...
  const plan: Array<[number, string, number]> = [[2, "easy", 8], [3, "easy", 8], [5, "long", 18], [6, "easy", 6]];
  assert.equal(estimate(withPlan(SIX_DAYS, plan)).quality, true);
  // ... and after today's long run it is out.
  assert.equal(estimate(withPlan({ ...SIX_DAYS, todayPlannedRuns: todayPlanned("long", 16) }, plan)).quality, false);
  // Only Sunday is free, next to the long run.
  assert.equal(estimate(withPlan(BASE, [[1, "easy", 8], [3, "easy", 8], [5, "long", 18]])).quality, false);
  // No room for another run.
  assert.equal(estimate(withPlan(BASE, [[1, "easy", 8], [3, "easy", 8], [5, "long", 18], [6, "easy", 6]])).quality, false);
});

// Final review item 12: when the weekly or long-run cap drops below the kept
// plan, the 15% hold would keep runs over the cap (the clamp then cuts them
// and the repair keeps them again). Mirroring the floor signal, that is a
// change signal, so continuity releases.
test("a kept plan the cap cannot hold, even 15% shorter, releases continuity", () => {
  // 70 km: 15% shorter it still holds 59.5 km, over the 51.8 km weekly cap.
  const overWeekly = estimate(withPlan(BASE, [[1, "easy", 16], [3, "tempo", 16], [5, "long", 22], [6, "easy", 16]]));
  assert.deepEqual(overWeekly.signals, ["The planned week is above this week's running cap: kept within 15% it holds at least 59.5 km over the 7 days, over the 51.8 km cap."]);

  // A 28 km long run is at least 23.8 km kept within 15%, over the 22.8 km long-run cap.
  const overLong = estimate(withPlan(BASE, [[1, "easy", 6], [3, "tempo", 6], [5, "long", 28], [6, "easy", 5]]));
  assert.deepEqual(overLong.signals, ["The planned week is above this week's running cap: kept within 15% the 28 km long run is at least 23.8 km, over its 22.8 km cap."]);

  // Today's run uses part of the weekly cap.
  const withToday = estimate(withPlan({ ...BASE, todayPlannedRuns: todayPlanned("easy", 12) }, [[1, "easy", 12], [3, "tempo", 12], [5, "long", 20], [6, "easy", 10]]));
  assert.ok(withToday.signals.some((signal) => signal.includes("holds at least 57.9 km over the 7 days, over the 51.8 km cap")), JSON.stringify(withToday.signals));

  // A plan the cap can hold within 15% stays.
  assert.deepEqual(estimate(withPlan(BASE, [[1, "easy", 10], [3, "tempo", 10], [5, "long", 20], [6, "easy", 10]])).signals, []);
});
