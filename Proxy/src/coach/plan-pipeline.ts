import { computeTrainingSignals, type TrainingSignals } from "./planner/compute-training-signals";
import { CONTINUITY_RULE, continuityState, keepRunningContinuity, strengthContinuityNotes, type ContinuityState } from "./planner/current-plan";
import { clampRunningWeek, runningGuardrails, runningGuardrailsForPrompt, type RunningGuardrails } from "./planner/running-guardrails";
import { clampWeeklyPlan, strengthGuardrailsForPrompt } from "./planner/strength-guardrails";
import { strengthMaintenanceReason, validateCombinedWeek } from "./planner/validate-combined-week";
import { validateRunningWeek } from "./planner/validate-running-week";
import { validateWeeklyPlan } from "./planner/validate-week-plan";
import type { CoachContext, RunningWeek, WeeklyPlan } from "./planner/types";

/**
 * generate -> clamp -> validate -> (one repair -> clamp -> validate) for the
 * weekly planners. Both planners get the computed training signals and the
 * exact guardrails the validators enforce. Model calls are injected so the
 * flow is testable without OpenAI.
 */

export type Generated<T> = { ok: true; value: T } | { ok: false; status: number; body: string };
export type RepairInput<T> = { messages: string[]; previousPlan: T };
export type PlannedRunSummary = Pick<RunningWeek["sessions"][number], "dayOffset" | "kind" | "distanceKm" | "elevationMeters">;

export type RunningPlannerGuidance = {
  trainingSignals: TrainingSignals | null;
  guardrails: Record<string, unknown>;
  continuity?: ContinuityGuidance | null;
};

export type StrengthPlannerGuidance = {
  trainingSignals: TrainingSignals | null;
  guardrails: Record<string, unknown>;
  plannedRuns?: PlannedRunSummary[];
  continuity?: ContinuityGuidance | null;
};

/** What the planners are told about keeping coachContext.currentPlan. */
export type ContinuityGuidance = { keepUnlessChanged: boolean; changeSignals: string[]; rule: string };

export type PipelineFailure =
  | { ok: false; reason: "upstream"; status: number; body: string }
  | { ok: false; reason: "validation"; stage: "running" | "strength"; messages: string[]; firstAttemptMessages: string[] };

export type CombinedPipelineResult =
  | {
      ok: true;
      runningWeek: RunningWeek;
      strengthWeek: WeeklyPlan;
      adjustments: string[];
      maintenanceReason: string | null;
      repairs: number;
    }
  | PipelineFailure;

export type StrengthPipelineResult =
  | { ok: true; strengthWeek: WeeklyPlan; adjustments: string[]; repairs: number }
  | PipelineFailure;

type ValidationRecorder = (phase: string, messages: string[], repairAttempt: boolean) => Promise<void>;

export type CombinedPipelineDeps = {
  context: CoachContext;
  now?: Date;
  generateRunning: (guidance: RunningPlannerGuidance, repair?: RepairInput<RunningWeek>) => Promise<Generated<RunningWeek>>;
  generateStrength: (guidance: StrengthPlannerGuidance, repair?: RepairInput<WeeklyPlan>) => Promise<Generated<WeeklyPlan>>;
  recordValidationFailure: ValidationRecorder;
};

export type StrengthPipelineDeps = Omit<CombinedPipelineDeps, "generateRunning">;

