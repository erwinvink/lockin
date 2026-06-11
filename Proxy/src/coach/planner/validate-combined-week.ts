import type { RunningWeek, WeeklyPlan } from "./types";

export function validateCombinedWeek(running: RunningWeek, strength: WeeklyPlan): string[] {
  const hardRunOffsets = new Set(
    running.sessions
      .filter((s) => ["long", "tempo", "intervals", "hills"].includes(s.kind))
      .map((s) => s.dayOffset)
  );
  const messages: string[] = [];
  for (const session of strength.sessions) {
    if (hardRunOffsets.has(session.dayOffset) &&
        ["very_hard", "max_output"].includes(session.plannedEffort?.label ?? "")) {
      messages.push(
        `Strength session "${session.title}" stacks ${session.plannedEffort.label} effort on a hard run day (offset ${session.dayOffset}). Lower the effort, or move it to another selected training day.`
      );
    }
  }
  return messages;
}
