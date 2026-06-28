import type { CoachContext, RunningWeek } from "./types";

export type RunningValidation = { accepted: boolean; messages: string[] };

const HARD_KINDS = new Set(["long", "tempo", "intervals", "hills"]);
const RECOVERY_STATES = new Set(["overreaching", "recovery_needed"]);

export function validateRunningWeek(week: RunningWeek, context: CoachContext): RunningValidation {
  const messages: string[] = [];
  const running = context.running;
  const allowed = running?.runningDayOffsets ?? [];
  const hasSelectedDays = allowed.length > 0;
  const hasSafetyFlags = week.safetyFlags.length > 0;

  if (hasSelectedDays && week.sessions.length === 0) {
    messages.push("Running week must contain at least one run when future running days are available.");
  }

  if (running && hasSelectedDays) {
    const frequency = runFrequencyPolicy(running, allowed.length);
    const canReduceFrequency =
      hasSafetyFlags ||
      RECOVERY_STATES.has(context.readiness.state) ||
      (running.weeksToRace > 0 && running.weeksToRace <= 3);

    if (!canReduceFrequency && week.sessions.length < frequency.minRuns) {
      messages.push(
        `Running week is too sparse for the athlete's current base; use at least ${frequency.minRuns} runs or add safety flags explaining the reduction.`
      );
    }

    if (week.sessions.length > frequency.maxRuns) {
      messages.push(frequency.maxReason);
    }
  }

  let previousOffset = -1;
  for (const [index, session] of week.sessions.entries()) {
    const label = `Run ${index + 1}`;
    if (session.dayOffset < 1 || session.dayOffset > 6 || !Number.isInteger(session.dayOffset)) {
      messages.push(`${label} must use dayOffset 1 through 6; today is locked.`);
    }
    if (hasSelectedDays && !allowed.includes(session.dayOffset)) {
      messages.push(`${label} is scheduled on a non-running day.`);
    }
    if (session.dayOffset <= previousOffset) {
      messages.push(`${label} must use a day offset strictly later than the previous run.`);
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
  const maxDistance = week.sessions.reduce((max, session) => Math.max(max, session.distanceKm), 0);
  if (longest > 0 && maxDistance > longest * 1.4 && !hasSafetyFlags) {
    messages.push("Long run jumps more than 40% past the recent longest run without safety flags.");
  }

  const hardCount = week.sessions.filter((s) => HARD_KINDS.has(s.kind)).length;
  if (week.sessions.length >= 3 && hardCount > Math.ceil(week.sessions.length / 2) && !hasSafetyFlags) {
    messages.push("More than half the week is hard running without safety flags.");
  }

  // Mirror of the strength coach's no-all-light rule: far from the race with
  // no flagged reason, a week of only easy/recovery runs is not a build week.
  const weeksToRace = running?.weeksToRace ?? 0;
  if (week.sessions.length >= 3 && hardCount === 0 && weeksToRace > 3 && !hasSafetyFlags) {
    messages.push(
      "A normal build week needs at least one quality session (long, tempo, intervals, or hills) unless safety flags explain the easy week."
    );
  }

  // Long-run placement: the maximal-distance session(s) must include the selected
  // long-run day. The app sends running.longRunDayOffset computed with the same
  // machinery as runningDayOffsets (omitted when the long-run day is today or past),
  // so it is compared directly — no name-to-offset lookup. Race exemption: when the
  // race lands inside this planning window, a maximal-distance session on the race
  // day takes long-run precedence wherever it falls (mirrors SKILL.md).
  const longRunDayOffset = running?.longRunDayOffset;
  const longestRuns = week.sessions.filter((session) => session.distanceKm === maxDistance);
  if (
    typeof longRunDayOffset === "number" &&
    longRunDayOffset >= 1 &&
    longRunDayOffset <= 6 &&
    hasSelectedDays &&
    longestRuns.length > 0 &&
    maxDistance > 0
  ) {
    const raceDayOffset = raceOffset(context);
    const onRaceDay = raceDayOffset !== null && longestRuns.some((session) => session.dayOffset === raceDayOffset);
    const onLongRunDay = longestRuns.some((session) => session.dayOffset === longRunDayOffset);
    if (!onRaceDay && !onLongRunDay) {
      messages.push("The longest run must land on the selected long-run day.");
    }
  }

  return { accepted: messages.length === 0, messages };
}

function runFrequencyPolicy(running: NonNullable<CoachContext["running"]>, availableDays: number): {
  minRuns: number;
  maxRuns: number;
  maxReason: string;
} {
  if (availableDays <= 0) {
    return { minRuns: 0, maxRuns: 0, maxReason: "No future running days are available." };
  }

  const recentRunCount = running.recentRuns.length;
  const baselineWeeklyKm = running.baselineWeeklyKm || 0;
  const longestRecentRunKm = running.longestRecentRunKm || 0;
  const lowStartingBase = recentRunCount < 3 && baselineWeeklyKm <= 20 && longestRecentRunKm <= 8;
  const establishedBase = baselineWeeklyKm >= 35 || longestRecentRunKm >= 16 || recentRunCount >= 8;
  const highFrequencyBase = baselineWeeklyKm >= 55 || longestRecentRunKm >= 24 || recentRunCount >= 15;

  if (lowStartingBase) {
    const maxRuns = Math.min(availableDays, 3);
    return {
      minRuns: maxRuns,
      maxRuns,
      maxReason: `Starter running weeks should use at most ${maxRuns} runs so recovery days stay in the plan.`
    };
  }

  const minRuns =
    availableDays <= 2
      ? availableDays
      : establishedBase && availableDays >= 4
        ? 4
        : 3;
  const maxRuns =
    availableDays >= 6 && !highFrequencyBase
      ? 5
      : availableDays;

  return {
    minRuns,
    maxRuns,
    maxReason:
      `Six-run weeks need demonstrated high-frequency or high-volume history; this context supports at most ${maxRuns} runs.`
  };
}

// Rounding the raw difference (same approach as weeksToRace) keeps the offset
// stable when local-midnight instants straddle UTC calendar days across a DST
// transition; truncating both to UTC days would be off by one in that case.
function raceOffset(context: CoachContext): number | null {
  const raceDate = context.running?.raceGoal.raceDate;
  const weekStart = context.profile.weekStart;
  if (!raceDate || !weekStart) return null;
  const diffDays = Math.round((Date.parse(raceDate) - Date.parse(weekStart)) / 86_400_000);
  return Number.isFinite(diffDays) && diffDays >= 1 && diffDays <= 6 ? diffDays : null;
}
