import { plainExerciseName } from "./exercise-catalog";
import { EFFORT_ORDER, EFFORT_WORD, effortLabelOf, goalField, goalValue, hardestOf, isGoalTest, isHardLabel, loweredEffort, metricForExercise, type GoalMetric } from "./goal-metrics";
import { plural } from "./numbers";
import { contextSeason, daysBetween, raceDayOffsetOf, raceNameText, SEASON_LIMITS } from "./season";
import { ceilingOf, percent, STRENGTH_LIMITS, type MetricProgression } from "./strength-limits";
import type { CoachContext, EffortLabel, PlannedEffort, WeeklyPlan } from "./types";
import { PLANNED_OFFSETS } from "./week-schedule";

/**
 * Strength in a planned recovery week and in the last 10 days before the
 * race. Both disciplines back off together:
 * - Recovery week: hard strength volume cut 40-60% (at most 60% of the hard
 *   sets prescribed in the last loading week), at most one hard session, no
 *   tests except on its last 2 days (the athlete is freshest there; a test
 *   there is outside the week's hard limits), no very_hard or max_output
 *   work, at most 3 sets per goal exercise, and no progression requirement
 *   (targets may hold or drop, not rise).
 * - Race taper: in the last 10 days strength stays light (no tests, no
 *   very_hard or max_output, at most one hard session, at most 3 sets per
 *   goal exercise, no progression requirement) and nothing hard (hard,
 *   very_hard, max_output) within 4 days of the race.
 * - After a race, judged per planned day (post-race day 1 is the day after
 *   it): nothing hard on days 1-2 (light or medium only), at most hard on
 *   days 3-7 (no very_hard or max_output, so no tests), normal from day 8.
 *   Only the effort is capped: the week stays a normal week (progression, the
 *   session minimum, goal sets and exposures hold), so it is not a phase
 *   (strengthPhaseActive) and never makes a week impossible.
 */
export const STRENGTH_PHASE_LIMITS = {
  /**
   * Hard sets at most hardSetRatio of the last loading week's (enforced: at
   * least 40% fewer); the advice is to cut up to hardSetCutUpTo.
   */
  recovery: { maxHardSessions: 1, maxGoalSets: 3, hardSetRatio: 0.6, hardSetCutUpTo: 0.6, testDays: 2 },
  race: { lightWithinDays: 10, noHardWithinDays: 4, maxHardSessions: 1, maxGoalSets: 3 },
  /** Post-race days (1 = the day after the race): nothing hard through day 2, at most hard through day 7 (season.ts holds the numbers). */
  postRace: SEASON_LIMITS.postRace.strength,
  /**
   * Computed overreaching (for the next 3-7 days, responseDays): hard sets at
   * most 70% of the last loading week's (enforced: at least 30% fewer; the
   * advice is up to hardSetCutUpTo); without that reference at most one hard
   * session; goal exercises without a recent prescription at most 3 sets.
   * No tests.
   */
  overreaching: {
    responseDays: { min: 3, max: 7 },
    hardSetRatio: 0.7,
    hardSetCutUpTo: 0.5,
    maxHardSessionsWithoutReference: 1,
    maxFreeGoalSets: 3
  }
} as const;

export type StrengthPhase = {
  recoveryWeek: {
    reason: string;
    hardSetCap: number | null;
    referenceHardSets: number | null;
    maxHardSessions: number;
    maxGoalSets: number;
    /** Offsets (1-6) on the recovery week's last 2 days, where a goal test is allowed. */
    testDayOffsets: number[];
  } | null;
  /** The race's day offset when a planned day (1-6) falls inside its last 10 days. */
  raceTaper: RaceDay | null;
  /**
   * The race's day offset (0 or below once it is past) when a planned day
   * (1-6) is post-race day 1-7. Not a phase: it caps effort per day only.
   */
  postRace: RaceDay | null;
};

type RaceDay = { raceName: string; raceDayOffset: number };

/** Which rule caps a planned day. */
export type StrengthRuleSource = "race_taper" | "recovery_week" | "post_race";

