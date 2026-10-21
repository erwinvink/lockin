import type { CoachContext, CoachEvaluation, CoachSnapshot, CoachVerdict } from "./types";

export function normalizeCoachVerdict(
  verdict: CoachVerdict,
  context: CoachContext,
  evaluation: CoachEvaluation & { snapshot: CoachSnapshot }
): CoachVerdict {
  const summary = athleteFacingText(verdict.summary);
  const latestChange = athleteFacingText(verdict.latestChange);
  const recommendation = athleteFacingText(verdict.recommendation);
  const nextStep = athleteFacingText(verdict.nextStep || recommendation);

  return {
    ...verdict,
    headline: athleteFacingText(verdict.headline),
    summary,
    latestChange,
    recommendation,
    runningRead: athleteFacingText(verdict.runningRead || latestChange),
    strengthRead: athleteFacingText(verdict.strengthRead || recommendation),
    nextStep: athleteFacingText(evaluation.nextAction || nextStep),
    watchItems: humanWatchItems(verdict.watchItems, [...context.readiness.riskFlags, ...verdict.safetyFlags]),
    contextState: context.readiness.state,
    shouldUpdatePlan: evaluation.planDecision.shouldUpdatePlan,
    evaluation,
    snapshot: evaluation.snapshot
  };
}

function athleteFacingText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replaceAll("averageDeltaLast5", "recent effort trend")
    .replaceAll("abovePlanBy2Count", "sessions harder than planned")
    .replaceAll("maxPain", "highest pain")
    .replaceAll("rpe", "RPE")
    .replaceAll("RPE RPE", "RPE")
    .replaceAll("recent_pain_level_4_or_higher", "pain reached 4/10 recently")
    .replaceAll("recent_effort_above_plan", "effort has been higher than planned")
    .replaceAll("_", " ")
    .trim();
}

function humanWatchItems(items: string[] | undefined, flags: string[]): string[] {
  const combined = [
    ...(items ?? []).map(athleteFacingText),
    ...flags.map(humanizeReadinessFlag)
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(combined)].slice(0, 3);
}

function humanizeReadinessFlag(flag: string): string {
  switch (flag) {
    case "recent_pain_level_4_or_higher":
      return "Pain reached 4/10 recently";
    case "recent_how_you_felt_very_weak":
      return "Recent session feedback was very weak";
    case "repeated_high_perceived_effort":
      return "Several recent sessions were very hard";
    case "recent_effort_above_plan":
      return "Effort has been higher than planned";
    case "last_full_month_pain_flag":
      return "Pain has shown up across the month";
    case "last_full_month_how_you_felt_very_weak":
      return "Fatigue has been high this month";
    case "low_last_full_month_training_count":
      return "Training consistency was low last month";
    case "sudden_monthly_volume_increase":
      return "Training volume jumped recently";
    case "insufficient_training_history":
      return "Not enough recent training history yet";
    default:
      return athleteFacingText(flag)
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}
