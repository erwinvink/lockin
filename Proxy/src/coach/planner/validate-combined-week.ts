import { computeTrainingSignals, type TrainingSignals } from "./compute-training-signals";
import { hardestLabel } from "./strength-guardrails";
import type { CoachContext, RunningWeek, WeeklyPlan } from "./types";

const HARD_RUN_KINDS = new Set(["long", "tempo", "intervals", "hills"]);
const HARD_STRENGTH_LABELS = new Set(["hard", "very_hard", "max_output"]);
const NEAR_LIMIT_LABELS = new Set(["very_hard", "max_output"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export function validateCombinedWeek(running: RunningWeek, strength: WeeklyPlan, context?: CoachContext): string[] {
  const hardRunOffsets = new Set(
    running.sessions
      .filter((s) => HARD_RUN_KINDS.has(s.kind))
      .map((s) => s.dayOffset)
  );
  const longRunOffsets = new Set(running.sessions.filter((s) => s.kind === "long").map((s) => s.dayOffset));
  const raceDayOffset = context ? raceOffset(context) : null;
  const messages: string[] = [];
  for (const session of strength.sessions) {
    const hardStrengthLabel = [session.plannedEffort?.label, ...session.exercises.map((exercise) => exercise.plannedEffort?.label)]
      .find((label) => HARD_STRENGTH_LABELS.has(label ?? ""));
    if (hardRunOffsets.has(session.dayOffset) && hardStrengthLabel) {
      messages.push(
        `Strength session "${session.title}" stacks ${hardStrengthLabel} effort on a long, tempo, interval, hill, or race-run day (offset ${session.dayOffset}). Lower the effort, or move it to another selected training day.`
      );
      continue;
    }

    const hardest = hardestLabel(session);
    const nextDay = session.dayOffset + 1;
    const beforeRace = raceDayOffset !== null && nextDay === raceDayOffset;
    if (hardest && NEAR_LIMIT_LABELS.has(hardest) && (longRunOffsets.has(nextDay) || beforeRace)) {
      messages.push(
        `Strength session "${session.title}" is ${hardest} on offset ${session.dayOffset}, the day before the ${beforeRace ? "race" : "long run"} on offset ${nextDay}. Keep very_hard and max_output strength (tests included) off the day before a long run or the race: lower it to hard or medium, or move it.`
      );
    }
  }

  const occupiedFutureOffsets = new Set([
    ...running.sessions.map((session) => session.dayOffset),
    ...strength.sessions.map((session) => session.dayOffset)
  ].filter((offset) => offset >= 1 && offset <= 6));
  if (occupiedFutureOffsets.size === 6) {
    messages.push("Running and strength together occupy all six future offsets; leave at least one complete rest day.");
  }

  return messages;
}

/**
 * Why this fixed running week may hold strength progression, or null. A
 * normal build week is not a reason: only a running week that is heavy
 * relative to the athlete's own norm (more than 10% above the 4-week
 * average, or 3+ hard runs), the peak/taper phase (1-6 weeks out), or the two
 * weeks after the race. Maintenance still forbids regression (validator).
 */
export function strengthMaintenanceReason(
  running: RunningWeek,
  context: CoachContext,
  signals: TrainingSignals | null = computeTrainingSignals(context, anchor(context))
): string | null {
  const runningContext = context.running;
  if (!runningContext) return null;

  const weeksToRace = runningContext.weeksToRace;
  if (weeksToRace >= 1 && weeksToRace <= 6) {
    return `Peak or taper phase: ${weeksToRace} week(s) to ${runningContext.raceGoal.name}.`;
  }
  const daysSinceRace = Math.round((Date.parse(context.profile.weekStart) - Date.parse(runningContext.raceGoal.raceDate)) / DAY_MS);
  if (Number.isFinite(daysSinceRace) && daysSinceRace >= 0 && daysSinceRace <= 14) {
    return `Post-race recovery: the race was ${daysSinceRace} day(s) ago.`;
  }

  const hardRunCount = running.sessions.filter((session) => HARD_RUN_KINDS.has(session.kind)).length;
  if (hardRunCount >= 3) {
    return `The running week has ${hardRunCount} hard runs.`;
  }

  const plannedKm = running.sessions.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
  const fourWeekAvg =
    signals && runningContext.recentRuns.length > 0 ? signals.running.fourWeekAvgKm : runningContext.baselineWeeklyKm || 0;
  if (fourWeekAvg > 0 && plannedKm > fourWeekAvg * 1.1) {
    return `The running week (${round1(plannedKm)} km) is more than 10% above the 4-week average (${round1(fourWeekAvg)} km).`;
  }
  return null;
}

export function fixedRunningLoadSupportsStrengthMaintenance(
  running: RunningWeek,
  context: CoachContext,
  signals?: TrainingSignals | null
): boolean {
  return strengthMaintenanceReason(running, context, signals === undefined ? computeTrainingSignals(context, anchor(context)) : signals) !== null;
}

function anchor(context: CoachContext): Date {
  const weekStart = Date.parse(context.profile?.weekStart ?? "");
  return Number.isFinite(weekStart) ? new Date(weekStart) : new Date();
}

function raceOffset(context: CoachContext): number | null {
  const raceDate = context.running?.raceGoal.raceDate;
  if (!raceDate) return null;
  const diff = Math.round((Date.parse(raceDate) - Date.parse(context.profile.weekStart)) / DAY_MS);
  return Number.isFinite(diff) && diff >= 1 && diff <= 6 ? diff : null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
