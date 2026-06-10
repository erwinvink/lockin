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
    planned: number;
    completed: number;
    missed: number;
    deload: number;
  };
  plannedWork: {
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
  shouldUpdatePlan: boolean;
  contextState: ContextState;
  safetyFlags: string[];
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
  averageHr?: number;
  rpe?: number;
  kind?: string;
};

export type RunningRequest = {
  raceGoal: { name: string; raceDate: string; distanceKm: number; elevationGainM: number };
  baselineWeeklyKm: number;
  longestRecentRunKm: number;
  runningDays: string[];
  runningDayOffsets: number[];
  longRunDay?: string;
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
