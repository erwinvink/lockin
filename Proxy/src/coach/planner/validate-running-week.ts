import {
  countedHardRuns,
  countedWeeklyKm,
  HARD_RUN_KINDS,
  isRaceDaySession,
  maxHardRunsFor,
  RUNNING_LIMITS,
  runningDayAvailability,
  runningGuardrails,
  targetProblem,
  type RunningGuardrails
} from "./running-guardrails";
import type { CoachContext, RunningWeek } from "./types";

export { runningDayAvailability } from "./running-guardrails";

export type RunningValidation = { accepted: boolean; messages: string[] };

/**
 * Structural and safety checks on a running week. Every message names the
 * limit and the offending value so the single repair attempt can fix it.
 * Safety flags are athlete-facing notes: they never waive a limit. Only the
 * computed relaxations in the guardrails (readiness, race/taper window,
 * wellness gate, recent distressed run, missing history) lower the run-count
 * floor or allow an all-easy week.
 */
export function validateRunningWeek(
  week: RunningWeek,
  context: CoachContext,
  guardrails: RunningGuardrails = runningGuardrails(context)
): RunningValidation {
  const messages: string[] = [];
  const running = context.running;
  const availability = runningDayAvailability(context);
  const allowed = availability.offsets;
  const hasSelectedDays = !availability.unconstrained;
  const hasAvailableDays = allowed.length > 0;
  const relaxed = guardrails.relaxations.length > 0;

  if (hasAvailableDays && week.sessions.length === 0) {
    messages.push("Running week must contain at least one run when future running days are available.");
  }

  if (new Set(week.sessions.map((session) => session.dayOffset).filter((offset) => offset >= 1 && offset <= 6)).size === 6) {
    messages.push("Running cannot occupy all six future offsets; leave at least one complete rest day for combined recovery.");
  }

  if (running && guardrails.frequency) {
    const frequency = guardrails.frequency;
    if (!relaxed && week.sessions.length < frequency.minRuns) {
      messages.push(
        `Running week is too sparse for the athlete's current base: ${week.sessions.length} runs planned, at least ${frequency.minRuns} required (${frequency.basis}). Add easy runs on available days; only computed readiness, taper, wellness, or recent-run warnings can lower this, safety flags cannot.`
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
    const problem = targetProblem(session.target);
    if (problem) {
      messages.push(`${label} ${problem}.`);
    }
    if (session.distanceKm < 0 || session.durationMinutes < 0 || session.elevationMeters < 0) {
      messages.push(`${label} has a negative distance, duration, or elevation.`);
    }
  }

  if (guardrails.weeklyVolume.kind === "capped") {
    const { capKm, referenceKm, basis } = guardrails.weeklyVolume;
    const plannedKm = countedWeeklyKm(week, guardrails);
    if (plannedKm > capKm + 0.05) {
      messages.push(
        `Planned running volume is ${plannedKm} km (race-day session excluded), above this week's cap of ${capKm} km (${Math.round(RUNNING_LIMITS.weeklyJumpRatio * 100)}% or ${RUNNING_LIMITS.weeklyMinimumStepKm} km above ${referenceKm} km, ${basis}). Remove at least ${round1(plannedKm - capKm)} km, mainly from easy or recovery runs; safety flags cannot waive this cap.`
      );
    }
  }

  if (guardrails.longRun) {
    const { capKm, recentLongestKm } = guardrails.longRun;
    for (const [index, session] of week.sessions.entries()) {
      if (isRaceDaySession(session, guardrails) || session.distanceKm <= capKm + 0.05) continue;
      messages.push(
        `Run ${index + 1} (${session.title}) is ${session.distanceKm} km, more than 40% above the recent longest run of ${recentLongestKm} km (cap ${capKm} km). Shorten it to ${capKm} km or less; safety flags cannot waive this cap.`
      );
    }
  }

  const hardRuns = week.sessions.filter((session) => HARD_RUN_KINDS.has(session.kind));
  const hardCount = countedHardRuns(week, guardrails);
  const maxHard = maxHardRunsFor(week.sessions.length);
  if (hardCount > maxHard) {
    messages.push(
      `The week has ${hardCount} hard runs (long, tempo, intervals, hills) in ${week.sessions.length} runs; hard running is capped at ${maxHard} for a ${week.sessions.length}-run week. Change ${hardCount - maxHard} of them to easy or recovery; safety flags cannot waive this cap.`
    );
  }

  messages.push(...consecutiveHardRunMessages(week, context, guardrails));

  // Mirror of the strength coach's no-all-light rule: far from the race with
  // no computed reason, a week of only easy/recovery runs is not a build week.
  const weeksToRace = running?.weeksToRace ?? 0;
  if (week.sessions.length >= 3 && hardRuns.length === 0 && weeksToRace > 3 && !relaxed) {
    messages.push(
      `A normal build week needs at least one quality session (long, tempo, intervals, or hills); this week has ${week.sessions.length} easy or recovery runs and no computed reason (readiness, taper, wellness gate, recent-run warning) for an all-easy week.`
    );
  }

  // Long-run placement: the maximal-distance session(s) must include the selected
  // long-run day. The app sends running.longRunDayOffset computed with the same
  // machinery as runningDayOffsets (omitted when the long-run day is today or past),
  // so it is compared directly — no name-to-offset lookup. Race exemption: when the
  // race lands inside this planning window, a maximal-distance session on the race
  // day takes long-run precedence wherever it falls (mirrors SKILL.md).
  const maxDistance = week.sessions.reduce((max, session) => Math.max(max, session.distanceKm), 0);
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
    const raceDayOffset = guardrails.raceDayOffset;
    const onRaceDay = raceDayOffset !== null && longestRuns.some((session) => session.dayOffset === raceDayOffset);
    const onLongRunDay = longestRuns.some((session) => session.dayOffset === longRunDayOffset);
    if (!onRaceDay && !onLongRunDay) {
      messages.push(`The longest run must land on the selected long-run day (offset ${longRunDayOffset}).`);
    }
  }

  return { accepted: messages.length === 0, messages };
}

function consecutiveHardRunMessages(week: RunningWeek, context: CoachContext, guardrails: RunningGuardrails): string[] {
  const messages: string[] = [];
  const sessions = week.sessions.map((session, index) => ({ session, index }));
  for (let i = 1; i < sessions.length; i += 1) {
    const previous = sessions[i - 1];
    const current = sessions[i];
    if (current.session.dayOffset !== previous.session.dayOffset + 1) continue;
    if (!HARD_RUN_KINDS.has(previous.session.kind) || !HARD_RUN_KINDS.has(current.session.kind)) continue;
    const bothLong = previous.session.kind === "long" && current.session.kind === "long";
    if (bothLong && guardrails.backToBackLongRunsAllowed) continue;

    let message =
      `Runs ${previous.index + 1} and ${current.index + 1} (${previous.session.kind} on offset ${previous.session.dayOffset}, ${current.session.kind} on offset ${current.session.dayOffset}) are hard runs on consecutive days. Put an easy run, recovery run, or rest day between hard runs.`;
    if (bothLong) {
      const race = context.running?.raceGoal.distanceKm ?? 0;
      const weeksToRace = context.running?.weeksToRace ?? 0;
      message += ` Back-to-back long runs are only allowed for races of ${RUNNING_LIMITS.backToBackMinRaceKm} km or more, ${RUNNING_LIMITS.backToBackWeeksToRace.min}-${RUNNING_LIMITS.backToBackWeeksToRace.max} weeks out (this race: ${race} km, ${weeksToRace} weeks out).`;
    }
    messages.push(message);
  }
  return messages;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
