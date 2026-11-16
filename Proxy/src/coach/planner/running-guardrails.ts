import { computeTrainingSignals, isRaceRun, type TrainingSignals } from "./compute-training-signals";
import { plural, round1 } from "./numbers";
import {
  HARD_RUN_KINDS,
  phaseWeeklyCap,
  QUALITY_RUN_KINDS,
  qualityRunLimit,
  runningPhaseLimits,
  runRuleFor,
  type RunningPhaseLimits
} from "./running-phase-limits";
import {
  HARD_EFFORT_KINDS,
  isStarterBase,
  loadBeforeToday,
  QUALITY_FLOOR_KINDS,
  RUNNING_FLOOR_LIMITS,
  runningFloors,
  todayCountsAsRun,
  todayHardKind,
  todayRun,
  type RunningFloors,
  type TodayRun
} from "./running-floors";
import { RUNNING_LIMITS } from "./running-limits";
import { daysBetween, postRaceDaysFor, SEASON_LIMITS } from "./season";
import type { CoachContext, RunningWeek, RunSummary, RunTarget } from "./types";
import { wellnessGate, WELLNESS_GATE_LIMITS } from "./wellness-gate";

export { RUNNING_FLOOR_LIMITS, type RunningFloors, type TodayRun } from "./running-floors";
export { HARD_RUN_KINDS } from "./running-phase-limits";
export { RUNNING_LIMITS } from "./running-limits";

/**
 * Computed running limits. The planner prompt, the clamp step and the
 * validator all read these, so the model is told exactly what is enforced.
 * Only computed facts relax a limit (a computed recovery need, race or taper
 * window, a planned recovery week, a recent distressed run, missing run
 * history); readiness overreaching does not: it comes from strength logs
 * only (effort flags, goal results below plan) and stays on the strength side;
 * a model-written safety flag and the free-text profile note never do (the
 * note is planner context; logged pain lowers the plan through readiness).
 * A tripped wellness gate is not a relaxation: it keeps quality runs out of
 * the next 48 hours, and the quality floor yields only when no later day is
 * left for the quality run.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const EASY_RUN_KINDS: ReadonlySet<string> = new Set(["easy", "recovery"]);
const ALL_FUTURE_OFFSETS = [1, 2, 3, 4, 5, 6];
const POST_RACE = SEASON_LIMITS.postRace;

export type RunningRelaxationCode =
  | "readiness_recovery_needed"
  | "race_this_week"
  | "taper_window"
  | "post_race_recovery"
  | "recent_run_distress"
  | "missing_run_history"
  | "planned_recovery_week";

/** Each computed reason in plain words: the planner names it, and the repair messages list them. */
export const RELAXATION_LABELS: Record<RunningRelaxationCode, string> = {
  readiness_recovery_needed: "readiness (recovery needed)",
  race_this_week: "the race this week",
  taper_window: "the taper",
  post_race_recovery: "the post-race window",
  planned_recovery_week: "a planned recovery week",
  recent_run_distress: "a recent run rated feel 1-2",
  missing_run_history: "missing run history"
};

/**
 * A computed reason that lifts the week's floors: the run-count floor, the
 * quality-run floor and the weekly-km floor. A tripped wellness gate is not
 * one of them (`RunningGuardrails.wellnessGate`), and free text (the profile
 * note) never is.
 */
export type RunningRelaxation = { code: RunningRelaxationCode; label: string; detail: string };

function relaxation(code: RunningRelaxationCode, detail: string): RunningRelaxation {
  return { code, label: RELAXATION_LABELS[code], detail };
}

export type WeeklyVolumeLimit =
  /**
   * `phase`: a recovery-week or race-window cap is the binding one.
   * `returnWeek`: the first week back after 4+ weeks without runs.
   */
  | { kind: "capped"; referenceKm: number; capKm: number; basis: string; phase?: boolean; returnWeek?: boolean }
  | { kind: "waived"; reason: string };