/** A planned day's rule: no cap, or a lighter day with its reason and source. */
export type StrengthSessionRule =
  | { light: false; noHard: false; maxGoalSets: null; reason: null; testsAllowed: true; source: null }
  | {
      /** No tests (except a recovery week's last 2 days) and no very_hard or max_output work. */
      light: true;
      /** Nothing hard at all (within 4 days of the race, or on post-race days 1-2). */
      noHard: boolean;
      maxGoalSets: number | null;
      reason: string;
      /** A goal test may sit on this day (only on a recovery week's last 2 days). */
      testsAllowed: boolean;
      source: StrengthRuleSource;
    };

const NO_RULE: StrengthSessionRule = { light: false, noHard: false, maxGoalSets: null, reason: null, testsAllowed: true, source: null };

export function strengthPhase(context: CoachContext): StrengthPhase {
  const periodization = context.periodization;
  const recovery = periodization?.recoveryWeekDue
    ? {
        reason: periodization.recoveryWeekReason,
        hardSetCap: periodization.recoveryWeek?.hardStrengthSetCap ?? null,
        referenceHardSets: periodization.recoveryWeek?.referenceHardStrengthSets ?? null,
        maxHardSessions: periodization.recoveryWeek?.maxHardStrengthSessions ?? STRENGTH_PHASE_LIMITS.recovery.maxHardSessions,
        maxGoalSets: periodization.recoveryWeek?.maxGoalSetsPerExercise ?? STRENGTH_PHASE_LIMITS.recovery.maxGoalSets,
        testDayOffsets: recoveryTestOffsets(context.profile.weekStart, periodization.recoveryWeek?.endsAt)
      }
    : null;

  // Both read the race's day offset from the season (null without a readable race).
  const season = contextSeason(context);
  const raceDayOffset = raceDayOffsetOf(season);
  const raceDay = raceDayOffset === null ? null : { raceName: raceNameText(season), raceDayOffset };
  const inTaper = (offset: number) => raceDayOffset !== null && raceDayOffset - offset >= 0 && raceDayOffset - offset <= STRENGTH_PHASE_LIMITS.race.lightWithinDays;
  const afterRace = (offset: number) => raceDayOffset !== null && postRaceDay(offset, raceDayOffset) !== null;
  return {
    recoveryWeek: recovery,
    raceTaper: PLANNED_OFFSETS.some(inTaper) ? raceDay : null,
    postRace: PLANNED_OFFSETS.some(afterRace) ? raceDay : null
  };
}

/** The planned day's post-race day while the post-race rule applies (1-7), else null. */
function postRaceDay(dayOffset: number, raceDayOffset: number): number | null {
  const day = dayOffset - raceDayOffset;
  return day >= 1 && day <= STRENGTH_PHASE_LIMITS.postRace.atMostHardThroughDay ? day : null;
}

/** The planned offsets (1-6) that take no hard strength after the race, and those that take at most hard. */
export function postRaceDayOffsets(postRace: RaceDay): { noHard: number[]; atMostHard: number[] } {
  const days = { noHard: [] as number[], atMostHard: [] as number[] };
  for (const offset of PLANNED_OFFSETS) {
    const day = postRaceDay(offset, postRace.raceDayOffset);
    if (day === null) continue;
    (day <= STRENGTH_PHASE_LIMITS.postRace.noHardThroughDay ? days.noHard : days.atMostHard).push(offset);
  }
  return days;
}

/** Offsets 1-6 that fall on the recovery week's last 2 days (none when its end is unknown). */
function recoveryTestOffsets(weekStart: string, endsAt: string | undefined): number[] {
  const lastDay = endsAt ? daysBetween(weekStart, endsAt) - 1 : Number.NaN;
  if (!Number.isFinite(lastDay)) return [];
  return PLANNED_OFFSETS.filter((offset) => offset <= lastDay && offset > lastDay - STRENGTH_PHASE_LIMITS.recovery.testDays);
}

export function strengthPhaseActive(phase: StrengthPhase): boolean {
  return phase.recoveryWeek !== null || phase.raceTaper !== null;
}

/** Any per-day effort rule this week: a recovery week, the race taper, or post-race days. */
export function hasStrengthDayRules(phase: StrengthPhase): boolean {
  return strengthPhaseActive(phase) || phase.postRace !== null;
}

