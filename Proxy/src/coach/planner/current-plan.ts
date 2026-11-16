import { deliveredVsPlanned, describeDelivered, didMoreThanPlanned, type DeliveredVsPlanned } from "./delivered-work";
import { highEffortOffPlan, testsAGoal } from "./effort-flags";
import { GOAL_METRICS, hardestOf, isGoalTest, LOGGED_FLAG, METRIC_LABEL, METRIC_PLURAL, metricForExercise, prescriptionEffort, type GoalMetric } from "./goal-metrics";
import { plural, round1 } from "./numbers";
import { NORMAL_READINESS_STATES, readinessStateAt } from "./readiness-state";
import { computeSeason, daysBetween, postRaceDaysFor, seasonPhaseText } from "./season";
import type {
  CoachContext,
  CoachRequest,
  CurrentPlanContext,
  CurrentPlanRun,
  CurrentPlanStrengthSession,
  PlannedSession,
  RunningWeek,
  TrainingLog,
  WeeklyPlan
} from "./types";

/**
 * Plan continuity. The rolling week is regenerated every night, so the
 * planners see the plan they made before for the coming days
 * (`coachContext.currentPlan`) and keep it unless a computed signal changed:
 * a new log with pain, very weak feedback or effort off plan, a result off
 * target, a missed session, a readiness change (readiness back to normal
 * after overreaching or a recovery need included), new runs that move the load
 * (or a run rated feel 1-2 / RPE 9+), a phase change (recovery week, race
 * window), or changed training days. Wellness gates are added by the
 * pipeline (Garmin data arrives after the context is built).
 */
