import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RUNNING_FLOOR_LIMITS, RUNNING_LIMITS } from "./running-guardrails";
import { RECOVERY_RUN_LIMITS, TAPER_LIMITS } from "./running-phase-limits";
import { WELLNESS_GATE_LIMITS } from "./wellness-gate";

// The running planner skill and its periodization reference, from where the
// proxy loads them (server.ts). The model is told what the code enforces, so
// the texts name the guardrail fields and carry the code's numbers.
const ROOT = join(process.cwd(), "src", "coach", "skills", "running-coach-planner");
const SKILL = readFileSync(join(ROOT, "SKILL.md"), "utf8");
const REFERENCE = readFileSync(join(ROOT, "references", "ultra-periodization.md"), "utf8");
const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const { longRunCapRatio, longRunWindowDays, recentRunWindowDays, returningFromBreakCapKm, weeklyClimbRatio, weeklyClimbMinimumM } = RUNNING_LIMITS;

test("the running skill names the guardrail fields and states the limits with the code's numbers", () => {
  for (const field of [
    "guardrails.floors",
    "floors.todayRun",
    "floors.todayRun.elevationM",
    "floors.weeklyKm.minKm",
    "floors.qualityRun.required",
    "computedRelaxations",
    "guardrails.longRun.capKm",
    "guardrails.weeklyClimb.capM",
    "guardrails.wellnessGate",
    "noSpeedStimulusLast3Weeks",
    "coachContext.profile.profileNotes",
    "`general_preparation`",
    "`transition`"
  ]) {
    assert.ok(SKILL.includes(field), `SKILL.md names ${field}`);
  }
  for (const number of [
    `${pct(RUNNING_FLOOR_LIMITS.weeklyKmRatio)} of the four-week training average`,
    `at most ${pct(RUNNING_FLOOR_LIMITS.reachableShare)} of what the week's runs hold at the long-run cap`,
    `${RUNNING_FLOOR_LIMITS.minRuns} or more runs`,
    `${longRunCapRatio}x the longest training run of the last ${longRunWindowDays} days`,
    `of the last ${recentRunWindowDays} days`,
    `the ${returningFromBreakCapKm} km return-week cap`,
    `${weeklyClimbRatio}x the 4-week average`,
    `${weeklyClimbMinimumM} m`,
    `next ${WELLNESS_GATE_LIMITS.gateHours} hours`
  ]) {
    assert.ok(SKILL.includes(number), `SKILL.md says: ${number}`);
  }
});

test("the periodization reference states the gates, caps, taper and recovery-week numbers the proxy enforces", () => {
  for (const field of ["floors.weeklyKm.minKm", "guardrails.wellnessGate", "guardrails.weeklyClimb.capM", "`general_preparation`", "`transition`"]) {
    assert.ok(REFERENCE.includes(field), `ultra-periodization.md names ${field}`);
  }
  const gate = WELLNESS_GATE_LIMITS;
  for (const number of [
    `${longRunCapRatio}x the longest training run of the last ${longRunWindowDays} days`,
    `last ${recentRunWindowDays} days`,
    `${weeklyClimbRatio}x the 4-week average`,
    `sleep score below ${gate.poorSleepScoreBelow} on ${gate.poorNightsNeeded} of the last ${gate.nightsWindow} nights`,
    `at most ${gate.maxReadingAgeDays} days old`,
    `next ${gate.gateHours} hours`,
    gate.belowBaselineStatuses.join(" or "),
    `15-21 days out: weekly km at most ${pct(TAPER_LIMITS.weeklyRatio.taper_3w)}`,
    `the long run at most ${pct(TAPER_LIMITS.longRunRatio.taper_3w!)} of the recent longest run`,
    `capped at ${pct(TAPER_LIMITS.weeklyRatio.taper_2w)}`,
    `the long run at most ${pct(TAPER_LIMITS.longRunRatio.taper_2w!)} of the recent longest run`,
    `each at most ${pct(TAPER_LIMITS.shortRunRatio)} of a normal easy run and at most ${TAPER_LIMITS.shortRunMaxKm} km`,
    `Inside ${TAPER_LIMITS.noHillsWithinDays} days: no hill session`,
    `${TAPER_LIMITS.newHillLoadFactor}x the athlete's usual m/km, never capped below ${TAPER_LIMITS.minElevationAllowanceM} m`,
    `weekly km at most ${pct(TAPER_LIMITS.weeklyRatio.post_race_1w)}), and at most ${pct(TAPER_LIMITS.weeklyRatio.post_race_2w)} from day 8 to the end of the post-race window`,
    `(capped at ${pct(RECOVERY_RUN_LIMITS.weeklyKmRatio)}), the long run at most ${pct(RECOVERY_RUN_LIMITS.longRunRatio)} of the recent longest run`
  ]) {
    assert.ok(REFERENCE.includes(number), `ultra-periodization.md says: ${number}`);
  }
  // The speed-session doses of the general-preparation and base phases.
  for (const dose of ["4-6 × 20 s", "12-24 min", "2 × 20 min"]) {
    assert.ok(REFERENCE.includes(dose), `ultra-periodization.md gives the dose: ${dose}`);
  }
});