/**
 * The week's lighter strength phase as one plain clause (sentence start, no
 * closing stop), or null in a week without one: "This is a planned recovery
 * week", "Ridge Ultra is 8 days away: this week is inside the 10-day
 * strength taper", "Ridge Ultra is 16 days away: the 10-day strength taper
 * starts this week". The coach read, the offload note and the safety flag
 * all say it this way.
 */
export function lighterPhaseText(phase: StrengthPhase): string | null {
  if (phase.recoveryWeek) return "This is a planned recovery week";
  if (!phase.raceTaper) return null;
  const { raceName, raceDayOffset } = phase.raceTaper;
  const days = STRENGTH_PHASE_LIMITS.race.lightWithinDays;
  const away = `${raceName.charAt(0).toUpperCase()}${raceName.slice(1)} is ${raceDayOffset} ${raceDayOffset === 1 ? "day" : "days"} away`;
  // From offset 1, every planned day is inside the taper when the race is at most 11 days away.
  return raceDayOffset - 1 <= days
    ? `${away}: this week is inside the ${days}-day strength taper`
    : `${away}: the ${days}-day strength taper starts this week`;
}

/**
 * The rule for a session on `dayOffset`. A post-race day caps the effort on
 * top of the recovery-week rule (the taper rule only covers days before the
 * race, so the two never meet).
 */
export function strengthSessionRule(dayOffset: number, phase: StrengthPhase): StrengthSessionRule {
  const base = phaseSessionRule(dayOffset, phase);
  const day = phase.postRace ? postRaceDay(dayOffset, phase.postRace.raceDayOffset) : null;
  if (!phase.postRace || day === null) return base;
  const { noHardThroughDay, atMostHardThroughDay } = STRENGTH_PHASE_LIMITS.postRace;
  const noHard = day <= noHardThroughDay;
  const race = phase.postRace.raceName;
  return {
    light: true,
    noHard: noHard || base.noHard,
    maxGoalSets: base.maxGoalSets,
    reason: noHard
      ? `day ${day} after ${race}: nothing hard in the first ${noHardThroughDay} days after a race`
      : `day ${day} after ${race}: no very hard or max effort, so no test, before day ${atMostHardThroughDay + 1} after a race`,
    testsAllowed: false,
    source: "post_race"
  };
}

function phaseSessionRule(dayOffset: number, phase: StrengthPhase): StrengthSessionRule {
  if (phase.raceTaper) {
    const daysToRace = phase.raceTaper.raceDayOffset - dayOffset;
    if (daysToRace >= 0 && daysToRace <= STRENGTH_PHASE_LIMITS.race.noHardWithinDays) {
      return {
        light: true,
        noHard: true,
        maxGoalSets: STRENGTH_PHASE_LIMITS.race.maxGoalSets,
        reason: `${plural(daysToRace, "day")} before ${phase.raceTaper.raceName}: nothing hard within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race`,
        testsAllowed: false,
        source: "race_taper"
      };
    }
    if (daysToRace >= 0 && daysToRace <= STRENGTH_PHASE_LIMITS.race.lightWithinDays) {
      return {
        light: true,
        noHard: false,
        maxGoalSets: STRENGTH_PHASE_LIMITS.race.maxGoalSets,
        reason: `${plural(daysToRace, "day")} before ${phase.raceTaper.raceName}: strength stays light in the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days`,
        testsAllowed: false,
        source: "race_taper"
      };
    }
  }
  if (phase.recoveryWeek) {
    return {
      light: true,
      noHard: false,
      maxGoalSets: phase.recoveryWeek.maxGoalSets,
      reason: "planned recovery week",
      testsAllowed: phase.recoveryWeek.testDayOffsets.includes(dayOffset),
      source: "recovery_week"
    };
  }
  return NO_RULE;
}

/**
 * A goal test on the recovery week's last 2 days: allowed there, and outside
 * the week's hard-session and hard-set limits (one max set per metric when
 * the athlete is freshest).
 */
export function isAllowedPhaseTest(phase: StrengthPhase, dayOffset: unknown, effort: { label?: unknown; stimulus?: unknown } | null | undefined): boolean {
  return phase.recoveryWeek !== null &&
    typeof dayOffset === "number" &&
    isGoalTest(effort) &&
    strengthSessionRule(dayOffset, phase).testsAllowed;
}