export type EasyRunReference = {
  /** Seconds per km; low is the faster bound. */
  paceSecPerKm: { low: number; high: number; median: number } | null;
  hrBpm: { low: number; high: number; median: number } | null;
  runsUsed: number;
  method: "labelled_easy_runs" | "slower_half_of_flat_runs";
};

/**
 * The long-run cap: 1.15x `referenceKm`, the longest training run of the last
 * 30 days, else of the last 42 days (races left out). With run history but no
 * training run in 42 days the cap is the return-week cap (`referenceKm`
 * null); with no runs on record, 1.15x the app's recent longest run. A race
 * is demonstrated capacity: text only, never a reference.
 */
export type LongRunLimit = { referenceKm: number | null; capKm: number; basis: string; demonstratedCapacity: string | null };

export type RunFrequencyPolicy = { minRuns: number; maxRuns: number; maxReason: string; basis: string };

export type RunningGuardrails = {
  anchor: string;
  relaxations: RunningRelaxation[];
  weeklyVolume: WeeklyVolumeLimit;
  longRun: LongRunLimit | null;
  /** Weekly climbing cap; null without run history (no climbing reference). */
  weeklyClimb: { fourWeekAvgM: number; capM: number; basis: string } | null;
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
  /**
   * A tripped wellness gate: no tempo, interval or hill run on these offsets
   * (the next 48 hours). It lifts no floor; the week's quality run goes on a
   * later day. `detail` names the signal (a continuity change signal too).
   */
  wellnessGate: { offsets: number[]; reason: string; detail: string } | null;
  /**
   * Today's run (offset 0, locked): the runs done today, else the runs the
   * current plan has for today. The floors count it: the plan covers offsets
   * 1-6 while the floors are weekly.
   */
  today: TodayRun | null;
  floors: RunningFloors;
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

  // The taper and recovery-week long-run ratios read the longest training run
  // of the last 6 weeks (races left out).
  const recentLongest = recentLongestTrainingRunKm(context, anchorMs);
  const longRun = longRunLimit(context, anchorMs);
  const fallbackWeeklyKm = signals && running && running.recentRuns.length > 0 ? signals.running.fourWeekAvgKm : running?.baselineWeeklyKm ?? null;
  const phase = runningPhaseLimits(context, recentLongest > 0 ? round1(recentLongest) : null, fallbackWeeklyKm);
  const weeklyVolume = withPhaseCap(weeklyVolumeLimit(context, recentRunCountLast6Weeks), phase);
  const gate = wellnessGate(context.garmin?.wellness ?? [], context.profile.weekStart);
  const gateLimits = gate
    ? { offsets: gate.offsets, reason: `${gate.why} ${gate.reasons.length > 1 ? "keep" : "keeps"} the next ${WELLNESS_GATE_LIMITS.gateHours} hours easy`, detail: gate.reasons.join(" ") }
    : null;
  const relaxations = computedRelaxations(context, anchorMs, raceDayOffset);
  if (phase.recoveryWeek) {
    relaxations.push(relaxation("planned_recovery_week", phase.recoveryWeek.reason));
  }
  const today = todayRun(context);
  const frequency = running
    ? feasibleFrequency(runFrequencyPolicy(context, availability.offsets.length, recentRunCountLast6Weeks), weeklyVolume, today)
    : null;
  return {
    anchor: now.toISOString(),
    relaxations,
    weeklyVolume,
    longRun,
    weeklyClimb: weeklyClimbLimit(context),
    frequency,
    availability,
    backToBackLongRunsAllowed: backToBackLongRunsAllowed(context),
    raceDayOffset,
    recentRunCountLast6Weeks,
    easyReference: running ? easyRunReference(running.recentRuns, anchorMs) : null,
    phase,
    qualityLimit: qualityRunLimit(phase),
    wellnessGate: gateLimits,
    today,
    floors: runningFloors(context, { relaxations, weeklyVolume, phase, availability, frequency, longRun, wellnessGate: gateLimits, today, recentRunCount: recentRunCountLast6Weeks })
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
    phase: true,
    ...(limit.kind === "capped" && limit.returnWeek ? { returnWeek: true } : {})
  };
}

