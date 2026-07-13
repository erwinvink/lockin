import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildCoachContext } from "./planner/build-coach-context";
import type { CoachRequest, RunningWeek, WeeklyPlan } from "./planner/types";

export type AutoPlanSource = "manual" | "post_training" | "app_active" | "nightly";
export type AutoPlanStatus = "idle" | "queued" | "generating" | "generated" | "skipped" | "retrying" | "failed";
export type AutoPlanAction = "generate" | "queue" | "skip";

export type AutoPlanGeneratedPlan = {
  planRevisionId: string;
  generatedAt: string;
  localDate: string;
  weekStart: string;
  source: AutoPlanSource;
  summary: string;
  strengthWeek?: WeeklyPlan;
  runningWeek?: RunningWeek;
  combinedWeek?: {
    summary: string;
    safetyFlags: string[];
    runningWeek: RunningWeek;
    strengthWeek: WeeklyPlan;
  };
};

export type AutoPlanUserState = {
  userId: string;
  status: AutoPlanStatus;
  timeZone: string;
  latestRequest: CoachRequest | null;
  latestRequestHash: string | null;
  latestTrainingHash: string | null;
  lastTriggerSource: AutoPlanSource | null;
  lastTriggerReason: string | null;
  lastTriggeredAt: string | null;
  lastGeneratedAt: string | null;
  lastGeneratedLocalDate: string | null;
  lastNightlyGeneratedLocalDate: string | null;
  lastPostTrainingGeneratedLocalDate: string | null;
  lastGeneratedHash: string | null;
  lastSkippedAt: string | null;
  nextNightlyRunAt: string | null;
  nextRetryAt: string | null;
  failureCount: number;
  lastError: string | null;
  planRevisionId: string | null;
  generatedPlan: AutoPlanGeneratedPlan | null;
  updatedAt: string;
};

export type AutoPlanStateFile = {
  version: 1;
  users: Record<string, AutoPlanUserState>;
};

export type AutoPlanTrigger = {
  source: AutoPlanSource;
  request: CoachRequest;
  force?: boolean;
  reason?: string;
  timeZone?: string;
};

export type AutoPlanDecision = {
  action: AutoPlanAction;
  source: AutoPlanSource;
  message: string;
  userId: string;
  localDate: string;
  contextHash: string;
  trainingHash: string;
  nextNightlyRunAt: string;
  generatedPlan?: AutoPlanGeneratedPlan | null;
};

export type AutoPlanStatusResponse = {
  userId: string;
  status: AutoPlanStatus;
  message: string;
  source: AutoPlanSource | null;
  reason: string | null;
  timeZone: string;
  lastTriggeredAt: string | null;
  lastGeneratedAt: string | null;
  nextNightlyRunAt: string | null;
  nextRetryAt: string | null;
  lastError: string | null;
  planRevisionId: string | null;
  generatedPlan: AutoPlanGeneratedPlan | null;
};

type AutoPlanStoreOptions = {
  now?: () => Date;
};