/** The session's hardest hard label for the hard-session limits (a test allowed at the end of a recovery week left out). */
export function phaseHardestLabel(session: Pick<WeeklyPlan["sessions"][number], "dayOffset" | "plannedEffort" | "exercises">, phase: StrengthPhase): EffortLabel | null {
  const labels = [session.plannedEffort, ...(Array.isArray(session.exercises) ? session.exercises : []).map((exercise) => exercise.plannedEffort)]
    .filter((effort) => effort && !isAllowedPhaseTest(phase, session.dayOffset, effort))
    .map(effortLabelOf);
  const hardest = hardestOf(labels);
  return hardest !== null && isHardLabel(hardest) ? hardest : null;
}

/** Hard sets (hard, very_hard, max_output) for the hard-set caps (a test allowed at the end of a recovery week left out). */
export function phaseHardSetCount(plan: Pick<WeeklyPlan, "sessions">, phase: StrengthPhase): number {
  return plan.sessions.reduce(
    (total, session) =>
      total +
      (Array.isArray(session.exercises) ? session.exercises : [])
        .filter((exercise) => isHardLabel(effortLabelOf(exercise?.plannedEffort)) && !isAllowedPhaseTest(phase, session.dayOffset, exercise.plannedEffort))
        .reduce((sum, exercise) => sum + (typeof exercise.sets === "number" ? Math.max(0, exercise.sets) : 0), 0),
    0
  );
}

/** Most sets per goal exercise this phase allows (recovery week, or the last 10 days), or null. */
export function phaseMaxGoalSets(phase: StrengthPhase): number | null {
  const limits: number[] = [];
  if (phase.recoveryWeek) limits.push(phase.recoveryWeek.maxGoalSets);
  if (phase.raceTaper) limits.push(STRENGTH_PHASE_LIMITS.race.maxGoalSets);
  return limits.length > 0 ? Math.min(...limits) : null;
}

/** Most hard sessions this phase allows (recovery week, or the last 10 days), or null. */
export function phaseMaxHardSessions(phase: StrengthPhase): number | null {
  const limits: number[] = [];
  if (phase.recoveryWeek) limits.push(phase.recoveryWeek.maxHardSessions);
  if (phase.raceTaper) limits.push(STRENGTH_PHASE_LIMITS.race.maxHardSessions);
  return limits.length > 0 ? Math.min(...limits) : null;
}

/** Text for the strength planner prompt. */
export function strengthPhaseForPrompt(phase: StrengthPhase): Record<string, unknown> | null {
  if (!hasStrengthDayRules(phase)) return null;
  const { recovery } = STRENGTH_PHASE_LIMITS;
  return {
    recoveryWeek: phase.recoveryWeek
      ? {
          reason: phase.recoveryWeek.reason,
          maxHardSessions: phase.recoveryWeek.maxHardSessions,
          maxGoalSetsPerExercise: phase.recoveryWeek.maxGoalSets,
          hardSetCap: phase.recoveryWeek.hardSetCap,
          referenceHardSets: phase.recoveryWeek.referenceHardSets,
          testDayOffsets: phase.recoveryWeek.testDayOffsets,
          rule: `Planned recovery week: summary starts with Offload:. Cut hard strength volume ${percent(1 - recovery.hardSetRatio)}-${percent(recovery.hardSetCutUpTo)}% (hard, very_hard and max_output working sets at most hardSetCap, about ${percent(recovery.hardSetRatio)}% of last loading week's referenceHardSets), at most maxHardSessions hard session, no very_hard or max_output, at most maxGoalSetsPerExercise sets per goal exercise. No tests, except on the week's last ${recovery.testDays} days (testDayOffsets): a due test (strengthGuardrails.assessment) goes there, and it does not count toward hardSetCap or maxHardSessions. Keep the habit with medium or light technique work; no progression is required and targets do not rise.`
        }
      : null,
    raceTaper: phase.raceTaper
      ? {
          raceName: phase.raceTaper.raceName,
          raceDayOffset: phase.raceTaper.raceDayOffset,
          rule: `In the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days before the race strength stays light: no tests, no very_hard or max_output, at most ${STRENGTH_PHASE_LIMITS.race.maxHardSessions} hard session, at most ${STRENGTH_PHASE_LIMITS.race.maxGoalSets} sets per goal exercise, no progression required. Nothing hard (hard, very_hard, max_output) within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race: mobility and easy technique only.`
        }
      : null,
    postRace: phase.postRace ? postRaceForPrompt(phase.postRace) : null
  };
}

