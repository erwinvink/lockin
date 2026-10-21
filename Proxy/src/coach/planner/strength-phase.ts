import type { CoachContext, EffortLabel, PlannedEffort, WeeklyPlan } from "./types";

/**
 * Strength in a planned recovery week and in the last 10 days before the
 * race. Both disciplines back off together:
 * - Recovery week: hard strength volume cut 40-60% (at most 60% of the hard
 *   sets prescribed in the last loading week), at most one hard session, no
 *   tests, no very_hard or max_output work, at most 3 sets per goal exercise,
 *   and no progression requirement (targets may hold or drop, not rise).
 * - Race taper: in the last 10 days strength stays light (no tests, no
 *   very_hard or max_output, at most one hard session, at most 3 sets per
 *   goal exercise, no progression requirement) and nothing hard (hard,
 *   very_hard, max_output) within 4 days of the race.
 */
export const STRENGTH_PHASE_LIMITS = {
  recovery: { maxHardSessions: 1, maxGoalSets: 3, hardSetRatio: 0.6 },
  race: { lightWithinDays: 10, noHardWithinDays: 4, maxHardSessions: 1, maxGoalSets: 3 }
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const HARD = new Set<EffortLabel>(["hard", "very_hard", "max_output"]);
const NEAR_LIMIT = new Set<EffortLabel>(["very_hard", "max_output"]);
const RPE_FOR: Record<"light" | "medium" | "hard", { rpe: number; rir: number }> = {
  light: { rpe: 3, rir: 5 },
  medium: { rpe: 6, rir: 4 },
  hard: { rpe: 8, rir: 2 }
};

export type StrengthPhase = {
  recoveryWeek: {
    reason: string;
    hardSetCap: number | null;
    referenceHardSets: number | null;
    maxHardSessions: number;
    maxGoalSets: number;
  } | null;
  /** Days from weekStart to the race when a planned day (1-6) falls inside its last 10 days. */
  raceTaper: { raceName: string; raceDayOffset: number } | null;
};

export type StrengthSessionRule = {
  /** No tests and no very_hard or max_output work. */
  light: boolean;
  /** Nothing hard at all (within 4 days of the race). */
  noHard: boolean;
  maxGoalSets: number | null;
  reason: string | null;
};

export function strengthPhase(context: CoachContext): StrengthPhase {
  const periodization = context.periodization;
  const recovery = periodization?.recoveryWeekDue
    ? {
        reason: periodization.recoveryWeekReason,
        hardSetCap: periodization.recoveryWeek?.hardStrengthSetCap ?? null,
        referenceHardSets: periodization.recoveryWeek?.referenceHardStrengthSets ?? null,
        maxHardSessions: periodization.recoveryWeek?.maxHardStrengthSessions ?? STRENGTH_PHASE_LIMITS.recovery.maxHardSessions,
        maxGoalSets: periodization.recoveryWeek?.maxGoalSetsPerExercise ?? STRENGTH_PHASE_LIMITS.recovery.maxGoalSets
      }
    : null;

  let raceTaper: StrengthPhase["raceTaper"] = null;
  const running = context.running;
  if (running) {
    const raceDayOffset = Math.round((Date.parse(running.raceGoal.raceDate) - Date.parse(context.profile.weekStart)) / DAY_MS);
    const touches = [1, 2, 3, 4, 5, 6].some((offset) => {
      const daysToRace = raceDayOffset - offset;
      return daysToRace >= 0 && daysToRace <= STRENGTH_PHASE_LIMITS.race.lightWithinDays;
    });
    if (Number.isFinite(raceDayOffset) && touches) raceTaper = { raceName: running.raceGoal.name, raceDayOffset };
  }
  return { recoveryWeek: recovery, raceTaper };
}

export function strengthPhaseActive(phase: StrengthPhase): boolean {
  return phase.recoveryWeek !== null || phase.raceTaper !== null;
}

/** The rule for a session on `dayOffset`. */
export function strengthSessionRule(dayOffset: number, phase: StrengthPhase): StrengthSessionRule {
  if (phase.raceTaper) {
    const daysToRace = phase.raceTaper.raceDayOffset - dayOffset;
    if (daysToRace >= 0 && daysToRace <= STRENGTH_PHASE_LIMITS.race.noHardWithinDays) {
      return {
        light: true,
        noHard: true,
        maxGoalSets: STRENGTH_PHASE_LIMITS.race.maxGoalSets,
        reason: `${daysToRace} day(s) before ${phase.raceTaper.raceName}: nothing hard within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race`
      };
    }
    if (daysToRace >= 0 && daysToRace <= STRENGTH_PHASE_LIMITS.race.lightWithinDays) {
      return {
        light: true,
        noHard: false,
        maxGoalSets: STRENGTH_PHASE_LIMITS.race.maxGoalSets,
        reason: `${daysToRace} day(s) before ${phase.raceTaper.raceName}: strength stays light in the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days`
      };
    }
  }
  if (phase.recoveryWeek) {
    return { light: true, noHard: false, maxGoalSets: phase.recoveryWeek.maxGoalSets, reason: "planned recovery week" };
  }
  return { light: false, noHard: false, maxGoalSets: null, reason: null };
}

/** Most hard sessions this phase allows (recovery week, or the last 10 days), or null. */
export function phaseMaxHardSessions(phase: StrengthPhase): number | null {
  const limits: number[] = [];
  if (phase.recoveryWeek) limits.push(phase.recoveryWeek.maxHardSessions);
  if (phase.raceTaper) limits.push(STRENGTH_PHASE_LIMITS.race.maxHardSessions);
  return limits.length > 0 ? Math.min(...limits) : null;
}

/** Working sets at hard or above across the week (tests included). */
export function hardSetCount(plan: WeeklyPlan): number {
  return plan.sessions.reduce(
    (total, session) =>
      total +
      (Array.isArray(session.exercises) ? session.exercises : [])
        .filter((exercise) => HARD.has(exercise.plannedEffort?.label))
        .reduce((sum, exercise) => sum + (typeof exercise.sets === "number" ? Math.max(0, exercise.sets) : 0), 0),
    0
  );
}

export function isHardLabel(label: unknown): boolean {
  return typeof label === "string" && HARD.has(label as EffortLabel);
}

export function isNearLimitLabel(label: unknown): boolean {
  return typeof label === "string" && NEAR_LIMIT.has(label as EffortLabel);
}

/** A planned effort lowered to `label`, with the matching RPE and RIR. */
export function loweredEffort(effort: PlannedEffort, label: "light" | "medium" | "hard", why: string): PlannedEffort {
  return {
    ...effort,
    label,
    targetRPE: RPE_FOR[label].rpe,
    targetRIR: Math.max(effort.targetRIR, RPE_FOR[label].rir),
    stimulus: effort.stimulus === "test" ? "strength" : effort.stimulus,
    reason: `${effort.reason?.trim() || "Planned effort"} Lowered for ${why}.`
  };
}

/** Text for the strength planner prompt. */
export function strengthPhaseForPrompt(phase: StrengthPhase): Record<string, unknown> | null {
  if (!strengthPhaseActive(phase)) return null;
  return {
    recoveryWeek: phase.recoveryWeek
      ? {
          reason: phase.recoveryWeek.reason,
          maxHardSessions: phase.recoveryWeek.maxHardSessions,
          maxGoalSetsPerExercise: phase.recoveryWeek.maxGoalSets,
          hardSetCap: phase.recoveryWeek.hardSetCap,
          referenceHardSets: phase.recoveryWeek.referenceHardSets,
          rule:
            "Planned recovery week: summary starts with Offload:. Cut hard strength volume 40-60% (hard, very_hard and max_output working sets at most hardSetCap, about 60% of last loading week's referenceHardSets), at most maxHardSessions hard session, no tests, no very_hard or max_output, at most maxGoalSetsPerExercise sets per goal exercise. Keep the habit with medium or light technique work; no progression is required and targets do not rise."
        }
      : null,
    raceTaper: phase.raceTaper
      ? {
          raceName: phase.raceTaper.raceName,
          raceDayOffset: phase.raceTaper.raceDayOffset,
          rule: `In the last ${STRENGTH_PHASE_LIMITS.race.lightWithinDays} days before the race strength stays light: no tests, no very_hard or max_output, at most ${STRENGTH_PHASE_LIMITS.race.maxHardSessions} hard session, at most ${STRENGTH_PHASE_LIMITS.race.maxGoalSets} sets per goal exercise, no progression required. Nothing hard (hard, very_hard, max_output) within ${STRENGTH_PHASE_LIMITS.race.noHardWithinDays} days of the race: mobility and easy technique only.`
        }
      : null
  };
}
