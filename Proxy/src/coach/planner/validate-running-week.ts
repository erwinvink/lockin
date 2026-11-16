import { round1 } from "./numbers";
import {
  countedHardRuns,
  countedWeeklyClimb,
  countedWeeklyKm,
  HARD_RUN_KINDS,
  isRaceDaySession,
  kmLeftAfterToday,
  maxHardRunsFor,
  RELAXATION_LABELS,
  RUNNING_FLOOR_LIMITS,
  RUNNING_LIMITS,
  runningDayAvailability,
  runningGuardrails,
  targetProblem,
  weeklyBudgetAfterToday,
  type RunningGuardrails
} from "./running-guardrails";
import { followsTodayHardRun, todayCountsAsRun, todayHardKind, todayRunLabel } from "./running-floors";
import { QUALITY_RUN_KINDS, runRuleFor } from "./running-phase-limits";
import { contextSeason, raceTimingText } from "./season";
import type { CoachContext, RunningWeek } from "./types";
import { WELLNESS_GATE_LIMITS } from "./wellness-gate";

export { runningDayAvailability } from "./running-guardrails";

export type RunningValidation = { accepted: boolean; messages: string[] };

/** The computed reasons that lower the run count and lift the floors, in the words the planner uses. */
const COMPUTED_REASONS = Object.values(RELAXATION_LABELS);

function onlyComputedReasons(what: string): string {
  return `only a computed reason ${what}: ${COMPUTED_REASONS.slice(0, -1).join(", ")} or ${COMPUTED_REASONS.at(-1)}; a profile note, a wellness gate and a safety flag cannot`;
}

