import { computeTrainingSignals, type TrainingSignals } from "./compute-training-signals";
import {
  phaseWeeklyCap,
  QUALITY_RUN_KINDS,
  qualityRunLimit,
  runningPhaseLimits,
  runRuleFor,
  type RunningPhaseLimits
} from "./running-phase-limits";
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
  /**
   * First week back after 4+ weeks without a run, and the floor of the cap
   * while there are fewer than 3 runs in the last 6 weeks (one short run
   * must not shrink the cap below what no runs at all would allow).
   */
  returningFromBreakCapKm: 20,
  sparseHistoryRunCount: 3,
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
  | "missing_run_history"
  | "profile_pain_note"
  | "planned_recovery_week";

/**
 * A computed reason that lowers the run-count floor. `floorOnly` reasons (a
 * profile pain note) allow fewer runs but never an all-easy build week.
 */
export type RunningRelaxation = { code: RunningRelaxationCode; detail: string; floorOnly?: boolean };

export type WeeklyVolumeLimit =
  /** `phase`: a recovery-week or race-window cap is the binding one. */
  | { kind: "capped"; referenceKm: number; capKm: number; basis: string; phase?: boolean }
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
  /** Recovery week and race window (taper, race week, post-race) rules. */
  phase: RunningPhaseLimits;
  /** Most tempo, interval and hill runs this window allows (recovery week, taper), or null. */
  qualityLimit: { max: number; reason: string } | null;
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

  const longRun = longRunLimit(context, signals);
  const fallbackWeeklyKm = signals && running && running.recentRuns.length > 0 ? signals.running.fourWeekAvgKm : running?.baselineWeeklyKm ?? null;
  const phase = runningPhaseLimits(context, longRun?.recentLongestKm ?? null, fallbackWeeklyKm);
  const weeklyVolume = withPhaseCap(weeklyVolumeLimit(context, signals, recentRunCountLast6Weeks), phase);
  const relaxations = computedRelaxations(context, anchorMs, raceDayOffset);
  if (phase.recoveryWeek) {
    relaxations.push({ code: "planned_recovery_week", detail: phase.recoveryWeek.reason });
  }
  return {
    anchor: now.toISOString(),
    relaxations,
    weeklyVolume,
    longRun,
    frequency: running
      ? feasibleFrequency(runFrequencyPolicy(context, availability.offsets.length, recentRunCountLast6Weeks), weeklyVolume)
      : null,
    availability,
    backToBackLongRunsAllowed: backToBackLongRunsAllowed(context),
    raceDayOffset,
    recentRunCountLast6Weeks,
    easyReference: running ? easyRunReference(running.recentRuns, anchorMs) : null,
    phase,
    qualityLimit: qualityRunLimit(phase)
  };
}

