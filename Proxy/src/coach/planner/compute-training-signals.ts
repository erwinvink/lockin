import { round1 } from "./numbers";
import { contextSeason, FLOOR_PHASES, SEASON_LIMITS } from "./season";
import type { CoachContext, CoachWellnessDay, RunSummary, Season } from "./types";
import { RUNNING_LIMITS } from "./running-limits";
import { hrvVersusBaseline, latestDayWith, latestHrvDay, WELLNESS_GATE_LIMITS } from "./wellness-gate";

/**
 * Pre-computed numbers for the coach read. LLMs are unreliable at arithmetic
 * over raw logs (PHIA, arXiv:2406.06464: 22% accuracy text-only vs 84% with
 * code-computed values), so every figure the verdict may cite is computed
 * here and handed over ready-made. The model writes; it never calculates.
 */
export type TrainingSignals = {
  running: {
    last7DaysKm: number;
    prior7DaysKm: number;
    fourWeekAvgKm: number;
    /** last7DaysKm vs fourWeekAvgKm, percent; null without a baseline. */
    volumeVsFourWeekPct: number | null;
    last7DaysAscentM: number;
    last7DaysDescentM: number | null;
    longestRunLast6WeeksKm: number;
    /** Most recent three long-ish runs (one per week max), oldest first. */
    recentLongRunsKm: number[];
    /**
     * Share of running time in the last 4 weeks at low intensity, 0-1: easy,
     * recovery and long runs (long runs are mostly Zone 2). This is the
     * 80/20 split by time: a normal build week reads about 0.8; well below
     * 0.75 means too much hard running. Runs without a kind and races are
     * left out.
     */
    lowIntensityTimeShareLast4Weeks: number | null;
    /** The same share over the last 3 weeks of training runs (races left out). */
    lowIntensityTimeShareLast3Weeks: number | null;
    /**
     * No speed stimulus in 3 weeks: that share is at least 0.95 in general
     * preparation, base, build or peak (taper and post-race weeks are easy
     * on purpose). The running planner adds the structured session.
     */
    noSpeedStimulusLast3Weeks: boolean;
    runCountLast7Days: number;
  };
  race: {
    /** Days to the race, 0 on race day; null once the race is past (copied from the season). */
    daysToRace: number | null;
    /** Days since the race once it is past, else null (copied from the season). */
    daysSinceRace: number | null;
    /** Kept for older readers: 0 on race day and after the race. */
    weeksToRace: number;
    /**
     * Before the race: "in-taper" 0-14 days out (race day included),
     * "approaching" 15-21 (the first taper week), else "training". After
     * it: "post-race" inside the race's post-race window, then "none"; also
     * "none" without a readable race date.
     */
    taperStatus: "in-taper" | "approaching" | "training" | "post-race" | "none";
  } | null;
  /**
   * Each value comes from the latest day that has it, at most 2 days old,
   * with that day: at the 01:30 nightly plan today's row is still empty, so
   * the values are usually yesterday's.
   */
  wellness: {
    /** The newest wellness row, with or without values. */
    latestDate: string;
    hrvStatus: string | null;
    hrvDate: string | null;
    /**
     * Daily HRV decision rule (wellness-gate.ts): "favor-easy" only when HRV
     * is below the athlete's baseline (LOW, POOR, or a 7-day average below
     * the baseline range); null when unknown, such as UNBALANCED without the
     * numbers (it can sit above the baseline).
     */
    hrvGate: "ok-for-hard" | "favor-easy" | null;
    sleepScore: number | null;
    sleepScoreDate: string | null;
    trainingReadiness: number | null;
    trainingReadinessDate: string | null;
    restingHr: number | null;
    restingHrDate: string | null;
  } | null;
  lastRun: {
    completedAt: string;
    distanceKm: number;
    paceSecPerKm: number | null;
    elevationGainM: number;
    averageHr: number | null;
    rpe: number | null;
    feelScore: number | null;
    kind: string | null;
  } | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LOW_INTENSITY_KINDS = new Set(["easy", "recovery", "long"]);
/** An easy share at or above this over 3 weeks means no speed stimulus. */
const NO_SPEED_STIMULUS_SHARE = 0.95;

export function computeTrainingSignals(context: CoachContext, now = new Date()): TrainingSignals | null {
  const running = context.running;
  if (!running) {
    return null;
  }

  const runs = [...running.recentRuns].sort(
    (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
  );

  const last7 = runsBetween(runs, now, 7, 0);
  const prior7 = runsBetween(runs, now, 14, 7);
  const last28 = runsBetween(runs, now, 28, 0);
  const last42 = runsBetween(runs, now, 42, 0);

  const last7DaysKm = sumKm(last7);
  const fourWeekAvgKm = sumKm(last28) / 4;

  const descentValues = last7
    .map((run) => run.elevationLossM)
    .filter((value): value is number => typeof value === "number" && value > 0);

  // A race is not training: it stays out of both easy shares.
  const training = (window: RunSummary[]) => window.filter((run) => !isRaceRun(run, running.raceGoal.raceDate));
  const lowIntensityShare4 = lowIntensityShare(training(last28));
  const lowIntensityShare3 = lowIntensityShare(training(runsBetween(runs, now, 21, 0)));

  const lastRun = runs.at(-1) ?? null;

  return {
    running: {
      last7DaysKm: round1(last7DaysKm),
      prior7DaysKm: round1(sumKm(prior7)),
      fourWeekAvgKm: round1(fourWeekAvgKm),
      volumeVsFourWeekPct:
        fourWeekAvgKm > 0 ? Math.round(((last7DaysKm - fourWeekAvgKm) / fourWeekAvgKm) * 100) : null,
      last7DaysAscentM: last7.reduce((total, run) => total + (run.elevationGainM || 0), 0),
      last7DaysDescentM: descentValues.length > 0 ? descentValues.reduce((a, b) => a + b, 0) : null,
      longestRunLast6WeeksKm: round1(Math.max(0, ...last42.map((run) => run.distanceKm))),
      recentLongRunsKm: weeklyLongRuns(last28, now).map(round1),
      lowIntensityTimeShareLast4Weeks: lowIntensityShare4 === null ? null : round2(lowIntensityShare4),
      lowIntensityTimeShareLast3Weeks: lowIntensityShare3 === null ? null : round2(lowIntensityShare3),
      noSpeedStimulusLast3Weeks:
        lowIntensityShare3 !== null && lowIntensityShare3 >= NO_SPEED_STIMULUS_SHARE && FLOOR_PHASES.has(contextSeason(context).phase),
      runCountLast7Days: last7.length
    },
    race: raceSignals(context, running.weeksToRace),
    wellness: wellnessSignals(context.garmin?.wellness ?? [], context.profile.weekStart),
    lastRun: lastRun
      ? {
          completedAt: lastRun.completedAt,
          distanceKm: round1(lastRun.distanceKm),
          paceSecPerKm:
            lastRun.distanceKm > 0 && lastRun.movingSeconds > 0
              ? Math.round(lastRun.movingSeconds / lastRun.distanceKm)
              : null,
          elevationGainM: lastRun.elevationGainM || 0,
          averageHr: lastRun.averageHr ?? null,
          rpe: lastRun.rpe ?? null,
          feelScore: lastRun.feelScore ?? null,
          kind: lastRun.kind ?? null
        }
      : null
  };
}

/** Evidence summaries paired with the athlete's numbers in the verdict
 * prompt — retrieved domain knowledge measurably improves response quality
 * (PHIA), and each entry encodes the hedges the literature demands. The
 * race-centred ones only apply while a race is ahead. No running-economy
 * claim for strength: the planner prescribes no heavy leg strength or
 * plyometrics yet (Part 2 adds them, and an accurate line with them). */
const COACH_REFERENCE_POINTS: ReadonlyArray<{ text: string; raceAhead?: true }> = [
  { text: "Volume jumps: week-over-week load ratios are weak, contested evidence (acute:chronic ratios predict injury no better than chance in some cohorts) — treat a sharp rise vs the 4-week average as a hedged caution, never as an injury verdict." },
  { text: `HRV gate: when HRV is below the athlete's baseline (Garmin LOW or POOR), favor easy work for the next ${WELLNESS_GATE_LIMITS.gateHours} hours; when balanced or above the baseline, hard sessions are fine. Unbalanced alone can mean above the baseline. Use it to move the next hard session, not to rewrite the plan.` },
  { text: "Taper: 15-21 days out run at most 80% of the pre-taper volume, 8-14 days out about 50-70% with one short quality session, and in race week only short shakeouts around the race — do not add fitness in the final two weeks.", raceAhead: true },
  { text: "Downhill conditioning: one hard downhill bout protects the legs against damage from the next one for up to about 6 weeks (the repeated-bout effect, shown in recreational runners); descent exposure matters for ultra prep, not just ascent." },
  { text: `Long-run progression: grow the weekly long run gradually, at most ${Math.round((RUNNING_LIMITS.longRunCapRatio - 1) * 100)}% past the longest training run of the last ${RUNNING_LIMITS.longRunWindowDays} days (a race is not a training run), and respect recovery weeks.` },
  { text: "Race readiness: the longest recent run versus the race distance is the key readiness gap to narrate.", raceAhead: true }
];

/** The reference points for this season: the race-centred ones only while a race is ahead. */
export function coachReferencePointsFor(season: Season): string[] {
  return COACH_REFERENCE_POINTS.filter((point) => !point.raceAhead || season.raceState === "upcoming").map((point) => point.text);
}

/**
 * A race, not training: a run of kind "race" or any run on the stored race
 * date (the app logs the race as the planned race session, kind "long").
 */
export function isRaceRun(run: RunSummary, raceDate: string | undefined): boolean {
  if (run.kind === "race") return true;
  const race = Date.parse(raceDate ?? "");
  const at = Date.parse(run.completedAt);
  return Number.isFinite(race) && Number.isFinite(at) && at >= race && at < race + DAY_MS;
}

function runsBetween(runs: RunSummary[], now: Date, daysBackStart: number, daysBackEnd: number): RunSummary[] {
  const windowStart = now.getTime() - daysBackStart * DAY_MS;
  const windowEnd = now.getTime() - daysBackEnd * DAY_MS;
  return runs.filter((run) => {
    const at = new Date(run.completedAt).getTime();
    return at > windowStart && at <= windowEnd;
  });
}

/** Share of running time in easy, recovery and long runs; runs without a kind are left out (null when none has one). */
function lowIntensityShare(runs: RunSummary[]): number | null {
  const withKind = runs.filter((run) => typeof run.kind === "string" && run.kind.length > 0);
  const total = withKind.reduce((sum, run) => sum + runSeconds(run), 0);
  if (total <= 0) return null;
  const low = withKind.filter((run) => LOW_INTENSITY_KINDS.has(run.kind as string)).reduce((sum, run) => sum + runSeconds(run), 0);
  return low / total;
}

/** Moving time, or 6 min/km when a manual log has none. */
function runSeconds(run: RunSummary): number {
  return run.movingSeconds > 0 ? run.movingSeconds : Math.max(0, run.distanceKm) * 360;
}

function sumKm(runs: RunSummary[]): number {
  return runs.reduce((total, run) => total + (run.distanceKm || 0), 0);
}

/** Longest run per trailing 7-day block over the last 28 days, oldest first. */
function weeklyLongRuns(last28: RunSummary[], now: Date): number[] {
  const longest: number[] = [];
  for (let week = 3; week >= 0; week -= 1) {
    const blockRuns = runsBetween(last28, now, (week + 1) * 7, week * 7);
    if (blockRuns.length > 0) {
      longest.push(Math.max(...blockRuns.map((run) => run.distanceKm)));
    }
  }
  return longest;
}

/** The race as the season counts it (one day count, from the week start). */
function raceSignals(context: CoachContext, weeksToRace: number): TrainingSignals["race"] {
  const season = contextSeason(context);
  return { daysToRace: season.daysToRace, daysSinceRace: season.daysSinceRace, weeksToRace, taperStatus: taperStatusFor(season) };
}

const IN_TAPER_DAYS = 14;

function taperStatusFor(season: Season): NonNullable<TrainingSignals["race"]>["taperStatus"] {
  if (season.daysToRace !== null) {
    if (season.daysToRace <= IN_TAPER_DAYS) return "in-taper";
    return season.daysToRace <= SEASON_LIMITS.phaseUntilDays.taper ? "approaching" : "training";
  }
  return season.raceState === "recent" ? "post-race" : "none";
}

function wellnessSignals(wellness: CoachWellnessDay[], weekStart: string): TrainingSignals["wellness"] {
  const latest = [...wellness]
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  if (!latest) {
    return null;
  }

  // Each value from the latest day that has it, as in the gate: at the 01:30
  // plan today's row has none yet.
  const hrvDay = latestHrvDay(wellness, weekStart);
  const status = hrvDay?.hrvStatus?.trim().toUpperCase() ?? "";
  const versusBaseline = hrvDay ? hrvVersusBaseline(hrvDay) : "unknown";
  const hrvGate = versusBaseline === "below" ? "favor-easy" : versusBaseline === "not_below" ? "ok-for-hard" : null;
  const reading = (field: "sleepScore" | "trainingReadiness" | "restingHr") => {
    const day = latestDayWith(wellness, weekStart, (entry) => positiveOrNull(entry[field]) !== null);
    return { value: day ? positiveOrNull(day[field]) : null, date: day?.date ?? null };
  };
  const sleep = reading("sleepScore");
  const readiness = reading("trainingReadiness");
  const restingHr = reading("restingHr");

  return {
    latestDate: latest.date,
    hrvStatus: status.length > 0 ? status : null,
    hrvDate: hrvDay?.date ?? null,
    hrvGate,
    sleepScore: sleep.value,
    sleepScoreDate: sleep.date,
    trainingReadiness: readiness.value,
    trainingReadinessDate: readiness.date,
    restingHr: restingHr.value,
    restingHrDate: restingHr.date
  };
}

// 0 (or null) means Garmin had no value: never a real low score.
function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
