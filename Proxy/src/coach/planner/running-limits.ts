/**
 * The numbers of the running limits. This module imports nothing, so the
 * guardrails, the floors and the coach read's reference points can all build
 * their text from it.
 */
export const RUNNING_LIMITS = {
  /** Planned weekly km may be at most 15% above the reference... */
  weeklyJumpRatio: 0.15,
  /** ...or reference + 3 km, whichever is larger (small bases need room). */
  weeklyMinimumStepKm: 3,
  /**
   * First week back after 4+ weeks without a run, and the floor of the cap
   * while there are fewer than 3 runs in the last 6 weeks (one short run
   * must not shrink the cap below what no runs at all would allow).
   */
  returningFromBreakCapKm: 20,
  sparseHistoryRunCount: 3,
  /**
   * No run (the race day excepted) above 1.15x the longest training run of
   * the last 30 days: a run more than 10-30% past the 30-day longest raised
   * overuse injuries (Frandsen 2025). Races are left out of the reference.
   */
  longRunCapRatio: 1.15,
  longRunWindowDays: 30,
  /**
   * Weekly climbing over the 7 days (today's run plus the planned runs, race
   * day excluded) at most 1.25x the average week of the 4 weeks before today,
   * never capped below 300 m.
   */
  weeklyClimbRatio: 1.25,
  weeklyClimbMinimumM: 300,
  paceSecPerKm: { min: 150, max: 720 },
  hrBpm: { min: 80, max: 210 },
  /** Volume clamping never shortens an easy run below this (or half its length). */
  easyRunMinimumKm: 3,
  backToBackMinRaceKm: 80,
  /** Build and peak: more than 3 and at most 12 weeks to the race. */
  backToBackWeeksToRace: { min: 4, max: 12 },
  recentRunWindowDays: 42
} as const;
