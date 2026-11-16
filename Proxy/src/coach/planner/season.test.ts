import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { POST_RACE_STRENGTH } from "../chat.fixtures";
import { computeSeason, contextSeason, daysBetween, hybridCoachReadLens, raceTimingText, SEASON_LIMITS, SEASON_READ_RULE, weeksToGo } from "./season";
import type { CoachContext } from "./types";

// The athlete's real season: a 54 km race on 31 Oct 2026 and no next race.
const RACE_DAY = "2026-10-31T00:00:00Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function race(distanceKm: number, raceDate = RACE_DAY, name = "Trail 54K") {
  return { name, raceDate, distanceKm };
}

function daysAfter(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString();
}

test("a 54 km race 1 day ago is a 14-day transition", () => {
  const season = computeSeason(race(54), daysAfter(RACE_DAY, 1));

  assert.equal(season.raceState, "recent");
  assert.equal(season.phase, "transition");
  assert.equal(season.emphasis, "transition");
  assert.equal(season.daysSinceRace, 1);
  assert.equal(season.daysToRace, null);
  assert.equal(season.postRaceDays, 14);
  assert.equal(season.raceName, "Trail 54K");
});

test("the last day of the post-race window is still the transition", () => {
  // 14 Nov 2026 is day 14 after the race.
  const season = computeSeason(race(54), "2026-11-14T00:00:00Z");

  assert.equal(season.raceState, "recent");
  assert.equal(season.phase, "transition");
  assert.equal(season.daysSinceRace, 14);
});

test("the day after the window the athlete is in general preparation, strength-led", () => {
  const season = computeSeason(race(54), "2026-11-15T00:00:00Z");

  assert.equal(season.raceState, "none");
  assert.equal(season.phase, "general_preparation");
  assert.equal(season.emphasis, "strength_led");
  assert.equal(season.daysSinceRace, 15);
  assert.equal(season.daysToRace, null);
  assert.equal(season.raceName, "Trail 54K");
});

test("post-race window scales with race size", () => {
  const windows = [21, 54, 100, 170].map((km) => computeSeason(race(km), daysAfter(RACE_DAY, 1)).postRaceDays);
  assert.deepEqual(windows, [7, 14, 25, 28]);

  // Day 20 after the race: still the transition after 100 km, over after 54 km.
  assert.equal(computeSeason(race(100), daysAfter(RACE_DAY, 20)).raceState, "recent");
  assert.equal(computeSeason(race(54), daysAfter(RACE_DAY, 20)).raceState, "none");

  // A race without a usable distance gets the shortest window.
  assert.deepEqual([0, Number.NaN].map((km) => computeSeason(race(km), daysAfter(RACE_DAY, 1)).postRaceDays), [7, 7]);
});

test("upcoming race phases by distance in time", () => {
  const weekStart = "2026-05-25T00:00:00Z";
  const cases: Array<[number, string, string]> = [
    [25 * 7, "general_preparation", "strength_led"],
    [14 * 7, "base", "balanced"],
    [10 * 7, "build", "balanced"],
    [5 * 7, "peak", "run_led"],
    [15, "taper", "run_led"],
    [8, "taper", "taper"]
  ];

  for (const [days, phase, emphasis] of cases) {
    const season = computeSeason(race(100, daysAfter(weekStart, days), "Mozart 100"), weekStart);
    assert.deepEqual(
      [season.raceState, season.daysToRace, season.daysSinceRace, season.phase, season.emphasis],
      ["upcoming", days, null, phase, emphasis],
      `${days} days to the race`
    );
  }
});

test("each phase and emphasis includes its last day", () => {
  const weekStart = "2026-05-25T00:00:00Z";
  const at = (days: number) => computeSeason(race(100, daysAfter(weekStart, days), "Mozart 100"), weekStart);

  assert.deepEqual([21, 22, 42, 43, 84, 85, 112, 113].map((days) => at(days).phase), [
    "taper", "peak", "peak", "build", "build", "base", "base", "general_preparation"
  ]);
  assert.deepEqual([10, 11, 56, 57, 112, 113].map((days) => at(days).emphasis), [
    "taper", "run_led", "run_led", "balanced", "balanced", "strength_led"
  ]);
});

test("race day is the taper's race day, not a past race", () => {
  const season = computeSeason(race(54), RACE_DAY);

  assert.equal(season.raceState, "upcoming");
  assert.equal(season.daysToRace, 0);
  assert.equal(season.daysSinceRace, null);
  assert.equal(season.phase, "taper");
  assert.equal(season.emphasis, "taper");
});

