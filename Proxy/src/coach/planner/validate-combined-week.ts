import type { CoachContext, RunningWeek, WeeklyPlan } from "./types";

const HARD_RUN_KINDS = new Set(["long", "tempo", "intervals", "hills"]);
const HARD_STRENGTH_LABELS = new Set(["hard", "very_hard", "max_output"]);

export function validateCombinedWeek(running: RunningWeek, strength: WeeklyPlan): string[] {
  const hardRunOffsets = new Set(
    running.sessions
      .filter((s) => HARD_RUN_KINDS.has(s.kind))
      .map((s) => s.dayOffset)
  );
  const messages: string[] = [];
  for (const session of strength.sessions) {
    const hardStrengthLabel = [session.plannedEffort?.label, ...session.exercises.map((exercise) => exercise.plannedEffort?.label)]
      .find((label) => HARD_STRENGTH_LABELS.has(label ?? ""));
    if (hardRunOffsets.has(session.dayOffset) && hardStrengthLabel) {
      messages.push(
        `Strength session "${session.title}" stacks ${hardStrengthLabel} effort on a long, tempo, interval, hill, or race-run day (offset ${session.dayOffset}). Lower the effort, or move it to another selected training day.`
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

export function fixedRunningLoadSupportsStrengthMaintenance(
  running: RunningWeek,
  context: CoachContext
): boolean {
  const hardRunCount = running.sessions.filter((session) => HARD_RUN_KINDS.has(session.kind)).length;
  const totalDistanceKm = running.sessions.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
  const baselineWeeklyKm = context.running?.baselineWeeklyKm ?? 0;
  if (baselineWeeklyKm <= 0) return hardRunCount >= 2;
  return (
    (hardRunCount >= 2 && totalDistanceKm >= baselineWeeklyKm * 0.6) ||
    (hardRunCount >= 1 && totalDistanceKm >= baselineWeeklyKm)
  );
}