/**
 * Structural and safety checks on a running week. Every message names the
 * limit and the offending value so the single repair attempt can fix it.
 * Safety flags are athlete-facing notes: they never waive a limit. Only the
 * computed relaxations in the guardrails (readiness, race/taper window,
 * planned recovery week, recent distressed run, missing history) lower the
 * run-count floor or lift the week's floors; the free-text profile note never
 * does. A wellness gate is not one of them: it only keeps quality runs out of
 * the next 48 hours. The weekly floors count today's run (locked) with the planned runs.
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
  // Computed reasons lower the run floor (a wellness gate is not one of them).
  // The quality-run and weekly-km floors come computed in guardrails.floors.
  const relaxed = guardrails.relaxations.length > 0;

  // When today's run used up the week's cap, the rest of the week may stay empty.
  const budget = weeklyBudgetAfterToday(guardrails);
  const budgetFitsARun = budget === null || budget >= RUNNING_LIMITS.easyRunMinimumKm;
  if (hasAvailableDays && week.sessions.length === 0 && budgetFitsARun) {
    messages.push("Running week must contain at least one run when future running days are available.");
  }

  if (new Set(week.sessions.map((session) => session.dayOffset).filter((offset) => offset >= 1 && offset <= 6)).size === 6) {
    messages.push("Running cannot occupy all six future offsets; leave at least one complete rest day for combined recovery.");
  }

  if (running && guardrails.frequency) {
    const frequency = guardrails.frequency;
    if (!relaxed && week.sessions.length < frequency.minRuns) {
      messages.push(
        `Running week is too sparse for the athlete's current base: ${week.sessions.length} runs planned, at least ${frequency.minRuns} required (${frequency.basis}). Add easy runs on available days; ${onlyComputedReasons("lowers the run count")}.`
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
    // The cap covers the same 7 days as the floors: today's run (locked) counts.
    const { capKm, referenceKm, basis, phase } = guardrails.weeklyVolume;
    const plannedKm = countedWeeklyKm(week, guardrails);
    const todayKm = guardrails.today?.distanceKm ?? 0;
    const totalKm = round1(plannedKm + todayKm);
    // Today's run is locked: the planned runs get what it leaves, never less than nothing.
    const budgetKm = kmLeftAfterToday(guardrails.weeklyVolume, guardrails.today);
    if (plannedKm > budgetKm + 0.05) {
      const why = phase
        ? basis
        : `${Math.round(RUNNING_LIMITS.weeklyJumpRatio * 100)}% or ${RUNNING_LIMITS.weeklyMinimumStepKm} km above ${referenceKm} km, ${basis}`;
      const volume = todayKm > 0
        ? `${plannedKm} km (race-day session excluded) plus today's ${todayKm} km run, ${totalKm} km over the 7 days`
        : `${plannedKm} km (race-day session excluded)`;
      messages.push(
        `Planned running volume is ${volume}, above this week's cap of ${capKm} km (${why}). Remove at least ${round1(plannedKm - budgetKm)} km, mainly from easy or recovery runs; safety flags cannot waive this cap.`
      );
    }
  }

  messages.push(...phaseRuleMessages(week, guardrails));

  const gate = guardrails.wellnessGate;
  if (gate) {
    week.sessions.forEach((session, index) => {
      if (!QUALITY_RUN_KINDS.has(session.kind) || !gate.offsets.includes(session.dayOffset)) return;
      messages.push(
        `Run ${index + 1} (${session.title}) is a ${session.kind} run on offset ${session.dayOffset}: ${gate.reason}, so no tempo, interval or hill run in the next ${WELLNESS_GATE_LIMITS.gateHours} hours. Move it to a later day or make it an easy run.`
      );
    });
  }

  if (guardrails.longRun) {
    const { capKm, referenceKm, basis } = guardrails.longRun;
    const above = Math.round((RUNNING_LIMITS.longRunCapRatio - 1) * 100);
    for (const [index, session] of week.sessions.entries()) {
      if (isRaceDaySession(session, guardrails) || session.distanceKm <= capKm + 0.05) continue;
      const why = referenceKm === null
        ? `above the long-run cap of ${capKm} km (${basis})`
        : `more than ${above}% above ${basis} (${referenceKm} km; cap ${capKm} km)`;
      messages.push(`Run ${index + 1} (${session.title}) is ${session.distanceKm} km, ${why}. Shorten it to ${capKm} km or less; safety flags cannot waive this cap.`);
    }
  }

  if (guardrails.weeklyClimb) {
    // Like the km cap, the climbing cap covers the 7 days: today's climbing (locked) counts.
    const { capM, basis } = guardrails.weeklyClimb;
    const plannedM = countedWeeklyClimb(week, guardrails);
    const todayM = guardrails.today?.elevationM ?? 0;
    const budgetM = Math.max(0, capM - todayM);
    if (plannedM > budgetM) {
      const climbing = todayM > 0
        ? `${plannedM} m (race-day session excluded) plus today's ${todayM} m, ${plannedM + todayM} m over the 7 days`
        : `${plannedM} m (race-day session excluded)`;
      messages.push(
        `Planned climbing is ${climbing}, above this week's cap of ${capM} m (${basis}). Pick flatter routes to remove at least ${plannedM - budgetM} m; safety flags cannot waive this cap.`
      );
    }
  }

  // The hard-run cap counts the same 7 days: today's run (locked) is one of
  // them from the easy-run minimum.
  const todayCounts = todayCountsAsRun(guardrails.today);
  const runCount = week.sessions.length + (todayCounts ? 1 : 0);
  const hardCount = countedHardRuns(week, guardrails);
  const maxHard = maxHardRunsFor(runCount);
  if (hardCount > maxHard) {
    const todayHard = todayHardKind(guardrails.today);
    const window = todayCounts ? ` over the 7 days, ${todayHard ? todayRunLabel(todayHard) : "today's run"} included` : "";
    messages.push(
      `The week has ${hardCount} hard runs (long, tempo, intervals, hills) in ${runCount} runs${window}; hard running is capped at ${maxHard} for a ${runCount}-run week. Change ${hardCount - maxHard} of them to easy or recovery; safety flags cannot waive this cap.`
    );
  }

  messages.push(...consecutiveHardRunMessages(week, context, guardrails));

  messages.push(...floorMessages(week, guardrails));

  // Long-run placement: the maximal-distance session(s) must include the selected
  // long-run day. The app sends running.longRunDayOffset computed with the same
  // machinery as runningDayOffsets (omitted when the long-run day is today or past),
  // so it is compared directly — no name-to-offset lookup. Race exemption: when the
  // race lands inside this planning window, a maximal-distance session on the race
  // day takes long-run precedence wherever it falls (mirrors SKILL.md).
  const maxDistance = week.sessions.reduce((max, session) => Math.max(max, session.distanceKm), 0);
  const longRunDayOffset = running?.longRunDayOffset;
  const longestRuns = week.sessions.filter((session) => session.distanceKm === maxDistance);
  // Race week and the week after the race hold no long run, so the long-run
  // day is free there.
  const longRunDayPhase = guardrails.phase.race?.days.find((day) => day.dayOffset === longRunDayOffset)?.phase;
  const longRunDayHasNoLongRun = longRunDayPhase === "race_week" || longRunDayPhase === "post_race_1w";
  if (
    typeof longRunDayOffset === "number" &&
    longRunDayOffset >= 1 &&
    longRunDayOffset <= 6 &&
    hasSelectedDays &&
    !longRunDayHasNoLongRun &&
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

/**
 * The phase floors (general preparation, base, build, peak) for weeks of 3 or
 * more runs, counted with today's run: one tempo, interval or hill run (the
 * long run does not count) and the weekly-km floor (the smaller of 85% of the
 * four-week training average and last week's training km), unless
 * guardrails.floors says they are lifted.
 */
