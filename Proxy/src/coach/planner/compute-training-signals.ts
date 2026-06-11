import type { CoachContext, GarminWellnessDay, RunSummary } from "./types";

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
    /** Share of runs in the last 4 weeks that were easy/recovery, 0-1. */
    easyShareLast4Weeks: number | null;
    runCountLast7Days: number;
  };
  race: {
    daysToRace: number;
    weeksToRace: number;
    /** "in-taper" ≤14 days out, "approaching" 15-21, else "training". */
    taperStatus: "in-taper" | "approaching" | "training";
  } | null;
  wellness: {
    latestDate: string;
    hrvStatus: string | null;
    /** Daily HRV decision rule: hard work only when HRV is not suppressed. */
    hrvGate: "ok-for-hard" | "favor-easy" | null;
    sleepScore: number | null;
    trainingReadiness: number | null;
    restingHr: number | null;
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
const EASY_KINDS = new Set(["easy", "recovery"]);
const SUPPRESSED_HRV = new Set(["UNBALANCED", "LOW", "POOR"]);

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

  const easyRunsWithKind = last28.filter((run) => typeof run.kind === "string" && run.kind.length > 0);

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
      easyShareLast4Weeks:
        easyRunsWithKind.length > 0
          ? round2(easyRunsWithKind.filter((run) => EASY_KINDS.has(run.kind as string)).length / easyRunsWithKind.length)
          : null,
      runCountLast7Days: last7.length
    },
    race: raceSignals(running.raceGoal.raceDate, running.weeksToRace, now),
    wellness: wellnessSignals(context.garmin?.wellness ?? []),
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
 * (PHIA), and each entry encodes the hedges the literature demands. */
export const coachReferencePoints = [
  "Volume jumps: week-over-week load ratios are weak, contested evidence (acute:chronic ratios predict injury no better than chance in some cohorts) — treat a sharp rise vs the 4-week average as a hedged caution, never as an injury verdict.",
  "HRV gate: when overnight HRV is suppressed, favor easy work or rest that day; when balanced or rising, hard sessions are fine. Use it to gate intensity, not to rewrite the plan.",
  "Taper: 8-14 days out, reduce running volume roughly 41-60% while keeping intensity and session frequency — do not add fitness in the final two weeks.",
  "Downhill conditioning: trail runners who train downhill repeats show markedly less muscle damage and better strength retention; descent exposure matters for ultra prep, not just ascent.",
  "Strength serves the race: heavy (≥80% 1RM) strength work and plyometrics improve running economy — frame strength sessions as part of the ultra build, not a separate hobby.",
  "Long-run progression: grow the weekly long run gradually and respect recovery weeks; the longest recent run versus race distance is the key readiness gap to narrate."
] as const;

function runsBetween(runs: RunSummary[], now: Date, daysBackStart: number, daysBackEnd: number): RunSummary[] {
  const windowStart = now.getTime() - daysBackStart * DAY_MS;
  const windowEnd = now.getTime() - daysBackEnd * DAY_MS;
  return runs.filter((run) => {
    const at = new Date(run.completedAt).getTime();
    return at > windowStart && at <= windowEnd;
  });
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

function raceSignals(raceDate: string, weeksToRace: number, now: Date): TrainingSignals["race"] {
  const days = Math.max(0, Math.ceil((new Date(raceDate).getTime() - now.getTime()) / DAY_MS));
  let taperStatus: "in-taper" | "approaching" | "training" = "training";
  if (days <= 14) {
    taperStatus = "in-taper";
  } else if (days <= 21) {
    taperStatus = "approaching";
  }
  return { daysToRace: days, weeksToRace, taperStatus };
}

function wellnessSignals(wellness: GarminWellnessDay[]): TrainingSignals["wellness"] {
  const latest = [...wellness]
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  if (!latest) {
    return null;
  }

  const status = latest.hrvStatus?.trim().toUpperCase() ?? "";
  let hrvGate: "ok-for-hard" | "favor-easy" | null = null;
  if (status === "BALANCED") {
    hrvGate = "ok-for-hard";
  } else if (SUPPRESSED_HRV.has(status)) {
    hrvGate = "favor-easy";
  }

  return {
    latestDate: latest.date,
    hrvStatus: status.length > 0 ? status : null,
    hrvGate,
    sleepScore: latest.sleepScore > 0 ? latest.sleepScore : null,
    trainingReadiness: latest.trainingReadiness > 0 ? latest.trainingReadiness : null,
    restingHr: latest.restingHr > 0 ? latest.restingHr : null
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
