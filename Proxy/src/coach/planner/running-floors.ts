import { isRaceRun } from "./compute-training-signals";
import { round1 } from "./numbers";
import type { LongRunLimit, RunFrequencyPolicy, RunningGuardrails, RunningRelaxation, WeeklyVolumeLimit } from "./running-guardrails";
import { RUNNING_LIMITS } from "./running-limits";
import { HARD_RUN_KINDS, QUALITY_RUN_KINDS, type RunningPhaseLimits } from "./running-phase-limits";
import { contextSeason, daysBetween, FLOOR_PHASES, SEASON_LIMITS, seasonPhaseText } from "./season";
import type { CoachContext, RunningContext, RunningRequest, RunSummary, Season, SeasonPhase } from "./types";
import { WELLNESS_GATE_LIMITS } from "./wellness-gate";

/**
 * The running floors: the week's minimum quality run and weekly km in
 * general preparation, base, build and peak. Also today's run (locked) and
 * the load before today, which the floors and the weekly caps (km, climbing,
 * hard runs) count over the same 7 days.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const RUNNING_FLOOR_LIMITS = {
  /** The floors apply to weeks of at least this many runs. */
  minRuns: 3,
  /** Weekly-km floor: this share of the four-week training average (and at most last week's training km). */
  weeklyKmRatio: 0.85,
  /**
   * For this many weeks after the post-race transition the weekly-km floor
   * reads the four weeks before the taper instead of the last four, which
   * still carry the taper and the race.
   */
  preTaperWeeksAfterTransition: 3,
  /** The pre-taper average needs at least this many days of run history in its four weeks. */
  preTaperMinCoveredDays: 14,
  /**
   * The weekly-km floor asks at most this share of what the week's runs hold
   * at the long-run cap (today's run plus maxRuns runs at capKm), rounded down
   * to the half kilometre: never every run at its cap.
   */
  reachableShare: 0.9
} as const;

/** A race is a hard effort, and the quality stimulus of its week (plan owner). */
export const HARD_EFFORT_KINDS: ReadonlySet<string> = new Set([...HARD_RUN_KINDS, "race"]);
export const QUALITY_FLOOR_KINDS: ReadonlySet<string> = new Set([...QUALITY_RUN_KINDS, "race"]);

/**
 * The week's minimums in general preparation, base, build and peak, for weeks
 * of 3 or more runs, over the 7 days of today's run plus the planned runs: at
 * least one tempo, interval or hill run (the long run does not count) and at
 * least the smaller of 85% of the four-week training average and last week's
 * training km (races left out). Each says why it is lifted: the taper or
 * post-race transition, a computed relaxation, a starter base or the first
 * week back after a break, no running day away from the long run, the day
 * after a hard run today and a wellness gate (quality), or the race window's
 * own caps or too few free days to hold it under the long-run cap (weekly km).
 */
export type RunningFloors = {
  qualityRun: { required: boolean; reason: string };
  weeklyKm: { minKm: number | null; reason: string };
};

/** Today's run (locked): its km and climbing count toward the week's floors and caps. */
export type TodayRun = { source: "done" | "planned"; distanceKm: number; elevationM: number; kinds: string[] };

export function runningFloors(
  context: CoachContext,
  input: {
    relaxations: RunningRelaxation[];
    weeklyVolume: WeeklyVolumeLimit;
    phase: RunningPhaseLimits;
    availability: { offsets: number[] };
    frequency: RunFrequencyPolicy | null;
    longRun: LongRunLimit | null;
    wellnessGate: RunningGuardrails["wellnessGate"];
    today: TodayRun | null;
    recentRunCount: number;
  }
): RunningFloors {
  const lifted = (reason: string): RunningFloors => ({ qualityRun: { required: false, reason }, weeklyKm: { minKm: null, reason } });
  const running = context.running;
  if (!running) return lifted("no running context");
  const season = contextSeason(context);
  if (!FLOOR_PHASES.has(season.phase)) {
    return lifted(
      season.phase === "transition"
        ? `post-race transition until day ${season.postRaceDays} after the race: easy running, no quality or weekly-km floor`
        : "taper: the race-window limits apply instead"
    );
  }
  if (isStarterBase(running, input.recentRunCount)) return lifted("starter base: easy runs build the habit first");
  if (input.weeklyVolume.kind === "capped" && input.weeklyVolume.returnWeek) {
    return lifted("first week back after 4+ weeks without runs: easy running first");
  }

  return { qualityRun: qualityRunFloor(running, season.phase, input), weeklyKm: weeklyKmFloor(context, input) };
}