export class AutoPlanStore {
  private updateQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath = defaultAutoPlanStatePath(),
    private readonly options: AutoPlanStoreOptions = {}
  ) {}

  async read(): Promise<AutoPlanStateFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AutoPlanStateFile>;
      if (parsed.version !== 1 || typeof parsed.users !== "object" || parsed.users === null) {
        return emptyAutoPlanState();
      }
      return { version: 1, users: parsed.users as Record<string, AutoPlanUserState> };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyAutoPlanState();
      }
      throw error;
    }
  }

  async write(state: AutoPlanStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  async updateUser<T>(
    userId: string,
    mutate: (user: AutoPlanUserState, state: AutoPlanStateFile) => T | Promise<T>
  ): Promise<T> {
    const previousUpdate = this.updateQueue;
    let releaseUpdate: () => void = () => {};
    this.updateQueue = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    await previousUpdate;

    try {
      const state = await this.read();
      const now = this.now().toISOString();
      const user = state.users[userId] ?? emptyUser(userId, now);
      state.users[userId] = user;
      const result = await mutate(user, state);
      user.updatedAt = this.now().toISOString();
      await this.write(state);
      return result;
    } finally {
      releaseUpdate();
    }
  }

  async usersDueForNightly(now: Date = this.now()): Promise<AutoPlanUserState[]> {
    const state = await this.read();
    return Object.values(state.users).filter((user) => {
      return Boolean(user.latestRequest) && Boolean(user.nextNightlyRunAt) && Date.parse(user.nextNightlyRunAt ?? "") <= now.getTime();
    });
  }

  now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

export function prepareAutoPlanTrigger(
  user: AutoPlanUserState,
  trigger: AutoPlanTrigger,
  now: Date = new Date()
): AutoPlanDecision {
  const request = trigger.request;
  const timeZone = normalizedTimeZone(trigger.timeZone || user.timeZone);
  const localDate = localDateKey(now, timeZone);
  const contextHash = stableHash(request);
  const trainingHash = stableHash(trainingDigest(request));
  const nextNightlyRunAt = nextNightlyRun(now, timeZone).toISOString();
  const source = trigger.source;
  const force = trigger.force === true || source === "manual";

  user.timeZone = timeZone;
  user.latestRequest = request;
  user.latestRequestHash = contextHash;
  user.latestTrainingHash = trainingHash;
  user.lastTriggerSource = source;
  user.lastTriggerReason = cleanString(trigger.reason) || defaultReasonFor(source);
  user.lastTriggeredAt = now.toISOString();
  user.nextNightlyRunAt = nextNightlyRunAt;
  user.lastError = null;

  const decision = decideAutoPlan(user, {
    source,
    force,
    localDate,
    contextHash,
    trainingHash,
    now,
    nextNightlyRunAt
  });

  if (decision.action === "generate") {
    user.status = "generating";
    user.nextRetryAt = null;
  } else if (decision.action === "queue") {
    user.status = "queued";
    user.nextRetryAt = decision.nextNightlyRunAt;
  } else {
    user.status = "skipped";
    user.lastSkippedAt = now.toISOString();
    user.nextRetryAt = null;
  }

  return decision;
}

export function markAutoPlanGenerated(
  user: AutoPlanUserState,
  decision: AutoPlanDecision,
  generatedPlan: Omit<AutoPlanGeneratedPlan, "planRevisionId" | "generatedAt" | "localDate" | "source">
): AutoPlanGeneratedPlan {
  const now = new Date().toISOString();
  const plan: AutoPlanGeneratedPlan = {
    ...generatedPlan,
    planRevisionId: randomUUID(),
    generatedAt: now,
    localDate: decision.localDate,
    source: decision.source
  };

  user.status = "generated";
  user.lastGeneratedAt = now;
  user.lastGeneratedLocalDate = decision.localDate;
  user.lastGeneratedHash = decision.contextHash;
  user.planRevisionId = plan.planRevisionId;
  user.generatedPlan = plan;
  user.failureCount = 0;
  user.nextRetryAt = null;
  user.lastError = null;
  if (decision.source === "nightly" || decision.source === "app_active") {
    user.lastNightlyGeneratedLocalDate = decision.localDate;
  }
  if (decision.source === "post_training") {
    user.lastPostTrainingGeneratedLocalDate = decision.localDate;
  }
  return plan;
}

export function markAutoPlanFailed(user: AutoPlanUserState, error: string, now: Date = new Date()): void {
  user.failureCount += 1;
  user.status = user.failureCount >= 3 ? "failed" : "retrying";
  user.lastError = error;
  user.nextRetryAt = new Date(now.getTime() + retryDelayMs(user.failureCount)).toISOString();
}

export function toAutoPlanStatus(user: AutoPlanUserState | null, userId: string, now: Date = new Date()): AutoPlanStatusResponse {
  const fallback = user ?? emptyUser(userId, now.toISOString());
  return {
    userId,
    status: fallback.status,
    message: messageFor(fallback),
    source: fallback.lastTriggerSource,
    reason: fallback.lastTriggerReason,
    timeZone: fallback.timeZone,
    lastTriggeredAt: fallback.lastTriggeredAt,
    lastGeneratedAt: fallback.lastGeneratedAt,
    nextNightlyRunAt: fallback.nextNightlyRunAt,
    nextRetryAt: fallback.nextRetryAt,
    lastError: fallback.lastError,
    planRevisionId: fallback.planRevisionId,
    generatedPlan: fallback.generatedPlan
  };
}

export function emptyAutoPlanState(): AutoPlanStateFile {
  return { version: 1, users: {} };
}

function decideAutoPlan(
  user: AutoPlanUserState,
  input: {
    source: AutoPlanSource;
    force: boolean;
    localDate: string;
    contextHash: string;
    trainingHash: string;
    now: Date;
    nextNightlyRunAt: string;
  }
): AutoPlanDecision {
  const base = {
    source: input.source,
    userId: user.userId,
    localDate: input.localDate,
    contextHash: input.contextHash,
    trainingHash: input.trainingHash,
    nextNightlyRunAt: input.nextNightlyRunAt,
    generatedPlan: user.generatedPlan
  };

  if (input.force) {
    return { ...base, action: "generate", message: "Generating a fresh plan now." };
  }

  if (input.source === "post_training") {
    if (user.lastPostTrainingGeneratedLocalDate === input.localDate) {
      return { ...base, action: "skip", message: "Post-training planning already ran today." };
    }
    if (!postTrainingSignalsNeedPlan(user.latestRequest, input.now)) {
      return { ...base, action: "skip", message: "Coach read updated; the rest of the week can stay as planned." };
    }
    return { ...base, action: "generate", message: "Latest training changed enough to recheck the future plan." };
  }

  if (input.source === "nightly") {
    if (user.lastNightlyGeneratedLocalDate === input.localDate && user.lastGeneratedHash === input.contextHash) {
      return { ...base, action: "skip", message: "Nightly planning already checked today's context." };
    }
    return { ...base, action: "generate", message: "Running the overnight plan refresh." };
  }

  if (input.source === "app_active") {
    if (user.nextNightlyRunAt && Date.parse(user.nextNightlyRunAt) <= input.now.getTime()) {
      return { ...base, action: "generate", message: "Catching up the overnight plan refresh." };
    }
    return { ...base, action: "queue", message: "Automatic planning is queued for tonight." };
  }

  return { ...base, action: "skip", message: "No automatic planning work is due." };
}

function postTrainingSignalsNeedPlan(request: CoachRequest | null, now: Date): boolean {
  if (!request) {
    return false;
  }
  const futurePlanned = request.plannedSessions.filter((session) => {
    return session.status === "planned" && Date.parse(session.scheduledDate) > now.getTime();
  });
  if (futurePlanned.length === 0) {
    return true;
  }

  const latestLog = [...request.trainingLogs]
    .filter((log) => Number.isFinite(Date.parse(log.completedAt)))
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
  if (latestLog) {
    if (latestLog.painLevel >= 4 || latestLog.fatigueLevel >= 9 || latestLog.rpe >= 9) {
      return true;
    }
    if (typeof latestLog.rpeDelta === "number" && Math.abs(latestLog.rpeDelta) >= 2) {
      return true;
    }
    const actualRPE = latestLog.actualRPE ?? latestLog.rpe;
    if (typeof latestLog.plannedRPE === "number" && actualRPE > latestLog.plannedRPE + 1) {
      return true;
    }
  }

  const matchedPerformance = Object.values(buildCoachContext(request, now).plannedWork.recentGoalPerformance ?? {});
  if (matchedPerformance.some((performance) => {
    if (performance.completedAt !== latestLog?.completedAt || performance.delta === null) return false;
    if (performance.delta !== 0) return true;
    return performance.clean === true && performance.consecutiveCleanCompletionsAtStandard >= 2;
  })) {
    return true;
  }

  const latestRun = [...(request.running?.recentRuns ?? [])]
    .filter((run) => Number.isFinite(Date.parse(run.completedAt)))
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))[0];
  if (latestRun) {
    if ((latestRun.feelScore ?? 3) <= 2 || (latestRun.rpe ?? 0) >= 9) {
      return true;
    }
  }

  return request.plannedSessions.some((session) => session.status === "missed" || session.status === "deload");
}

