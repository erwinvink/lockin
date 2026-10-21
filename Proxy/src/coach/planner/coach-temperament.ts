import type { CoachContext } from "./types";

const normalProgressionStates = new Set(["building", "plateau", "insufficient_history"]);

export const disciplineCoachTemperament = {
  voice:
    "Calm, direct, standards-driven discipline coach. No hype, no celebrity imitation, no motivational filler, and no soft praise for standing still.",
  standards: [
    "Start from the athlete's actual logs, not from optimism.",
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
  "Clean completion without pain earns a visible next step; pain, missed work, or overreaching earns a clear adjustment."
].join(" ");

export type FlatGoalMetric = {
  metric: "pullUps" | "pushUps" | "plankSeconds";
  label: string;
  latestTarget: number;
  latestVolume: number;
};

export function flatGoalMetricsRequiringProgression(context: CoachContext): FlatGoalMetric[] {
  if (!hasCleanProgressionSignal(context)) return [];

  const checks: Array<["pullUps" | "pushUps" | "plankSeconds", string]> = [
    ["pullUps", "pull-up"],
    ["pushUps", "push-up"],
    ["plankSeconds", "plank"]
  ];

  return checks.flatMap(([metric, label]) => {
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
  if (!normalProgressionStates.has(context.readiness.state)) return false;
  if ((context.adherence.missedLast14Days ?? 0) >= 2) return false;
  return Object.values(context.plannedWork.recentGoalPerformance ?? {}).some((performance) => {
    if (!performance.clean || performance.prescribedTarget === null || performance.delta === null) return false;
    return performance.delta >= 2 || performance.consecutiveCleanCompletionsAtStandard >= 2;
  });
}