/**
 * A wellness gate keeps the quality floor but takes the next 48 hours out:
 * the quality run needs a later day away from the long run, and only when
 * none is left is the floor lifted.
 */
function qualityRunFloor(
  running: RunningContext,
  phase: SeasonPhase,
  input: { relaxations: RunningRelaxation[]; availability: { offsets: number[] }; wellnessGate: RunningGuardrails["wellnessGate"]; today: TodayRun | null }
): RunningFloors["qualityRun"] {
  if (input.relaxations.length > 0) return { required: false, reason: liftedBy(input.relaxations) };
  // Today's run is part of the week: a quality run or a race today is the week's quality session.
  const todayQuality = input.today?.kinds.find((kind) => QUALITY_FLOOR_KINDS.has(kind));
  if (todayQuality) return { required: false, reason: `${todayRunLabel(todayQuality)} is this week's quality session` };
  const around = { longRunDayOffset: running.longRunDayOffset, today: input.today };
  if (qualityRunDays(input.availability.offsets, around).length === 0) {
    return {
      required: false,
      reason: `no running day away from the long run${todayHardKind(input.today) ? " and the day after today's hard run" : ""} is left for a tempo, interval or hill run`
    };
  }
  const gate = input.wellnessGate;
  const rule = `${seasonPhaseText(phase)}: one tempo, interval or hill run a week, and the long run does not count`;
  if (!gate) return { required: true, reason: rule };
  if (qualityRunDays(input.availability.offsets, { ...around, gatedOffsets: gate.offsets }).length === 0) {
    return { required: false, reason: `${gate.reason}, and no later running day away from the long run is left for a tempo, interval or hill run` };
  }
  return { required: true, reason: `${rule}; it goes on a later day, not in the next ${WELLNESS_GATE_LIMITS.gateHours} hours (${gate.reason})` };
}

/**
 * The weekly-km floor: the smaller of 85% of the four-week training average
 * and last week's training km (races left out), so it asks at most to hold
 * last week's volume and never forces a jump. In the first 3 weeks after the
 * post-race transition the four-week average still carries the taper and the
 * race, so the floor reads the average training week before the taper
 * instead (when it is higher): the floor then holds last week rather than
 * letting weeks planned at it shrink.
 */
function weeklyKmFloor(
  context: CoachContext,
  input: {
    relaxations: RunningRelaxation[];
    phase: RunningPhaseLimits;
    frequency: RunFrequencyPolicy | null;
    longRun: LongRunLimit | null;
    today: TodayRun | null;
  }
): RunningFloors["weeklyKm"] {
  const { relaxations, frequency, longRun } = input;
  const todayKm = input.today?.distanceKm ?? 0;
  // A recovery week and a missing history (no weekly cap) each come with a
  // relaxation, and the race window is next: below, a normal weekly cap applies.
  if (relaxations.length > 0) return { minKm: null, reason: liftedBy(relaxations) };
  if (input.phase.race) return { minKm: null, reason: "race window: its own weekly caps apply this week" };
  const ratio = RUNNING_FLOOR_LIMITS.weeklyKmRatio;
  // The cap reads the same days before local midnight, races included, and
  // is at least 3 km above them, so the floor always stays under the cap.
  const { last7Km, fourWeekAvgKm } = loadBeforeToday(context, { racesIncluded: false });
  const running = context.running!;
  const preTaperKm = running.preTaperTrainingWeekKm !== undefined
    ? running.preTaperTrainingWeekKm
    : preTaperTrainingWeekKm(running, contextSeason(context), context.profile.weekStart);
  const usePreTaper = preTaperKm !== null && preTaperKm > fourWeekAvgKm;
  const averageKm = usePreTaper ? preTaperKm : fourWeekAvgKm;
  const minKm = round1(Math.min(averageKm * ratio, last7Km));
  if (minKm <= 0) return { minKm: null, reason: "no training km last week" };
  // Every run stays under the long-run cap, so few free days may not hold the floor.
  if (frequency && longRun && todayKm + frequency.maxRuns * longRun.capKm < minKm) {
    return { minKm: null, reason: `only ${frequency.maxRuns} runs of at most ${longRun.capKm} km fit this week, less than the ${minKm} km floor` };
  }
  const average = usePreTaper
    ? `the ${round1(averageKm)} km average training week before the taper (the last four weeks, ${round1(fourWeekAvgKm)} km a week, still carry the taper and the race)`
    : `the ${round1(fourWeekAvgKm)} km four-week training average`;
  const reason = `the smaller of ${Math.round(ratio * 100)}% of ${average} and last week's ${round1(last7Km)} km of training (races left out), counted over the 7 days with today's run`;
  // Close to what the runs hold at the cap, the floor would need every run at
  // its cap (round distances miss it): it asks a share of that instead.
  if (frequency && longRun) {
    const share = RUNNING_FLOOR_LIMITS.reachableShare;
    const holdsKm = round1(todayKm + frequency.maxRuns * longRun.capKm);
    const reachableKm = Math.floor(round1(holdsKm * share) * 2) / 2;
    if (reachableKm > 0 && reachableKm < minKm) {
      const today = todayKm > 0 ? `today's ${round1(todayKm)} km run and ` : "";
      return {
        minKm: reachableKm,
        reason: `${Math.round(share * 100)}% of the ${holdsKm} km that ${today}${frequency.maxRuns} runs of at most ${longRun.capKm} km hold, rounded down to the half kilometre, so no run has to sit at its cap; it would otherwise be ${minKm} km, ${reason}`
      };
    }
  }
  return { minKm, reason };
}