function trainingDigest(request: CoachRequest): Record<string, unknown> {
  return {
    weekStart: request.weekStart,
    planned: request.plannedSessions.map((session) => ({
      id: session.id,
      scheduledDate: session.scheduledDate,
      status: session.status
    })),
    logs: request.trainingLogs.map((log) => ({
      id: log.id,
      sessionId: log.sessionId,
      completedAt: log.completedAt,
      rpe: log.rpe,
      painLevel: log.painLevel,
      fatigueLevel: log.fatigueLevel,
      plannedRPE: log.plannedRPE,
      actualRPE: log.actualRPE,
      rpeDelta: log.rpeDelta,
      pullUps: log.pullUps,
      pushUps: log.pushUps,
      plankSeconds: log.plankSeconds,
      loggedPullUps: log.loggedPullUps,
      loggedPushUps: log.loggedPushUps,
      loggedPlankSeconds: log.loggedPlankSeconds
    })),
    runs: request.running?.recentRuns.map((run) => ({
      completedAt: run.completedAt,
      distanceKm: run.distanceKm,
      rpe: run.rpe,
      feelScore: run.feelScore
    })) ?? []
  };
}

export function refreshRequestForNightly(
  request: CoachRequest,
  now: Date,
  timeZone: string
): CoachRequest {
  const normalizedZone = normalizedTimeZone(timeZone);
  const parts = localDateParts(now, normalizedZone);
  const localStart = zonedDateTimeToUTC(parts.year, parts.month, parts.day, 0, 0, normalizedZone);
  const strengthOffsets = futureOffsetsForWeekdays(request.trainingDays ?? [], now, normalizedZone);
  const runningOffsets = futureOffsetsForWeekdays(request.running?.runningDays ?? [], now, normalizedZone);
  const longRunDayOffset = request.running?.longRunDay
    ? futureOffsetsForWeekdays([request.running.longRunDay], now, normalizedZone)[0]
    : undefined;

  return {
    ...request,
    weekStart: localStart.toISOString(),
    trainingDayOffsets: strengthOffsets,
    plannedSessions: request.plannedSessions.filter((session) => {
      const scheduled = Date.parse(session.scheduledDate);
      return session.status !== "planned" || !Number.isFinite(scheduled) || scheduled >= localStart.getTime();
    }),
    running: request.running
      ? {
          ...request.running,
          runningDayOffsets: runningOffsets,
          longRunDayOffset
        }
      : undefined
  };
}

