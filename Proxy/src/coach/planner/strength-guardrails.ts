import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import {
  hardSetCount,
  isHardLabel,
  isNearLimitLabel,
  loweredEffort,
  phaseMaxHardSessions,
  strengthPhase,
  strengthPhaseActive,
  strengthPhaseForPrompt,
  strengthSessionRule,
  type StrengthPhase
} from "./strength-phase";
import type { CoachContext, EffortLabel, EffortStimulus, PlannedEffort, WeeklyPlan } from "./types";

/**
 * Computed strength limits shared by the planner prompt, the clamp step and
 * the validator: working caps from the athlete's best, set bounds, the weekly
 * hard-session cap, and per-metric progression bands (earned step, hold band,
 * or maintenance hold).
 */

export type GoalMetric = "pullUps" | "pushUps" | "plankSeconds";

export const GOAL_METRICS: GoalMetric[] = ["pullUps", "pushUps", "plankSeconds"];
export const METRIC_LABEL: Record<GoalMetric, string> = { pullUps: "pull-up", pushUps: "push-up", plankSeconds: "plank" };
const METRIC_UNIT: Record<GoalMetric, string> = { pullUps: "reps", pushUps: "reps", plankSeconds: "seconds" };
const METRIC_NAME: Record<GoalMetric, string> = { pullUps: "Pull-ups", pushUps: "Push-ups", plankSeconds: "Plank" };

/**
 * Appends what a clamp changed to the session's progression rationale (the
 * text the app shows with the session), like the running clamps add notes.
 */
export function annotateSession(session: { progressionRationale?: unknown }, notes: string[]) {
  if (notes.length === 0) return;
  const base = typeof session.progressionRationale === "string" ? session.progressionRationale.trim() : "";
  const note = `Adjusted to the plan limits: ${notes.join("; ")}.`;
  session.progressionRationale = base ? `${base} ${note}` : note;
}

export const STRENGTH_LIMITS = {
  workingCapRatio: { pullUps: 0.85, pushUps: 0.75, plankSeconds: 0.8 } as Record<GoalMetric, number>,
  goalSets: { min: 2, max: 6 },
  maxHardSessions: { withRunning: 2, strengthOnly: 3 },
  maxConsecutiveHardDays: 2,
  /** A previous prescription older than this no longer anchors continuity. */
  continuityWindowDays: 21,
  usefulFloorRatio: 0.45
} as const;

const HARD_LABELS = new Set<string>(["hard", "very_hard", "max_output"]);
const NORMAL_PROGRESSION_STATES = new Set(["building", "plateau", "insufficient_history"]);
const DAY_MS = 24 * 60 * 60 * 1000;

export type EffortLike = { label: EffortLabel; stimulus: EffortStimulus };

export type MetricProgression = {
  metric: GoalMetric;
  label: string;
  /**
   * earned: progression is required (rep step, or +1 set at the same target).
   * maintenance: progression was earned but heavy running allows a hold; no regression.
   * hold: not earned; the target stays in the hold band, sets may rise by one.
   * free: no recent prescription or an offload state; only caps apply.
   * offload: planned recovery week or the last 10 days before the race: no
   * progression required, the target may hold or drop but not rise.
   */
  status: "earned" | "maintenance" | "hold" | "free" | "offload";
  previousTarget: number | null;
  previousSets: number | null;
  /** Allowed range for the week's top working target (useful goal work). */
  target: { min: number; max: number } | null;
  /** Most sets allowed on the top working prescription. */
  maxSets: number | null;
  /** The +1 set alternative for earned progression: same target, these sets. */
  setRoute: { target: number; sets: number } | null;
  cap: number | null;
  floor: number | null;
  note: string;
};

export type StrengthProgressionOptions = {
  /** Heavy running week: earned progression may hold instead of rising. */
  maintenance?: boolean;
};

export function metricForExercise(exercise: unknown): GoalMetric | null {
  if (exercise === "pullUp") return "pullUps";
  if (exercise === "pushUp") return "pushUps";
  if (exercise === "plank") return "plankSeconds";
  return null;
}