/**
 * In the first 3 weeks after the post-race transition of the stored race:
 * the average training week (races left out) of the four weeks before its
 * taper (which starts 21 days out), over the part of them the run history
 * covers (at least 14 days). Null outside those weeks or without that
 * history. buildCoachContext reads it from the whole history the app sends.
 */
export function preTaperTrainingWeekKm(running: Pick<RunningRequest, "raceGoal" | "recentRuns">, season: Season, weekStart: string): number | null {
  if (season.raceState !== "none" || season.daysSinceRace === null) return null;
  const daysAfterTransition = season.daysSinceRace - season.postRaceDays;
  if (daysAfterTransition < 1 || daysAfterTransition > RUNNING_FLOOR_LIMITS.preTaperWeeksAfterTransition * 7) return null;
  const raceMs = Date.parse(running.raceGoal.raceDate);
  const weekStartMs = Date.parse(weekStart);
  if (!Number.isFinite(raceMs) || !Number.isFinite(weekStartMs)) return null;
  const end = raceMs - SEASON_LIMITS.phaseUntilDays.taper * DAY_MS;
  const times = running.recentRuns.map((run) => Date.parse(run.completedAt)).filter(Number.isFinite);
  // The app sends a limited history: only the part of the four weeks it
  // covers counts, from the local midnight of the oldest run on record.
  const oldestDayStart = times.length === 0 ? Number.POSITIVE_INFINITY : weekStartMs - Math.ceil((weekStartMs - Math.min(...times)) / DAY_MS) * DAY_MS;
  const coveredStart = Math.max(end - 28 * DAY_MS, oldestDayStart);
  const coveredDays = (end - coveredStart) / DAY_MS;
  if (coveredDays < RUNNING_FLOOR_LIMITS.preTaperMinCoveredDays) return null;
  const km = running.recentRuns
    .filter((run) => {
      const at = Date.parse(run.completedAt);
      return at >= coveredStart && at < end && !isRaceRun(run, running.raceGoal.raceDate);
    })
    .reduce((sum, run) => sum + Math.max(0, run.distanceKm), 0);
  return km > 0 ? round1((km / coveredDays) * 7) : null;
}

/**
 * Today's run: the runs done today (recentRuns) whenever there are any, a
 * tune-up race included, else the runs the current plan has for today. The
 * goal race is not a training run: on race day there is no today's run, so
 * the race counts toward neither the floors nor the caps.
 */
export function todayRun(context: CoachContext): TodayRun | null {
  const running = context.running;
  const start = Date.parse(context.profile.weekStart);
  if (!running || !Number.isFinite(start)) return null;
  if (daysBetween(context.profile.weekStart, running.raceGoal.raceDate) === 0) return null;
  const done = running.recentRuns.filter((run) => {
    const at = Date.parse(run.completedAt);
    return Number.isFinite(at) && at >= start && at < start + DAY_MS && run.distanceKm > 0;
  });
  const runs: Array<{ distanceKm: number; elevationM: number; kind?: string | null }> = done.length > 0
    ? done.map((run) => ({ distanceKm: run.distanceKm, elevationM: Math.max(0, run.elevationGainM || 0), kind: run.kind }))
    : (context.todayPlannedRuns ?? [])
        .map((run) => ({ distanceKm: run.distanceKm ?? 0, elevationM: Math.max(0, run.elevationMeters ?? 0), kind: run.kind }))
        .filter((run) => run.distanceKm > 0);
  if (runs.length === 0) return null;
  return {
    source: done.length > 0 ? "done" : "planned",
    distanceKm: round1(runs.reduce((sum, run) => sum + run.distanceKm, 0)),
    elevationM: Math.round(runs.reduce((sum, run) => sum + run.elevationM, 0)),
    kinds: runs.map((run) => run.kind).filter((kind): kind is string => typeof kind === "string" && kind.length > 0)
  };
}

