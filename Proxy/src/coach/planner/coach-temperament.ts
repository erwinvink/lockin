import { GOAL_METRICS, METRIC_LABEL } from "./goal-metrics";
import { NORMAL_READINESS_STATES } from "./readiness-state";
import { strengthPhase, strengthPhaseActive } from "./strength-phase";
import type { CoachContext } from "./types";

/**
 * How every coach prompt reads a session (planner, coach read, chat; the
 * skills spell it out too). The computed signals follow the same rule
 * (delivered-work.ts): effort is judged against the work delivered.
 */
export const DELIVERED_WORK_PRINCIPLE =
  "Judge the work the athlete actually delivered, not only the plan. Clearly more than planned (for example 38 push-ups on a day that asked for 10) explains a higher effort rating and shows the athlete can and wants to do more: plan from the level shown, never less because the athlete did more. The warning signs are effort above plan on work done as planned, falling short of the plan, pain, very weak feedback, and the computed readiness and wellness gates. Lower numbers that simply match a lighter planned week (taper, recovery week, after a race) are not a decline.";

export const disciplineCoachTemperament = {
  voice:
    "Calm, direct, standards-driven discipline coach. No hype, no celebrity imitation, no motivational filler, and no soft praise for standing still.",
  standards: [
    "Start from the athlete's actual logs, not from optimism.",
    DELIVERED_WORK_PRINCIPLE,
    "When recent work is clean, pain is low, and effort is under control, progression is expected.",
    "If numbers are held steady, name the safety or recovery reason clearly.",
    "Treat recovery work as assigned work when readiness is poor.",
    "Use short athlete-facing language: standard, next step, execute, earned progression."
  ],
  avoid: [
    "Do not mention public figures or copy a public figure's exact phrasing.",
    "Do not congratulate stagnation.",
    "Do not turn safety into passivity when readiness is clean."
  ]
} as const;

export const disciplineCoachSystemPrompt = [
  "Use a disciplined accountability-coach temperament.",
  disciplineCoachTemperament.voice,
  "Acknowledge completed work briefly, then point to the next standard.",
  "Clean completion without pain earns a visible next step; pain, missed work, or overreaching earns a clear adjustment.",
  DELIVERED_WORK_PRINCIPLE
].join(" ");

export type FlatGoalMetric = {
  metric: "pullUps" | "pushUps" | "plankSeconds";
  label: string;
  latestTarget: number;
  latestVolume: number;
};

export function flatGoalMetricsRequiringProgression(context: CoachContext): FlatGoalMetric[] {
  if (!hasCleanProgressionSignal(context)) return [];

  // A calibration (effort above plan) holds these metrics this week.
  const calibrated = new Set(context.readiness.calibration?.metrics ?? []);

  return GOAL_METRICS.flatMap((metric) => {
    const label = METRIC_LABEL[metric];
    if (calibrated.has(metric)) return [];
    const performance = context.plannedWork.recentGoalPerformance?.[metric];
    if (
      !performance?.clean ||
      performance.prescribedTarget === null ||
      performance.prescribedSets === null ||
      performance.delta === null
    ) {
      return [];
    }
    const earnedImmediately = performance.delta >= 2;
    const earnedByRepeat =
      performance.latestLoggedBest !== null &&
      performance.latestLoggedBest >= performance.prescribedTarget &&
      performance.consecutiveCleanCompletionsAtStandard >= 2;
    if (!earnedImmediately && !earnedByRepeat) return [];
    return [{
      metric,
      label,
      latestTarget: performance.prescribedTarget,
      latestVolume: performance.prescribedTarget * performance.prescribedSets
    }];
  });
}

export function hasCleanProgressionSignal(context: CoachContext): boolean {
  if (!NORMAL_READINESS_STATES.has(context.readiness.state)) return false;
  // A planned recovery week or the race taper holds the targets on purpose (strength-phase.ts).
  if (strengthPhaseActive(strengthPhase(context))) return false;
  if ((context.adherence.missedLast14Days ?? 0) >= 2) return false;
  return Object.values(context.plannedWork.recentGoalPerformance ?? {}).some((performance) => {
    if (!performance.clean || performance.prescribedTarget === null || performance.delta === null) return false;
    return performance.delta >= 2 || performance.consecutiveCleanCompletionsAtStandard >= 2;
  });
}