function postRaceForPrompt(postRace: RaceDay): Record<string, unknown> {
  const { noHardThroughDay: noHard, atMostHardThroughDay: atMostHard } = STRENGTH_PHASE_LIMITS.postRace;
  const offsets = postRaceDayOffsets(postRace);
  return {
    raceName: postRace.raceName,
    noHardDayOffsets: offsets.noHard,
    atMostHardDayOffsets: offsets.atMostHard,
    rule: `After the race, judged per planned day (post-race day 1 is the day after the race): nothing hard (hard, very_hard, max_output) on post-race days 1-${noHard} (noHardDayOffsets), light or medium only; at most hard on days ${noHard + 1}-${atMostHard} (atMostHardDayOffsets): no very_hard or max_output, so no tests; from day ${atMostHard + 1} after the race normal effort. Only the effort is capped: this is a normal week for upper-body strength, so earned progression, the session minimum, goal sets and goal exposures still apply; carry them with medium (from day ${noHard + 1} also hard) working sets. Harder work on these days is lowered to the limit (enforced).`
  };
}

type ClampSession = WeeklyPlan["sessions"][number];
type ClampExercise = ClampSession["exercises"][number];

/**
 * A converted test's value inside the ceiling (the progression band's top,
 * the held level, else the working cap): one above it is lowered to it, and
 * one of 0 (an "as many as possible" set) takes it when the metric has a band
 * (hold, earned, reduce, offload). Without a ceiling, or with 0
 * and no band (free: only the caps apply, as in a pain week), no number is
 * safe to invent: the block becomes light technique work, which is not
 * counted. Returns the effort the block keeps.
 */
function testValueWithin(exercise: ClampExercise, metric: GoalMetric, entry: MetricProgression, why: string): "kept" | "light" {
  const ceiling = ceilingOf(entry);
  const value = goalValue(metric, exercise);
  if (ceiling === null || (value <= 0 && entry.status === "free")) {
    exercise.plannedEffort = { ...loweredEffort(exercise.plannedEffort, "light", why), stimulus: "technique" };
    exercise.intensity = "Light";
    return "light";
  }
  if (value <= 0 || value > ceiling) exercise[goalField(metric)] = ceiling;
  return "kept";
}

/**
 * A test the week cannot hold (the phase rules, or overreaching) as working
 * sets: medium effort, at least 2 sets of goal work, the value inside the
 * ceiling (testValueWithin), or light technique work when no number is safe.
 * A support exercise's test only drops to medium. Returns the effort it became.
 */
export function testAsWorkingSets(exercise: ClampExercise, metric: GoalMetric | null, entry: MetricProgression | null, why: string): "medium" | "light" {
  if (metric && entry && testValueWithin(exercise, metric, entry, why) === "light") return "light";
  exercise.plannedEffort = loweredEffort(exercise.plannedEffort, "medium", why);
  exercise.intensity = "Medium";
  if (metric && exercise.sets < STRENGTH_LIMITS.goalSets.min) exercise.sets = STRENGTH_LIMITS.goalSets.min;
  return "medium";
}

/**
 * At most `maxHard` hard sessions: keep the earliest, lower the rest to
 * medium (a test allowed at the end of a recovery week stays outside it).
 */
export function limitHardSessions(
  sessions: ClampSession[],
  phase: StrengthPhase,
  maxHard: number,
  when: string,
  adjustments: string[],
  sessionNotes: string[][]
): boolean {
  let kept = 0;
  let changed = false;
  sessions.forEach((session, index) => {
    if (phaseHardestLabel(session, phase) === null) return;
    kept += 1;
    if (kept <= maxHard) return;
    lowerSessionToMedium(session, `at most ${plural(maxHard, "hard strength session")} ${when}`, (effort) => isAllowedPhaseTest(phase, session.dayOffset, effort));
    adjustments.push(`Session ${index + 1} (${session.title}): lowered to medium (at most ${maxHard} hard strength session ${when}).`);
    sessionNotes[index].push(`effort lowered to medium (${maxHard === 1 ? "one hard session" : `${maxHard} hard sessions`} this week)`);
    changed = true;
  });
  return changed;
}