/** Planner-facing view of the guardrails (plain JSON, no functions). */
export function runningGuardrailsForPrompt(guardrails: RunningGuardrails): Record<string, unknown> {
  const { longRunCapRatio, longRunWindowDays, recentRunWindowDays, returningFromBreakCapKm } = RUNNING_LIMITS;
  const gateHours = WELLNESS_GATE_LIMITS.gateHours;
  const labels = Object.values(RELAXATION_LABELS);
  return {
    weeklyVolume:
      guardrails.weeklyVolume.kind === "capped"
        ? {
            referenceKm: guardrails.weeklyVolume.referenceKm,
            capKm: guardrails.weeklyVolume.capKm,
            basis: guardrails.weeklyVolume.basis,
            rule: guardrails.weeklyVolume.phase
              ? "Today's run (floors.todayRun, locked) plus the sum of planned distances (race-day session excluded) must be at most capKm: the cap covers the same 7 days as the floors. Over the cap, the proxy shortens easy and recovery runs first, then the long run and the quality session."
              : "Today's run (floors.todayRun, locked) plus the sum of planned distances (race-day session excluded) must be at most capKm: the cap covers the same 7 days as the floors. Over the cap, the proxy shortens easy and recovery runs."
          }
        : { waived: true, reason: guardrails.weeklyVolume.reason },
    longRun: guardrails.longRun
      ? {
          referenceKm: guardrails.longRun.referenceKm,
          basis: guardrails.longRun.basis,
          capKm: guardrails.longRun.capKm,
          demonstratedCapacity: guardrails.longRun.demonstratedCapacity,
          rule: `No run except the race itself may exceed capKm: ${longRunCapRatio}x the longest training run of the last ${longRunWindowDays} days (races left out; with none in ${longRunWindowDays} days, of the last ${recentRunWindowDays} days; with none in ${recentRunWindowDays} days, the ${returningFromBreakCapKm} km return-week cap; with no runs on record, ${longRunCapRatio}x the athlete's recent longest run). A race is demonstrated capacity, never the long-run reference.`
        }
      : null,
    weeklyClimb: guardrails.weeklyClimb
      ? {
          fourWeekAvgM: guardrails.weeklyClimb.fourWeekAvgM,
          capM: guardrails.weeklyClimb.capM,
          basis: guardrails.weeklyClimb.basis,
          rule: "Today's climbing (floors.todayRun.elevationM, locked) plus the sum of planned elevationMeters (race-day session excluded) must be at most capM: the cap covers the same 7 days as the floors, and its 4-week average ends at local midnight. Over the cap, the proxy takes the climbing off the easy and recovery runs first, then the long run, and the hill and quality runs last."
        }
      : null,
    frequency: guardrails.frequency
      ? { minRuns: guardrails.frequency.minRuns, maxRuns: guardrails.frequency.maxRuns, basis: guardrails.frequency.basis }
      : null,
    hardRuns: {
      maxHardRuns: { "1-2 runs": "all", "3-4 runs": 2, "5 or more runs": 3 },
      counted: `Over the 7 days: today's run (floors.todayRun, locked) is one of the runs from ${RUNNING_LIMITS.easyRunMinimumKm} km, and then a hard run when it is long, tempo, intervals, hills or a race.`,
      backToBackLongRunsCountAsOne: guardrails.backToBackLongRunsAllowed,
      hardKinds: [...HARD_RUN_KINDS],
      consecutiveDays: guardrails.backToBackLongRunsAllowed
        ? "Never two hard runs on consecutive days, today's run included (after a hard run today, offset 1 is no hard run), except two long runs back to back (allowed for this race and phase)."
        : "Never two hard runs on consecutive days, today's run included: after a hard run today, offset 1 is no hard run."
    },
    floors: {
      qualityRun: guardrails.floors.qualityRun,
      weeklyKm: guardrails.floors.weeklyKm,
      todayRun: guardrails.today,
      rule: `Enforced with ${RUNNING_FLOOR_LIMITS.minRuns} or more runs planned, over the 7 days of today's run (todayRun, locked: done or planned) plus the planned runs: when qualityRun.required is true, at least one tempo, interval or hill run (the long run does not count; a quality run or a race today already counts, a race being the quality stimulus of its week); when weeklyKm.minKm is a number, todayRun.distanceKm plus the planned km (race-day session excluded) at least minKm (weeklyKm.reason gives its numbers). Each reason says why the floor applies or is lifted.`
    },
    computedRelaxations: guardrails.relaxations,
    computedRelaxationRule: `These computed reasons (computedRelaxations) allow fewer runs than frequency.minRuns and lift the quality-run and weekly-km floors: ${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}. The floors also lift on their own, and floors.*.reason says so: both in the taper and the post-race transition, for a starter base and in the first week back after 4+ weeks without runs; the quality run when no running day is left away from the long run, the day after a hard run today and a wellness gate's next ${gateHours} hours; the weekly km when the race window reaches into the week or the free days cannot hold it under the long-run cap. Nothing else lifts a floor: a wellness gate (wellnessGate) only as above, and never a safety flag or the profile note (coachContext.profile.profileNotes), which shapes which runs you choose within the limits; logged pain lowers the plan through readiness.`,
    wellnessGate: guardrails.wellnessGate
      ? {
          dayOffsets: guardrails.wellnessGate.offsets,
          reason: guardrails.wellnessGate.reason,
          rule: `No tempo, interval or hill run on these day offsets (the next ${gateHours} hours); the proxy turns one there into an easy run. The gate lifts no floor: the run count, the weekly km and the quality run stay, so put the quality run on a later day that is not next to the long run (floors.qualityRun says when no such day is left).`
        }
      : null,
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
          postRaceDays: guardrails.phase.race.postRaceDays,
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
            `post_race_1w (days 1-7 after the race): easy or recovery runs only, short; post_race_2w (day 8 to day postRaceDays after the race): easy runs (strides inside them are fine), recovery runs and an easy long run only, no tempo, intervals or hills; weekly km at most 70% of the pre-taper average. postRaceDays grows with the race distance (one day per ${POST_RACE.kmPerDay} km, ${POST_RACE.minDays}-${POST_RACE.maxDays} days).`,
            "normal: outside the race window; the normal weekly and long-run caps apply. This is a day value, not the season phase (coachContext.season.phase).",
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
 * Hard runs as counted against maxHardRunsFor, over the 7 days: a hard run
 * today (locked, a race included) counts when today's run counts as a run.
 * Runs are read by their day, in any order. When back-to-back long runs are
 * allowed, a long run on the day after another long run belongs to the same
 * long-run block and is not counted a second time.
 */
export function countedHardRuns(week: RunningWeek, guardrails: RunningGuardrails): number {
  const todayHard = todayCountsAsRun(guardrails.today) ? todayHardKind(guardrails.today) : null;
  const runs: Array<{ dayOffset: number; kind: string; today: boolean }> = [
    ...(todayHard ? [{ dayOffset: 0, kind: todayHard, today: true }] : []),
    ...week.sessions.map((session) => ({ dayOffset: session.dayOffset, kind: session.kind, today: false }))
  ];
  return runs.filter((entry) => {
    // Today's entry is only there for a hard run; a planned run is hard by its kind.
    if (!entry.today && !HARD_EFFORT_KINDS.has(entry.kind)) return false;
    const dayBefore = runs.find((other) => other.dayOffset === entry.dayOffset - 1);
    return !(guardrails.backToBackLongRunsAllowed && entry.kind === "long" && dayBefore?.kind === "long");
  }).length;
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
  clampWellnessGate(sessions, guardrails, adjustments);

  if (guardrails.longRun) {
    const { capKm: cap, referenceKm, basis } = guardrails.longRun;
    sessions.forEach((session, index) => {
      if (isRaceDaySession(session, guardrails) || session.distanceKm <= cap) return;
      const before = session.distanceKm;
      scaleSession(session, floorHalf(cap));
      session.notes.push(
        referenceKm === null
          ? `Shortened to ${session.distanceKm} km: with no training run in the last ${RUNNING_LIMITS.recentRunWindowDays} days, one run stays within the ${cap} km return-week cap.`
          : `Shortened to ${session.distanceKm} km: one run goes at most ${Math.round((RUNNING_LIMITS.longRunCapRatio - 1) * 100)}% past ${basis} (${referenceKm} km).`
      );
      adjustments.push(
        `Run ${index + 1} (${session.title}): shortened from ${before} km to ${session.distanceKm} km (long-run cap ${cap} km).`
      );
    });
  }

  if (guardrails.weeklyVolume.kind === "capped") {
    // The cap covers the 7 days: today's run (locked) uses part of it.
    const todayKm = guardrails.today?.distanceKm ?? 0;
    const cap = kmLeftAfterToday(guardrails.weeklyVolume, guardrails.today);
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
        const capText = todayKm > 0 ? `${cap} km left after today's ${todayKm} km run (cap ${guardrails.weeklyVolume.capKm} km)` : `${cap} km cap`;
        adjustments.push(
          `Weekly volume ${round1(total)} km was above the ${capText}; ${others.length > 0 && rest > 0.05 ? "easy runs, then the long run and quality session," : "easy and recovery runs"} were shortened to ${round1(after)} km total.`
        );
      }
    }
  }

  clampWeeklyClimb(sessions, guardrails, adjustments);

  return { week: { ...week, sessions }, adjustments };
}

