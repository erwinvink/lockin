import type { CoachContext, RunningWeek } from "./types";

export type RunningValidation = { accepted: boolean; messages: string[] };

const HARD_KINDS = new Set(["long", "tempo", "intervals", "hills"]);

export function validateRunningWeek(week: RunningWeek, context: CoachContext): RunningValidation {
  const messages: string[] = [];
  const running = context.running;
  const allowed = running?.runningDayOffsets ?? [];
  const hasSelectedDays = allowed.length > 0;
  const hasSafetyFlags = week.safetyFlags.length > 0;

  if (hasSelectedDays && week.sessions.length !== allowed.length) {
    messages.push(`Running week must contain exactly ${allowed.length} runs, one per selected running day.`);
  }

  let previousOffset = -1;
  for (const [index, session] of week.sessions.entries()) {
    const label = `Run ${index + 1}`;
    if (session.dayOffset < 1 || session.dayOffset > 6) {
      messages.push(`${label} must use dayOffset 1 through 6; today is locked.`);
    }
    if (hasSelectedDays && !allowed.includes(session.dayOffset)) {
      messages.push(`${label} is scheduled on a non-running day.`);
    }
    if (session.dayOffset <= previousOffset) {
      messages.push("Runs must use strictly increasing day offsets.");
    }
    previousOffset = session.dayOffset;
    if (session.target.low > session.target.high) {
      messages.push(`${label} target low must not exceed target high.`);
    }
    if (session.distanceKm < 0 || session.durationMinutes < 0 || session.elevationMeters < 0) {
      messages.push(`${label} has a negative distance, duration, or elevation.`);
    }
  }

  const longest = running?.longestRecentRunKm ?? 0;
  const longRun = [...week.sessions].sort((a, b) => b.distanceKm - a.distanceKm)[0];
  if (longRun && longest > 0 && longRun.distanceKm > longest * 1.4 && !hasSafetyFlags) {
    messages.push("Long run jumps more than 40% past the recent longest run without safety flags.");
  }

  const hardCount = week.sessions.filter((s) => HARD_KINDS.has(s.kind)).length;
  if (week.sessions.length >= 3 && hardCount > Math.ceil(week.sessions.length / 2) && !hasSafetyFlags) {
    messages.push("More than half the week is hard running without safety flags.");
  }

  // Race-day offset: when the race lands inside this planning window, the race
  // session takes long-run precedence wherever it falls (mirrors SKILL.md).
  const raceDayOffset = raceOffset(context);
  if (running?.longRunDay && hasSelectedDays && longRun && longRun.dayOffset !== raceDayOffset) {
    // runningDays and runningDayOffsets are parallel arrays (same construction
    // as the app's trainingDays/trainingDayOffsets), so the index lookup is valid.
    const longRunOffset = running.runningDayOffsets[running.runningDays.indexOf(running.longRunDay)];
    if (longRunOffset !== undefined && longRunOffset >= 1 && longRun.dayOffset !== longRunOffset) {
      messages.push("The longest run must land on the selected long-run day.");
    }
  }

  return { accepted: messages.length === 0, messages };
}

function raceOffset(context: CoachContext): number | null {
  const raceDate = context.running?.raceGoal.raceDate;
  const weekStart = context.profile.weekStart;
  if (!raceDate || !weekStart) return null;
  const diffDays = Math.round((startOfUTCDay(raceDate) - startOfUTCDay(weekStart)) / 86_400_000);
  return diffDays >= 1 && diffDays <= 6 ? diffDays : null;
}

function startOfUTCDay(iso: string): number {
  const date = new Date(iso);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
