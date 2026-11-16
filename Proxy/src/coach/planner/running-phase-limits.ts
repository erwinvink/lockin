import { plural, round1 } from "./numbers";
import { contextSeason, daysBetween, postRaceDaysFor, raceNameText, SEASON_LIMITS } from "./season";
import type { CoachContext, RunSummary } from "./types";

/**
 * Phase limits for the running week: a planned recovery week (from
 * context.periodization) and the race window (taper, race week and the
 * race's post-race window). The rolling week can straddle phases, so the
 * weekly cap averages a ratio over the seven days of the window and the
 * per-run rules look at each run's own day.
 *
 * Numbers (kept in line with references/ultra-periodization.md):
 * - 15-21 days out: weekly km at most 80% of the pre-taper 4-week average,
 *   long run at most 75% of the recent longest run.
 * - 8-14 days out: weekly km at most 70% (aim 50-70%), long run at most 60%.
 * - Race week (1-7 days out): only short easy runs or shakeouts, each at most
 *   50% of a normal easy run and at most 8 km (strides inside them are fine).
 * - One short quality session at most from 21 days out, none inside 7 days.
 * - No hill session and no new hill load inside 10 days: climbing at most
 *   1.5x the athlete's usual m/km (and never capped below 150 m).
 * - First week after the race: easy or recovery runs only; from day 8 to the
 *   end of the race's post-race window (one day per 4 race km, 7-28 days;
 *   season.ts) easy runs, recovery runs and an easy long run, no tempo,
 *   interval or hill session. The weekly cap ratio is 40% the first week
 *   and 70% from day 8.
 * - Recovery week: weekly km at most 75% of the four block weeks before
 *   (aim 60-75%), long run at most 70% of the recent longest, one quality
 *   session at most.
 */
export const TAPER_LIMITS = {
  weeklyRatio: {
    normal: 1.15,
    taper_3w: 0.8,
    taper_2w: 0.7,
    race_week: 0.4,
    race_day: 0.4,
    post_race_1w: 0.4,
    post_race_2w: 0.7
  } as Record<RaceDayPhase, number>,
  longRunRatio: { taper_3w: 0.75, taper_2w: 0.6 } as Partial<Record<RaceDayPhase, number>>,
  shortRunRatio: 0.5,
  shortRunMaxKm: 8,
  shortRunMinKm: 3,
  /** Shakeout cap when the athlete has no normal easy run to measure. */
  shortRunDefaultKm: 5,
  taperDays: SEASON_LIMITS.phaseUntilDays.taper,
  lastQualityDaysOut: 8,
  maxQualityRunsInTaper: 1,
  noHillsWithinDays: 10,
  /** Usual climbing is the median m/km of recent runs, at least this. */
  minElevationPerKm: 15,
  /** Inside 10 days a run may climb at most this multiple of the usual m/km... */
  newHillLoadFactor: 1.5,
  /** ...and is never capped below this many meters. */
  minElevationAllowanceM: 150
} as const;

export const RECOVERY_RUN_LIMITS = {
  weeklyKmRatio: 0.75,
  longRunRatio: 0.7,
  maxQualityRuns: 1
} as const;

/** One day's place in the race window; "normal" is outside it (not the season's "build" phase). */
export type RaceDayPhase = "normal" | "taper_3w" | "taper_2w" | "race_week" | "race_day" | "post_race_1w" | "post_race_2w";

