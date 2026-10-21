import { computeTrainingSignals, type TrainingSignals } from "./compute-training-signals";
import type { CoachContext, RunningWeek, RunSummary, RunTarget } from "./types";

/**
 * Computed running limits. The planner prompt, the clamp step and the
 * validator all read these, so the model is told exactly what is enforced.
 * Only computed facts relax a limit (readiness state, race or taper window,
 * a tripped wellness gate, a recent distressed run, missing run history);
 * a model-written safety flag never does.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const HARD_RUN_KINDS: ReadonlySet<string> = new Set(["long", "tempo", "intervals", "hills"]);
export const EASY_RUN_KINDS: ReadonlySet<string> = new Set(["easy", "recovery"]);
const SUPPRESSED_HRV = new Set(["UNBALANCED", "LOW", "POOR"]);
const ALL_FUTURE_OFFSETS = [1, 2, 3, 4, 5, 6];

export const RUNNING_LIMITS = {
  /** Planned weekly km may be at most 15% above the reference... */
  weeklyJumpRatio: 0.15,
  /** ...or reference + 3 km, whichever is larger (small bases need room). */
  weeklyMinimumStepKm: 3,
  /** First week back after 4+ weeks without a run. */
  returningFromBreakCapKm: 20,
  longRunCapRatio: 1.4,
  paceSecPerKm: { min: 150, max: 720 },
  hrBpm: { min: 80, max: 210 },
  /** Volume clamping never shortens an easy run below this (or half its length). */
  easyRunMinimumKm: 3,
  backToBackMinRaceKm: 80,
  /** Build and peak: more than 3 and at most 12 weeks to the race. */
  backToBackWeeksToRace: { min: 4, max: 12 },
  recentRunWindowDays: 42,
  wellnessMaxAgeDays: 3
} as const;

export type RunningRelaxationCode =
  | "readiness_overreaching"
  | "readiness_recovery_needed"
  | "race_this_week"
  | "taper_window"
  | "post_race_recovery"
  | "wellness_gate"
  | "recent_run_distress"
  | "missing_run_history";

export type RunningRelaxation = { code: RunningRelaxationCode; detail: string };

export type WeeklyVolumeLimit =
  | { kind: "capped"; referenceKm: number; capKm: number; basis: string }
  | { kind: "waived"; reason: string };

export type EasyRunReference = {
  /** Seconds per km; low is the faster bound. */
  paceSecPerKm: { low: number; high: number; median: number } | null;
  hrBpm: { low: number; high: number; median: number } | null;
  runsUsed: number;
  method: "labelled_easy_runs" | "slower_half_of_flat_runs";
};

export type RunFrequencyPolicy = { minRuns: number; maxRuns: number; maxReason: string; basis: string };

export type RunningGuardrails = {
  anchor: string;
  relaxations: RunningRelaxation[];
  weeklyVolume: WeeklyVolumeLimit;
  longRun: { recentLongestKm: number; capKm: number } | null;
  frequency: RunFrequencyPolicy | null;
  availability: { unconstrained: boolean; offsets: number[] };
  backToBackLongRunsAllowed: boolean;
  raceDayOffset: number | null;
  recentRunCountLast6Weeks: number;
  easyReference: EasyRunReference | null;
};

export type RunningGuardrailOptions = {
  /** Reference instant for the rolling windows; defaults to weekStart. */
  now?: Date;
  signals?: TrainingSignals | null;
};