export function goalValue(metric: GoalMetric, exercise: { reps?: unknown; seconds?: unknown }): number {
  const value = metric === "plankSeconds" ? exercise.seconds : exercise.reps;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Working reps (or seconds) per set: 85% / 75% / 80% of the best recent value. */
export function workingCap(metric: GoalMetric, best: number | null | undefined): number | null {
  if (typeof best !== "number" || best <= 0) return null;
  const raw = Math.floor(best * STRENGTH_LIMITS.workingCapRatio[metric] + 1e-9);
  return metric === "plankSeconds" ? Math.max(10, raw) : Math.max(1, raw);
}

export function usefulFloor(best: number | null | undefined): number | null {
  return typeof best === "number" && best >= 10 ? Math.ceil(best * STRENGTH_LIMITS.usefulFloorRatio) : null;
}

/**
 * Earned progression step, scaled to the metric: pull-ups +1 rep; push-ups
 * +1 below 15 reps, +1-2 below 30, +1-3 from 30; plank +5-10 s below 60 s,
 * +5-15 s from 60 s.
 */
export function progressionStep(metric: GoalMetric, previous: number): { min: number; max: number } {
  if (metric === "pullUps") return { min: 1, max: 1 };
  if (metric === "pushUps") return { min: 1, max: previous < 15 ? 1 : previous < 30 ? 2 : 3 };
  return { min: 5, max: previous < 60 ? 10 : 15 };
}

export function describeStep(metric: GoalMetric, previous: number): string {
  const step = progressionStep(metric, previous);
  if (metric === "pullUps") return "exactly 1 repetition";
  if (metric === "pushUps") return step.max === 1 ? "+1 repetition" : `+1 to +${step.max} repetitions`;
  return `+5 to +${step.max} seconds`;
}

/** Goal work that counts for progression: not light, not technique/recovery, not a test. */
export function isUsefulGoalEffort(effort: EffortLike | null | undefined): boolean {
  if (!effort) return false;
  return effort.label !== "light" && effort.stimulus !== "recovery" && effort.stimulus !== "technique" && effort.stimulus !== "test";
}

export function isHardStrengthSession(session: WeeklyPlan["sessions"][number]): boolean {
  return hardestLabel(session) !== null;
}

export function hardestLabel(session: WeeklyPlan["sessions"][number]): EffortLabel | null {
  const labels = [session.plannedEffort?.label, ...(session.exercises ?? []).map((exercise) => exercise.plannedEffort?.label)];
  for (const label of ["max_output", "very_hard", "hard"] as const) {
    if (labels.includes(label)) return label;
  }
  return null;
}

export function maxHardStrengthSessions(context: CoachContext): number {
  const normal = context.running ? STRENGTH_LIMITS.maxHardSessions.withRunning : STRENGTH_LIMITS.maxHardSessions.strengthOnly;
  const phase = phaseMaxHardSessions(strengthPhase(context));
  return phase === null ? normal : Math.min(normal, phase);
}

export function strengthProgressionPlan(
  context: CoachContext,
  options: StrengthProgressionOptions = {}
): Record<GoalMetric, MetricProgression> {
  const earned = new Map(flatGoalMetricsRequiringProgression(context).map((entry) => [entry.metric, entry]));
  const normal = NORMAL_PROGRESSION_STATES.has(context.readiness.state);
  const missedRecently = (context.adherence.missedLast14Days ?? 0) >= 2;
  const result = {} as Record<GoalMetric, MetricProgression>;

  for (const metric of GOAL_METRICS) {
    const label = METRIC_LABEL[metric];
    const unit = METRIC_UNIT[metric];
    const best = context.history.bestRecentTests[metric];
    const cap = workingCap(metric, best);
    const floor = usefulFloor(best);
    const capOr = (value: number) => (cap === null ? value : Math.min(value, cap));
    const base: Omit<MetricProgression, "status" | "previousTarget" | "previousSets" | "target" | "maxSets" | "setRoute" | "note"> = {
      metric,
      label,
      cap,
      floor
    };

    if (!normal) {
      result[metric] = {
        ...base,
        status: "free",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: 1, max: cap },
        maxSets: STRENGTH_LIMITS.goalSets.max,
        setRoute: null,
        note: `Computed readiness is ${context.readiness.state}: no progression; reduce as needed within the cap.`
      };
      continue;
    }

    const phase = strengthPhase(context);
    if (strengthPhaseActive(phase)) {
      const previous = previousWorkingPrescription(context, metric);
      const upper = previous ? capOr(previous.target) : cap;
      const maxGoalSets = Math.min(phase.recoveryWeek?.maxGoalSets ?? 6, phase.raceTaper ? 3 : 6);
      const why = phase.recoveryWeek ? "Planned recovery week" : `The last 10 days before ${phase.raceTaper!.raceName}`;
      result[metric] = {
        ...base,
        status: "offload",
        previousTarget: previous?.target ?? null,
        previousSets: previous ? Math.max(previous.sets, STRENGTH_LIMITS.goalSets.min) : null,
        target: upper === null ? null : { min: 1, max: upper },
        maxSets: maxGoalSets,
        setRoute: null,
        note: `${why}: no progression is required; keep the top working target at or below ${upper ?? "the cap"} ${unit} with at most ${maxGoalSets} sets. Fewer sets or a lighter effort is the point.`
      };
      continue;
    }

    const earnedEntry = earned.get(metric);
    const performance = context.plannedWork.recentGoalPerformance?.[metric];
    if (earnedEntry && performance?.prescribedSets !== null && performance?.prescribedSets !== undefined) {
      const previous = earnedEntry.latestTarget;
      // A legacy 1-set prescription continues as 2 sets: goal work never uses fewer.
      const previousSets = Math.max(performance.prescribedSets, STRENGTH_LIMITS.goalSets.min);
      const step = progressionStep(metric, previous);
      const repMin = previous + step.min;
      const repMax = capOr(previous + step.max);
      const repsPossible = repMin <= repMax;
      const setsPossible = previousSets < STRENGTH_LIMITS.goalSets.max;
      const heldTarget = capOr(previous);
      const setRoute = setsPossible ? { target: heldTarget, sets: previousSets + 1 } : null;

      if (options.maintenance) {
        result[metric] = {
          ...base,
          status: "maintenance",
          previousTarget: previous,
          previousSets,
          target: { min: heldTarget, max: repsPossible ? repMax : heldTarget },
          maxSets: previousSets + (setsPossible ? 1 : 0),
          setRoute,
          note: `Progression was earned, but this week's running load allows a maintenance hold: keep at least ${heldTarget} ${unit} (no regression); progressing is still allowed.`
        };
      } else if (repsPossible || setsPossible) {
        result[metric] = {
          ...base,
          status: "earned",
          previousTarget: previous,
          previousSets,
          target: repsPossible ? { min: repMin, max: repMax } : { min: heldTarget, max: heldTarget },
          maxSets: repsPossible ? previousSets : previousSets + 1,
          setRoute,
          note: repsPossible
            ? `Clean matched performance earned progression from ${previous} ${unit} x ${previousSets} sets: prescribe ${span(repMin, repMax)} ${unit} with at most ${previousSets} sets${setRoute ? `, or keep ${setRoute.target} ${unit} and use ${setRoute.sets} sets` : ""}.`
            : `Clean matched performance earned progression, but ${previous + step.min} ${unit} would exceed the working cap of ${cap}: keep ${heldTarget} ${unit} and use ${previousSets + 1} sets.`
        };
      } else {
        result[metric] = {
          ...base,
          status: "hold",
          previousTarget: previous,
          previousSets,
          target: { min: heldTarget, max: heldTarget },
          maxSets: previousSets,
          setRoute: null,
          note: `Progression was earned but the working cap (${cap}) and the ${STRENGTH_LIMITS.goalSets.max}-set limit block it: hold ${heldTarget} ${unit} and schedule an Assessment when readiness allows.`
        };
      }
      continue;
    }

    const previous = previousWorkingPrescription(context, metric);
    if (!previous) {
      result[metric] = {
        ...base,
        status: "free",
        previousTarget: null,
        previousSets: null,
        target: cap === null ? null : { min: Math.min(floor ?? 1, cap), max: cap },
        maxSets: STRENGTH_LIMITS.goalSets.max,
        setRoute: null,
        note: "No recent prescription to continue from: start inside the working cap and the useful floor."
      };
      continue;
    }

    const step = progressionStep(metric, previous.target);
    previous.sets = Math.max(previous.sets, STRENGTH_LIMITS.goalSets.min);
    const upper = capOr(Math.max(previous.target, floor ?? 0));
    const lower = missedRecently ? 1 : Math.max(1, Math.min(previous.target - step.max, upper));
    result[metric] = {
      ...base,
      status: "hold",
      previousTarget: previous.target,
      previousSets: previous.sets,
      target: { min: lower, max: upper },
      maxSets: Math.min(STRENGTH_LIMITS.goalSets.max, previous.sets + 1),
      setRoute: null,
      note: `Progression is not earned: keep the top working target between ${lower} and ${upper} ${unit} (previous ${previous.target} x ${previous.sets} sets); sets may rise by at most one.`
    };
  }

  return result;
}

