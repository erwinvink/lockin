import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
import { POST_RACE_STRENGTH_TEXT } from "./season";
import { lighterPhaseText, strengthPhase, type StrengthPhase } from "./strength-phase";
import { ROLLING_TREND } from "./summarize-training-history";
import { wellnessGate, WELLNESS_GATE_LIMITS, type WellnessGate } from "./wellness-gate";
import type {
  CoachAdherenceBand,
  CoachEvaluation,
  CoachEvaluationStatus,
  CoachPlanDecisionAction,
  CoachProgressState,
  CoachSnapshot,
  CoachContext
} from "./types";
import type { TrainingSignals } from "./compute-training-signals";

const EXPECTED_ADHERENCE_PCT = 80;
/**
 * Garmin training readiness below this reads watch: a weak signal (heuristic
 * only) the planner does not act on, so on its own it never reads "Needs
 * recovery".
 */
const LOW_TRAINING_READINESS = 40;

/**
 * The coach read. Its readiness is the planner's, from one source: the
 * computed readiness state (readiness-state.ts) and the running planner's
 * wellness gate (wellness-gate.ts; hybrid athletes only, since only the
 * running planner acts on it), so the read never tells the athlete to
 * recover while the plan stays a normal week, or to push on while the plan
 * offloads. Garmin training readiness is the read's own weak signal.
 */
export function evaluateCoachRead(
  context: CoachContext,
  signals: TrainingSignals | null,
  generatedAt = new Date()
): CoachEvaluation & { snapshot: CoachSnapshot } {
  const adherence = evaluateAdherence(context);
  const gate = context.running ? wellnessGate(context.garmin?.wellness ?? [], context.profile.weekStart) : null;
  const readiness = evaluateReadiness(context, signals, gate);
  // The strength phase too: a planned recovery week or the race taper holds
  // the targets on purpose, so the read neither asks for progression nor
  // reads ahead; after a race only the effort is capped.
  const phase = strengthPhase(context);
  const lighterWeek = lighterPhaseText(phase);
  const progress = evaluateProgress(context, phase, lighterWeek);
  const status = chooseStatus({
    band: adherence.band,
    readinessState: context.readiness.state,
    wellnessGated: gate !== null,
    trainingReadiness: readiness.trainingReadiness,
    progressState: progress.state,
    lighterWeek: lighterWeek !== null
  });
  const planDecision = choosePlanDecision(context, status, progress.flatGoalMetrics, lighterWeek);
  const nextAction = chooseNextAction(context, status, planDecision.action);
  const statusLabel = statusLabelFor(status);
  const evaluation: CoachEvaluation = {
    status,
    statusLabel,
    adherence,
    readiness,
    progress,
    planDecision,
    nextAction
  };

  return {
    ...evaluation,
    snapshot: buildSnapshot(evaluation, generatedAt)
  };
}

function evaluateAdherence(context: CoachContext): CoachEvaluation["adherence"] {
  const dueSessions = context.adherence.due ?? context.adherence.planned;
  const completedSessions = context.adherence.completed;
  const partialSessions = context.adherence.partial ?? 0;
  const deloadSessions = context.adherence.deload;
  const missedSessions = context.adherence.missed + (context.adherence.pending ?? 0);
  const futureSessionsExcluded = context.adherence.future ?? 0;
  const completedPct = context.adherence.adherenceScorePct ?? (
    dueSessions > 0
      ? Math.round(((completedSessions + deloadSessions + partialSessions * 0.5) / dueSessions) * 100)
      : null
  );
  const band = adherenceBand(completedPct);
  return {
    standardPct: EXPECTED_ADHERENCE_PCT,
    band,
    completedPct,
    dueSessions,
    completedSessions,
    partialSessions,
    deloadSessions,
    missedSessions,
    futureSessionsExcluded,
    rationale: adherenceRationale(band, completedPct, dueSessions, futureSessionsExcluded)
  };
}

function evaluateReadiness(context: CoachContext, signals: TrainingSignals | null, gate: WellnessGate | null): CoachEvaluation["readiness"] {
  const trainingReadiness = signals?.wellness?.trainingReadiness ?? null;
  return {
    state: context.readiness.state,
    // The planner's state: logged pain of 4 or more or very weak feedback in
    // the recent window (readiness-flags.ts). A month-level pain flag is a
    // watch item, and Garmin numbers alone never call for recovery.
    painOrFatigueFlag: context.readiness.state === "recovery_needed",
    hrvGate: signals?.wellness?.hrvGate ?? null,
    trainingReadiness,
    riskFlags: context.readiness.riskFlags,
    rationale: readinessRationale(context.readiness, gate, trainingReadiness)
  };
}