export function runningGuardrails(context: CoachContext, options: RunningGuardrailOptions = {}): RunningGuardrails {
  const now = options.now ?? defaultAnchor(context);
  const anchorMs = now.getTime();
  const running = context.running;
  const signals = options.signals !== undefined ? options.signals : computeTrainingSignals(context, now);
  const raceDayOffset = raceOffset(context);
  const availability = runningDayAvailability(context);
  const recentRunCountLast6Weeks = running
    ? running.recentRuns.filter((run) => withinDaysBefore(run, anchorMs, RUNNING_LIMITS.recentRunWindowDays)).length
    : 0;

  return {
    anchor: now.toISOString(),
    relaxations: computedRelaxations(context, anchorMs, raceDayOffset),
    weeklyVolume: weeklyVolumeLimit(context, signals),
    longRun: longRunLimit(context, signals),
    frequency: running ? runFrequencyPolicy(context, availability.offsets.length, recentRunCountLast6Weeks) : null,
    availability,
    backToBackLongRunsAllowed: backToBackLongRunsAllowed(context),
    raceDayOffset,
    recentRunCountLast6Weeks,
    easyReference: running ? easyRunReference(running.recentRuns, anchorMs) : null
  };
}

/** Planner-facing view of the guardrails (plain JSON, no functions). */
export function runningGuardrailsForPrompt(guardrails: RunningGuardrails): Record<string, unknown> {
  return {
    weeklyVolume:
      guardrails.weeklyVolume.kind === "capped"
        ? {
            referenceKm: guardrails.weeklyVolume.referenceKm,
            capKm: guardrails.weeklyVolume.capKm,
            basis: guardrails.weeklyVolume.basis,
            rule: "Sum of planned distances (race-day session excluded) must be at most capKm. Over the cap, the proxy shortens easy and recovery runs."
          }
        : { waived: true, reason: guardrails.weeklyVolume.reason },
    longRun: guardrails.longRun
      ? {
          recentLongestKm: guardrails.longRun.recentLongestKm,
          capKm: guardrails.longRun.capKm,
          rule: "No run except the race itself may exceed capKm (1.4x the recent longest run)."
        }
      : null,
    frequency: guardrails.frequency
      ? { minRuns: guardrails.frequency.minRuns, maxRuns: guardrails.frequency.maxRuns, basis: guardrails.frequency.basis }
      : null,
    hardRuns: {
      maxHardRuns: { "1-2 runs": "all", "3-4 runs": 2, "5 runs": 3 },
      backToBackLongRunsCountAsOne: guardrails.backToBackLongRunsAllowed,
      hardKinds: [...HARD_RUN_KINDS],
      consecutiveDays: guardrails.backToBackLongRunsAllowed
        ? "Never two hard runs on consecutive days, except two long runs back to back (allowed for this race and phase)."
        : "Never two hard runs on consecutive days."
    },
    computedRelaxations: guardrails.relaxations,
    computedRelaxationRule:
      "Only these computed reasons allow fewer runs than frequency.minRuns or an all-easy week. Safety flags never waive a limit.",
    raceDayOffset: guardrails.raceDayOffset,
    recentRunCountLast6Weeks: guardrails.recentRunCountLast6Weeks,
    easyReference: guardrails.easyReference,
    targetBounds: {
      paceSecPerKm: [RUNNING_LIMITS.paceSecPerKm.min, RUNNING_LIMITS.paceSecPerKm.max],
      hrBpm: [RUNNING_LIMITS.hrBpm.min, RUNNING_LIMITS.hrBpm.max],
      rule: "Targets outside these bounds are dropped (the run becomes effort-based) or replaced with easyReference."
    }
  };
}

export function maxHardRunsFor(runCount: number): number {
  if (runCount <= 2) return runCount;
  return runCount <= 4 ? 2 : 3;
}

/**
 * Hard runs as counted against maxHardRunsFor. When back-to-back long runs
 * are allowed, a long run on the day after another long run belongs to the
 * same long-run block and is not counted a second time.
 */
export function countedHardRuns(week: RunningWeek, guardrails: RunningGuardrails): number {
  let count = 0;
  week.sessions.forEach((session, index) => {
    if (!HARD_RUN_KINDS.has(session.kind)) return;
    const previous = week.sessions[index - 1];
    const secondOfBackToBack =
      guardrails.backToBackLongRunsAllowed &&
      session.kind === "long" &&
      previous?.kind === "long" &&
      session.dayOffset === previous.dayOffset + 1;
    if (!secondOfBackToBack) count += 1;
  });
  return count;
}