export const HARD_RUN_KINDS: ReadonlySet<string> = new Set(["long", "tempo", "intervals", "hills"]);
export const QUALITY_RUN_KINDS: ReadonlySet<string> = new Set(["tempo", "intervals", "hills"]);
const EASY_KINDS: ReadonlySet<string> = new Set(["easy", "recovery"]);
/** From day 8 to the end of the post-race window: easy running and an easy long run, no quality session. */
const POST_RACE_LATE_KINDS: ReadonlySet<string> = new Set(["easy", "recovery", "long"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export type RecoveryWeekRunLimits = {
  reason: string;
  weeklyKmCap: number | null;
  targetWeeklyKm: { low: number; high: number } | null;
  longRunCapKm: number | null;
  maxQualityRuns: number;
};

export type RaceWindow = {
  raceName: string;
  daysToRaceAtWeekStart: number;
  /** Days after the race its post-race rules last (postRaceDaysFor). */
  postRaceDays: number;
  /** Pre-taper 4-week average: the base the taper ratios apply to. */
  referenceKm: number | null;
  referenceBasis: string;
  weeklyKmCap: number | null;
  /** Window days 0-6 with their days to the race and phase. */
  days: Array<{ dayOffset: number; daysToRace: number; phase: RaceDayPhase }>;
  normalEasyRunKm: number | null;
  shortRunCapKm: number;
  longRunCapKm: Partial<Record<RaceDayPhase, number>>;
  usualElevationPerKm: number;
};

export type RunningPhaseLimits = {
  recoveryWeek: RecoveryWeekRunLimits | null;
  race: RaceWindow | null;
};

/** What the per-run rules read of a run: its day, kind and distance (planned or kept). */
export type RunRuleInput = { dayOffset: number; kind: string; distanceKm: number };

export type RunRule = {
  phase: RaceDayPhase;
  daysToRace: number | null;
  /** Kinds allowed on this day (null: any); with the reason. */
  allowedKinds: ReadonlySet<string> | null;
  kindReason: string | null;
  maxKm: number | null;
  maxKmReason: string | null;
  maxElevationM: number | null;
  elevationReason: string | null;
  raceDay: boolean;
};

export function runningPhaseLimits(
  context: CoachContext,
  recentLongestKm: number | null,
  fallbackWeeklyKm: number | null
): RunningPhaseLimits {
  return {
    recoveryWeek: recoveryWeekLimits(context, recentLongestKm, fallbackWeeklyKm),
    race: raceWindow(context, recentLongestKm, fallbackWeeklyKm)
  };
}

function recoveryWeekLimits(context: CoachContext, recentLongestKm: number | null, fallbackWeeklyKm: number | null): RecoveryWeekRunLimits | null {
  const periodization = context.periodization;
  if (!periodization?.recoveryWeekDue || !context.running) return null;
  const week = periodization.recoveryWeek;
  const reference = week?.referenceWeeklyKm ?? fallbackWeeklyKm;
  return {
    reason: periodization.recoveryWeekReason,
    weeklyKmCap: week?.weeklyKmCap ?? (reference && reference > 0 ? round1(reference * RECOVERY_RUN_LIMITS.weeklyKmRatio) : null),
    targetWeeklyKm: week?.targetWeeklyKm ?? (reference && reference > 0 ? { low: round1(reference * 0.6), high: round1(reference * 0.75) } : null),
    longRunCapKm: week?.longRunCapKm ?? (recentLongestKm && recentLongestKm > 0 ? round1(recentLongestKm * RECOVERY_RUN_LIMITS.longRunRatio) : null),
    maxQualityRuns: week?.maxQualityRuns ?? RECOVERY_RUN_LIMITS.maxQualityRuns
  };
}

/** The phase of one day; `postRaceDays` is the race's post-race window (postRaceDaysFor). */
export function phaseForDaysToRace(daysToRace: number, postRaceDays: number): RaceDayPhase {
  if (daysToRace > TAPER_LIMITS.taperDays) return "normal";
  if (daysToRace >= 15) return "taper_3w";
  if (daysToRace >= 8) return "taper_2w";
  if (daysToRace >= 1) return "race_week";
  if (daysToRace === 0) return "race_day";
  if (daysToRace >= -7) return "post_race_1w";
  if (daysToRace >= -postRaceDays) return "post_race_2w";
  return "normal";
}

function raceWindow(context: CoachContext, recentLongestKm: number | null, fallbackWeeklyKm: number | null): RaceWindow | null {
  const running = context.running;
  if (!running) return null;
  const raceMs = Date.parse(running.raceGoal.raceDate);
  const weekStartMs = Date.parse(context.profile.weekStart);
  if (!Number.isFinite(raceMs) || !Number.isFinite(weekStartMs)) return null;
  const daysToRace = daysBetween(weekStartMs, raceMs);
  const postRaceDays = postRaceDaysFor(running.raceGoal.distanceKm);
  const days = [0, 1, 2, 3, 4, 5, 6].map((dayOffset) => ({
    dayOffset,
    daysToRace: daysToRace - dayOffset,
    phase: phaseForDaysToRace(daysToRace - dayOffset, postRaceDays)
  }));
  if (days.every((day) => day.phase === "normal")) return null;

  const runs = running.recentRuns.filter((run) => Number.isFinite(Date.parse(run.completedAt)));
  const reference = preTaperReference(runs, raceMs, weekStartMs, fallbackWeeklyKm);
  const meanRatio = days.reduce((sum, day) => sum + TAPER_LIMITS.weeklyRatio[day.phase], 0) / days.length;
  const normalEasyRunKm = normalEasyRun(runs, Math.min(raceMs - TAPER_LIMITS.taperDays * DAY_MS, weekStartMs));
  const shortRunCapKm = normalEasyRunKm === null
    ? TAPER_LIMITS.shortRunDefaultKm
    : clamp(roundHalf(normalEasyRunKm * TAPER_LIMITS.shortRunRatio), TAPER_LIMITS.shortRunMinKm, TAPER_LIMITS.shortRunMaxKm);
  const longRunCapKm: Partial<Record<RaceDayPhase, number>> = {};
  if (recentLongestKm && recentLongestKm > 0) {
    for (const [phase, ratio] of Object.entries(TAPER_LIMITS.longRunRatio) as Array<[RaceDayPhase, number]>) {
      longRunCapKm[phase] = round1(recentLongestKm * ratio);
    }
  }

  return {
    raceName: raceNameText(contextSeason(context)),
    daysToRaceAtWeekStart: daysToRace,
    postRaceDays,
    referenceKm: reference.km,
    referenceBasis: reference.basis,
    weeklyKmCap: reference.km === null ? null : round1(reference.km * meanRatio),
    days,
    normalEasyRunKm,
    shortRunCapKm,
    longRunCapKm,
    usualElevationPerKm: usualElevationPerKm(runs)
  };
}

/**
 * The average week of the four weeks before the taper (which starts 21 days
 * out), or before today when the taper has not started. Only the part of that
 * window the recent runs cover counts, scaled to a week.
 */
function preTaperReference(runs: RunSummary[], raceMs: number, weekStartMs: number, fallbackWeeklyKm: number | null): { km: number | null; basis: string } {
  const end = Math.min(raceMs - TAPER_LIMITS.taperDays * DAY_MS, weekStartMs);
  const start = end - 28 * DAY_MS;
  const oldest = runs.length >= 30 ? Math.min(...runs.map((run) => Date.parse(run.completedAt))) : Number.NEGATIVE_INFINITY;
  const coveredStart = Math.max(start, oldest);
  const coveredDays = (end - coveredStart) / DAY_MS;
  if (coveredDays >= 14 && runs.length > 0) {
    const km = runs
      .filter((run) => {
        const at = Date.parse(run.completedAt);
        return at >= coveredStart && at < end;
      })
      .reduce((sum, run) => sum + Math.max(0, run.distanceKm), 0);
    if (km <= 0 && fallbackWeeklyKm && fallbackWeeklyKm > 0) {
      return { km: round1(fallbackWeeklyKm), basis: `the recent average of ${round1(fallbackWeeklyKm)} km/week (no runs before the taper)` };
    }
    if (km <= 0) return { km: null, basis: "no runs before the taper" };
    return {
      km: round1((km / coveredDays) * 7),
      basis: `the pre-taper average of ${round1((km / coveredDays) * 7)} km/week (the ${Math.round(coveredDays)} days before ${new Date(end).toISOString().slice(0, 10)})`
    };
  }
  if (fallbackWeeklyKm && fallbackWeeklyKm > 0) {
    return { km: round1(fallbackWeeklyKm), basis: `the recent average of ${round1(fallbackWeeklyKm)} km/week (too few pre-taper runs on record)` };
  }
  return { km: null, basis: "no run history before the taper" };
}

/** Median easy or recovery run (else median non-long run) of the six weeks before `end`. */
function normalEasyRun(runs: RunSummary[], end: number): number | null {
  const window = runs.filter((run) => {
    const at = Date.parse(run.completedAt);
    return at < end && at >= end - 42 * DAY_MS && run.distanceKm >= 2;
  });
  const easy = window.filter((run) => typeof run.kind === "string" && EASY_KINDS.has(run.kind));
  if (easy.length >= 3) return round1(median(easy.map((run) => run.distanceKm)));
  const nonLong = window.filter((run) => run.kind !== "long" && !QUALITY_RUN_KINDS.has(run.kind ?? ""));
  if (nonLong.length >= 3) return round1(median(nonLong.map((run) => run.distanceKm)));
  return null;
}

function usualElevationPerKm(runs: RunSummary[]): number {
  const perKm = runs.filter((run) => run.distanceKm >= 3).map((run) => Math.max(0, run.elevationGainM || 0) / run.distanceKm);
  const usual = perKm.length >= 3 ? median(perKm) : 0;
  return Math.max(TAPER_LIMITS.minElevationPerKm, Math.round(usual));
}

/** The race-window and recovery-week rules for one run, by its own day. */
export function runRuleFor(session: RunRuleInput, limits: RunningPhaseLimits): RunRule {
  const race = limits.race;
  const day = race?.days.find((entry) => entry.dayOffset === session.dayOffset) ?? null;
  const phase = day?.phase ?? "normal";
  const rule: RunRule = {
    phase,
    daysToRace: day?.daysToRace ?? null,
    allowedKinds: null,
    kindReason: null,
    maxKm: null,
    maxKmReason: null,
    maxElevationM: null,
    elevationReason: null,
    raceDay: phase === "race_day"
  };
  if (rule.raceDay) return rule;
  if (!race || !day) {
    applyRecoveryLongRun(rule, session, limits);
    return rule;
  }
  const days = day.daysToRace;

  if (phase === "race_week") {
    rule.allowedKinds = EASY_KINDS;
    rule.kindReason = `${plural(days, "day")} before ${race.raceName}: only short easy runs or shakeouts (strides inside an easy run are fine)`;
    rule.maxKm = race.shortRunCapKm;
    rule.maxKmReason = race.normalEasyRunKm === null
      ? `race week shakeouts stay at or below ${race.shortRunCapKm} km`
      : `race week shakeouts stay at or below ${Math.round(TAPER_LIMITS.shortRunRatio * 100)}% of a normal ${race.normalEasyRunKm} km easy run (max ${TAPER_LIMITS.shortRunMaxKm} km)`;
  } else if (phase === "post_race_1w") {
    rule.allowedKinds = EASY_KINDS;
    rule.kindReason = `${plural(-days, "day")} after ${race.raceName}: easy or recovery runs only`;
  } else if (phase === "post_race_2w") {
    rule.allowedKinds = POST_RACE_LATE_KINDS;
    rule.kindReason = `${plural(-days, "day")} after ${race.raceName}: easy runs (strides inside them are fine), recovery runs and an easy long run only, no tempo, interval or hill session until day ${race.postRaceDays} after the race`;
  } else if (phase === "taper_3w" || phase === "taper_2w") {
    const cap = race.longRunCapKm[phase];
    if (session.kind === "long" && cap !== undefined) {
      rule.maxKm = cap;
      rule.maxKmReason = `${days} days before the race the long run stays at or below ${Math.round((TAPER_LIMITS.longRunRatio[phase] ?? 1) * 100)}% of the recent longest run`;
    }
  }

  if (days >= 1 && days <= TAPER_LIMITS.noHillsWithinDays) {
    if (!rule.allowedKinds) {
      rule.allowedKinds = new Set(["easy", "recovery", "long", "tempo", "intervals"]);
      rule.kindReason = `${plural(days, "day")} before the race: no new hill or downhill session inside ${TAPER_LIMITS.noHillsWithinDays} days`;
    }
    rule.maxElevationM = Math.max(
      TAPER_LIMITS.minElevationAllowanceM,
      Math.round(TAPER_LIMITS.newHillLoadFactor * race.usualElevationPerKm * Math.max(0, session.distanceKm))
    );
    rule.elevationReason = `inside ${TAPER_LIMITS.noHillsWithinDays} days of the race no new hill load: at most 1.5x your usual ${race.usualElevationPerKm} m/km of climbing`;
  }
  applyRecoveryLongRun(rule, session, limits);
  return rule;
}

function applyRecoveryLongRun(rule: RunRule, session: RunRuleInput, limits: RunningPhaseLimits) {
  const recovery = limits.recoveryWeek;
  if (!recovery || recovery.longRunCapKm === null || session.kind !== "long") return;
  if (rule.maxKm === null || recovery.longRunCapKm < rule.maxKm) {
    rule.maxKm = recovery.longRunCapKm;
    rule.maxKmReason = "in a recovery week the long run stays at or below 70% of the recent longest run";
  }
}

/** Most tempo, interval and hill sessions this window allows, or null for the normal hard-run rules. */
export function qualityRunLimit(limits: RunningPhaseLimits): { max: number; reason: string } | null {
  const reasons: string[] = [];
  let max = Number.POSITIVE_INFINITY;
  if (limits.recoveryWeek) {
    max = Math.min(max, limits.recoveryWeek.maxQualityRuns);
    reasons.push("a recovery week keeps one short quality session at most");
  }
  const taperDays = limits.race?.days.filter((day) => day.dayOffset >= 1 && (day.phase === "taper_3w" || day.phase === "taper_2w")) ?? [];
  if (taperDays.length > 0) {
    max = Math.min(max, TAPER_LIMITS.maxQualityRunsInTaper);
    reasons.push("the taper keeps one short quality session at most (until 8 days out)");
  }
  return Number.isFinite(max) ? { max, reason: reasons.join("; ") } : null;
}

/** The phase cap on weekly km (race-day session excluded), or null. */
export function phaseWeeklyCap(limits: RunningPhaseLimits): { capKm: number; basis: string } | null {
  const candidates: Array<{ capKm: number; basis: string }> = [];
  const recovery = limits.recoveryWeek;
  if (recovery?.weeklyKmCap !== null && recovery?.weeklyKmCap !== undefined) {
    candidates.push({ capKm: recovery.weeklyKmCap, basis: `planned recovery week: at most 75% of the recent average (aim ${recovery.targetWeeklyKm?.low ?? "60%"}-${recovery.targetWeeklyKm?.high ?? "75%"} km)` });
  }
  const race = limits.race;
  if (race?.weeklyKmCap !== null && race?.weeklyKmCap !== undefined) {
    candidates.push({ capKm: race.weeklyKmCap, basis: `race window (${describeRaceDays(race)}) against ${race.referenceBasis}` });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((lowest, candidate) => (candidate.capKm < lowest.capKm ? candidate : lowest));
}

/**
 * "6 days (days 20-25 after the race) at 70%, 1 day normal". After the
 * race the label names the actual days, since the window's length varies
 * with the race (postRaceDays).
 */
export function describeRaceDays(race: RaceWindow): string {
  const byPhase = new Map<RaceDayPhase, number[]>();
  for (const day of race.days) byPhase.set(day.phase, [...(byPhase.get(day.phase) ?? []), day.daysToRace]);
  const label: Record<RaceDayPhase, (daysAfter: string) => string> = {
    normal: () => "normal",
    taper_3w: () => "15-21 days out at 80%",
    taper_2w: () => "8-14 days out at 70%",
    race_week: () => "race week at 40%",
    race_day: () => "race day",
    post_race_1w: (daysAfter) => `(${daysAfter} after the race) at 40%`,
    post_race_2w: (daysAfter) => `(${daysAfter} after the race) at 70%`
  };
  return [...byPhase.entries()]
    .map(([phase, daysToRace]) => {
      const after = daysToRace.map((days) => -days);
      const [first, last] = [Math.min(...after), Math.max(...after)];
      return `${plural(daysToRace.length, "day")} ${label[phase](first === last ? `day ${first}` : `days ${first}-${last}`)}`;
    })
    .join(", ");
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function roundHalf(value: number): number {
  return Math.round(value * 2) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