export function strengthGuardrailsForPrompt(
  context: CoachContext,
  options: StrengthProgressionOptions & { maintenanceReason?: string | null } = {}
): Record<string, unknown> {
  const progression = strengthProgressionPlan(context, options);
  return {
    workingCaps: Object.fromEntries(
      GOAL_METRICS.map((metric) => [
        metric,
        {
          maxPerSet: progression[metric].cap,
          basedOnBest: context.history.bestRecentTests[metric],
          ratio: STRENGTH_LIMITS.workingCapRatio[metric],
          ...(context.history.bestBeforeBlock?.[metric] ? { olderBestBeforeThisBlock: context.history.bestBeforeBlock[metric] } : {})
        }
      ])
    ),
    phase: strengthPhaseForPrompt(strengthPhase(context)),
    workingCapRule:
      "Working reps or hold seconds per set must not exceed maxPerSet, except stimulus test. Over-cap values are lowered to the cap. basedOnBest is the current level: the baseline set at the plan block start plus logs since then. olderBestBeforeThisBlock is context only; never plan from it.",
    goalSetsPerExercise: STRENGTH_LIMITS.goalSets,
    maxHardSessionsThisWeek: maxHardStrengthSessions(context),
    hardSessionRule:
      "A session is hard when it or any exercise is hard, very_hard, or max_output. No hard strength on more than two consecutive days, and no very_hard or max_output strength (tests included) on the day before a long run or the race.",
    maintenance: options.maintenance
      ? { allowed: true, reason: options.maintenanceReason ?? "Heavy running week." }
      : { allowed: false },
    progression: Object.fromEntries(
      GOAL_METRICS.map((metric) => {
        const entry = progression[metric];
        return [
          metric,
          {
            status: entry.status,
            previousTarget: entry.previousTarget,
            previousSets: entry.previousSets,
            allowedTopTarget: entry.target,
            maxSetsOnTopTarget: entry.maxSets,
            setRoute: entry.setRoute,
            usefulFloor: entry.floor,
            rule: entry.note
          }
        ];
      })
    )
  };
}