/**
 * Where runs may go this week. A selection exists when the athlete picked any
 * running day (`runningDays`), even if none of them is left this week: then
 * the offsets are empty and the week has zero runs. No running days picked at
 * all means unconstrained: any future day 1 through 6.
 */
export function runningDayAvailability(context: CoachContext): { unconstrained: boolean; offsets: number[] } {
  const running = context.running;
  const unconstrained = (running?.runningDays ?? []).length === 0;
  return {
    unconstrained,
    offsets: unconstrained ? [...ALL_FUTURE_OFFSETS] : [...(running?.runningDayOffsets ?? [])]
  };
}

export function isRaceDaySession(session: RunningWeek["sessions"][number], guardrails: RunningGuardrails): boolean {
  return guardrails.raceDayOffset !== null && session.dayOffset === guardrails.raceDayOffset;
}

export function countedWeeklyKm(week: RunningWeek, guardrails: RunningGuardrails): number {
  return round1(
    week.sessions
      .filter((session) => !isRaceDaySession(session, guardrails))
      .reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0)
  );
}

/**
 * Deterministic, safe fixes applied before validation: implausible targets
 * are replaced with the athlete's easy reference or dropped, over-cap runs
 * are shortened to the long-run cap, and easy/recovery runs are shortened to
 * fit the weekly cap when they can absorb the excess. Returns a new week.
 */
export function clampRunningWeek(
  week: RunningWeek,
  context: CoachContext,
  guardrails: RunningGuardrails = runningGuardrails(context)
): { week: RunningWeek; adjustments: string[] } {
  const adjustments: string[] = [];
  const sessions = week.sessions.map((session) => ({ ...session, target: { ...session.target }, notes: [...session.notes] }));

  sessions.forEach((session, index) => {
    const fixed = fixTarget(session, guardrails.easyReference);
    if (fixed) {
      session.target = fixed.target;
      adjustments.push(`Run ${index + 1} (${session.title}): ${fixed.reason}`);
    }
  });

  if (guardrails.longRun) {
    const cap = guardrails.longRun.capKm;
    sessions.forEach((session, index) => {
      if (isRaceDaySession(session, guardrails) || session.distanceKm <= cap) return;
      const before = session.distanceKm;
      scaleSession(session, floorHalf(cap));
      session.notes.push(`Shortened to ${session.distanceKm} km: 1.4x your recent longest run (${guardrails.longRun!.recentLongestKm} km) is the cap.`);
      adjustments.push(
        `Run ${index + 1} (${session.title}): shortened from ${before} km to ${session.distanceKm} km (long-run cap ${cap} km).`
      );
    });
  }

  if (guardrails.weeklyVolume.kind === "capped") {
    const cap = guardrails.weeklyVolume.capKm;
    const counted = sessions.filter((session) => !isRaceDaySession(session, guardrails));
    const total = counted.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
    const excess = total - cap;
    if (excess > 0.05) {
      const easy = counted.filter((session) => EASY_RUN_KINDS.has(session.kind) && session.distanceKm > 0);
      const reducible = easy.reduce((sum, session) => sum + (session.distanceKm - easyFloor(session.distanceKm)), 0);
      if (reducible >= excess) {
        const share = excess / reducible;
        for (const session of easy) {
          const floor = easyFloor(session.distanceKm);
          const target = session.distanceKm - (session.distanceKm - floor) * share;
          const next = Math.max(floor, floorHalf(target));
          if (next < session.distanceKm) {
            scaleSession(session, next);
            session.notes.push("Shortened to keep this week inside the weekly volume cap.");
          }
        }
        const after = counted.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
        adjustments.push(
          `Weekly volume ${round1(total)} km was above the ${cap} km cap; easy and recovery runs were shortened to ${round1(after)} km total.`
        );
      }
    }
  }

  return { week: { ...week, sessions }, adjustments };
}

export function describeTarget(target: RunTarget): string {
  if (target.type === "none") return "no target";
  if (target.type === "pace") return `pace ${target.low}-${target.high} s/km`;
  return `heart rate ${target.low}-${target.high} bpm`;
}