/**
 * The order in which runs give up climbing over the weekly cap: easy and
 * recovery runs first, then the long run, the quality and hill runs last (a
 * hill session's climbs are its stimulus).
 */
const CLIMB_CUT_ORDER: ReadonlyArray<{ label: string; holds: (kind: string) => boolean }> = [
  { label: "the easy and recovery runs", holds: (kind) => kind !== "long" && !QUALITY_FLOOR_KINDS.has(kind) },
  { label: "the long run", holds: (kind) => kind === "long" },
  { label: "the hill and quality runs", holds: (kind) => QUALITY_FLOOR_KINDS.has(kind) }
];

/**
 * Over the weekly climbing cap the climbing comes off the runs in
 * CLIMB_CUT_ORDER (race day excluded): each group is lowered in proportion,
 * down to flat, before the next one gives way. The cap covers the 7 days:
 * today's climbing (locked) uses part of it.
 */
function clampWeeklyClimb(sessions: RunningWeek["sessions"], guardrails: RunningGuardrails, adjustments: string[]) {
  if (!guardrails.weeklyClimb) return;
  const cap = guardrails.weeklyClimb.capM;
  const todayM = guardrails.today?.elevationM ?? 0;
  const budget = Math.max(0, cap - todayM);
  const counted = sessions.filter((session) => !isRaceDaySession(session, guardrails));
  const total = countedClimb(counted);
  if (total <= budget) return;
  const lowered: string[] = [];
  for (const group of CLIMB_CUT_ORDER) {
    const excess = countedClimb(counted) - budget;
    if (excess <= 0) break;
    const runs = counted.filter((session) => group.holds(session.kind) && session.elevationMeters > 0);
    const groupM = runs.reduce((sum, session) => sum + session.elevationMeters, 0);
    if (groupM <= 0) continue;
    const ratio = Math.max(0, groupM - excess) / groupM;
    for (const session of runs) {
      const next = Math.floor(session.elevationMeters * ratio + 1e-9);
      if (next >= session.elevationMeters) continue;
      session.elevationMeters = next;
      session.notes.push(
        next === 0
          ? todayM >= cap
            ? `Pick a flat route: today's ${todayM} m of climbing already reaches this week's ${cap} m.`
            : `Pick a flat route: the week's climbing stays at or below ${cap} m${todayM > 0 ? `, today's ${todayM} m included` : ""}, and the harder runs keep theirs.`
          : `Pick a route with about ${next} m of climbing: the week's climbing stays at or below ${cap} m${todayM > 0 ? `, today's ${todayM} m included` : ""}.`
      );
    }
    lowered.push(group.label);
  }
  const capText = todayM > 0 ? `${budget} m left after today's ${todayM} m (cap ${cap} m)` : `${cap} m cap`;
  const quality = CLIMB_CUT_ORDER[2];
  const keepsQuality = !lowered.includes(quality.label) && counted.some((session) => quality.holds(session.kind) && session.elevationMeters > 0);
  const order = lowered.length > 1 ? `${lowered.slice(0, -1).join(", ")} first, then ${lowered.at(-1)}` : lowered[0];
  adjustments.push(
    `Weekly climbing ${total} m was above the ${capText}; the climbing came off ${order}${keepsQuality ? `, so ${quality.label} keep theirs` : ""}: ${countedClimb(counted)} m total.`
  );
}