function span(min: number, max: number): string {
  return min === max ? `${min}` : `${min}-${max}`;
}

function previousWorkingPrescription(context: CoachContext, metric: GoalMetric): { target: number; sets: number } | null {
  const trend = context.plannedWork.recentGoalTargets[metric];
  const target = trend?.latestWorkingTarget;
  const sets = trend?.latestWorkingSets;
  const date = trend?.latestWorkingDate;
  if (typeof target !== "number" || target <= 0 || typeof sets !== "number" || sets <= 0 || !date) return null;
  const age = Date.parse(context.profile.weekStart) - Date.parse(date);
  if (!Number.isFinite(age) || age > STRENGTH_LIMITS.continuityWindowDays * DAY_MS) return null;
  return { target, sets };
}

type ClampSession = WeeklyPlan["sessions"][number];

/**
 * Recovery-week and race-taper fixes, all downward: tests become medium
 * working sets inside the cap, very_hard and max_output become hard, hard
 * work within 4 days of the race becomes medium, hard sessions beyond the
 * phase limit become medium, goal sets go to at most 3, and hard sets above
 * the recovery cap are trimmed (then lowered to medium). Returns whether
 * anything changed.
 */
function clampStrengthPhase(
  sessions: ClampSession[],
  phase: StrengthPhase,
  progression: Record<GoalMetric, MetricProgression>,
  adjustments: string[],
  sessionNotes: string[][]
): boolean {
  let changed = false;

  sessions.forEach((session, index) => {
    const rule = strengthSessionRule(session.dayOffset, phase);
    if (!rule.light || !Array.isArray(session.exercises)) return;
    const why = rule.reason ?? "this lighter week";
    for (const exercise of session.exercises) {
      const effort = exercise.plannedEffort;
      if (!effort) continue;
      const metric = metricForExercise(exercise.exercise);
      if (effort.stimulus === "test" || effort.label === "max_output") {
        const field = metric === "plankSeconds" ? "seconds" : "reps";
        const cap = metric ? progression[metric].target?.max ?? progression[metric].cap : null;
        if (metric && cap !== null && goalValue(metric, exercise) > cap) exercise[field] = cap;
        exercise.plannedEffort = loweredEffort(effort, "medium", why);
        exercise.intensity = "Medium";
        if (metric && exercise.sets < STRENGTH_LIMITS.goalSets.min) exercise.sets = STRENGTH_LIMITS.goalSets.min;
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: the test became medium working sets (${why}).`);
        sessionNotes[index].push(`${exercise.exercise} test -> medium working sets (no tests ${phase.recoveryWeek ? "in a recovery week" : "this close to the race"})`);
        changed = true;
      } else if ((rule.noHard && isHardLabel(effort.label)) || isNearLimitLabel(effort.label)) {
        const target = rule.noHard ? "medium" : "hard";
        exercise.plannedEffort = loweredEffort(effort, target, why);
        exercise.intensity = target === "medium" ? "Medium" : "Hard";
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: ${effort.label} lowered to ${target} (${why}).`);
        sessionNotes[index].push(`${exercise.exercise} effort ${effort.label} -> ${target}`);
        changed = true;
      }
      if (metric && rule.maxGoalSets !== null && exercise.sets > rule.maxGoalSets && isUsefulGoalEffort(exercise.plannedEffort)) {
        adjustments.push(`Session ${index + 1} (${session.title}) ${exercise.exercise}: ${exercise.sets} sets lowered to ${rule.maxGoalSets} (${why}).`);
        sessionNotes[index].push(`${exercise.exercise} ${exercise.sets} -> ${rule.maxGoalSets} sets`);
        exercise.sets = rule.maxGoalSets;
        changed = true;
      }
    }
    syncSessionEffort(session, rule.noHard ? "medium" : "hard", why);
  });

  // At most N hard sessions: keep the earliest, lower the rest to medium.
  const maxHard = phaseMaxHardSessions(phase);
  if (maxHard !== null) {
    let kept = 0;
    sessions.forEach((session, index) => {
      if (hardestLabel(session) === null) return;
      kept += 1;
      if (kept <= maxHard) return;
      lowerSessionToMedium(session, "only one hard strength session this week");
      adjustments.push(`Session ${index + 1} (${session.title}): lowered to medium (at most ${maxHard} hard strength session in this lighter week).`);
      sessionNotes[index].push("effort lowered to medium (one hard session this week)");
      changed = true;
    });
  }

  const cap = phase.recoveryWeek?.hardSetCap ?? null;
  if (cap !== null) {
    const plan = { sessions } as WeeklyPlan;
    let excess = hardSetCount(plan) - cap;
    if (excess > 0) {
      const before = hardSetCount(plan);
      // Trim sets on hard exercises, latest sessions first, keeping 2 sets
      // of goal work and 1 of support work.
      for (let index = sessions.length - 1; index >= 0 && excess > 0; index -= 1) {
        for (const exercise of [...(sessions[index].exercises ?? [])].reverse()) {
          if (excess <= 0) break;
          if (!isHardLabel(exercise.plannedEffort?.label)) continue;
          const minimum = metricForExercise(exercise.exercise) ? STRENGTH_LIMITS.goalSets.min : 1;
          const cut = Math.min(excess, exercise.sets - minimum);
          if (cut > 0) {
            exercise.sets -= cut;
            excess -= cut;
            sessionNotes[index].push(`${exercise.exercise} -${cut} hard set(s)`);
          }
        }
      }
      // Still over: lower hard exercises to medium, latest first.
      for (let index = sessions.length - 1; index >= 0 && excess > 0; index -= 1) {
        for (const exercise of [...(sessions[index].exercises ?? [])].reverse()) {
          if (excess <= 0) break;
          if (!isHardLabel(exercise.plannedEffort?.label) || !exercise.plannedEffort) continue;
          exercise.plannedEffort = loweredEffort(exercise.plannedEffort, "medium", "the recovery week's hard-set cap");
          exercise.intensity = "Medium";
          excess -= exercise.sets;
          sessionNotes[index].push(`${exercise.exercise} effort -> medium`);
        }
        syncSessionEffort(sessions[index], "hard", "the recovery week's hard-set cap");
      }
      adjustments.push(`Hard strength sets ${before} were above the recovery week's cap of ${cap}; trimmed to ${hardSetCount(plan)}.`);
      changed = true;
    }
  }
  return changed;
}