export function targetProblem(target: RunTarget): string | null {
  if (target.type === "none") {
    return target.low === 0 && target.high === 0 ? null : "a 'none' target must use low 0 and high 0";
  }
  if (!Number.isFinite(target.low) || !Number.isFinite(target.high)) return "target bounds must be numbers";
  if (target.low > target.high) return `target low must not exceed target high (got low ${target.low}, high ${target.high})`;
  if (target.type === "pace") {
    const { min, max } = RUNNING_LIMITS.paceSecPerKm;
    if (target.low < min || target.high > max) {
      return `pace target ${target.low}-${target.high} s/km is outside the plausible ${min}-${max} s/km (2:30-12:00 per km) range`;
    }
    return null;
  }
  const { min, max } = RUNNING_LIMITS.hrBpm;
  if (target.low < min || target.high > max) {
    return `heart-rate target ${target.low}-${target.high} bpm is outside the plausible ${min}-${max} bpm range`;
  }
  return null;
}

function fixTarget(
  session: RunningWeek["sessions"][number],
  reference: EasyRunReference | null
): { target: RunTarget; reason: string } | null {
  const original = session.target;
  if (original.type === "none") {
    return original.low === 0 && original.high === 0 ? null : { target: noTarget(), reason: "an empty target was normalized." };
  }

  let low = original.low;
  let high = original.high;
  const swapped = Number.isFinite(low) && Number.isFinite(high) && low > high;
  if (swapped) [low, high] = [high, low];
  const candidate: RunTarget = { type: original.type, low, high };

  if (targetProblem(candidate) !== null) {
    const replacement = referenceTarget(session, reference);
    return replacement
      ? { target: replacement, reason: `${describeTarget(original)} was implausible; replaced with the easy-run reference (${describeTarget(replacement)}).` }
      : { target: noTarget(), reason: `${describeTarget(original)} was implausible; the target was dropped so the run is effort-based.` };
  }

  if (EASY_RUN_KINDS.has(session.kind) && reference) {
    if (candidate.type === "pace" && reference.paceSecPerKm && candidate.high < reference.paceSecPerKm.low - 20) {
      const replacement = { type: "pace" as const, low: reference.paceSecPerKm.low, high: reference.paceSecPerKm.high };
      return { target: replacement, reason: `${describeTarget(original)} is much faster than the athlete's easy pace; replaced with ${describeTarget(replacement)}.` };
    }
    if (candidate.type === "hr" && reference.hrBpm && candidate.low > reference.hrBpm.high + 5) {
      const replacement = { type: "hr" as const, low: reference.hrBpm.low, high: reference.hrBpm.high };
      return { target: replacement, reason: `${describeTarget(original)} is well above the athlete's easy heart rate; replaced with ${describeTarget(replacement)}.` };
    }
  }

  return swapped ? { target: candidate, reason: "target bounds were swapped so low is the lower number." } : null;
}

function referenceTarget(session: RunningWeek["sessions"][number], reference: EasyRunReference | null): RunTarget | null {
  if (!reference) return null;
  const easy = EASY_RUN_KINDS.has(session.kind);
  if (!easy && session.kind !== "long") return null;
  if (reference.hrBpm) return { type: "hr", low: reference.hrBpm.low, high: reference.hrBpm.high };
  const elevationPerKm = session.distanceKm > 0 ? session.elevationMeters / session.distanceKm : 0;
  if (reference.paceSecPerKm && (easy || elevationPerKm <= 25)) {
    return { type: "pace", low: reference.paceSecPerKm.low, high: reference.paceSecPerKm.high };
  }
  return null;
}

function noTarget(): RunTarget {
  return { type: "none", low: 0, high: 0 };
}

function scaleSession(session: RunningWeek["sessions"][number], distanceKm: number) {
  const ratio = session.distanceKm > 0 ? distanceKm / session.distanceKm : 1;
  session.durationMinutes = Math.max(0, Math.round(session.durationMinutes * ratio));
  session.elevationMeters = Math.max(0, Math.round(session.elevationMeters * ratio));
  session.distanceKm = distanceKm;
}