// Wording that shipped before and was wrong (audits) stays out of both texts:
// the profile note and the wellness gate were once computed reasons.
test("the running skill no longer carries wording the audits removed", () => {
  for (const [file, text] of [["SKILL.md", SKILL], ["ultra-periodization.md", REFERENCE]]) {
    for (const removed of [
      "1.4x",
      "(the long run counts)",
      "At most one quality session per week",
      "accents, not workouts",
      "Khassetarash 2023",
      "verified in trail runners",
      "~3 weeks",
      "floorOnly",
      "a pain or injury note in the athlete's profile",
      "a tripped wellness gate, a recent run rated feel 1-2",
      "taper, wellness gate, recent distressed run"
    ]) {
      assert.ok(!text.includes(removed), `${file} still says: ${removed}`);
    }
    assert.ok(!/HRV status "unbalanced" or "low"/i.test(text), `${file}: UNBALANCED alone is no gate`);
  }
});

// Task 8: overreaching comes from strength logs only and no longer relaxes the
// running week; a computed recovery need (logged pain or very weak feedback) does.
test("the running skill names a recovery need, not any readiness state, as a computed relaxation", () => {
  assert.ok(!SKILL.includes("(readiness state, race or taper window"), "SKILL.md: not any readiness state");
  assert.ok(SKILL.includes("readiness recovery needed"), "SKILL.md names the recovery need");
  assert.match(SKILL, /overreaching[^.]*strength logs[^.]*does not relax the running week/);
});

// Final review item 4: in the first weeks after the post-race transition the
// weekly-km floor reads the training weeks before the taper; the skill, the
// reference and the prompt's floor rule say so with the code's numbers.
test("the running texts state the pre-taper floor reference after the transition", () => {
  const expected = `first ${RUNNING_FLOOR_LIMITS.preTaperWeeksAfterTransition} weeks after the post-race transition`;
  for (const [file, text] of [["SKILL.md", SKILL], ["ultra-periodization.md", REFERENCE]] as const) {
    assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    assert.ok(text.includes("four weeks before the taper"), `${file} should say: four weeks before the taper`);
  }
});

// Final review item 6: the climbing clamp keeps the hill session's climbs.
test("the running texts state the order in which runs give up climbing", () => {
  const expected = "easy and recovery runs first, then the long run, and the hill and quality runs last";
  for (const [file, text] of [["SKILL.md", SKILL], ["ultra-periodization.md", REFERENCE]] as const) {
    assert.ok(text.includes(expected), `${file} should say: ${expected}`);
    assert.ok(!text.includes("each run's climbing in proportion"), `${file} no longer says: each run's climbing in proportion`);
  }
});

// Final review item 12: a kept plan over a lowered cap releases continuity.
test("the running texts say a kept plan over this week's caps may change", () => {
  for (const [file, text] of [["SKILL.md", SKILL], ["ultra-periodization.md", REFERENCE]] as const) {
    assert.ok(text.includes("above this week's weekly or long-run cap"), `${file} should say: above this week's weekly or long-run cap`);
  }
});