/** The lower of the normal cap and a recovery-week or race-window cap. */
function withPhaseCap(limit: WeeklyVolumeLimit, phase: RunningPhaseLimits): WeeklyVolumeLimit {
  const phaseCap = phaseWeeklyCap(phase);
  if (!phaseCap) return limit;
  if (limit.kind === "capped" && limit.capKm <= phaseCap.capKm) return limit;
  return {
    kind: "capped",
    referenceKm: limit.kind === "capped" ? limit.referenceKm : 0,
    capKm: phaseCap.capKm,
    basis: phaseCap.basis,
    phase: true
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
            rule: guardrails.weeklyVolume.phase
              ? "Sum of planned distances (race-day session excluded) must be at most capKm. Over the cap, the proxy shortens easy and recovery runs first, then the long run and the quality session."
              : "Sum of planned distances (race-day session excluded) must be at most capKm. Over the cap, the proxy shortens easy and recovery runs."
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
      "Only these computed reasons allow fewer runs than frequency.minRuns; all of them except floorOnly ones (a profile pain note) also allow an all-easy week. Safety flags never waive a limit.",
    raceDayOffset: guardrails.raceDayOffset,
    recentRunCountLast6Weeks: guardrails.recentRunCountLast6Weeks,
    easyReference: guardrails.easyReference,
    recoveryWeek: guardrails.phase.recoveryWeek
      ? {
          reason: guardrails.phase.recoveryWeek.reason,
          weeklyKmCap: guardrails.phase.recoveryWeek.weeklyKmCap,
          targetWeeklyKm: guardrails.phase.recoveryWeek.targetWeeklyKm,
          longRunCapKm: guardrails.phase.recoveryWeek.longRunCapKm,
          maxQualityRuns: guardrails.phase.recoveryWeek.maxQualityRuns,
          rule:
            "Planned recovery week: keep the run frequency, cut volume to targetWeeklyKm, shorten the long run to longRunCapKm or less, and keep intensity with at most one short quality session (or strides inside an easy run). Say in the summary that this is a planned recovery week and why."
        }
      : null,
    raceWindow: guardrails.phase.race
      ? {
          raceName: guardrails.phase.race.raceName,
          daysToRaceAtWeekStart: guardrails.phase.race.daysToRaceAtWeekStart,
          days: guardrails.phase.race.days.filter((day) => day.dayOffset >= 1),
          preTaperReferenceKm: guardrails.phase.race.referenceKm,
          weeklyKmCap: guardrails.phase.race.weeklyKmCap,
          longRunCapKm: guardrails.phase.race.longRunCapKm,
          normalEasyRunKm: guardrails.phase.race.normalEasyRunKm,
          raceWeekRunCapKm: guardrails.phase.race.shortRunCapKm,
          usualClimbMPerKm: guardrails.phase.race.usualElevationPerKm,
          rules: [
            "taper_3w (15-21 days out): weekly km at most 80% of the pre-taper average; long run at most longRunCapKm.taper_3w.",
            "taper_2w (8-14 days out): weekly km 50-70% of the pre-taper average; long run at most longRunCapKm.taper_2w; keep one short quality session (the last one at least 8 days out).",
            "race_week (1-7 days out): besides the race, only short easy runs or shakeouts of at most raceWeekRunCapKm each (50% of a normal easy run, max 8 km); strides inside an easy run are fine; no tempo, intervals, hills or long runs.",
            "Inside 10 days: no hill session and no new hill or downhill load (climbing at most 1.5x usualClimbMPerKm, never capped below 150 m).",
            "post_race_1w: easy or recovery runs only, short; post_race_2w: back to easy volume at most 70% of the pre-taper average.",
            "Days in one window can sit in different phases: each run follows the rule of its own day."
          ]
        }
      : null,
    qualityLimit: guardrails.qualityLimit,
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

  clampPhaseRules(sessions, guardrails, adjustments);

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
      // In a recovery week or the race window the cut is large, so the long
      // run and the quality session give up to 40% too once the easy runs
      // are at their floor.
      const others = guardrails.weeklyVolume.phase
        ? counted.filter((session) => !EASY_RUN_KINDS.has(session.kind) && session.distanceKm > 0)
        : [];
      const otherReducible = others.reduce((sum, session) => sum + (session.distanceKm - phaseFloor(session.distanceKm)), 0);
      if (reducible + otherReducible >= excess) {
        const fromEasy = Math.min(excess, reducible);
        shortenProportionally(easy, fromEasy, reducible, easyFloor, "Shortened to keep this week inside the weekly volume cap.");
        const rest = counted.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0) - cap;
        if (rest > 0.05 && otherReducible > 0) {
          shortenProportionally(others, Math.min(rest, otherReducible), otherReducible, phaseFloor, "Shortened to keep this lighter week inside its volume cap.");
        }
        const after = counted.reduce((sum, session) => sum + Math.max(0, session.distanceKm), 0);
        adjustments.push(
          `Weekly volume ${round1(total)} km was above the ${cap} km cap; ${others.length > 0 && rest > 0.05 ? "easy runs, then the long run and quality session," : "easy and recovery runs"} were shortened to ${round1(after)} km total.`
        );
      }
    }
  }

  return { week: { ...week, sessions }, adjustments };
}

/**
 * Recovery-week and race-window fixes: runs whose day allows only easy
 * running (race week, the first week after the race), hill sessions inside
 * 10 days, and quality sessions beyond the window's limit become easy runs;
 * runs over their day's distance cap are shortened and climbing inside 10
 * days is lowered to the athlete's usual terrain.
 */
function clampPhaseRules(sessions: RunningWeek["sessions"], guardrails: RunningGuardrails, adjustments: string[]) {
  const phase = guardrails.phase;
  if (!phase.recoveryWeek && !phase.race) return;

  sessions.forEach((session, index) => {
    const rule = runRuleFor(session, phase);
    if (rule.allowedKinds && !rule.allowedKinds.has(session.kind) && rule.kindReason) {
      const before = `${session.kind}`;
      const title = session.title;
      convertToEasy(session, rule.kindReason, rule.phase === "race_week", guardrails.easyReference);
      adjustments.push(`Run ${index + 1} (${title}): ${before} changed to an easy run (${rule.kindReason}).`);
    }
  });

  const limit = guardrails.qualityLimit;
  if (limit) {
    let kept = 0;
    sessions.forEach((session, index) => {
      if (!QUALITY_RUN_KINDS.has(session.kind) || isRaceDaySession(session, guardrails)) return;
      kept += 1;
      if (kept <= limit.max) return;
      const before = session.kind;
      const title = session.title;
      convertToEasy(session, limit.reason, false, guardrails.easyReference);
      adjustments.push(`Run ${index + 1} (${title}): ${before} changed to an easy run (${limit.reason}).`);
    });
  }

  sessions.forEach((session, index) => {
    const rule = runRuleFor(session, phase);
    if (rule.maxKm !== null && session.distanceKm > rule.maxKm + 0.05) {
      const before = session.distanceKm;
      scaleSession(session, floorHalf(rule.maxKm));
      session.notes.push(`Shortened to ${session.distanceKm} km: ${rule.maxKmReason}.`);
      adjustments.push(`Run ${index + 1} (${session.title}): shortened from ${before} km to ${session.distanceKm} km (${rule.maxKmReason}, cap ${rule.maxKm} km).`);
    }
    if (rule.maxElevationM !== null && session.elevationMeters > rule.maxElevationM) {
      const before = session.elevationMeters;
      session.elevationMeters = rule.maxElevationM;
      session.notes.push(`Pick a route with about ${rule.maxElevationM} m of climbing at most: ${rule.elevationReason}.`);
      adjustments.push(`Run ${index + 1} (${session.title}): climbing lowered from ${before} m to ${rule.maxElevationM} m (${rule.elevationReason}).`);
    }
  });
}

