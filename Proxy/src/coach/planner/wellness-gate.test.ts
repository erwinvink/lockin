import assert from "node:assert/strict";
import test from "node:test";
import { hrvVersusBaseline, latestHrvDay, wellnessGate } from "./wellness-gate";
import type { CoachWellnessDay } from "./types";

// 2026-05-11 is the first day of the rolling week (today).
const WEEK_START = "2026-05-11T00:00:00Z";

// Garmin's UNBALANCED means the 7-day average sits outside the baseline range
// in either direction, so on its own it says nothing about suppression.
test("only HRV below the athlete's baseline trips the gate: LOW or POOR, never UNBALANCED on its own", () => {
  for (const status of ["LOW", "poor"]) {
    assert.ok(wellnessGate([day("2026-05-11", { hrvStatus: status })], WEEK_START), status);
  }
  for (const status of ["UNBALANCED", "BALANCED", null]) {
    assert.equal(wellnessGate([day("2026-05-11", { hrvStatus: status })], WEEK_START), null, String(status));
  }
  assert.equal(hrvVersusBaseline(day("2026-05-11", { hrvStatus: "UNBALANCED" })), "unknown");
  assert.match(wellnessGate([day("2026-05-11", { hrvStatus: "LOW" })], WEEK_START)?.reasons.join(" ") ?? "", /HRV status LOW on 2026-05-11/);
});

test("a 7-day HRV average below the baseline range trips the gate; one above it does not", () => {
  const below = day("2026-05-11", { hrvStatus: "UNBALANCED", hrvWeeklyAvgMs: 41, hrvBaselineLowMs: 45 });
  const above = day("2026-05-11", { hrvStatus: "UNBALANCED", hrvWeeklyAvgMs: 62, hrvBaselineLowMs: 45 });

  assert.match(wellnessGate([below], WEEK_START)?.reasons.join(" ") ?? "", /7-day HRV average of 41 ms is below the baseline range \(from 45 ms\)/);
  assert.equal(wellnessGate([above], WEEK_START), null);
  assert.equal(hrvVersusBaseline(above), "not_below");
});

test("a sleep score below 50 needs 2 of the last 3 nights", () => {
  const poor = (date: string) => day(date, { sleepScore: 44 });

  assert.equal(wellnessGate([day("2026-05-10"), poor("2026-05-11")], WEEK_START), null, "one poor night");
  const twoNights = wellnessGate([poor("2026-05-09"), day("2026-05-10"), poor("2026-05-11")], WEEK_START);
  assert.match(twoNights?.reasons.join(" ") ?? "", /Sleep score below 50 on 2 of the last 3 nights \(44 on 2026-05-09, 44 on 2026-05-11\)/);
  assert.equal(wellnessGate([poor("2026-05-06"), poor("2026-05-07"), day("2026-05-11")], WEEK_START), null, "both poor nights are more than 3 days back");
  assert.equal(wellnessGate([day("2026-05-10", { sleepScore: null }), poor("2026-05-11")], WEEK_START), null, "a night without a score is not a poor night");
});

test("a tripped gate covers the next 48 hours, so tomorrow (today is locked); a stale reading trips nothing", () => {
  assert.deepEqual(wellnessGate([day("2026-05-11", { hrvStatus: "LOW" })], WEEK_START)?.offsets, [1]);
  assert.equal(wellnessGate([day("2026-05-07", { hrvStatus: "LOW" })], WEEK_START), null, "4 days old");
});

// The 01:30 nightly plan: today's row is there but holds no HRV reading or
// sleep score yet, so the gate reads the latest day that has one.
test("an empty row for today hides neither yesterday's HRV reading nor the last nights' sleep", () => {
  const emptyToday = day("2026-05-11", { hrvStatus: null, hrvMs: null, sleepScore: null });
  const lowYesterday = day("2026-05-10", { hrvStatus: "LOW" });
  assert.equal(latestHrvDay([lowYesterday, emptyToday], WEEK_START)?.date, "2026-05-10");
  assert.match(wellnessGate([lowYesterday, emptyToday], WEEK_START)?.reasons.join(" ") ?? "", /HRV status LOW on 2026-05-10/);

  // Sleep: the last 3 nights that have a score, so 8-10 May.
  const poor = (date: string) => day(date, { sleepScore: 44 });
  const sleep = wellnessGate([poor("2026-05-08"), day("2026-05-09"), poor("2026-05-10"), emptyToday], WEEK_START);
  assert.match(sleep?.reasons.join(" ") ?? "", /Sleep score below 50 on 2 of the last 3 nights \(44 on 2026-05-08, 44 on 2026-05-10\)/);
});

test("an HRV reading more than 2 days old is ignored", () => {
  assert.deepEqual(wellnessGate([day("2026-05-09", { hrvStatus: "LOW" })], WEEK_START)?.offsets, [1], "2 days old");
  assert.equal(wellnessGate([day("2026-05-08", { hrvStatus: "LOW" })], WEEK_START), null, "3 days old");
  // Days without a reading after it do not make it newer.
  const noReading = (date: string) => day(date, { hrvStatus: null, hrvMs: null });
  assert.equal(latestHrvDay([day("2026-05-08", { hrvStatus: "LOW" }), noReading("2026-05-10"), noReading("2026-05-11")], WEEK_START), null);
  // The 7-day average and the baseline's lower bound are a reading too.
  const numbersOnly = day("2026-05-10", { hrvStatus: null, hrvWeeklyAvgMs: 40, hrvBaselineLowMs: 46 });
  assert.equal(latestHrvDay([day("2026-05-09", { hrvStatus: "BALANCED" }), numbersOnly], WEEK_START)?.date, "2026-05-10");
});

test("east of UTC+12 the last nights still count", () => {
  // Auckland in December (UTC+13): local midnight of 12 December is 11:00Z on the 11th.
  const auckland = "2026-12-11T11:00:00Z";
  const gate = wellnessGate([day("2026-12-11", { sleepScore: 40 }), day("2026-12-12", { sleepScore: 40 })], auckland);
  assert.match(gate?.reasons.join(" ") ?? "", /Sleep score below 50 on 2 of the last 3 nights/);
});

function day(date: string, overrides: Partial<CoachWellnessDay> = {}): CoachWellnessDay {
  return {
    date,
    sleepScore: 80,
    sleepSeconds: 27000,
    hrvStatus: "BALANCED",
    hrvMs: 50,
    bodyBattery: 60,
    trainingReadiness: 70,
    restingHr: 47,
    ...overrides
  };
}