function easyFloor(distanceKm: number): number {
  return Math.min(distanceKm, Math.max(RUNNING_LIMITS.easyRunMinimumKm, distanceKm * 0.5));
}

function floorHalf(value: number): number {
  return Math.floor(value * 2 + 1e-9) / 2;
}

function computedRelaxations(context: CoachContext, anchorMs: number, raceDayOffset: number | null): RunningRelaxation[] {
  const relaxations: RunningRelaxation[] = [];
  const state = context.readiness.state;
  if (state === "overreaching" || state === "recovery_needed") {
    relaxations.push({ code: `readiness_${state}`, detail: `Computed readiness is ${state}.` });
  }

  const running = context.running;
  if (running) {
    if (raceDayOffset !== null) {
      relaxations.push({ code: "race_this_week", detail: `The race is on day offset ${raceDayOffset}.` });
    } else if (running.weeksToRace >= 1 && running.weeksToRace <= 3) {
      relaxations.push({ code: "taper_window", detail: `${running.weeksToRace} week(s) to the race: taper window.` });
    }

    const daysToRace = daysFromWeekStart(context, running.raceGoal.raceDate);
    if (daysToRace !== null && daysToRace <= 0 && daysToRace >= -14) {
      relaxations.push({ code: "post_race_recovery", detail: `The race was ${-daysToRace} day(s) ago.` });
    }

    const distressed = running.recentRuns
      .filter((run) => withinDaysBefore(run, anchorMs, 7))
      .filter((run) => typeof run.feelScore === "number" && run.feelScore >= 1 && run.feelScore <= 2);
    if (distressed.length > 0) {
      const latest = distressed[distressed.length - 1];
      relaxations.push({
        code: "recent_run_distress",
        detail: `A run on ${latest.completedAt.slice(0, 10)} was rated ${latest.feelScore}/5 for feel.`
      });
    }

    if (running.recentRuns.length === 0 && (running.baselineWeeklyKm || 0) <= 0) {
      relaxations.push({ code: "missing_run_history", detail: "No run history and no baseline weekly volume." });
    }
  }

  const gate = wellnessGate(context, anchorMs);
  if (gate) relaxations.push(gate);
  return relaxations;
}

function wellnessGate(context: CoachContext, anchorMs: number): RunningRelaxation | null {
  const latest = [...(context.garmin?.wellness ?? [])].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!latest) return null;
  const dayMs = Date.parse(`${latest.date.slice(0, 10)}T12:00:00Z`);
  if (!Number.isFinite(dayMs) || Math.abs(anchorMs - dayMs) > RUNNING_LIMITS.wellnessMaxAgeDays * DAY_MS) return null;
  const hrv = latest.hrvStatus?.trim().toUpperCase() ?? "";
  if (SUPPRESSED_HRV.has(hrv)) {
    return { code: "wellness_gate", detail: `HRV status ${hrv} on ${latest.date}.` };
  }
  if (typeof latest.sleepScore === "number" && latest.sleepScore > 0 && latest.sleepScore < 50) {
    return { code: "wellness_gate", detail: `Sleep score ${latest.sleepScore} on ${latest.date}.` };
  }
  return null;
}

function weeklyVolumeLimit(context: CoachContext, signals: TrainingSignals | null): WeeklyVolumeLimit {
  const running = context.running;
  if (!running) return { kind: "waived", reason: "No running context." };
  const baseline = running.baselineWeeklyKm || 0;

  if (running.recentRuns.length === 0 || !signals) {
    if (baseline > 0) {
      return {
        kind: "capped",
        referenceKm: round1(baseline),
        capKm: capFrom(baseline),
        basis: `the athlete's baseline of ${round1(baseline)} km/week (no run history was sent)`
      };
    }
    return { kind: "waived", reason: "No run history and no baseline weekly volume: plan a minimal assessment week." };
  }

  const last7 = signals.running.last7DaysKm;
  const fourWeekAvg = signals.running.fourWeekAvgKm;
  const reference = Math.max(last7, fourWeekAvg);
  if (reference <= 0) {
    return {
      kind: "capped",
      referenceKm: 0,
      capKm: RUNNING_LIMITS.returningFromBreakCapKm,
      basis: `no runs in the last 4 weeks, so the return week is capped at ${RUNNING_LIMITS.returningFromBreakCapKm} km`
    };
  }
  return {
    kind: "capped",
    referenceKm: round1(reference),
    capKm: capFrom(reference),
    basis: `the larger of the last 7 days (${last7} km) and the 4-week average (${fourWeekAvg} km)`
  };
}