function convertToEasy(session: RunningWeek["sessions"][number], reason: string, shakeout: boolean, reference: EasyRunReference | null) {
  session.kind = "easy";
  session.title = shakeout ? "Easy shakeout run" : "Easy run";
  session.purpose = `Easy aerobic running: ${reason}.`;
  session.zone = "Zone 2";
  const target = referenceTarget(session, reference) ?? noTarget();
  session.target = target;
  if (target.type === "pace" && session.distanceKm > 0) {
    session.durationMinutes = Math.round((session.distanceKm * (target.low + target.high)) / 2 / 60);
  }
  session.notes.push(`Changed to an easy run: ${reason}.`);
}

function shortenProportionally(
  sessions: RunningWeek["sessions"],
  amount: number,
  reducible: number,
  floorOf: (distanceKm: number) => number,
  note: string
) {
  if (amount <= 0 || reducible <= 0) return;
  const share = Math.min(1, amount / reducible);
  for (const session of sessions) {
    const floor = floorOf(session.distanceKm);
    const target = session.distanceKm - (session.distanceKm - floor) * share;
    const next = Math.max(floor, floorHalf(target));
    if (next < session.distanceKm) {
      scaleSession(session, next);
      session.notes.push(note);
    }
  }
}

function phaseFloor(distanceKm: number): number {
  return Math.min(distanceKm, distanceKm * 0.6);
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

    if (hasProfilePainNote(context.profile.profileNotes)) {
      relaxations.push({
        code: "profile_pain_note",
        detail: "The athlete's profile notes mention pain or an injury: fewer runs than the floor are fine; the caps and the quality-session rule stay.",
        floorOnly: true
      });
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

/**
 * The athlete's own pain or injury note. The app appends a session-length
 * sentence to the profile notes; that alone is not a pain note.
 */
export function hasProfilePainNote(profileNotes: string | undefined): boolean {
  const withoutSessionCap = (profileNotes ?? "").replace(/Keep each strength session within \d+ minutes\.?/gi, "");
  return withoutSessionCap.trim().length > 0;
}

/**
 * Keeps the run-count floor reachable under the weekly cap: minRuns easy
 * runs of the minimum length must fit, else the floor drops to what fits.
 */
function feasibleFrequency(policy: RunFrequencyPolicy, weeklyVolume: WeeklyVolumeLimit): RunFrequencyPolicy {
  if (weeklyVolume.kind !== "capped") return policy;
  const fits = Math.floor((weeklyVolume.capKm + 1e-9) / RUNNING_LIMITS.easyRunMinimumKm);
  if (policy.minRuns <= fits) return policy;
  const minRuns = Math.max(0, fits);
  return {
    ...policy,
    minRuns,
    basis: `${policy.basis}; at most ${minRuns} runs of ${RUNNING_LIMITS.easyRunMinimumKm} km fit the ${weeklyVolume.capKm} km cap`
  };
}

function weeklyVolumeLimit(context: CoachContext, signals: TrainingSignals | null, recentRunCount: number): WeeklyVolumeLimit {
  const running = context.running;
  if (!running) return { kind: "waived", reason: "No running context." };
  const baseline = running.baselineWeeklyKm || 0;
  const returnCap = RUNNING_LIMITS.returningFromBreakCapKm;
  const sparse = recentRunCount < RUNNING_LIMITS.sparseHistoryRunCount;

  if (running.recentRuns.length === 0 || !signals) {
    if (baseline > 0) {
      const cap = capFrom(baseline);
      return {
        kind: "capped",
        referenceKm: round1(baseline),
        capKm: Math.max(cap, returnCap),
        basis: `the athlete's baseline of ${round1(baseline)} km/week (no run history was sent)${cap < returnCap ? `, raised to the ${returnCap} km return cap` : ""}`
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
  const cap = capFrom(reference);
  if (sparse && cap < returnCap) {
    return {
      kind: "capped",
      referenceKm: round1(reference),
      capKm: returnCap,
      basis: `only ${recentRunCount} run(s) in the last 6 weeks, so the ${returnCap} km return cap applies instead of 15% above ${round1(reference)} km`
    };
  }
  return {
    kind: "capped",
    referenceKm: round1(reference),
    capKm: cap,
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
