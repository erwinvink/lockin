import type { CoachContext, RunningRequest, Season, SeasonEmphasis, SeasonPhase } from "./types";

/**
 * The season, computed once from the stored race and the week start, so
 * every planner and prompt reads the same race state, phase and emphasis
 * instead of deriving them from weeksToRace (which reads 0 for any past
 * race).
 *
 * - Post-race window: one day per 4 race km, at least 7 and at most 28 days
 *   (54 km: 14 days; 100 km: 25). Neuromuscular recovery grows with race
 *   size (9-16 days after 166 km), so one fixed window does not fit all.
 * - Before the race (race day included), by days to the race: taper up to
 *   21, peak up to 42, build up to 84, base up to 112, general preparation
 *   beyond. Emphasis: taper up to 10, running leads up to 56, balanced up to
 *   112, strength leads beyond.
 * - Inside the post-race window: transition. After it, or with no race at
 *   all: general preparation, strength leads.
 * - Post-race strength (strength-phase.ts enforces it per planned day):
 *   running recovers first while strength carries on, nothing hard on
 *   post-race days 1-2, no very hard or max effort through day 7, then
 *   normal upper-body progression.
 */
export const SEASON_LIMITS = {
  postRace: { kmPerDay: 4, minDays: 7, maxDays: 28, strength: { noHardThroughDay: 2, atMostHardThroughDay: 7 } },
  /** Last day (days to the race) of each phase before the race. */
  phaseUntilDays: { taper: 21, peak: 42, build: 84, base: 112 },
  /** Last day (days to the race) of each emphasis before the race. */
  emphasisUntilDays: { taper: 10, run_led: 56, balanced: 112 }
} as const;

/**
 * Phases whose running weeks carry the quality-run and weekly-km floors
 * (running-guardrails.ts): every phase except the taper and the post-race
 * transition, which have their own race-window limits.
 */
export const FLOOR_PHASES: ReadonlySet<SeasonPhase> = new Set<SeasonPhase>(["general_preparation", "base", "build", "peak"]);

/** How the coach read talks about the race (the coach-read system prompt). */
export const SEASON_READ_RULE =
  "Read the race from coachContext.season, computed by code: before the race, count down to it; inside the post-race window (raceState recent), say how many days ago it was (for example \"your race 10 days ago\"); after that window or with no race ahead (raceState none), say no race is planned and leave the old race out. Never call a past race 0 weeks out or in taper.";

/**
 * The hybrid coach read's lens (the coach-read system prompt): the race
 * countdown leads only while a race is ahead; otherwise the season does.
 * It names no race: the athlete's own text stays in coachContext.
 */
export function hybridCoachReadLens(season: Season): string {
  const voice = "Write like an experienced ultra-endurance coach who also programs strength: direct, calm, practical, and not technical.";
  return season.raceState === "upcoming"
    ? `${voice} Running volume, the long run, descent exposure, and the race countdown lead the read; strength work is framed as serving the race (part of the same training week, never a separate hobby); make no claim that it makes the athlete run faster or more economically: the plan has no heavy leg strength or plyometrics.`
    : `${voice} No race is ahead, so the season leads the read instead of a race countdown: frame running and strength by coachContext.season (its phase, emphasis and reason).`;
}

type SeasonRace = Pick<RunningRequest["raceGoal"], "name" | "raceDate" | "distanceKm">;

const DAY_MS = 24 * 60 * 60 * 1000;

const PHASE_TEXT: Record<SeasonPhase, string> = {
  general_preparation: "general preparation",
  base: "base phase",
  build: "build phase",
  peak: "peak phase",
  taper: "taper",
  transition: "post-race transition"
};

const { noHardThroughDay, atMostHardThroughDay } = SEASON_LIMITS.postRace.strength;
/** The post-race strength rule in plain words, for the season reason and the chat. */
export const POST_RACE_STRENGTH_TEXT =
  `strength carries on: light or medium on days 1-${noHardThroughDay} after the race, nothing very hard or max through day ${atMostHardThroughDay}, then normal upper-body progression`;

const EMPHASIS_TEXT: Record<SeasonEmphasis, string> = {
  transition: `running recovers first while ${POST_RACE_STRENGTH_TEXT}`,
  strength_led: "strength leads",
  balanced: "running and strength balanced",
  run_led: "running leads",
  taper: "the race comes first"
};

/** The race's name in plan text: "your race" when it was stored without one. */
export function raceNameText(season: Season): string {
  return season.raceName ?? "your race";
}

