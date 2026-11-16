import { CONTINUITY_LIMITS } from "./current-plan";
import { round1 } from "./numbers";
import { QUALITY_FLOOR_KINDS, qualityRunDays } from "./running-floors";
import { weeklyBudgetAfterToday, type RunningGuardrails } from "./running-guardrails";
import { HARD_RUN_KINDS, runRuleFor } from "./running-phase-limits";
import type { CoachContext, CurrentPlanRun } from "./types";

/**
 * Continuity yields to the running floors and caps when keeping the current
 * plan cannot meet them; that is a change signal. It also covers a relaxation
 * that ended without one (a run rated feel 1-2 ageing out of its 7 days).
 * - Weekly km: today's run, plus each kept run grown by at most 15% and never
 *   past its own cap, plus the running days the kept plan leaves free (last
 *   night's plan never covers offset 6) at their allowed maximum, all within
 *   the weekly cap, must reach the floor with a margin. Each run's most is
 *   rounded down, as the clamp and most plans do, so a kept plan never falls
 *   short of the floor by rounding.
 * - Quality: the kept plan has no tempo, interval or hill run, and no free
 *   running day is left that could take one.
 * - Caps: the mirror of the floor. Each kept run shortened by at most 15%
 *   (the race day left out), plus today's run, must fit the weekly cap, and
 *   each kept run must fit its own cap (the long-run cap, or its day's
 *   race-window or recovery-week cap). A lowered cap otherwise keeps runs
 *   over it, and the clamp and the hold would pull the plan two ways.
 */
export const CONTINUITY_FLOOR_LIMITS = {
  /** The kept plan's most must reach the weekly-km floor by at least this much. */
  marginKm: 0.5,
  /** Each run's most is rounded down to this step. */
  roundDownKm: 0.5
} as const;

export function floorChangeSignals(context: CoachContext, guardrails: RunningGuardrails): string[] {
  if (!context.currentPlan) return [];
  const { weeklyKm, qualityRun } = guardrails.floors;
  const signals: string[] = [];
  const reachKm = keptPlanMostKm(context, guardrails);
  if (weeklyKm.minKm !== null && reachKm !== null && reachKm < weeklyKm.minKm + CONTINUITY_FLOOR_LIMITS.marginKm) {
    const tolerance = Math.round(CONTINUITY_LIMITS.runDistanceTolerance * 100);
    signals.push(`The planned week is below the running floor: kept within ${tolerance}% it reaches ${reachKm} km over the 7 days, under the ${weeklyKm.minKm} km floor.`);
  }
  if (qualityRun.required && !keptPlanCanHoldQuality(context, guardrails)) {
    signals.push("The planned week has no tempo, interval or hill run, and the running floor needs one.");
  }
  return [...signals, ...capChangeSignals(context, guardrails)];
}

/**
 * The kept plan over this week's caps even 15% shorter: the weekly cap (today's
 * run included, the race day left out) or a run's own cap (the long-run cap,
 * or its day's race-window or recovery-week cap).
 */
function capChangeSignals(context: CoachContext, guardrails: RunningGuardrails): string[] {
  const plan = keptAndFree(context, guardrails);
  if (!plan) return [];
  const tolerance = CONTINUITY_LIMITS.runDistanceTolerance;
  const kept = plan.kept
    .filter((run) => guardrails.raceDayOffset === null || run.dayOffset !== guardrails.raceDayOffset)
    .map((run) => ({ run, km: Math.max(0, run.distanceKm ?? 0), leastKm: round1(Math.max(0, run.distanceKm ?? 0) * (1 - tolerance)) }));
  const lead = `The planned week is above this week's running cap: kept within ${Math.round(tolerance * 100)}%`;
  const signals: string[] = [];
  if (guardrails.weeklyVolume.kind === "capped") {
    const capKm = guardrails.weeklyVolume.capKm;
    const leastKm = round1((guardrails.today?.distanceKm ?? 0) + kept.reduce((sum, { leastKm: km }) => sum + km, 0));
    if (leastKm > capKm + 0.05) signals.push(`${lead} it holds at least ${leastKm} km over the 7 days, over the ${capKm} km cap.`);
  }
  const overOwnCap = kept
    .map(({ run, km, leastKm }) => ({ run, km, leastKm, capKm: runCapKm(run.dayOffset, run.kind ?? "easy", guardrails) }))
    .filter(({ leastKm, capKm }) => leastKm > capKm + 0.05);
  if (overOwnCap.length > 0) {
    const runs = overOwnCap.map(({ run, km, leastKm, capKm }) => `the ${round1(km)} km ${run.kind ? `${run.kind} ` : ""}run is at least ${leastKm} km, over its ${round1(capKm)} km cap`);
    signals.push(`${lead} ${runs.join("; ")}.`);
  }
  return signals;
}

