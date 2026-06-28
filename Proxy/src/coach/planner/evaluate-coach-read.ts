import { flatGoalMetricsRequiringProgression } from "./coach-temperament";
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

export function evaluateCoachRead(
  context: CoachContext,
  signals: TrainingSignals | null,
  generatedAt = new Date()
): CoachEvaluation & { snapshot: CoachSnapshot } {
  const adherence = evaluateAdherence(context);
  const readiness = evaluateReadiness(context, signals);
  const progress = evaluateProgress(context);
  const status = chooseStatus(
    adherence.band,
    readiness.painOrFatigueFlag,
    context.readiness.state,
    readiness.hrvGate,
    readiness.trainingReadiness,
    progress.state
  );
  const planDecision = choosePlanDecision(context, status, readiness.painOrFatigueFlag, progress.flatGoalMetrics);
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

function evaluateReadiness(context: CoachContext, signals: TrainingSignals | null): CoachEvaluation["readiness"] {
  const hrvGate = signals?.wellness?.hrvGate ?? null;
  const trainingReadiness = signals?.wellness?.trainingReadiness ?? null;
  const riskFlags = context.readiness.riskFlags;
  const painOrFatigueFlag =
    context.readiness.state === "recovery_needed" ||
    (typeof trainingReadiness === "number" && trainingReadiness < 30) ||
    riskFlags.some((flag) => flag.includes("pain") || flag.includes("fatigue") || flag.includes("weak"));

  return {
    state: context.readiness.state,
    painOrFatigueFlag,
    hrvGate,
    trainingReadiness,
    riskFlags,
    rationale: readinessRationale(context.readiness.state, painOrFatigueFlag, hrvGate, trainingReadiness)
  };
}

function evaluateProgress(context: CoachContext): CoachEvaluation["progress"] {
  const flatGoalMetrics = flatGoalMetricsRequiringProgression(context).map((metric) => metric.label);
  const trendLabel = context.history.twoFullMonthTrend.label;
  const state: CoachProgressState = (() => {
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
    rationale: progressRationale(state, flatGoalMetrics)
  };
}

function adherenceBand(completedPct: number | null): CoachAdherenceBand {
  if (completedPct === null) return "not_enough_due_sessions";
  if (completedPct >= 90) return "excellent";
  if (completedPct >= EXPECTED_ADHERENCE_PCT) return "on_track";
  if (completedPct >= 60) return "watch";
  return "behind";
}

function chooseStatus(
  band: CoachAdherenceBand,
  painOrFatigueFlag: boolean,
  readinessState: CoachContext["readiness"]["state"],
  hrvGate: "ok-for-hard" | "favor-easy" | null,
  trainingReadiness: number | null,
  progressState: CoachProgressState
): CoachEvaluationStatus {
  if (painOrFatigueFlag || readinessState === "recovery_needed") return "needs_recovery";
  if (hrvGate === "favor-easy" || (typeof trainingReadiness === "number" && trainingReadiness < 40)) return "watch";
  if (band === "behind" || progressState === "declining") return "behind";
  if (band === "watch" || readinessState === "overreaching") return "watch";
  if (band === "excellent" && progressState === "improving") return "ahead";
  return "on_track";
}

function choosePlanDecision(
  context: CoachContext,
  status: CoachEvaluationStatus,
  painOrFatigueFlag: boolean,
  flatGoalMetrics: string[]
): CoachEvaluation["planDecision"] {
  if (context.adherence.planned === 0) {
    return decision("update_plan", true, "No current sessions are planned, so Lockin should create the next useful week.");
  }
  if (status === "needs_recovery" && painOrFatigueFlag) {
    return decision("recovery_first", true, "Readiness is the limiter, so recovery comes before more load.");
  }
  if (context.plannedWork.todaySessions.length > 0 && status === "watch") {
    return decision("gate_intensity", false, "Today can stay on the calendar, but intensity should be capped if the body does not come around.");
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
  state: CoachContext["readiness"]["state"],
  painOrFatigueFlag: boolean,
  hrvGate: "ok-for-hard" | "favor-easy" | null,
  trainingReadiness: number | null
): string {
  if (state === "recovery_needed") return "Pain or fatigue signals put recovery first.";
  if (hrvGate === "favor-easy") return "Latest wellness favors easy work today.";
  if (typeof trainingReadiness === "number" && trainingReadiness < 40) return `Training readiness is low at ${trainingReadiness}.`;
  if (painOrFatigueFlag) return "Recent feedback contains a pain or fatigue warning.";
  return "No current readiness gate is blocking normal work.";
}

function progressRationale(state: CoachProgressState, flatGoalMetrics: string[]): string {
  if (flatGoalMetrics.length > 0) {
    return `Recent ${flatGoalMetrics.join(", ")} targets have repeated and need progression when readiness allows.`;
  }
  switch (state) {
    case "improving":
      return "Recent month-to-month training metrics are improving.";
    case "holding":
      return "Progress is holding rather than clearly moving forward.";
    case "declining":
      return "Recent month-to-month training metrics are declining.";
    case "not_enough_data":
      return "There is not enough clean history to judge progress yet.";
  }
}