/** The session label follows its hardest exercise down (never up). */
function syncSessionEffort(session: ClampSession, ceiling: "medium" | "hard", why: string) {
  const effort = session.plannedEffort;
  if (!effort || !Array.isArray(session.exercises)) return;
  const order: EffortLabel[] = ["light", "medium", "hard", "very_hard", "max_output"];
  const hardestExercise = session.exercises.reduce<EffortLabel>(
    (hardest, exercise) => (order.indexOf(exercise.plannedEffort?.label) > order.indexOf(hardest) ? exercise.plannedEffort.label : hardest),
    "light"
  );
  const allowed = order[Math.min(order.indexOf(ceiling), Math.max(order.indexOf(hardestExercise), order.indexOf("medium")))];
  if (order.indexOf(effort.label) > order.indexOf(allowed)) {
    session.plannedEffort = loweredEffort(effort, allowed === "hard" ? "hard" : "medium", why);
  }
}

function lowerSessionToMedium(session: ClampSession, why: string) {
  if (session.plannedEffort && isHardLabel(session.plannedEffort.label)) session.plannedEffort = loweredEffort(session.plannedEffort, "medium", why);
  for (const exercise of session.exercises ?? []) {
    if (exercise.plannedEffort && isHardLabel(exercise.plannedEffort.label)) {
      exercise.plannedEffort = loweredEffort(exercise.plannedEffort, "medium", why);
      exercise.intensity = "Medium";
    }
  }
}