/** The phase in plain words: "general preparation", "post-race transition". */
export function seasonPhaseText(phase: SeasonPhase): string {
  return PHASE_TEXT[phase];
}

/** Days of post-race rules for a race of this distance. */
export function postRaceDaysFor(distanceKm: number): number {
  const { kmPerDay, minDays, maxDays } = SEASON_LIMITS.postRace;
  const days = Number.isFinite(distanceKm) ? Math.round(distanceKm / kmPerDay) : minDays;
  return Math.min(maxDays, Math.max(minDays, days));
}

/**
 * Whole days from one local midnight to another (ISO strings or epoch ms),
 * rounded so a daylight-saving change between them is no extra day; NaN when
 * either is not a date.
 */
export function daysBetween(from: string | number, to: string | number): number {
  const ms = (value: string | number) => (typeof value === "number" ? value : Date.parse(value));
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

export function computeSeason(race: SeasonRace | null | undefined, weekStart: string): Season {
  const days = race ? daysBetween(weekStart, race.raceDate) : Number.NaN;
  if (!race || !Number.isFinite(days)) {
    return withReason(
      { raceState: "none", raceName: null, daysToRace: null, daysSinceRace: null, postRaceDays: 0, phase: "general_preparation", emphasis: "strength_led" },
      "No race is planned"
    );
  }

  const postRaceDays = postRaceDaysFor(race.distanceKm);
  // A blank name is printed as "your race".
  const raceName = (race.name ?? "").trim() || null;
  const printed = raceName ?? "Your race";
  if (days >= 0) {
    const upcoming = { raceState: "upcoming", raceName, daysToRace: days, daysSinceRace: null, postRaceDays, phase: upcomingPhase(days), emphasis: upcomingEmphasis(days) } as const;
    return days === 0
      ? withReason(upcoming, `${printed} is today`, "race day")
      : withReason(upcoming, `${printed} is in ${dayCount(days)}`);
  }

  const daysSinceRace = -days;
  const past = { raceName, daysToRace: null, daysSinceRace, postRaceDays };
  const ago = `${printed} was ${dayCount(daysSinceRace)} ago`;
  return daysSinceRace <= postRaceDays
    ? withReason({ ...past, raceState: "recent", phase: "transition", emphasis: "transition" }, ago, `post-race transition until day ${postRaceDays} after the race`)
    : withReason({ ...past, raceState: "none", phase: "general_preparation", emphasis: "strength_led" }, `${ago} and no next race is planned`);
}

/** The race's day offset from the week start: 0 on race day, negative once it is past; null without a race. */
export function raceDayOffsetOf(season: Season): number | null {
  if (season.daysToRace !== null) return season.daysToRace;
  return season.daysSinceRace === null ? null : -season.daysSinceRace;
}

/** Whole weeks to an upcoming race (1 for 1-7 days); null on race day, after the race, or without a date. */
export function weeksToGo(season: Season): number | null {
  return season.daysToRace !== null && season.daysToRace > 0 ? Math.ceil(season.daysToRace / 7) : null;
}

/** How far the race is, in plain words: "10 weeks out", "in 3 days", "today", "15 days ago", "no race date". */
export function raceTimingText(season: Season): string {
  if (season.daysSinceRace !== null) return `${dayCount(season.daysSinceRace)} ago`;
  if (season.daysToRace === null) return "no race date";
  if (season.daysToRace === 0) return "today";
  if (season.daysToRace <= 7) return `in ${dayCount(season.daysToRace)}`;
  return `${weeksToGo(season)} weeks out`;
}

/** The context's season; a hand-built context without one gets it computed. */
export function contextSeason(context: CoachContext): Season {
  return context.season ?? computeSeason(context.running?.raceGoal, context.profile.weekStart);
}

function upcomingPhase(days: number): SeasonPhase {
  const until = SEASON_LIMITS.phaseUntilDays;
  if (days <= until.taper) return "taper";
  if (days <= until.peak) return "peak";
  if (days <= until.build) return "build";
  if (days <= until.base) return "base";
  return "general_preparation";
}

function upcomingEmphasis(days: number): SeasonEmphasis {
  const until = SEASON_LIMITS.emphasisUntilDays;
  if (days <= until.taper) return "taper";
  if (days <= until.run_led) return "run_led";
  if (days <= until.balanced) return "balanced";
  return "strength_led";
}

function withReason(season: Omit<Season, "reason">, where: string, phaseText = PHASE_TEXT[season.phase]): Season {
  return { ...season, reason: `${where}: ${phaseText}, ${EMPHASIS_TEXT[season.emphasis]}.` };
}

/** "1 day", "14 days". */
function dayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}