function evaluateProgress(context: CoachContext, phase: StrengthPhase, lighterWeek: string | null): CoachEvaluation["progress"] {
  const flatGoalMetrics = flatGoalMetricsRequiringProgression(context).map((metric) => metric.label);
  const rolling = context.history.rollingTrend !== undefined;
  const trendLabel = (context.history.rollingTrend ?? context.history.twoFullMonthTrend).label;
  const state: CoachProgressState = (() => {
    // The planner's state: with too little history it judges no trend (and plans a normal week).
    if (context.readiness.state === "insufficient_history") return "not_enough_data";
    switch (trendLabel) {
      case "improving":
        return "improving";
      case "flat":
        return "holding";
      case "declining":
        return "declining";
      case "insufficient_history":
        return "not_enough_data";
    }
  })();

  return {
    state,
    trendLabel,
    flatGoalMetrics,
    rationale: lighterWeek
      ? `${lighterWeek}. Strength is lighter on purpose and the targets hold; no progression is expected this week.`
      : `${progressRationale(state, flatGoalMetrics, rolling)}${phase.postRace ? ` After the race running recovers first while ${POST_RACE_STRENGTH_TEXT}.` : ""}`
  };
}

function adherenceBand(completedPct: number | null): CoachAdherenceBand {
  if (completedPct === null) return "not_enough_due_sessions";
  if (completedPct >= 90) return "excellent";
  if (completedPct >= EXPECTED_ADHERENCE_PCT) return "on_track";
  if (completedPct >= 60) return "watch";
  return "behind";
}

/**
 * Readiness first, from the planner's own state: recovery_needed reads
 * needs recovery; overreaching (the planner's strength offload, a rolling
 * decline included) reads watch, never behind; the planner's wellness gate
 * or a low Garmin training readiness reads watch. Then adherence and
 * progress. A decline the planner does not act on (too little history) is
 * no status: "behind" comes from adherence.
 */
function chooseStatus({ band, readinessState, wellnessGated, trainingReadiness, progressState, lighterWeek }: {
  band: CoachAdherenceBand;
  readinessState: CoachContext["readiness"]["state"];
  wellnessGated: boolean;
  trainingReadiness: number | null;
  progressState: CoachProgressState;
  /** A planned recovery week or the race taper: lighter on purpose. */
  lighterWeek: boolean;
}): CoachEvaluationStatus {
  if (readinessState === "recovery_needed") return "needs_recovery";
  if (readinessState === "overreaching") return "watch";
  if (wellnessGated || (typeof trainingReadiness === "number" && trainingReadiness < LOW_TRAINING_READINESS)) return "watch";
  if (band === "behind") return "behind";
  if (band === "watch") return "watch";
  // A planned lighter week is on track, not ahead: the plan holds on purpose.
  if (band === "excellent" && progressState === "improving" && !lighterWeek) return "ahead";
  return "on_track";
}

function choosePlanDecision(
  context: CoachContext,
  status: CoachEvaluationStatus,
  flatGoalMetrics: string[],
  lighterWeek: string | null
): CoachEvaluation["planDecision"] {
  if (context.adherence.planned === 0) {
    return decision("update_plan", true, "No current sessions are planned, so Lockin should create the next useful week.");
  }
  if (status === "needs_recovery") {
    return decision("recovery_first", true, "Readiness is the limiter, so recovery comes before more load.");
  }
  if (context.plannedWork.todaySessions.length > 0 && status === "watch") {
    return decision("gate_intensity", false, "Today can stay on the calendar, but intensity should be capped if the body does not come around.");
  }
  if (lighterWeek) {
    return decision("keep_plan", false, `${lighterWeek}. The lighter plan is the right structure: hold the targets.`);
  }
  if (flatGoalMetrics.length > 0) {
    return decision("update_plan", true, `Recent ${flatGoalMetrics.join(", ")} work needs visible progression.`);
  }
  return decision("keep_plan", false, "The current plan is still the right structure; execution is the lever.");
}

function decision(action: CoachPlanDecisionAction, shouldUpdatePlan: boolean, rationale: string): CoachEvaluation["planDecision"] {
  return { action, shouldUpdatePlan, rationale };
}