/**
 * Hard sets (hard, very_hard, max_output) above `cap`: trim sets on hard
 * exercises, latest sessions first, keeping 2 sets of goal work and 1 of
 * support work; still over, lower hard exercises to medium, latest first.
 * A test allowed at the end of a recovery week is left alone.
 */
export function trimHardSets(
  sessions: ClampSession[],
  phase: StrengthPhase,
  cap: number,
  owner: string,
  adjustments: string[],
  sessionNotes: string[][]
): boolean {
  const plan = { sessions };
  const before = phaseHardSetCount(plan, phase);
  let excess = before - cap;
  if (excess <= 0) return false;
  for (let index = sessions.length - 1; index >= 0 && excess > 0; index -= 1) {
    for (const exercise of [...(sessions[index].exercises ?? [])].reverse()) {
      if (excess <= 0) break;
      if (!isHardLabel(exercise.plannedEffort?.label) || isAllowedPhaseTest(phase, sessions[index].dayOffset, exercise.plannedEffort)) continue;
      const minimum = metricForExercise(exercise.exercise) ? STRENGTH_LIMITS.goalSets.min : 1;
      const cut = Math.min(excess, exercise.sets - minimum);
      if (cut > 0) {
        sessionNotes[index].push(`${plainExerciseName(exercise.exercise)} ${exercise.sets} -> ${exercise.sets - cut} hard ${exercise.sets - cut === 1 ? "set" : "sets"}`);
        exercise.sets -= cut;
        excess -= cut;
      }
    }
  }
  for (let index = sessions.length - 1; index >= 0 && excess > 0; index -= 1) {
    for (const exercise of [...(sessions[index].exercises ?? [])].reverse()) {
      if (excess <= 0) break;
      if (!isHardLabel(exercise.plannedEffort?.label) || !exercise.plannedEffort) continue;
      if (isAllowedPhaseTest(phase, sessions[index].dayOffset, exercise.plannedEffort)) continue;
      sessionNotes[index].push(`${plainExerciseName(exercise.exercise)} ${EFFORT_WORD[exercise.plannedEffort.label]} -> medium effort`);
      exercise.plannedEffort = loweredEffort(exercise.plannedEffort, "medium", `${owner} hard-set cap`);
      exercise.intensity = "Medium";
      excess -= exercise.sets;
    }
    syncSessionEffort(sessions[index], "hard", `${owner} hard-set cap`);
  }
  adjustments.push(`Hard strength sets ${before} were above ${owner} cap of ${cap}; trimmed to ${phaseHardSetCount(plan, phase)}.`);
  return true;
}

/** The session label follows its hardest exercise down (never up), to at most `ceiling`. */
export function syncSessionEffort(session: ClampSession, ceiling: "medium" | "hard", why: string) {
  const effort = session.plannedEffort;
  if (!effort || !Array.isArray(session.exercises)) return;
  const rank = (label: EffortLabel) => EFFORT_ORDER.indexOf(label);
  const hardestExercise = hardestOf(session.exercises.map((exercise) => exercise.plannedEffort?.label)) ?? "light";
  const allowed = EFFORT_ORDER[Math.min(rank(ceiling), Math.max(rank(hardestExercise), rank("medium")))];
  if (rank(effort.label) > rank(allowed)) {
    session.plannedEffort = loweredEffort(effort, allowed === "hard" ? "hard" : "medium", why);
  }
}

/** Every hard label of the session lowered to medium, except what `keep` holds on to. */
export function lowerSessionToMedium(session: ClampSession, why: string, keep: (effort: PlannedEffort) => boolean = () => false) {
  if (session.plannedEffort && isHardLabel(session.plannedEffort.label) && !keep(session.plannedEffort)) {
    session.plannedEffort = loweredEffort(session.plannedEffort, "medium", why);
  }
  for (const exercise of session.exercises ?? []) {
    if (exercise.plannedEffort && isHardLabel(exercise.plannedEffort.label) && !keep(exercise.plannedEffort)) {
      exercise.plannedEffort = loweredEffort(exercise.plannedEffort, "medium", why);
      exercise.intensity = "Medium";
    }
  }
}
