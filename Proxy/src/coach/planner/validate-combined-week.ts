import { hardestLabel, isNearLimitLabel } from "./goal-metrics";
import { round1 } from "./numbers";
import { loadBeforeToday, todayRun } from "./running-floors";
import { contextSeason, raceNameText, raceTimingText } from "./season";
import { percent } from "./strength-limits";
import type { CoachContext, RunningWeek, WeeklyPlan } from "./types";
import { freeOffsets, isHardRun } from "./week-schedule";

export function validateCombinedWeek(running: RunningWeek, strength: WeeklyPlan, context?: CoachContext): string[] {
  const hardRunOffsets = new Set(running.sessions.filter((s) => isHardRun(s.kind)).map((s) => s.dayOffset));
  const longRunOffsets = new Set(running.sessions.filter((s) => s.kind === "long").map((s) => s.dayOffset));
  const raceDayOffset = context ? raceOffset(context) : null;
  const messages: string[] = [];
  for (const session of strength.sessions) {
    // A test counts as the max effort it is, whatever its label (hardestLabel).
    const hardStrengthLabel = hardestLabel(session);
    if (hardRunOffsets.has(session.dayOffset) && hardStrengthLabel) {
      messages.push(
        `Strength session "${session.title}" stacks ${hardStrengthLabel} effort on a long, tempo, interval, hill, or race-run day (offset ${session.dayOffset}). Lower the effort, or move it to another selected training day.`
      );
      continue;
    }

    const hardest = hardestLabel(session);
    const nextDay = session.dayOffset + 1;
    const beforeRace = raceDayOffset !== null && nextDay === raceDayOffset;
    if (hardest && isNearLimitLabel(hardest) && (longRunOffsets.has(nextDay) || beforeRace)) {
      messages.push(
        `Strength session "${session.title}" is ${hardest} on offset ${session.dayOffset}, the day before the ${beforeRace ? "race" : "long run"} on offset ${nextDay}. Keep very_hard and max_output strength (tests included) off the day before a long run or the race: lower it to hard or medium, or move it.`
      );
    }
  }

  // One of offsets 1-6 stays a full rest day (no run, no strength).
  if (freeOffsets([...running.sessions, ...strength.sessions].map((session) => session.dayOffset)).length === 0) {
    messages.push("Running and strength together occupy all six future offsets; leave at least one complete rest day.");
  }

  return messages;
}

/** Leg maintenance: 3 or more hard runs besides the long run, or the week above 1.1x the four-week training average. */
export const LEG_MAINTENANCE_LIMITS = { hardRunsBesidesLongRun: 3, kmOverTrainingAverage: 1.1 } as const;

/**
 * Parked for Part 2 (leg dosing): no planner calls it yet; it stays, with its
 * tests, for the leg-strength family. Why this running week keeps leg
 * strength at maintenance, or null. Upper-body goal work never enters maintenance:
 * running load does not limit it, so neither a heavy running week, hard runs
 * nor the race calendar holds its progression (strength-guardrails.ts).
 * Legs hold in the peak and taper phases (the last 6 weeks before the race,
 * race day included), in the post-race transition (season.ts), with 3 or
 * more hard runs besides the long run, and when today's run plus the planned
 * runs pass 1.1x the four-week training average (races left out).
 */
export function legMaintenanceReason(running: RunningWeek, context: CoachContext): string | null {
  const runningContext = context.running;
  if (!runningContext) return null;
  const season = contextSeason(context);
  const race = raceNameText(season);
  if (season.phase === "peak" || season.phase === "taper") return `Peak or taper phase: ${race} is ${raceTimingText(season)}.`;
  if (season.raceState === "recent") return `Post-race transition: ${race} was ${raceTimingText(season)}.`;

  const today = todayRun(context);
  const kinds = [...running.sessions.map((session) => session.kind), ...(today?.kinds ?? [])];
  const hardRuns = kinds.filter((kind) => isHardRun(kind) && kind !== "long").length;
  if (hardRuns >= LEG_MAINTENANCE_LIMITS.hardRunsBesidesLongRun) {
    return `The running week has ${hardRuns} hard runs besides the long run.`;
  }

  const plannedKm = (today?.distanceKm ?? 0) + running.sessions.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
  const average = runningContext.recentRuns.length > 0
    ? loadBeforeToday(context, { racesIncluded: false }).fourWeekAvgKm
    : runningContext.baselineWeeklyKm || 0;
  if (average > 0 && plannedKm > average * LEG_MAINTENANCE_LIMITS.kmOverTrainingAverage) {
    return `The running week (${round1(plannedKm)} km with today's run) is more than ${percent(LEG_MAINTENANCE_LIMITS.kmOverTrainingAverage - 1)}% above the four-week training average (${round1(average)} km).`;
  }
  return null;
}

/** The race's day offset when it falls on a planned day (1-6), else null. */
function raceOffset(context: CoachContext): number | null {
  const days = contextSeason(context).daysToRace;
  return days !== null && days >= 1 && days <= 6 ? days : null;
}
