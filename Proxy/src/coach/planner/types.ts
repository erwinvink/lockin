export type ExerciseKind =
  | "pullUp"
  | "pushUp"
  | "plank"
  | "scapularPull"
  | "hollowHold"
  | "inclinePushUp"
  | "pikePushUp"
  | "deadHang"
  | "shoulderMobility";

export type SessionFocus = "pull" | "push" | "core" | "mixed" | "recovery";
export type ContextState = "building" | "plateau" | "overreaching" | "recovery_needed" | "insufficient_history";
export type EffortLabel = "light" | "medium" | "hard" | "very_hard" | "max_output";
export type EffortStimulus = "recovery" | "technique" | "volume" | "strength" | "test";

export type PlannedEffort = {
  label: EffortLabel;
  targetRPE: number;
  targetRIR: number;
  stimulus: EffortStimulus;
  reason: string;
};

export type CoachRequest = {
  userId?: string;
  model: string;
  baseline: { pullUps: number; pushUps: number; plankSeconds: number };
  goals: { pullUps: number; pushUps: number; plankSeconds: number };
  profileNotes: string;
  weekStart: string;
  weeklySessions: number;
  trainingDays?: string[];
  trainingDayOffsets?: number[];
  equipment: string[];
  targetDate: string;
  trainingLogs: TrainingLog[];
  plannedSessions: PlannedSession[];
  running?: RunningRequest;
};

export type TrainingLog = {
  id?: string;
  sessionId: string;
  completedAt: string;
  pullUps: number;
  pushUps: number;
  plankSeconds: number;
  loggedPullUps: boolean;
  loggedPushUps: boolean;
  loggedPlankSeconds: boolean;
  rpe: number;
  painLevel: number;
  fatigueLevel: number;
  perceivedEffort?: number;
  plannedRPE?: number;
  actualRPE?: number;
  rpeDelta?: number;
  rpeSummary?: string;
  plannedEffortLabel?: EffortLabel;
  plannedEffortReason?: string;
  howYouFeltScore?: number;
  howYouFelt?: "very_weak" | "weak" | "normal" | "strong" | "very_strong";
  notes: string;
};

export type PlannedSession = {
  id: string;
  scheduledDate: string;
  title: string;
  focus: SessionFocus;
  status: string;
  exercises?: PlannedExercisePrescription[];
};

export type PlannedExercisePrescription = {
  exercise: ExerciseKind;
  sets: number;
  targetReps: number;
  targetSeconds: number;
  plannedEffortLabel?: EffortLabel;
  plannedEffortStimulus?: EffortStimulus;
};

export type MetricSummary = {
  count: number;
  best: number | null;
  latest: number | null;
};

export type MonthSummary = {
  month: string;
  isPartial: boolean;
  logCount: number;
  pullUps: MetricSummary;
  pushUps: MetricSummary;
  plankSeconds: MetricSummary;
  averageRPE: number | null;
  averagePerceivedEffort?: number | null;
  maxPain: number;
  maxFatigue: number;
  worstHowYouFelt?: "very_weak" | "weak" | "normal" | "strong" | "very_strong" | null;
};

export type TrendSummary = {
  pullUpsDelta: number | null;
  pushUpsDelta: number | null;
  plankSecondsDelta: number | null;
  logCountDelta: number;
  label: "improving" | "flat" | "declining" | "insufficient_history";
};

export type RPECalibrationSummary = {
  recentPlannedLogCount: number;
  averageDeltaLast5: number | null;
  abovePlanBy2Count: number;
  belowPlanBy2Count: number;
  latestSummary: string | null;
};

export type CoachContext = {
  profile: {
    baseline: CoachRequest["baseline"];
    goals: CoachRequest["goals"];
    profileNotes: string;
    weekStart: string;
    weeklySessions: number;
    trainingDays: string[];
    trainingDayOffsets: number[];
    equipment: string[];
    targetDate: string;
  };
  history: {
    last5Logs: TrainingLog[];
    rpeCalibration: RPECalibrationSummary;
    currentPartialMonth: MonthSummary;
    lastFullMonth: MonthSummary;
    previousFullMonth: MonthSummary;
    twoFullMonthTrend: TrendSummary;
    bestRecentTests: {
      pullUps: number | null;
      pushUps: number | null;
      plankSeconds: number | null;
    };
  };
  adherence: {
    /** All planned sessions in the request window, including future sessions. */
    planned: number;
    /** Sessions scheduled up to now; future work is excluded from adherence judgement. */
    due?: number;
    future?: number;
    completed: number;
    partial?: number;
    missed: number;
    deload: number;
    pending?: number;
    adherenceScorePct?: number | null;
  };
  plannedWork: {
    todaySessions: Array<{
      id: string;
      title: string;
      status: string;
      focus: SessionFocus;
      scheduledDate: string;
    }>;
    recentGoalTargets: {
      pullUps: PlannedGoalTrend;
      pushUps: PlannedGoalTrend;
      plankSeconds: PlannedGoalTrend;
    };
  };
  readiness: {
    state: ContextState;
    riskFlags: string[];
  };
  running?: RunningContext;
  garmin?: { wellness: GarminWellnessDay[] };
};