/** Planned climbing in meters, race-day session excluded. */
export function countedWeeklyClimb(week: RunningWeek, guardrails: RunningGuardrails): number {
  return countedClimb(week.sessions.filter((session) => !isRaceDaySession(session, guardrails)));
}

function countedClimb(sessions: RunningWeek["sessions"]): number {
  return Math.round(sessions.reduce((sum, session) => sum + Math.max(0, session.elevationMeters), 0));
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

/** A tripped wellness gate: tempo, interval and hill runs in the next 48 hours become easy runs. */
function clampWellnessGate(sessions: RunningWeek["sessions"], guardrails: RunningGuardrails, adjustments: string[]) {
  const gate = guardrails.wellnessGate;
  if (!gate) return;
  sessions.forEach((session, index) => {
    if (!QUALITY_RUN_KINDS.has(session.kind) || !gate.offsets.includes(session.dayOffset)) return;
    const before = session.kind;
    const title = session.title;
    convertToEasy(session, gate.reason, false, guardrails.easyReference);
    adjustments.push(`Run ${index + 1} (${title}): ${before} changed to an easy run (${gate.reason}).`);
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
  // Logged pain or very weak feedback is whole-body. Overreaching is computed
  // from strength logs only, so it eases the strength week, not the runs.
  if (context.readiness.state === "recovery_needed") {
    relaxations.push(relaxation("readiness_recovery_needed", "Computed readiness is recovery needed (logged pain of 4 or more, or very weak feedback)."));
  }

  const running = context.running;
  if (running) {
    const daysToRace = daysFromWeekStart(context, running.raceGoal.raceDate);
    if (raceDayOffset !== null) {
      relaxations.push(relaxation("race_this_week", `The race is on day offset ${raceDayOffset}.`));
    } else if (daysToRace === 0) {
      // Race day: the rest of the rolling week is the first week after the race.
      relaxations.push(relaxation("race_this_week", "The race is today."));
    } else if (running.weeksToRace >= 1 && running.weeksToRace <= 3) {
      relaxations.push(relaxation("taper_window", `${plural(running.weeksToRace, "week")} to the race: taper window.`));
    }

    if (daysToRace !== null && daysToRace < 0 && daysToRace >= -postRaceDaysFor(running.raceGoal.distanceKm)) {
      relaxations.push(relaxation("post_race_recovery", `The race was ${plural(-daysToRace, "day")} ago.`));
    }

    const distressed = running.recentRuns
      .filter((run) => withinDaysBefore(run, anchorMs, 7))
      .filter((run) => typeof run.feelScore === "number" && run.feelScore >= 1 && run.feelScore <= 2);
    if (distressed.length > 0) {
      const latest = distressed[distressed.length - 1];
      relaxations.push(relaxation("recent_run_distress", `A run on ${latest.completedAt.slice(0, 10)} was rated ${latest.feelScore}/5 for feel.`));
    }

    if (running.recentRuns.length === 0 && (running.baselineWeeklyKm || 0) <= 0) {
      relaxations.push(relaxation("missing_run_history", "No run history and no baseline weekly volume."));
    }
  }

  return relaxations;
}


/**
 * Keeps the run-count floor reachable under the weekly cap: minRuns easy
 * runs of the minimum length must fit the budget today's run leaves, else
 * the floor drops to what fits.
 */
function feasibleFrequency(policy: RunFrequencyPolicy, weeklyVolume: WeeklyVolumeLimit, today: TodayRun | null): RunFrequencyPolicy {
  if (weeklyVolume.kind !== "capped") return policy;
  const budget = kmLeftAfterToday(weeklyVolume, today);
  const todayKm = today?.distanceKm ?? 0;
  const fits = Math.max(0, Math.floor((budget + 1e-9) / RUNNING_LIMITS.easyRunMinimumKm));
  if (policy.minRuns <= fits) return policy;
  const minRuns = fits;
  const where = todayKm > 0 ? `the ${round1(budget)} km left of the ${weeklyVolume.capKm} km cap after today's ${todayKm} km run` : `the ${weeklyVolume.capKm} km cap`;
  return {
    ...policy,
    minRuns,
    basis: `${policy.basis}; at most ${minRuns} runs of ${RUNNING_LIMITS.easyRunMinimumKm} km fit ${where}`
  };
}

/** The weekly cap left for offsets 1-6 after today's run (locked), never below 0; null without a cap. */
export function weeklyBudgetAfterToday(guardrails: RunningGuardrails): number | null {
  return guardrails.weeklyVolume.kind === "capped" ? kmLeftAfterToday(guardrails.weeklyVolume, guardrails.today) : null;
}

/** The one computation of the km a capped week leaves after today's run (never below 0): the clamp, the run-count floor, the validator and continuity read it. */
export function kmLeftAfterToday(weeklyVolume: Extract<WeeklyVolumeLimit, { kind: "capped" }>, today: TodayRun | null): number {
  return Math.max(0, round1(weeklyVolume.capKm - (today?.distanceKm ?? 0)));
}

function weeklyVolumeLimit(context: CoachContext, recentRunCount: number): WeeklyVolumeLimit {
  const running = context.running;
  if (!running) return { kind: "waived", reason: "No running context." };
  const baseline = running.baselineWeeklyKm || 0;
  const returnCap = RUNNING_LIMITS.returningFromBreakCapKm;
  const sparse = recentRunCount < RUNNING_LIMITS.sparseHistoryRunCount;

  if (running.recentRuns.length === 0) {
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

  // Anchored at local midnight like the floor: today's run counts against
  // the 7-day budget, so it must not also raise the cap in a daytime re-plan.
  const { last7Km, fourWeekAvgKm } = loadBeforeToday(context, { racesIncluded: true });
  const last7 = round1(last7Km);
  const fourWeekAvg = round1(fourWeekAvgKm);
  const reference = Math.max(last7, fourWeekAvg);
  if (reference <= 0) {
    return {
      kind: "capped",
      referenceKm: 0,
      capKm: RUNNING_LIMITS.returningFromBreakCapKm,
      basis: `no runs in the last 4 weeks, so the return week is capped at ${RUNNING_LIMITS.returningFromBreakCapKm} km`,
      returnWeek: true
    };
  }
  const cap = capFrom(reference);
  if (sparse && cap < returnCap) {
    return {
      kind: "capped",
      referenceKm: round1(reference),
      capKm: returnCap,
      basis: `only ${plural(recentRunCount, "run")} in the last ${RUNNING_LIMITS.recentRunWindowDays / 7} weeks, so the ${returnCap} km return cap applies instead of ${Math.round(RUNNING_LIMITS.weeklyJumpRatio * 100)}% above ${round1(reference)} km`
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

/**
 * The longest training run of the last 6 weeks, races left out: a race is
 * demonstrated capacity, never a long-run reference. With no runs on record,
 * the app's recent longest run (it cannot be a logged race).
 */
function recentLongestTrainingRunKm(context: CoachContext, anchorMs: number): number {
  const running = context.running;
  if (!running) return 0;
  if (running.recentRuns.length === 0) return running.longestRecentRunKm || 0;
  return Math.max(
    0,
    ...running.recentRuns
      .filter((run) => withinDaysBefore(run, anchorMs, RUNNING_LIMITS.recentRunWindowDays) && !isRaceRun(run, running.raceGoal.raceDate))
      .map((run) => run.distanceKm)
  );
}

function longRunLimit(context: CoachContext, anchorMs: number): LongRunLimit | null {
  const running = context.running;
  if (!running) return null;
  const raceDate = running.raceGoal.raceDate;
  const { longRunWindowDays, recentRunWindowDays, longRunCapRatio, returningFromBreakCapKm } = RUNNING_LIMITS;
  const within = (days: number) => running.recentRuns.filter((run) => withinDaysBefore(run, anchorMs, days) && run.distanceKm > 0);
  const longestTraining = (runs: RunSummary[]) => Math.max(0, ...runs.filter((run) => !isRaceRun(run, raceDate)).map((run) => run.distanceKm));
  const recent = within(recentRunWindowDays);
  const longestRace = recent
    .filter((run) => isRaceRun(run, raceDate))
    .reduce<RunSummary | null>((longest, run) => (!longest || run.distanceKm > longest.distanceKm ? run : longest), null);
  const demonstratedCapacity = longestRace
    ? `A ${round1(longestRace.distanceKm)} km race on ${longestRace.completedAt.slice(0, 10)}: demonstrated capacity, not a long-run reference.`
    : null;
  const capFrom = (referenceKm: number, basis: string): LongRunLimit => ({
    referenceKm: round1(referenceKm),
    capKm: round1(referenceKm * longRunCapRatio),
    basis,
    demonstratedCapacity
  });

  const last30 = longestTraining(within(longRunWindowDays));
  if (last30 > 0) return capFrom(last30, `the longest training run of the last ${longRunWindowDays} days`);
  const last42 = longestTraining(recent);
  if (last42 > 0) return capFrom(last42, `the longest training run of the last ${recentRunWindowDays} days (none in the last ${longRunWindowDays})`);
  // Runs on record but no training run in 42 days (a break, or only a race):
  // never a race as the reference; the return-week cap holds one run.
  if (running.recentRuns.length > 0) {
    return { referenceKm: null, capKm: returningFromBreakCapKm, basis: `the return-week cap: no training run in the last ${recentRunWindowDays} days`, demonstratedCapacity };
  }
  // No runs on record: the app's recent longest run cannot be a logged race.
  const stated = running.longestRecentRunKm || 0;
  return stated > 0 ? capFrom(stated, "the recent longest run") : null;
}

/**
 * At most 1.25x the average weekly climbing of the 4 weeks before today
 * (local midnight, like the km cap), never capped below 300 m. The cap
 * covers the 7 days of today's run plus the planned runs. Without run history
 * there is no climbing reference: no cap.
 */
function weeklyClimbLimit(context: CoachContext): RunningGuardrails["weeklyClimb"] {
  const running = context.running;
  if (!running || running.recentRuns.length === 0) return null;
  // A race's climbing is not training: it stays out of the reference.
  const fourWeekAvgM = Math.round(loadBeforeToday(context, { racesIncluded: false }).fourWeekAvgClimbM);
  const { weeklyClimbRatio, weeklyClimbMinimumM } = RUNNING_LIMITS;
  return {
    fourWeekAvgM,
    capM: Math.round(Math.max(fourWeekAvgM * weeklyClimbRatio, weeklyClimbMinimumM)),
    basis: `the larger of ${weeklyClimbRatio}x the 4-week average of ${fourWeekAvgM} m a week (races left out) and ${weeklyClimbMinimumM} m`
  };
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
  const basis = `${recentRunCount} runs in the last ${RUNNING_LIMITS.recentRunWindowDays / 7} weeks, baseline ${round1(baselineWeeklyKm)} km/week, longest recent run ${round1(longestRecentRunKm)} km`;
  // Run counts only count runs inside the last 6 weeks: an old block of
  // runs before a long break is not an established base.
  const lowStartingBase = isStarterBase(running, recentRunCount);
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
  const diff = daysBetween(context.profile.weekStart, date);
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