test("days are counted across a daylight-saving change", () => {
  // Local midnights in Amsterdam: 24 Oct is summer time, 7 Nov winter time.
  const season = computeSeason(race(54, "2026-10-23T22:00:00Z"), "2026-11-06T23:00:00Z");

  assert.equal(season.daysSinceRace, 14);
  assert.equal(season.raceState, "recent");
});

test("contextSeason prefers the stored season and computes one for a hand-built context", () => {
  const stored = computeSeason(race(54), daysAfter(RACE_DAY, 1));
  const handBuilt = { profile: { weekStart: "2026-11-15T00:00:00Z" }, running: { raceGoal: race(54) } } as unknown as CoachContext;

  assert.equal(contextSeason({ ...handBuilt, season: stored }), stored);
  assert.equal(contextSeason(handBuilt).daysSinceRace, 15);
});

test("daysBetween counts whole days between local midnights", () => {
  assert.equal(daysBetween("2026-11-01T00:00:00Z", "2026-10-31T00:00:00Z"), -1);
  // Amsterdam: 28 Mar (winter time) to 4 Apr (summer time) is 7 days, one hour short.
  assert.equal(daysBetween("2026-03-27T23:00:00Z", "2026-04-03T22:00:00Z"), 7);
  assert.equal(daysBetween(Date.parse("2026-11-01T00:00:00Z"), Date.parse("2026-11-15T00:00:00Z")), 14);
  assert.ok(Number.isNaN(daysBetween("2026-11-01T00:00:00Z", "not-a-date")));
});

test("a race without a name is printed as your race", () => {
  const weekStart = "2026-05-25T00:00:00Z";
  const upcoming = computeSeason(race(100, daysAfter(weekStart, 70), "  "), weekStart);
  const recent = computeSeason(race(54, RACE_DAY, ""), daysAfter(RACE_DAY, 1));

  assert.equal(upcoming.raceName, null);
  assert.equal(upcoming.raceState, "upcoming");
  assert.match(upcoming.reason, /^Your race is in 70 days: /);
  assert.match(recent.reason, /^Your race was 1 day ago: /);

  // A request that leaves the name out entirely reads the same, never throws.
  const nameless = computeSeason({ raceDate: RACE_DAY, distanceKm: 54 } as unknown as Parameters<typeof computeSeason>[0], daysAfter(RACE_DAY, 1));
  assert.equal(nameless.raceName, null);
  assert.match(nameless.reason, /^Your race was 1 day ago: /);
});

test("race timing in plain words: days in the last week, weeks before, never 0 weeks out", () => {
  const weekStart = "2026-05-25T00:00:00Z";
  const at = (days: number) => computeSeason(race(100, daysAfter(weekStart, days)), weekStart);

  assert.deepEqual([70, 8, 7, 1, 0, -3].map((days) => raceTimingText(at(days))), ["10 weeks out", "2 weeks out", "in 7 days", "in 1 day", "today", "3 days ago"]);
  assert.equal(raceTimingText(computeSeason(race(54, "not-a-date"), weekStart)), "no race date");
  assert.deepEqual([70, 7, 1, 0, -3].map((days) => weeksToGo(at(days))), [10, 1, 1, null, null]);
});

test("without a race the athlete is in general preparation, strength-led", () => {
  for (const season of [computeSeason(undefined, "2026-11-15T00:00:00Z"), computeSeason(race(54, "not-a-date"), "2026-11-15T00:00:00Z")]) {
    assert.equal(season.raceState, "none");
    assert.equal(season.raceName, null);
    assert.equal(season.daysToRace, null);
    assert.equal(season.daysSinceRace, null);
    assert.equal(season.postRaceDays, 0);
    assert.equal(season.phase, "general_preparation");
    assert.equal(season.emphasis, "strength_led");
  }
});