function floorMessages(week: RunningWeek, guardrails: RunningGuardrails): string[] {
  if (week.sessions.length < RUNNING_FLOOR_LIMITS.minRuns) return [];
  const { qualityRun, weeklyKm } = guardrails.floors;
  const messages: string[] = [];
  // Every computed relaxation lifts both floors; free text and safety flags never do.
  const liftedBy = onlyComputedReasons("lifts this floor");
  // A quality run inside a wellness gate's 48 hours does not count (it is rejected there).
  const gated = guardrails.wellnessGate?.offsets ?? [];
  const hasQuality = week.sessions.some(
    (session) => QUALITY_RUN_KINDS.has(session.kind) && !isRaceDaySession(session, guardrails) && !gated.includes(session.dayOffset)
  );
  if (qualityRun.required && !hasQuality) {
    const where = gated.length > 0
      ? `a later day that is not next to the long run and not in the next ${WELLNESS_GATE_LIMITS.gateHours} hours`
      : "a day that is not next to the long run";
    messages.push(
      `This week needs at least one quality session (${qualityRun.reason}): it has ${week.sessions.length} runs and none of them is a tempo, interval or hill run that counts. Make an easy run on ${where} a tempo, interval or hill session; ${liftedBy}.`
    );
  }
  if (weeklyKm.minKm !== null) {
    // The floor is weekly: today's run (locked) counts with the planned runs.
    const plannedKm = countedWeeklyKm(week, guardrails);
    const todayKm = guardrails.today?.distanceKm ?? 0;
    const totalKm = round1(plannedKm + todayKm);
    if (totalKm < weeklyKm.minKm - 0.05) {
      const volume = todayKm > 0
        ? `${plannedKm} km (race-day session excluded) plus today's ${todayKm} km run, ${totalKm} km over the 7 days`
        : `${plannedKm} km (race-day session excluded)`;
      messages.push(
        `Planned running volume is ${volume}, below this week's floor of ${weeklyKm.minKm} km (${weeklyKm.reason}). Add at least ${round1(weeklyKm.minKm - totalKm)} km, mainly to easy runs; ${liftedBy}.`
      );
    }
  }
  return messages;
}

/** Recovery-week and race-window rules, each run by its own day. */
function phaseRuleMessages(week: RunningWeek, guardrails: RunningGuardrails): string[] {
  const phase = guardrails.phase;
  if (!phase.recoveryWeek && !phase.race) return [];
  const messages: string[] = [];
  week.sessions.forEach((session, index) => {
    const rule = runRuleFor(session, phase);
    const label = `Run ${index + 1} (${session.title})`;
    if (rule.allowedKinds && !rule.allowedKinds.has(session.kind)) {
      const fix = rule.allowedKinds.has("tempo") ? "an easy run or a flat session" : "an easy or recovery run";
      messages.push(`${label} is a ${session.kind} run on offset ${session.dayOffset}, ${rule.kindReason}. Make it ${fix}.`);
    }
    if (rule.maxKm !== null && session.distanceKm > rule.maxKm + 0.05) {
      messages.push(`${label} is ${session.distanceKm} km; ${rule.maxKmReason}: at most ${rule.maxKm} km. Shorten it by at least ${round1(session.distanceKm - rule.maxKm)} km.`);
    }
    if (rule.maxElevationM !== null && session.elevationMeters > rule.maxElevationM) {
      messages.push(`${label} climbs ${session.elevationMeters} m over ${session.distanceKm} km; ${rule.elevationReason}: at most ${rule.maxElevationM} m. Pick a flatter route.`);
    }
  });
  const limit = guardrails.qualityLimit;
  if (limit) {
    const quality = week.sessions
      .map((session, index) => ({ session, index }))
      .filter(({ session }) => QUALITY_RUN_KINDS.has(session.kind) && !isRaceDaySession(session, guardrails));
    if (quality.length > limit.max) {
      messages.push(
        `The week has ${quality.length} quality sessions (tempo, intervals, hills: runs ${quality.map(({ index }) => index + 1).join(", ")}); ${limit.reason}, so at most ${limit.max}. Change ${quality.length - limit.max} of them to easy runs.`
      );
    }
  }
  return messages;
}

function consecutiveHardRunMessages(week: RunningWeek, context: CoachContext, guardrails: RunningGuardrails): string[] {
  const messages: string[] = [];
  // Today's run (locked) is part of the sequence: after a hard run today, offset 1 is no hard run.
  const todayHard = todayHardKind(guardrails.today);
  const tomorrow = week.sessions.findIndex((session) => followsTodayHardRun(session.dayOffset, guardrails.today));
  if (todayHard && tomorrow >= 0 && HARD_RUN_KINDS.has(week.sessions[tomorrow].kind)) {
    const session = week.sessions[tomorrow];
    const backToBackLong = todayHard === "long" && session.kind === "long" && guardrails.backToBackLongRunsAllowed;
    if (!backToBackLong) {
      // The longest run must stay on the long-run day, so it cannot move.
      const fix = context.running?.longRunDayOffset === 1
        ? "Make it an easy run on this day: the longest run stays on the long-run day."
        : "Make it an easy or recovery run, or move it to a later day.";
      messages.push(
        `Run ${tomorrow + 1} (${session.title}) is a ${session.kind} run on offset 1, the day after ${todayRunLabel(todayHard)}: no hard runs on consecutive days. ${fix}`
      );
    }
  }
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
      message += ` Back-to-back long runs are only allowed for races of ${RUNNING_LIMITS.backToBackMinRaceKm} km or more, ${RUNNING_LIMITS.backToBackWeeksToRace.min}-${RUNNING_LIMITS.backToBackWeeksToRace.max} weeks out (this race: ${race} km, ${raceTimingText(contextSeason(context))}).`;
    }
    messages.push(message);
  }
  return messages;
}