function futureOffsetsForWeekdays(days: string[], now: Date, timeZone: string): number[] {
  const weekdayOrder = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const todayName = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(now).toLowerCase();
  const todayIndex = weekdayOrder.indexOf(todayName);
  if (todayIndex < 0) return [];

  return [...new Set(days.map((day) => weekdayOrder.indexOf(cleanString(day).toLowerCase())))]
    .filter((dayIndex) => dayIndex >= 0)
    .map((dayIndex) => (dayIndex - todayIndex + 7) % 7)
    .filter((offset) => offset >= 1 && offset <= 6)
    .sort((a, b) => a - b);
}

function emptyUser(userId: string, now: string): AutoPlanUserState {
  return {
    userId,
    status: "idle",
    timeZone: "UTC",
    latestRequest: null,
    latestRequestHash: null,
    latestTrainingHash: null,
    lastTriggerSource: null,
    lastTriggerReason: null,
    lastTriggeredAt: null,
    lastGeneratedAt: null,
    lastGeneratedLocalDate: null,
    lastNightlyGeneratedLocalDate: null,
    lastPostTrainingGeneratedLocalDate: null,
    lastGeneratedHash: null,
    lastSkippedAt: null,
    nextNightlyRunAt: null,
    nextRetryAt: null,
    failureCount: 0,
    lastError: null,
    planRevisionId: null,
    generatedPlan: null,
    updatedAt: now
  };
}

function nextNightlyRun(now: Date, timeZone: string): Date {
  const parts = localDateParts(now, timeZone);
  let target = zonedDateTimeToUTC(parts.year, parts.month, parts.day, 1, 30, timeZone);
  if (target.getTime() <= now.getTime()) {
    const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1, 12));
    const tomorrowParts = localDateParts(tomorrow, timeZone);
    target = zonedDateTimeToUTC(tomorrowParts.year, tomorrowParts.month, tomorrowParts.day, 1, 30, timeZone);
  }
  return target;
}

function zonedDateTimeToUTC(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let index = 0; index < 3; index += 1) {
    const parts = localDateParts(guess, timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    guess = new Date(guess.getTime() + (wanted - actual));
  }
  return guess;
}

function localDateKey(date: Date, timeZone: string): string {
  const parts = localDateParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function localDateParts(date: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute)
  };
}

function normalizedTimeZone(value: string): string {
  const trimmed = cleanString(value) || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return "UTC";
  }
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJSON(value)).digest("hex");
}

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJSON(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function retryDelayMs(failureCount: number): number {
  return Math.min(6 * 60 * 60 * 1000, 2 ** Math.max(0, failureCount - 1) * 30 * 60 * 1000);
}

function messageFor(user: AutoPlanUserState): string {
  if (user.lastError && (user.status === "failed" || user.status === "retrying")) {
    return user.lastError;
  }
  switch (user.status) {
    case "queued":
      return "Automatic planning is queued for tonight.";
    case "generating":
      return "Automatic planning is running.";
    case "generated":
      return user.lastTriggerSource === "post_training"
        ? "Plan rechecked after your latest training."
        : "Plan refreshed automatically.";
    case "skipped":
      return "Plan checked; no regeneration needed.";
    case "retrying":
      return "Automatic planning will retry.";
    case "failed":
      return "Automatic planning needs attention.";
    case "idle":
      return "Automatic planning is ready.";
  }
}

function defaultReasonFor(source: AutoPlanSource): string {
  switch (source) {
    case "manual": return "Manual plan request.";
    case "post_training": return "Training was completed.";
    case "app_active": return "App sent the latest planning context.";
    case "nightly": return "Nightly planning window.";
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function defaultAutoPlanStatePath(): string {
  return process.env.AUTO_PLAN_STATE_PATH ?? join(process.cwd(), ".data", "auto-plan-state.json");
}