test("the reason is one plain sentence about where the season stands", () => {
  const weekStart = "2026-05-25T00:00:00Z";
  const reasons = {
    upcoming: computeSeason(race(100, daysAfter(weekStart, 70), "Mozart 100"), weekStart).reason,
    raceDay: computeSeason(race(54), RACE_DAY).reason,
    recent: computeSeason(race(54), daysAfter(RACE_DAY, 1)).reason,
    afterWindow: computeSeason(race(54), "2026-11-15T00:00:00Z").reason,
    noRace: computeSeason(undefined, weekStart).reason
  };

  assert.equal(reasons.upcoming, "Mozart 100 is in 70 days: build phase, running and strength balanced.");
  assert.equal(reasons.raceDay, "Trail 54K is today: race day, the race comes first.");
  // Task 8 review: running recovers first while strength carries on (the post-race strength rule's numbers).
  assert.equal(reasons.recent, `Trail 54K was 1 day ago: post-race transition until day 14 after the race, running recovers first while ${POST_RACE_STRENGTH}.`);
  assert.equal(reasons.afterWindow, "Trail 54K was 15 days ago and no next race is planned: general preparation, strength leads.");
  assert.equal(reasons.noRace, "No race is planned: general preparation, strength leads.");
  for (const reason of Object.values(reasons)) {
    assert.doesNotMatch(reason, /_|[a-z][A-Z]|weeks out/, reason);
  }
});

test("the skills pick the phase from the computed season and state its timing", async () => {
  // The same location the proxy loads the skills from (server.ts).
  const skills = join(process.cwd(), "src", "coach", "skills");
  const [runningSkill, periodization, fitnessSkill] = await Promise.all([
    readFile(join(skills, "running-coach-planner", "SKILL.md"), "utf8"),
    readFile(join(skills, "running-coach-planner", "references", "ultra-periodization.md"), "utf8"),
    readFile(join(skills, "fitness-coach-planner", "SKILL.md"), "utf8")
  ]);

  // Field names and the computed numbers only: the wording is rewritten by later tasks.
  for (const text of [runningSkill, periodization]) {
    assert.ok(text.includes("`coachContext.season.phase`"), "the phase comes from the computed season");
    assert.ok(!text.includes("Use `weeksToRace` to pick the phase"));
  }
  const { phaseUntilDays: until, postRace } = SEASON_LIMITS;
  for (const expected of [
    "`general_preparation`", "`base`", "`build`", "`peak`", "`taper`", "`transition`", "`season.postRaceDays`",
    `more than ${until.base} days`,
    `${until.build + 1}-${until.base} days`,
    `${until.peak + 1}-${until.build} days`,
    `${until.taper + 1}-${until.peak} days`,
    `${until.taper} days`,
    `${postRace.kmPerDay} race km`
  ]) {
    assert.ok(periodization.includes(expected), `ultra-periodization.md should say: ${expected}`);
  }
  assert.match(periodization, new RegExp(`${postRace.minDays}\\D{1,20}${postRace.maxDays} days`), "the window bounds");
  assert.ok(fitnessSkill.includes("`coachContext.season`"), "the strength planner reads the season");
});

// The hybrid read framed everything around a race countdown, even with no race ahead.
test("the coach read leads with the race only while one is ahead; otherwise the season leads", () => {
  const upcoming = hybridCoachReadLens(computeSeason(race(100, "2026-08-03T00:00:00Z", "Mozart 100"), "2026-05-25T00:00:00Z"));
  assert.match(upcoming, /the race countdown lead the read; strength work is framed as serving the race/);
  // Task 8: no running-economy promise while the planner prescribes no heavy legs or plyometrics (Part 2).
  assert.doesNotMatch(upcoming, /\(running economy/);
  assert.match(upcoming, /make no claim that it makes the athlete run faster/);

  for (const season of [
    computeSeason(race(54), daysAfter(RACE_DAY, 1)),
    computeSeason(race(54), "2026-11-15T00:00:00Z"),
    computeSeason(race(54, "not-a-date"), "2026-11-15T00:00:00Z")
  ]) {
    const lens = hybridCoachReadLens(season);
    assert.doesNotMatch(lens, /race countdown lead|serving the race/, lens);
    assert.match(lens, /coachContext\.season/, lens);
    // The athlete's race name stays out of the system message.
    assert.doesNotMatch(lens, /Trail 54K/, lens);
  }
});

// The coach read used to be handed "0 weeks out" for a past race.
test("the coach read is told to say how long ago the race was, or that none is planned", () => {
  assert.match(SEASON_READ_RULE, /coachContext\.season/);
  assert.match(SEASON_READ_RULE, /raceState recent/);
  assert.match(SEASON_READ_RULE, /your race 10 days ago/);
  assert.match(SEASON_READ_RULE, /raceState none\), say no race is planned and leave the old race out/);
  assert.match(SEASON_READ_RULE, /Never call a past race 0 weeks out or in taper/);
});