function capFrom(reference: number): number {
  return round1(Math.max(reference * (1 + RUNNING_LIMITS.weeklyJumpRatio), reference + RUNNING_LIMITS.weeklyMinimumStepKm));
}

function longRunLimit(context: CoachContext, signals: TrainingSignals | null): RunningGuardrails["longRun"] {
  const running = context.running;
  if (!running) return null;
  const recentLongest = Math.max(running.longestRecentRunKm || 0, signals?.running.longestRunLast6WeeksKm ?? 0);
  if (recentLongest <= 0) return null;
  return { recentLongestKm: round1(recentLongest), capKm: round1(recentLongest * RUNNING_LIMITS.longRunCapRatio) };
}

function backToBackLongRunsAllowed(context: CoachContext): boolean {
  const running = context.running;
  if (!running) return false;
  const { min, max } = RUNNING_LIMITS.backToBackWeeksToRace;
  return (
    running.raceGoal.distanceKm >= RUNNING_LIMITS.backToBackMinRaceKm &&
    running.weeksToRace >= min &&
    running.weeksToRace <= max
  );
}

function runFrequencyPolicy(context: CoachContext, availableDays: number, recentRunCount: number): RunFrequencyPolicy {
  const running = context.running!;
  if (availableDays <= 0) {
    return { minRuns: 0, maxRuns: 0, maxReason: "No future running days are available.", basis: "no running day left this week" };
  }

  const baselineWeeklyKm = running.baselineWeeklyKm || 0;
  const longestRecentRunKm = running.longestRecentRunKm || 0;
  const basis = `${recentRunCount} runs in the last 6 weeks, baseline ${round1(baselineWeeklyKm)} km/week, longest recent run ${round1(longestRecentRunKm)} km`;
  // Run counts only count runs inside the last 6 weeks: an old block of
  // runs before a long break is not an established base.
  const lowStartingBase = recentRunCount < 3 && baselineWeeklyKm <= 20 && longestRecentRunKm <= 8;
  const establishedBase = baselineWeeklyKm >= 35 || longestRecentRunKm >= 16 || recentRunCount >= 8;
  if (lowStartingBase) {
    const maxRuns = Math.min(availableDays, 3);
    return {
      minRuns: maxRuns,
      maxRuns,
      maxReason: `Starter running weeks should use at most ${maxRuns} runs so recovery days stay in the plan.`,
      basis: `starter base (${basis})`
    };
  }

  const minRuns = availableDays <= 2 ? availableDays : establishedBase && availableDays >= 4 ? 4 : 3;
  const maxRuns = Math.min(5, availableDays);
  return {
    minRuns,
    maxRuns,
    maxReason: `The combined plan needs one complete rest day; this context supports at most ${maxRuns} runs.`,
    basis: `${establishedBase ? "established" : "moderate"} base (${basis})`
  };
}

/**
 * The athlete's own easy pace and heart rate, from recent runs: runs the
 * athlete or the plan marked easy/recovery (or rated RPE 1-4), else the
 * slower half of recent flat, non-quality runs. Median-based so one odd run
 * does not move it.
 */
