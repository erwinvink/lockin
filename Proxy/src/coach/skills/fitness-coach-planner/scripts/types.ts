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
  notes: string;
};

export type PlannedSession = {
  id: string;
  scheduledDate: string;
  title: string;
  focus: SessionFocus;
  status: string;
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
  maxPain: number;
  maxFatigue: number;
};

export type TrendSummary = {
  pullUpsDelta: number | null;
  pushUpsDelta: number | null;
  plankSecondsDelta: number | null;
  logCountDelta: number;
  label: "improving" | "flat" | "declining" | "insufficient_history";
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
  readiness: {
    state: ContextState;
    riskFlags: string[];
  };
};

export type WeeklyPlan = {
  summary: string;
  contextState: ContextState;
  safetyFlags: string[];
  sessions: Array<{
    title: string;
    dayOffset: number;
    focus: SessionFocus;
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