/**
 * The most today's run plus the kept plan can reach over the 7 days, in km,
 * or null without a current plan: each kept run grown by at most 15% and
 * never past its own cap, plus the free running days at their most (a day
 * other than the long-run day never past the kept long run), as many as the
 * run count allows, all within the weekly cap.
 */
export function keptPlanMostKm(context: CoachContext, guardrails: RunningGuardrails): number | null {
  const plan = keptAndFree(context, guardrails);
  if (!plan) return null;
  const { kept, free, room, longRunDay } = plan;
  const keptReach = kept.map((run) => ({
    run,
    km: roundDown(Math.min(Math.max(0, run.distanceKm ?? 0) * (1 + CONTINUITY_LIMITS.runDistanceTolerance), runCapKm(run.dayOffset, run.kind ?? "easy", guardrails)))
  }));
  // A run on another day cannot be longer than the long run (it must sit on the long-run day).
  const longReach = keptReach.find(({ run }) => run.dayOffset === longRunDay)?.km ?? Number.POSITIVE_INFINITY;
  const freeKm = free
    .map((offset) => roundDown(offset === longRunDay ? runCapKm(offset, "long", guardrails) : Math.min(runCapKm(offset, "easy", guardrails), longReach)))
    .sort((a, b) => b - a)
    .slice(0, room)
    .reduce((sum, km) => sum + km, 0);
  const budget = weeklyBudgetAfterToday(guardrails) ?? Number.POSITIVE_INFINITY;
  const plannedKm = Math.min(budget, keptReach.reduce((sum, { km }) => sum + km, 0) + freeKm);
  return Math.round(((guardrails.today?.distanceKm ?? 0) + plannedKm) * 10) / 10;
}

/**
 * Whether the kept plan holds a tempo, interval or hill run outside a
 * wellness gate, or a free running day could still take one (the shared
 * quality-day rule, with the kept hard runs as neighbours).
 */
export function keptPlanCanHoldQuality(context: CoachContext, guardrails: RunningGuardrails): boolean {
  const plan = keptAndFree(context, guardrails);
  if (!plan) return true;
  const { kept, free, room, longRunDay } = plan;
  const gated = guardrails.wellnessGate?.offsets ?? [];
  if (kept.some((run) => QUALITY_FLOOR_KINDS.has(run.kind ?? "") && !gated.includes(run.dayOffset))) return true;
  if (room === 0) return false;
  const hardRunOffsets = kept.filter((run) => HARD_RUN_KINDS.has(run.kind ?? "")).map((run) => run.dayOffset);
  return qualityRunDays(free, { longRunDayOffset: longRunDay, today: guardrails.today, hardRunOffsets, gatedOffsets: gated }).length > 0;
}

/** The kept runs (offsets 1-6), the free running days, and how many more runs fit. */
function keptAndFree(
  context: CoachContext,
  guardrails: RunningGuardrails
): { kept: CurrentPlanRun[]; free: number[]; room: number; longRunDay: number | undefined } | null {
  const plan = context.currentPlan;
  if (!plan) return null;
  const kept = plan.runs.filter((run) => run.dayOffset >= 1 && run.dayOffset <= 6);
  const free = guardrails.availability.offsets.filter((offset) => offset >= 1 && offset <= 6 && !kept.some((run) => run.dayOffset === offset));
  const room = Math.max(0, (guardrails.frequency?.maxRuns ?? free.length + kept.length) - kept.length);
  return { kept, free, room, longRunDay: context.running?.longRunDayOffset };
}

/** The most one run on this day may be: the long-run cap and the day's race-window or recovery-week cap. */
function runCapKm(dayOffset: number, kind: string, guardrails: RunningGuardrails): number {
  const phaseCap = runRuleFor({ dayOffset, kind, distanceKm: 0 }, guardrails.phase).maxKm;
  return Math.min(guardrails.longRun?.capKm ?? Number.POSITIVE_INFINITY, phaseCap ?? Number.POSITIVE_INFINITY);
}

/** Rounded down to the rounding step (infinity stays infinity). */
function roundDown(km: number): number {
  const step = CONTINUITY_FLOOR_LIMITS.roundDownKm;
  return Math.floor(km / step + 1e-9) * step;
}