export function easyRunReference(runs: RunSummary[], anchorMs: number): EasyRunReference | null {
  const recent = runs.filter(
    (run) => withinDaysBefore(run, anchorMs, RUNNING_LIMITS.recentRunWindowDays) && run.distanceKm >= 3 && run.movingSeconds > 0
  );
  const labelled = recent.filter(
    (run) =>
      (typeof run.kind === "string" && EASY_RUN_KINDS.has(run.kind)) ||
      ((run.kind === undefined || run.kind === null || run.kind === "") && typeof run.rpe === "number" && run.rpe >= 1 && run.rpe <= 4)
  );

  let pool: RunSummary[];
  let method: EasyRunReference["method"];
  if (labelled.length >= 3) {
    pool = labelled;
    method = "labelled_easy_runs";
  } else {
    const flat = recent.filter(
      (run) => !(typeof run.kind === "string" && HARD_RUN_KINDS.has(run.kind)) && (run.elevationGainM || 0) / run.distanceKm <= 25
    );
    if (flat.length < 4) return null;
    const byPace = [...flat].sort((a, b) => pace(b) - pace(a));
    pool = byPace.slice(0, Math.ceil(byPace.length / 2));
    method = "slower_half_of_flat_runs";
  }

  const paces = pool.map(pace).filter((value) => value >= RUNNING_LIMITS.paceSecPerKm.min && value <= RUNNING_LIMITS.paceSecPerKm.max);
  const hrs = pool
    .map((run) => run.averageHr)
    .filter((value): value is number => typeof value === "number" && value >= RUNNING_LIMITS.hrBpm.min && value <= RUNNING_LIMITS.hrBpm.max);

  const medianPace = paces.length >= 3 ? Math.round(median(paces)) : null;
  const medianHr = hrs.length >= 3 ? Math.round(median(hrs)) : null;
  if (medianPace === null && medianHr === null) return null;

  return {
    paceSecPerKm:
      medianPace === null
        ? null
        : {
            low: clamp(roundTo5(medianPace - 15), RUNNING_LIMITS.paceSecPerKm.min, RUNNING_LIMITS.paceSecPerKm.max),
            high: clamp(roundTo5(medianPace + 20), RUNNING_LIMITS.paceSecPerKm.min, RUNNING_LIMITS.paceSecPerKm.max),
            median: medianPace
          },
    hrBpm:
      medianHr === null
        ? null
        : {
            low: clamp(medianHr - 8, RUNNING_LIMITS.hrBpm.min, RUNNING_LIMITS.hrBpm.max),
            high: clamp(medianHr + 4, RUNNING_LIMITS.hrBpm.min, RUNNING_LIMITS.hrBpm.max),
            median: medianHr
          },
    runsUsed: pool.length,
    method
  };
}

function pace(run: RunSummary): number {
  return run.movingSeconds / run.distanceKm;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function withinDaysBefore(run: RunSummary, anchorMs: number, days: number): boolean {
  const at = Date.parse(run.completedAt);
  return Number.isFinite(at) && at > anchorMs - days * DAY_MS && at <= anchorMs + DAY_MS;
}

function defaultAnchor(context: CoachContext): Date {
  const weekStart = Date.parse(context.profile.weekStart);
  return Number.isFinite(weekStart) ? new Date(weekStart) : new Date();
}

function daysFromWeekStart(context: CoachContext, date: string): number | null {
  const diff = Math.round((Date.parse(date) - Date.parse(context.profile.weekStart)) / DAY_MS);
  return Number.isFinite(diff) ? diff : null;
}

// Rounding the raw difference (same approach as weeksToRace) keeps the offset
// stable when local-midnight instants straddle UTC calendar days across a DST
// transition; truncating both to UTC days would be off by one in that case.
function raceOffset(context: CoachContext): number | null {
  const raceDate = context.running?.raceGoal.raceDate;
  if (!raceDate || !context.profile.weekStart) return null;
  const diffDays = daysFromWeekStart(context, raceDate);
  return diffDays !== null && diffDays >= 1 && diffDays <= 6 ? diffDays : null;
}

function roundTo5(value: number): number {
  return Math.round(value / 5) * 5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// The epsilon keeps 45 * 1.15 (51.749999...) at 51.8.
function round1(value: number): number {
  return Math.round(value * 10 + 1e-9) / 10;
}