export async function runCombinedWeekPipeline(deps: CombinedPipelineDeps): Promise<CombinedPipelineResult> {
  const { context } = deps;
  const now = deps.now ?? new Date();
  const signals = computeTrainingSignals(context, now);
  const guardrails = runningGuardrails(context, { now, signals });
  const continuity = continuityState(context, wellnessChangeSignals(guardrails));
  const continuityGuidance = toContinuityGuidance(continuity);
  const runningGuidance: RunningPlannerGuidance = {
    trainingSignals: signals,
    guardrails: runningGuardrailsForPrompt(guardrails),
    continuity: continuityGuidance
  };

  const running = await generateValidated<RunningWeek>({
    stage: "running",
    generate: (repair) => deps.generateRunning(runningGuidance, repair),
    prepare: (week) => {
      // Continuity first, so the caps still win over a kept distance.
      const kept = continuity?.keep && context.currentPlan
        ? keepRunningContinuity(week, context.currentPlan)
        : { week, adjustments: [] };
      const clamped = clampRunningWeek(kept.week, context, guardrails);
      return { value: clamped.week, adjustments: [...kept.adjustments, ...clamped.adjustments] };
    },
    validate: (week) => validateRunningWeek(week, context, guardrails).messages,
    record: deps.recordValidationFailure
  });
  if (!running.ok) return running;

  const runningWeek = running.value;
  const plannedRuns = runningWeek.sessions.map(({ dayOffset, kind, distanceKm, elevationMeters }) => ({
    dayOffset,
    kind,
    distanceKm,
    elevationMeters
  }));
  const maintenanceReason = strengthMaintenanceReason(runningWeek, context, signals);
  const maintenance = maintenanceReason !== null;
  const strengthGuidance: StrengthPlannerGuidance = {
    trainingSignals: signals,
    guardrails: strengthGuardrailsForPrompt(context, { maintenance, maintenanceReason }),
    plannedRuns,
    continuity: continuityGuidance
  };

  const strength = await generateValidated<WeeklyPlan>({
    stage: "strength",
    generate: (repair) => deps.generateStrength(strengthGuidance, repair),
    prepare: (plan) => {
      const clamped = clampWeeklyPlan(plan, context, { maintenance });
      const notes = continuity?.keep && context.currentPlan ? strengthContinuityNotes(clamped.plan, context.currentPlan) : [];
      return { value: clamped.plan, adjustments: [...clamped.adjustments, ...notes] };
    },
    validate: (plan) => [
      ...validateWeeklyPlan(plan, context, { allowProgressionHoldForRunning: maintenance }).messages,
      ...validateCombinedWeek(runningWeek, plan, context)
    ],
    record: deps.recordValidationFailure
  });
  if (!strength.ok) return strength;

  return {
    ok: true,
    runningWeek,
    strengthWeek: strength.value,
    adjustments: [...running.adjustments, ...strength.adjustments],
    maintenanceReason,
    repairs: running.repairs + strength.repairs
  };
}

export async function runStrengthWeekPipeline(deps: StrengthPipelineDeps): Promise<StrengthPipelineResult> {
  const { context } = deps;
  const signals = computeTrainingSignals(context, deps.now ?? new Date());
  const continuity = continuityState(context);
  const guidance: StrengthPlannerGuidance = {
    trainingSignals: signals,
    guardrails: strengthGuardrailsForPrompt(context),
    continuity: toContinuityGuidance(continuity)
  };
  const strength = await generateValidated<WeeklyPlan>({
    stage: "strength",
    generate: (repair) => deps.generateStrength(guidance, repair),
    prepare: (plan) => {
      const clamped = clampWeeklyPlan(plan, context);
      const notes = continuity?.keep && context.currentPlan ? strengthContinuityNotes(clamped.plan, context.currentPlan) : [];
      return { value: clamped.plan, adjustments: [...clamped.adjustments, ...notes] };
    },
    validate: (plan) => validateWeeklyPlan(plan, context).messages,
    record: deps.recordValidationFailure
  });
  if (!strength.ok) return strength;
  return { ok: true, strengthWeek: strength.value, adjustments: strength.adjustments, repairs: strength.repairs };
}

/** Garmin and recent-run warnings count as change signals for continuity. */
function wellnessChangeSignals(guardrails: RunningGuardrails): string[] {
  return guardrails.relaxations
    .filter((relaxation) => relaxation.code === "wellness_gate" || relaxation.code === "recent_run_distress")
    .map((relaxation) => relaxation.detail);
}

function toContinuityGuidance(continuity: ContinuityState | null): ContinuityGuidance | null {
  return continuity ? { keepUnlessChanged: continuity.keep, changeSignals: continuity.signals, rule: CONTINUITY_RULE } : null;
}

async function generateValidated<T>(input: {
  stage: "running" | "strength";
  generate: (repair?: RepairInput<T>) => Promise<Generated<T>>;
  prepare: (value: T) => { value: T; adjustments: string[] };
  validate: (value: T) => string[];
  record: ValidationRecorder;
}): Promise<{ ok: true; value: T; adjustments: string[]; repairs: number } | PipelineFailure> {
  const first = await input.generate();
  if (!first.ok) return { ok: false, reason: "upstream", status: first.status, body: first.body };
  const firstPrepared = input.prepare(first.value);
  const firstMessages = input.validate(firstPrepared.value);
  if (firstMessages.length === 0) {
    return { ok: true, value: firstPrepared.value, adjustments: firstPrepared.adjustments, repairs: 0 };
  }

  await input.record(`${input.stage}_initial_validation`, firstMessages, false);
  // The repair sees the clamped plan, so it only has to fix what clamping could not.
  const repaired = await input.generate({ messages: firstMessages, previousPlan: firstPrepared.value });
  if (!repaired.ok) return { ok: false, reason: "upstream", status: repaired.status, body: repaired.body };
  const prepared = input.prepare(repaired.value);
  const messages = input.validate(prepared.value);
  if (messages.length > 0) {
    await input.record(`${input.stage}_repair_validation`, messages, true);
    return { ok: false, reason: "validation", stage: input.stage, messages, firstAttemptMessages: firstMessages };
  }
  return { ok: true, value: prepared.value, adjustments: prepared.adjustments, repairs: 1 };
}