function chooseNextAction(
  context: CoachContext,
  status: CoachEvaluationStatus,
  planDecision: CoachPlanDecisionAction
): string {
  const today = context.plannedWork.todaySessions[0];
  if (status === "needs_recovery") {
    return today
      ? `Make ${today.title} easy today, or skip it if pain or fatigue is still high.`
      : "Take recovery today and return to the next planned session only if readiness improves.";
  }
  if (planDecision === "update_plan" && context.adherence.planned === 0) {
    return "Hold steady while Lockin prepares the next week; do not add random extra work.";
  }
  if (status === "behind") {
    return today
      ? `Do ${today.title} at the planned effort and log it.`
      : "Do the next planned session at the planned effort and log it.";
  }
  if (status === "watch" || planDecision === "gate_intensity") {
    return today
      ? `Start ${today.title} conservatively and stop before pain or heavy fatigue climbs.`
      : "Keep the next planned session conservative unless readiness is clearly normal.";
  }
  if (today) {
    return `Complete ${today.title} as planned and log the result.`;
  }
  return "Rest today and be ready for the next planned session.";
}

function buildSnapshot(evaluation: CoachEvaluation, generatedAt: Date): CoachSnapshot {
  return {
    version: 1,
    generatedAt: generatedAt.toISOString(),
    status: evaluation.status,
    statusLabel: evaluation.statusLabel,
    adherencePct: evaluation.adherence.completedPct,
    readinessState: evaluation.readiness.state,
    planDecision: evaluation.planDecision.action,
    shouldUpdatePlan: evaluation.planDecision.shouldUpdatePlan,
    nextAction: evaluation.nextAction,
    facts: [
      `Adherence ${evaluation.adherence.completedPct === null ? "not ready" : `${evaluation.adherence.completedPct}%`}`,
      `Readiness ${evaluation.readiness.state.replaceAll("_", " ")}`,
      `Progress ${evaluation.progress.state.replaceAll("_", " ")}`,
      `Plan ${evaluation.planDecision.action.replaceAll("_", " ")}`
    ]
  };
}

function statusLabelFor(status: CoachEvaluationStatus): string {
  switch (status) {
    case "ahead":
      return "Ahead";
    case "on_track":
      return "On track";
    case "watch":
      return "Watch";
    case "behind":
      return "Behind";
    case "needs_recovery":
      return "Needs recovery";
  }
}

function adherenceRationale(
  band: CoachAdherenceBand,
  completedPct: number | null,
  dueSessions: number,
  futureSessionsExcluded: number
): string {
  if (completedPct === null) {
    return futureSessionsExcluded > 0
      ? "No sessions are due yet, so future planned sessions are excluded from the score."
      : "No sessions are due yet, so adherence is not judged.";
  }
  const suffix = futureSessionsExcluded > 0 ? ` ${futureSessionsExcluded} future session${futureSessionsExcluded === 1 ? "" : "s"} excluded.` : "";
  switch (band) {
    case "excellent":
      return `${completedPct}% across ${dueSessions} due session${dueSessions === 1 ? "" : "s"} is excellent.${suffix}`;
    case "on_track":
      return `${completedPct}% meets the 80% adherence standard.${suffix}`;
    case "watch":
      return `${completedPct}% is below the 80% standard but still recoverable.${suffix}`;
    case "behind":
      return `${completedPct}% is behind the 80% adherence standard.${suffix}`;
    case "not_enough_due_sessions":
      return "No due sessions yet.";
  }
}

function readinessRationale(
  readiness: CoachContext["readiness"],
  gate: WellnessGate | null,
  trainingReadiness: number | null
): string {
  if (readiness.state === "recovery_needed") return "Pain or fatigue signals put recovery first.";
  if (readiness.state === "overreaching") {
    return `${readiness.reason ?? "Recent strength sessions point to overreaching."} The strength plan eases off for a few days.`;
  }
  if (gate) return `Latest wellness favors easy work for the next ${WELLNESS_GATE_LIMITS.gateHours} hours: ${gate.why}.`;
  if (typeof trainingReadiness === "number" && trainingReadiness < LOW_TRAINING_READINESS) {
    return `Training readiness is low at ${trainingReadiness}: a weak signal on its own, so start conservatively; the plan stays as it is.`;
  }
  return "No current readiness gate is blocking normal work.";
}

function progressRationale(state: CoachProgressState, flatGoalMetrics: string[], rolling: boolean): string {
  if (flatGoalMetrics.length > 0) {
    return `Recent ${flatGoalMetrics.join(", ")} targets have repeated and need progression when readiness allows.`;
  }
  // The label comes from the rolling windows when they exist, else from the two full months.
  const weeks = ROLLING_TREND.windowDays / 7;
  const compared = rolling ? `Your best results of the last ${weeks} weeks are` : "Recent month-to-month training metrics are";
  switch (state) {
    case "improving":
      return rolling ? `${compared} above the ${weeks} weeks before.` : `${compared} improving.`;
    case "holding":
      return "Progress is holding rather than clearly moving forward.";
    case "declining":
      return rolling ? `${compared} below the ${weeks} weeks before.` : `${compared} declining.`;
    case "not_enough_data":
      return "There is not enough clean history to judge progress yet.";
  }
}