/**
 * The load before today, from local midnight (weekStart) back: the km of the
 * last 7 days, and the average week of the last 28 days in km and in
 * climbing. Today's run is never in it: it counts against the week's caps
 * instead. The floor and the climbing cap read training runs (races left
 * out); the weekly km cap reads every run.
 */
export function loadBeforeToday(
  context: CoachContext,
  options: { racesIncluded: boolean }
): { last7Km: number; fourWeekAvgKm: number; fourWeekAvgClimbM: number } {
  const running = context.running;
  const start = Date.parse(context.profile.weekStart);
  if (!running || !Number.isFinite(start)) return { last7Km: 0, fourWeekAvgKm: 0, fourWeekAvgClimbM: 0 };
  const runsIn = (days: number) =>
    running.recentRuns.filter((run) => {
      const at = Date.parse(run.completedAt);
      return Number.isFinite(at) && at >= start - days * DAY_MS && at < start && (options.racesIncluded || !isRaceRun(run, running.raceGoal.raceDate));
    });
  const km = (runs: RunSummary[]) => runs.reduce((sum, run) => sum + Math.max(0, run.distanceKm), 0);
  const fourWeeks = runsIn(28);
  return {
    last7Km: km(runsIn(7)),
    fourWeekAvgKm: km(fourWeeks) / 4,
    fourWeekAvgClimbM: fourWeeks.reduce((sum, run) => sum + Math.max(0, run.elevationGainM || 0), 0) / 4
  };
}

/** The kind of today's hard run (locked, done or planned; a tune-up race included), or null. */
export function todayHardKind(today: TodayRun | null): string | null {
  return today?.kinds.find((kind) => HARD_EFFORT_KINDS.has(kind)) ?? null;
}

/** Today's run is one of the week's runs (the hard-run cap) from the easy-run minimum: a 1 km jog is not. */
export function todayCountsAsRun(today: TodayRun | null): boolean {
  return today !== null && today.distanceKm >= RUNNING_LIMITS.easyRunMinimumKm;
}

/** "today's tempo run", or "today's race". */
export function todayRunLabel(kind: string): string {
  return kind === "race" ? "today's race" : `today's ${kind} run`;
}

/** After a hard run today, the next day (offset 1) is no hard run. */
export function followsTodayHardRun(dayOffset: number, today: TodayRun | null): boolean {
  return dayOffset === 1 && todayHardKind(today) !== null;
}

/**
 * The days that can take the week's tempo, interval or hill run: offsets 1-6
 * that are not the long-run day or next to it, not next to another hard run,
 * not the day after a hard run today, and outside a wellness gate's hours.
 */
export function qualityRunDays(
  offsets: number[],
  around: { longRunDayOffset?: number | null; today: TodayRun | null; hardRunOffsets?: number[]; gatedOffsets?: number[] }
): number[] {
  const longRun = around.longRunDayOffset;
  const hard = [...(around.hardRunOffsets ?? []), ...(typeof longRun === "number" && longRun >= 1 && longRun <= 6 ? [longRun] : [])];
  return offsets.filter(
    (offset) =>
      offset >= 1 &&
      offset <= 6 &&
      !followsTodayHardRun(offset, around.today) &&
      !(around.gatedOffsets ?? []).includes(offset) &&
      hard.every((day) => Math.abs(offset - day) > 1)
  );
}

/** Fewer than 3 runs in 6 weeks, a small baseline and a short longest run. */
export function isStarterBase(running: RunningContext, recentRunCount: number): boolean {
  return recentRunCount < 3 && (running.baselineWeeklyKm || 0) <= 20 && (running.longestRecentRunKm || 0) <= 8;
}

/** "lifted by a planned recovery week", "lifted by readiness (recovery needed) and a recent run rated feel 1-2". */
function liftedBy(relaxations: RunningRelaxation[]): string {
  const labels = [...new Set(relaxations.map((relaxation) => relaxation.label))];
  return `lifted by ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0]}`;
}