export const CONTINUITY_LIMITS = {
  /** A kept run may differ by at most this share of its planned distance. */
  runDistanceTolerance: 0.15,
  /** A completed run this far off its planned distance (and >= 2 km) moved the load. */
  runDeviationRatio: 0.25,
  runDeviationMinKm: 2,
  /** An unplanned run of at least this length moved the load. */
  extraRunMinKm: 5,
  /** Without a known plan time, changes in the last day count. */
  defaultLookbackHours: 24
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

const TOLERANCE_PCT = Math.round(CONTINUITY_LIMITS.runDistanceTolerance * 100);

/** The exit signal: the state the plan was made in was reduced, and readiness is normal again. */
export const READINESS_BACK_TO_NORMAL = "Readiness is back to normal: return to the full plan.";

export const CONTINUITY_RULE =
  `coachContext.currentPlan is the plan made earlier for these days. When keepUnlessChanged is true (no computed signal changed), keep each planned day's session: the same run kind with roughly the same distance (within ${TOLERANCE_PCT}%), and the same strength focus and goal targets. When changeSignals lists reasons, change only what they call for. Either way, say in the summary what changed and why, or that nothing changed.`;

/** The planned future sessions (tomorrow through offset 6) the app sent, as day offsets. */
export function currentPlanFromRequest(request: CoachRequest): Pick<CurrentPlanContext, "runs" | "strengthSessions"> {
  const weekStart = Date.parse(request.weekStart);
  const runs: CurrentPlanRun[] = [];
  const strengthSessions: CurrentPlanStrengthSession[] = [];
  if (!Number.isFinite(weekStart)) return { runs, strengthSessions };
  for (const session of request.plannedSessions) {
    if (session.status !== "planned") continue;
    const dayOffset = Math.round((Date.parse(session.scheduledDate) - weekStart) / DAY_MS);
    if (!Number.isInteger(dayOffset) || dayOffset < 1 || dayOffset > 6) continue;
    if (isRunSession(session)) {
      runs.push(planRunFromSession(session, dayOffset));
    } else if ((session.exercises ?? []).length > 0) {
      strengthSessions.push({
        dayOffset,
        title: session.title,
        focus: session.focus,
        hardestEffort: hardestOf((session.exercises ?? []).map((exercise) => exercise.plannedEffortLabel)),
        goalWork: (session.exercises ?? [])
          .filter((exercise) => metricForExercise(exercise.exercise) !== null)
          .map((exercise) => ({
            exercise: exercise.exercise,
            sets: exercise.sets,
            target: exercise.exercise === "plank" ? exercise.targetSeconds : exercise.targetReps,
            effort: exercise.plannedEffortLabel ?? null,
            stimulus: exercise.plannedEffortStimulus ?? null
          }))
      });
    }
  }
  runs.sort((a, b) => a.dayOffset - b.dayOffset);
  strengthSessions.sort((a, b) => a.dayOffset - b.dayOffset);
  return { runs, strengthSessions };
}

/**
 * Runs the app's plan has for today (offset 0, locked) and that are not done
 * yet. They are not part of continuity (offsets 1-6), but they count toward
 * the week's running floors.
 */
export function todayPlannedRunsFromRequest(request: CoachRequest): CurrentPlanRun[] {
  const weekStart = Date.parse(request.weekStart);
  if (!Number.isFinite(weekStart)) return [];
  return request.plannedSessions
    .filter((session) => session.status === "planned" && isRunSession(session) && Math.round((Date.parse(session.scheduledDate) - weekStart) / DAY_MS) === 0)
    .map((session) => planRunFromSession(session, 0));
}

function planRunFromSession(session: PlannedSession, dayOffset: number): CurrentPlanRun {
  return {
    dayOffset,
    title: session.title,
    kind: session.runKind ?? null,
    distanceKm: typeof session.distanceKm === "number" ? session.distanceKm : null,
    elevationMeters: typeof session.elevationMeters === "number" ? session.elevationMeters : null,
    target: session.target ?? null
  };
}

export type StoredPlan = {
  generatedAt: string;
  weekStart: string;
  runningWeek?: RunningWeek;
  strengthWeek?: WeeklyPlan;
};

/** A plan the proxy generated earlier (auto-plan store), re-based onto `weekStart`. */
export function currentPlanFromStoredPlan(plan: StoredPlan, weekStart: string): Pick<CurrentPlanContext, "runs" | "strengthSessions"> {
  const shift = Math.round((Date.parse(weekStart) - Date.parse(plan.weekStart)) / DAY_MS);
  const runs: CurrentPlanRun[] = [];
  const strengthSessions: CurrentPlanStrengthSession[] = [];
  if (!Number.isFinite(shift)) return { runs, strengthSessions };
  for (const run of plan.runningWeek?.sessions ?? []) {
    const dayOffset = run.dayOffset - shift;
    if (dayOffset < 1 || dayOffset > 6) continue;
    runs.push({ dayOffset, title: run.title, kind: run.kind, distanceKm: run.distanceKm, elevationMeters: run.elevationMeters, target: run.target });
  }
  for (const session of plan.strengthWeek?.sessions ?? []) {
    const dayOffset = session.dayOffset - shift;
    if (dayOffset < 1 || dayOffset > 6) continue;
    strengthSessions.push({
      dayOffset,
      title: session.title,
      focus: session.focus,
      hardestEffort: hardestOf([session.plannedEffort?.label, ...(session.exercises ?? []).map((exercise) => exercise.plannedEffort?.label)]),
      goalWork: (session.exercises ?? [])
        .filter((exercise) => metricForExercise(exercise.exercise) !== null)
        .map((exercise) => ({
          exercise: exercise.exercise,
          sets: exercise.sets,
          target: exercise.exercise === "plank" ? exercise.seconds : exercise.reps,
          effort: exercise.plannedEffort?.label ?? null,
          stimulus: exercise.plannedEffort?.stimulus ?? null
        }))
    });
  }
  return { runs, strengthSessions };
}

/**
 * The current plan with its change signals, for the context. `base` is the
 * context built so far (readiness, plannedWork, periodization).
 */
export function buildCurrentPlanContext(
  request: CoachRequest,
  base: Pick<CoachContext, "plannedWork" | "periodization" | "profile" | "readiness" | "adherence">,
  now: Date,
  plan: Pick<CurrentPlanContext, "runs" | "strengthSessions"> = currentPlanFromRequest(request),
  generatedAt: string | null = validIso(request.currentPlanGeneratedAt),
  source: CurrentPlanContext["source"] = "app"
): CurrentPlanContext | undefined {
  if (plan.runs.length === 0 && plan.strengthSessions.length === 0) return undefined;
  const changeSignals = planChangeSignals(request, base, plan, generatedAt, now);
  return {
    generatedAt,
    source,
    runs: plan.runs,
    strengthSessions: plan.strengthSessions,
    changeSignals,
    keepUnlessChanged: changeSignals.length === 0,
    rule: CONTINUITY_RULE
  };
}

/**
 * Swap in a newer plan from the auto-plan store (the app may not have applied
 * it yet), with its runs for today.
 */
export function withStoredCurrentPlan(context: CoachContext, request: CoachRequest, stored: StoredPlan | null | undefined, now: Date): CoachContext {
  if (!stored || !Number.isFinite(Date.parse(stored.generatedAt))) return context;
  const appPlanAt = Date.parse(request.currentPlanGeneratedAt ?? "");
  if (Number.isFinite(appPlanAt) && appPlanAt >= Date.parse(stored.generatedAt)) return context;
  const plan = currentPlanFromStoredPlan(stored, request.weekStart);
  const currentPlan = buildCurrentPlanContext(request, context, now, plan, stored.generatedAt, "auto_plan");
  const { todayPlannedRuns: _appToday, ...rest } = context;
  const today = todayRunsFromStoredPlan(stored, request.weekStart);
  return { ...rest, currentPlan, ...(today.length > 0 ? { todayPlannedRuns: today } : {}) };
}

/** The stored plan's runs for today (offset 0 after re-basing onto `weekStart`). */
function todayRunsFromStoredPlan(plan: StoredPlan, weekStart: string): CurrentPlanRun[] {
  const shift = Math.round((Date.parse(weekStart) - Date.parse(plan.weekStart)) / DAY_MS);
  if (!Number.isFinite(shift)) return [];
  return (plan.runningWeek?.sessions ?? [])
    .filter((run) => run.dayOffset - shift === 0)
    .map((run) => ({ dayOffset: 0, title: run.title, kind: run.kind, distanceKm: run.distanceKm, elevationMeters: run.elevationMeters, target: run.target }));
}

/** What changed since the current plan was made, in athlete-readable words. */
export function planChangeSignals(
  request: CoachRequest,
  base: Pick<CoachContext, "plannedWork" | "periodization" | "profile" | "readiness" | "adherence">,
  plan: Pick<CurrentPlanContext, "runs" | "strengthSessions">,
  generatedAt: string | null,
  now: Date
): string[] {
  const nowMs = now.getTime();
  const weekStart = Date.parse(request.weekStart);
  const since = generatedAt ? Date.parse(generatedAt) : nowMs - CONTINUITY_LIMITS.defaultLookbackHours * 60 * 60 * 1000;
  const signals: string[] = [];
  const after = (iso: string) => {
    const at = Date.parse(iso);
    return Number.isFinite(at) && at > since && at <= nowMs;
  };

  const logs = [...request.trainingLogs].sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const sessionsById = new Map(request.plannedSessions.map((session) => [session.id, session]));
  for (const log of logs.filter((entry) => after(entry.completedAt))) {
    const exercises = sessionsById.get(log.sessionId)?.exercises;
    const reason = logChangeReason(log, deliveredVsPlanned(log, exercises), exercises);
    if (reason) signals.push(`New log on ${day(log.completedAt)}: ${reason}.`);
  }
  for (const [metric, performance] of Object.entries(base.plannedWork.recentGoalPerformance ?? {})) {
    if (!performance.completedAt || !after(performance.completedAt) || performance.delta === null) continue;
    if (performance.delta !== 0) {
      signals.push(`New ${metricName(metric)} result on ${day(performance.completedAt)}: ${performance.latestLoggedBest} against ${performance.prescribedTarget} planned.`);
    } else if (performance.clean && performance.consecutiveCleanCompletionsAtStandard >= 2) {
      signals.push(`New ${metricName(metric)} result on ${day(performance.completedAt)}: a second clean completion at ${performance.prescribedTarget} earned progression.`);
    }
  }

  const missedFrom = since - DAY_MS;
  for (const session of request.plannedSessions) {
    const scheduled = Date.parse(session.scheduledDate);
    if (!Number.isFinite(scheduled) || scheduled < missedFrom || scheduled >= weekStart) continue;
    if (session.status === "missed" || session.status === "planned") {
      signals.push(`Missed session: ${session.title} on ${day(session.scheduledDate)}.`);
    }
  }

  const runs = request.running?.recentRuns ?? [];
  const plannedRuns = request.plannedSessions.filter(isRunSession);
  for (const run of runs.filter((entry) => after(entry.completedAt))) {
    if (typeof run.feelScore === "number" && run.feelScore >= 1 && run.feelScore <= 2) {
      signals.push(`Run on ${day(run.completedAt)} felt ${run.feelScore === 1 ? "very weak" : "weak"}.`);
      continue;
    }
    if (typeof run.rpe === "number" && run.rpe >= 9) {
      signals.push(`Run on ${day(run.completedAt)} was rated RPE ${run.rpe}.`);
      continue;
    }
    const at = Date.parse(run.completedAt);
    const planned = plannedRuns.find((session) => {
      const scheduled = Date.parse(session.scheduledDate);
      return at >= scheduled && at < scheduled + DAY_MS;
    });
    if (planned && typeof planned.distanceKm === "number" && planned.distanceKm > 0) {
      const off = Math.abs(run.distanceKm - planned.distanceKm);
      if (off >= CONTINUITY_LIMITS.runDeviationMinKm && off > planned.distanceKm * CONTINUITY_LIMITS.runDeviationRatio) {
        signals.push(`Run on ${day(run.completedAt)}: ${round1(run.distanceKm)} km against ${round1(planned.distanceKm)} km planned.`);
      }
    } else if (!planned && run.distanceKm >= CONTINUITY_LIMITS.extraRunMinKm) {
      signals.push(`Unplanned ${round1(run.distanceKm)} km run on ${day(run.completedAt)}.`);
    }
  }

  // Readiness changes, from the two computed states: when the plan was made
  // (recomputed from the logs up to then) and now. Leaving a reduced state
  // releases the plan made in it (it was eased for that state).
  const then = readinessStateAt(request, new Date(since), base.adherence);
  const current = base.readiness.state;
  if (!NORMAL_READINESS_STATES.has(then) && NORMAL_READINESS_STATES.has(current)) {
    signals.push(READINESS_BACK_TO_NORMAL);
  } else if (current === "recovery_needed" && then !== "recovery_needed") {
    signals.push("Readiness changed to recovery needed.");
  } else if (then === "recovery_needed" && current === "overreaching") {
    signals.push("Readiness changed from recovery needed to overreaching.");
  }

  const periodization = base.periodization;
  const blockStart = Date.parse(request.planBlockStartedAt ?? "");
  if (periodization?.blockWeek && Number.isFinite(blockStart) && since >= blockStart) {
    const sinceWeek = Math.floor(Math.max(0, Math.round((since - blockStart) / DAY_MS)) / 7) + 1;
    if (sinceWeek !== periodization.blockWeek) {
      // Only a planned recovery week ends: the post-race weeks or a low-volume week are no recovery week.
      const previousWeek = periodization.blockWeek - 1;
      const lastWeek = periodization.recentWeeks.find((week) => week.blockWeek === previousWeek);
      if (periodization.recoveryWeekDue) signals.push(`A planned recovery week starts (block week ${periodization.blockWeek}).`);
      else if (lastWeek?.plannedRecovery) signals.push("The recovery week is over.");
    }
  }

  const raceGoal = request.running?.raceGoal;
  const raceDate = Date.parse(raceGoal?.raceDate ?? "");
  if (raceGoal && Number.isFinite(raceDate) && Number.isFinite(weekStart)) {
    // From the taper's first week to the end of the race's post-race window.
    const daysToRace = daysBetween(weekStart, raceDate);
    if (daysToRace <= 27 && daysToRace >= -postRaceDaysFor(raceGoal.distanceKm)) {
      signals.push(`Race window: ${daysToRace >= 0 ? `${plural(daysToRace, "day")} to the race` : `${plural(-daysToRace, "day")} after the race`}, so the limits move day by day.`);
    }
    // A new season phase brings its own floors (the day after the post-race
    // window, general preparation needs a quality run and the weekly-km
    // floor), so the plan made in the old phase may change.
    if (Number.isFinite(since)) {
      const planDay = new Date(weekStart + Math.floor((since - weekStart) / DAY_MS) * DAY_MS).toISOString();
      const then = computeSeason(raceGoal, planDay).phase;
      const current = computeSeason(raceGoal, request.weekStart).phase;
      if (then !== current) {
        signals.push(`The season moved from ${seasonPhaseText(then)} to ${seasonPhaseText(current)} since the plan was made.`);
      }
    }
  }

  const strengthDays = new Set(base.profile.trainingDayOffsets);
  if (base.profile.trainingDays.length > 0 && plan.strengthSessions.some((session) => !strengthDays.has(session.dayOffset))) {
    signals.push("Strength training days changed.");
  }
  const runningDays = request.running?.runningDays ?? [];
  const runningOffsets = new Set(request.running?.runningDayOffsets ?? []);
  if (runningDays.length > 0 && plan.runs.some((run) => !runningOffsets.has(run.dayOffset))) {
    signals.push("Running days changed.");
  }
  return [...new Set(signals)];
}

/**
 * Why a new log should change the plan, or null. Pain and very weak feedback
 * come first; then a test result (a new level); then delivered work: clearly
 * more than planned explains a higher effort and is a reason to plan more,
 * not an effort warning. Effort is judged against the plan (effort-flags.ts):
 * near-max ratings count only on work planned below very_hard.
 */
export function logChangeReason(
  log: TrainingLog,
  delivered: DeliveredVsPlanned[] = [],
  exercises?: PlannedSession["exercises"]
): string | null {
  if (log.painLevel >= 4) return `pain ${log.painLevel}/10`;
  if (log.fatigueLevel >= 9) return "very weak session feedback";
  if (testsAGoal(exercises)) {
    const results = testedResults(log, exercises);
    if (results.length > 0) return `test result ${results.join(", ")}`;
  }
  if (didMoreThanPlanned(delivered)) {
    const more = delivered.filter((entry) => entry.overDelivered).map(describeDelivered).join(", ");
    const actual = log.actualRPE ?? log.rpe;
    const effortAbovePlan = log.rpe >= 9 ||
      (typeof log.rpeDelta === "number" && log.rpeDelta >= 2) ||
      (typeof log.plannedRPE === "number" && actual > log.plannedRPE + 1);
    return `did more than planned (${more})${effortAbovePlan ? "; the higher effort came from the extra work" : ""}`;
  }
  if (highEffortOffPlan(log, exercises)) return `RPE ${log.rpe}`;
  if (testsAGoal(exercises)) return null;
  if (typeof log.rpeDelta === "number" && Math.abs(log.rpeDelta) >= 2) {
    return `effort ${Math.abs(log.rpeDelta)} ${log.rpeDelta > 0 ? "above" : "below"} plan`;
  }
  const actual = log.actualRPE ?? log.rpe;
  if (typeof log.plannedRPE === "number" && actual > log.plannedRPE + 1) return `RPE ${actual} against ${log.plannedRPE} planned`;
  return null;
}

/** The logged results of the goal exercises the session tested: "42 push-ups", "95 s plank". */
function testedResults(log: TrainingLog, exercises: PlannedSession["exercises"]): string[] {
  const tested = new Set((exercises ?? [])
    .filter((exercise) => isGoalTest(prescriptionEffort(exercise)))
    .map((exercise) => metricForExercise(exercise.exercise)));
  return GOAL_METRICS
    .filter((metric) => tested.has(metric) && log[LOGGED_FLAG[metric]])
    .map((metric) => (metric === "plankSeconds" ? `${log[metric]} s plank` : `${log[metric]} ${METRIC_PLURAL[metric]}`));
}

export type ContinuityState = { keep: boolean; signals: string[] };

/** The final continuity decision: the context's signals plus wellness and recent-run warnings from the guardrails. */
export function continuityState(context: CoachContext, extraSignals: string[] = []): ContinuityState | null {
  const plan = context.currentPlan;
  if (!plan) return null;
  const signals = [...plan.changeSignals, ...extraSignals];
  return { keep: signals.length === 0, signals };
}

/**
 * Soft check for an unchanged situation: a re-planned run on a day that
 * already had a run of the same kind stays within 15% of its distance
 * (clamped back); other changes (kind, a dropped or added run) are listed in
 * the adjustments, never rejected.
 */
export function keepRunningContinuity(week: RunningWeek, plan: CurrentPlanContext): { week: RunningWeek; adjustments: string[] } {
  const adjustments: string[] = [];
  const tolerance = CONTINUITY_LIMITS.runDistanceTolerance;
  const sessions = week.sessions.map((session) => ({ ...session, target: { ...session.target }, notes: [...session.notes] }));
  for (const previous of plan.runs) {
    const next = sessions.find((session) => session.dayOffset === previous.dayOffset);
    const label = `Continuity, offset ${previous.dayOffset}`;
    if (!next) {
      adjustments.push(`${label}: the planned ${previous.kind ?? ""} run (${previous.title}) was dropped although nothing changed.`.replace("  ", " "));
      continue;
    }
    if (previous.kind && next.kind !== previous.kind) {
      adjustments.push(`${label}: ${previous.kind} changed to ${next.kind} although nothing changed.`);
      continue;
    }
    if (previous.distanceKm === null || previous.distanceKm <= 0) continue;
    const low = round1(previous.distanceKm * (1 - tolerance));
    const high = round1(previous.distanceKm * (1 + tolerance));
    if (next.distanceKm >= low - 0.05 && next.distanceKm <= high + 0.05) continue;
    const before = next.distanceKm;
    const keptKm = before > high ? high : low;
    const ratio = before > 0 ? keptKm / before : 1;
    next.durationMinutes = Math.max(0, Math.round(next.durationMinutes * ratio));
    next.elevationMeters = Math.max(0, Math.round(next.elevationMeters * ratio));
    next.distanceKm = keptKm;
    next.notes.push(`Kept close to the earlier plan (${previous.distanceKm} km): nothing in your training changed since.`);
    adjustments.push(`${label}: ${before} km kept within ${TOLERANCE_PCT}% of the planned ${previous.distanceKm} km (${keptKm} km) because nothing changed.`);
  }
  const previousOffsets = new Set(plan.runs.map((run) => run.dayOffset));
  const lastPlannedOffset = Math.max(0, ...plan.runs.map((run) => run.dayOffset), ...plan.strengthSessions.map((session) => session.dayOffset));
  for (const session of sessions) {
    if (!previousOffsets.has(session.dayOffset) && session.dayOffset <= lastPlannedOffset) {
      adjustments.push(`Continuity, offset ${session.dayOffset}: a ${session.kind} run was added although nothing changed.`);
    }
  }
  return { week: { ...week, sessions }, adjustments };
}

/** Strength continuity is flagged, never clamped: focus and goal targets should match the earlier plan. */
export function strengthContinuityNotes(plan: WeeklyPlan, current: CurrentPlanContext): string[] {
  const adjustments: string[] = [];
  if (!Array.isArray(plan.sessions)) return adjustments;
  for (const previous of current.strengthSessions) {
    const next = plan.sessions.find((session) => session.dayOffset === previous.dayOffset);
    const label = `Continuity, offset ${previous.dayOffset}`;
    if (!next) {
      adjustments.push(`${label}: the planned ${previous.focus} strength session (${previous.title}) was dropped although nothing changed.`);
      continue;
    }
    if (next.focus !== previous.focus) {
      adjustments.push(`${label}: strength focus ${previous.focus} changed to ${next.focus} although nothing changed.`);
    }
    for (const work of previous.goalWork) {
      const match = (next.exercises ?? []).find((exercise) => exercise.exercise === work.exercise);
      const target = match ? (work.exercise === "plank" ? match.seconds : match.reps) : null;
      if (match && (target !== work.target || match.sets !== work.sets)) {
        adjustments.push(`${label}: ${work.exercise} ${work.sets} x ${work.target} changed to ${match.sets} x ${target} although nothing changed.`);
      }
    }
  }
  return adjustments;
}

function isRunSession(session: PlannedSession): boolean {
  return session.discipline === "running" || (typeof session.runKind === "string" && session.runKind.length > 0);
}

function metricName(metric: string): string {
  return Object.hasOwn(METRIC_LABEL, metric) ? METRIC_LABEL[metric as GoalMetric] : metric;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function validIso(value: string | undefined): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}