export type PlannedGoalTrend = {
  latestTarget: number | null;
  latestVolume: number | null;
  flatCount: number;
  latestDate: string | null;
};

export type WeeklyPlan = {
  summary: string;
  contextState: ContextState;
  safetyFlags: string[];
  sessions: Array<{
    title: string;
    dayOffset: number;
    focus: SessionFocus;
    plannedEffort: PlannedEffort;
    purpose: string;
    estimatedDurationMinutes: number;
    progressionRationale: string;
    safetyNotes: string[];
    loggingFieldsRequired: Array<"pullUps" | "pushUps" | "plankSeconds">;
    exercises: Array<{
      exercise: ExerciseKind;
      sets: number;
      reps: number;
      seconds: number;
      restSeconds: number;
      intensity: string;
      plannedEffort: PlannedEffort;
    }>;
  }>;
};

export type CoachVerdict = {
  headline: string;
  summary: string;
  latestChange: string;
  recommendation: string;
  runningRead: string;
  strengthRead: string;
  nextStep: string;
  watchItems: string[];
  shouldUpdatePlan: boolean;
  contextState: ContextState;
  safetyFlags: string[];
  evaluation?: CoachEvaluation;
  snapshot?: CoachSnapshot;
};

export type CoachEvaluationStatus = "ahead" | "on_track" | "watch" | "behind" | "needs_recovery";
export type CoachAdherenceBand = "excellent" | "on_track" | "watch" | "behind" | "not_enough_due_sessions";
export type CoachProgressState = "improving" | "holding" | "declining" | "not_enough_data";
export type CoachPlanDecisionAction = "keep_plan" | "gate_intensity" | "update_plan" | "recovery_first";

export type CoachEvaluation = {
  status: CoachEvaluationStatus;
  statusLabel: string;
  adherence: {
    standardPct: 80;
    band: CoachAdherenceBand;
    completedPct: number | null;
    dueSessions: number;
    completedSessions: number;
    partialSessions: number;
    deloadSessions: number;
    missedSessions: number;
    futureSessionsExcluded: number;
    rationale: string;
  };
  readiness: {
    state: ContextState;
    painOrFatigueFlag: boolean;
    hrvGate: "ok-for-hard" | "favor-easy" | null;
    trainingReadiness: number | null;
    riskFlags: string[];
    rationale: string;
  };
  progress: {
    state: CoachProgressState;
    trendLabel: TrendSummary["label"];
    flatGoalMetrics: string[];
    rationale: string;
  };
  planDecision: {
    action: CoachPlanDecisionAction;
    shouldUpdatePlan: boolean;
    rationale: string;
  };
  nextAction: string;
};

export type CoachSnapshot = {
  version: 1;
  generatedAt: string;
  status: CoachEvaluationStatus;
  statusLabel: string;
  adherencePct: number | null;
  readinessState: ContextState;
  planDecision: CoachPlanDecisionAction;
  shouldUpdatePlan: boolean;
  nextAction: string;
  facts: string[];
};

export type RunKind = "easy" | "long" | "recovery" | "hills" | "tempo" | "intervals";

export type RunTarget = { type: "pace" | "hr"; low: number; high: number };

export type RunningWeek = {
  summary: string;
  safetyFlags: string[];
  sessions: Array<{
    title: string;
    dayOffset: number;
    kind: RunKind;
    purpose: string;
    distanceKm: number;
    durationMinutes: number;
    elevationMeters: number;
    target: RunTarget;
    zone: string;
    notes: string[];
  }>;
};

export type RunSummary = {
  completedAt: string;
  distanceKm: number;
  movingSeconds: number;
  elevationGainM: number;
  // Descent in meters; drives downhill-conditioning planning (repeated-bout effect).
  elevationLossM?: number;
  averageHr?: number;
  rpe?: number;
  // 1 very weak ... 5 very strong; omitted when the athlete never set it.
  // Carries catastrophic-run signals (feel 1-2) that RPE alone can miss.
  feelScore?: number;
  kind?: string;
};

export type RunningRequest = {
  raceGoal: {
    name: string;
    // ISO-8601 instant, normalized to local start-of-day by the app (same encoder as weekStart, so UTC day-diff math is timezone-stable)
    raceDate: string;
    distanceKm: number;
    elevationGainM: number;
  };
  baselineWeeklyKm: number;
  longestRecentRunKm: number;
  runningDays: string[];
  runningDayOffsets: number[];
  longRunDay?: string;
  // Offset of the long-run day relative to weekStart, computed app-side with the
  // same machinery as runningDayOffsets; omitted when the long-run day is today or past.
  longRunDayOffset?: number;
  recentRuns: RunSummary[];
};

export type GarminWellnessDay = {
  date: string;
  sleepScore: number;
  sleepSeconds: number;
  hrvStatus: string;
  hrvMs: number;
  bodyBattery: number;
  trainingReadiness: number;
  restingHr: number;
};

export type RunningContext = RunningRequest & { weeksToRace: number };