/**
 * Deterministic, downward-only fixes: over-cap reps or seconds go to the cap
 * (tests excluded), useful goal work gets 2-6 sets, and the top working
 * target is lowered into its progression band (with the set increase dropped
 * when the target already rose). Raising an under-progressed target is left
 * to the repair step, because the plan's rationale text must match it.
 */
export function clampWeeklyPlan(
  plan: WeeklyPlan,
  context: CoachContext,
  options: StrengthProgressionOptions = {}
): { plan: WeeklyPlan; adjustments: string[] } {
  if (!plan || !Array.isArray(plan.sessions)) return { plan, adjustments: [] };
  const adjustments: string[] = [];
  const progression = strengthProgressionPlan(context, options);
  const normal = NORMAL_PROGRESSION_STATES.has(context.readiness.state);
  const sessions = plan.sessions.map((session) => ({
    ...session,
    plannedEffort: session.plannedEffort ? { ...session.plannedEffort } : session.plannedEffort,
    exercises: Array.isArray(session.exercises)
      ? session.exercises.map((exercise) => ({ ...exercise, plannedEffort: exercise.plannedEffort ? { ...exercise.plannedEffort } : exercise.plannedEffort }))
      : session.exercises
  }));
  // Athlete-facing notes per session, so the session text never quotes the old numbers.
  const sessionNotes: string[][] = sessions.map(() => []);
  let summary = plan.summary;
  let safetyFlags = plan.safetyFlags;
  const phase = strengthPhase(context);
  if (normal && strengthPhaseActive(phase)) {
    const fixed = clampStrengthPhase(sessions, phase, progression, adjustments, sessionNotes);
    if (phase.recoveryWeek && typeof summary === "string" && !summary.trim().startsWith("Offload:")) {
      const rest = summary.trim().replace(/^(?:Build|Restore|Maintenance|Assessment):\s*/, "");
      summary = `Offload: ${rest}`;
      adjustments.push("Summary phase set to Offload: for the planned recovery week.");
    }
    const flag = phase.recoveryWeek
      ? "Planned recovery week: lighter on purpose after three loading weeks."
      : `Race taper: strength stays light in the last 10 days before ${phase.raceTaper!.raceName}.`;
    if (Array.isArray(safetyFlags) && !safetyFlags.includes(flag) && (fixed || safetyFlags.length === 0)) {
      safetyFlags = [...safetyFlags, flag];
    }
  }

  sessions.forEach((session, sessionIndex) => {
    if (!Array.isArray(session.exercises)) return;
    const notes: string[] = sessionNotes[sessionIndex];
    for (const exercise of session.exercises) {
      const metric = metricForExercise(exercise.exercise);
      if (!metric) continue;
      const where = `Session ${sessionIndex + 1} (${session.title}) ${exercise.exercise}`;
      const effort = exercise.plannedEffort as EffortLike | undefined;
      const field = metric === "plankSeconds" ? "seconds" : "reps";
      const entry = progression[metric];
      const name = METRIC_NAME[metric];
      const unit = METRIC_UNIT[metric];

      if (effort?.stimulus !== "test" && entry.cap !== null && goalValue(metric, exercise) > entry.cap) {
        adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to the working cap of ${entry.cap} ${unit}.`);
        notes.push(`${name} ${goalValue(metric, exercise)} -> ${entry.cap} ${unit} per set (working cap)`);
        exercise[field] = entry.cap;
      }

      if (!isUsefulGoalEffort(effort) || typeof exercise.sets !== "number") continue;
      if (exercise.sets > STRENGTH_LIMITS.goalSets.max) {
        adjustments.push(`${where}: ${exercise.sets} sets lowered to ${STRENGTH_LIMITS.goalSets.max}.`);
        notes.push(`${name} ${exercise.sets} -> ${STRENGTH_LIMITS.goalSets.max} sets`);
        exercise.sets = STRENGTH_LIMITS.goalSets.max;
      } else if (exercise.sets >= 1 && exercise.sets < STRENGTH_LIMITS.goalSets.min) {
        adjustments.push(`${where}: ${exercise.sets} working set raised to ${STRENGTH_LIMITS.goalSets.min}.`);
        notes.push(`${name} ${exercise.sets} -> ${STRENGTH_LIMITS.goalSets.min} sets`);
        exercise.sets = STRENGTH_LIMITS.goalSets.min;
      }

      if (!normal || entry.status === "free" || !entry.target) continue;
      if (entry.status === "offload") {
        if (goalValue(metric, exercise) > entry.target.max) {
          adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to ${entry.target.max} ${unit} (no progression in this lighter week).`);
          notes.push(`${name} ${goalValue(metric, exercise)} -> ${entry.target.max} ${unit} per set (no progression this week)`);
          exercise[field] = entry.target.max;
        }
        continue;
      }
      if (goalValue(metric, exercise) > entry.target.max) {
        const reason = entry.status === "hold" ? "progression not earned" : "largest allowed progression step";
        adjustments.push(`${where}: ${goalValue(metric, exercise)} lowered to ${entry.target.max} ${unit} (${reason}).`);
        notes.push(`${name} ${goalValue(metric, exercise)} -> ${entry.target.max} ${unit} per set (${reason})`);
        exercise[field] = entry.target.max;
      }
      const previousTarget = entry.previousTarget;
      const previousSets = entry.previousSets;
      if (previousTarget === null || previousSets === null) continue;
      const maxSetsAtHeldTarget = Math.min(STRENGTH_LIMITS.goalSets.max, previousSets + 1);
      const floorSets = Math.max(previousSets, STRENGTH_LIMITS.goalSets.min);
      if (goalValue(metric, exercise) > previousTarget && exercise.sets > floorSets) {
        adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${floorSets} so the target and the sets do not rise together.`);
        notes.push(`${name} ${exercise.sets} -> ${floorSets} sets (reps and sets do not rise together)`);
        exercise.sets = floorSets;
      } else if (exercise.sets > maxSetsAtHeldTarget) {
        adjustments.push(`${where}: sets lowered from ${exercise.sets} to ${maxSetsAtHeldTarget} (at most one more set than ${previousSets}).`);
        notes.push(`${name} ${exercise.sets} -> ${maxSetsAtHeldTarget} sets (at most one set more than last week)`);
        exercise.sets = maxSetsAtHeldTarget;
      }
    }
    annotateSession(session, notes);
  });

  return { plan: { ...plan, summary, safetyFlags, sessions }, adjustments };
}
