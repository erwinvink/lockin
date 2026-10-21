import type { MetricSummary, MonthSummary, RollingTrendSummary, TrainingLog, TrendSummary } from "./types";

type MetricName = "pullUps" | "pushUps" | "plankSeconds";
type FlagName = "loggedPullUps" | "loggedPushUps" | "loggedPlankSeconds";

const metricFlags: Record<MetricName, FlagName> = {
  pullUps: "loggedPullUps",
  pushUps: "loggedPushUps",
  plankSeconds: "loggedPlankSeconds"
};

export function summarizeMonth(logs: TrainingLog[], monthStart: Date, isPartial: boolean): MonthSummary {
  const monthEnd = addMonths(monthStart, 1);
  const monthLogs = logs.filter((log) => {
    const completedAt = new Date(log.completedAt);
    return completedAt >= monthStart && completedAt < monthEnd;
  });

  return {
    month: monthKey(monthStart),
    isPartial,
    logCount: monthLogs.length,
    pullUps: summarizeMetric(monthLogs, "pullUps"),
    pushUps: summarizeMetric(monthLogs, "pushUps"),
    plankSeconds: summarizeMetric(monthLogs, "plankSeconds"),
    averageRPE: average(monthLogs.map((log) => log.rpe)),
    averagePerceivedEffort: average(monthLogs.map((log) => log.rpe)),
    maxPain: maxOrZero(monthLogs.map((log) => log.painLevel)),
    maxFatigue: maxOrZero(monthLogs.map((log) => log.fatigueLevel)),
    worstHowYouFelt: worstHowYouFelt(monthLogs)
  };
}

export function summarizeTrend(lastFullMonth: MonthSummary, previousFullMonth: MonthSummary): TrendSummary {
  const pullUpsDelta = delta(lastFullMonth.pullUps.best, previousFullMonth.pullUps.best);
  const pushUpsDelta = delta(lastFullMonth.pushUps.best, previousFullMonth.pushUps.best);
  const plankSecondsDelta = delta(lastFullMonth.plankSeconds.best, previousFullMonth.plankSeconds.best);
  const knownDeltas = [pullUpsDelta, pushUpsDelta, plankSecondsDelta].filter((value): value is number => value !== null);

  if (lastFullMonth.logCount < 2 || previousFullMonth.logCount < 2 || knownDeltas.length === 0) {
    return {
      pullUpsDelta,
      pushUpsDelta,
      plankSecondsDelta,
      logCountDelta: lastFullMonth.logCount - previousFullMonth.logCount,
      label: "insufficient_history"
    };
  }

  const positive = knownDeltas.filter((value) => value > 0).length;
  const negative = knownDeltas.filter((value) => value < 0).length;

  return {
    pullUpsDelta,
    pushUpsDelta,
    plankSecondsDelta,
    logCountDelta: lastFullMonth.logCount - previousFullMonth.logCount,
    label: positive > negative ? "improving" : negative > positive ? "declining" : "flat"
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling windows for plateau and decline detection. */
export const ROLLING_TREND = {
  windowDays: 21,
  /** Logs of a metric each window needs before that metric is compared. */
  minLogsPerWindow: 2
} as const;

/**
 * Plateau and decline from rolling windows instead of calendar months: the
 * best of the last 21 days against the best of the 21 days before, per goal
 * metric. A metric is compared only when both windows hold at least two logs
 * of it, so one odd session never decides the label. `sinceMs` (the plan
 * block start) drops older logs, so a lower retest at a new block is not read
 * as a decline against the old block.
 */
export function summarizeRollingTrend(logs: TrainingLog[], now: Date, sinceMs: number | null = null): RollingTrendSummary {
  const { windowDays, minLogsPerWindow } = ROLLING_TREND;
  const end = now.getTime();
  const recentStart = end - windowDays * DAY_MS;
  const previousStart = recentStart - windowDays * DAY_MS;
  const eligible = logs.filter((log) => {
    const at = Date.parse(log.completedAt);
    return Number.isFinite(at) && at <= end && (sinceMs === null || at >= sinceMs);
  });
  const inWindow = (from: number, to: number) =>
    eligible.filter((log) => {
      const at = Date.parse(log.completedAt);
      return at > from && at <= to;
    });
  const recentLogs = inWindow(recentStart, end);
  const previousLogs = inWindow(previousStart, recentStart);
  const recent = windowSummary(recentLogs, recentStart, end);
  const previous = windowSummary(previousLogs, previousStart, recentStart);

  const metricDelta = (metric: MetricName): number | null => {
    const recentMetric = summarizeMetric(recentLogs, metric);
    const previousMetric = summarizeMetric(previousLogs, metric);
    if (recentMetric.count < minLogsPerWindow || previousMetric.count < minLogsPerWindow) return null;
    return delta(recentMetric.best, previousMetric.best);
  };
  const pullUpsDelta = metricDelta("pullUps");
  const pushUpsDelta = metricDelta("pushUps");
  const plankSecondsDelta = metricDelta("plankSeconds");
  const knownDeltas = [pullUpsDelta, pushUpsDelta, plankSecondsDelta].filter((value): value is number => value !== null);
  const positive = knownDeltas.filter((value) => value > 0).length;
  const negative = knownDeltas.filter((value) => value < 0).length;

  return {
    windowDays,
    recent,
    previous,
    pullUpsDelta,
    pushUpsDelta,
    plankSecondsDelta,
    logCountDelta: recentLogs.length - previousLogs.length,
    label:
      knownDeltas.length === 0
        ? "insufficient_history"
        : positive > negative
          ? "improving"
          : negative > positive
            ? "declining"
            : "flat"
  };
}

function windowSummary(logs: TrainingLog[], from: number, to: number): RollingTrendSummary["recent"] {
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    logCount: logs.length,
    pullUps: summarizeMetric(logs, "pullUps").best,
    pushUps: summarizeMetric(logs, "pushUps").best,
    plankSeconds: summarizeMetric(logs, "plankSeconds").best
  };
}

export function startOfMonthUTC(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function summarizeMetric(logs: TrainingLog[], metric: MetricName): MetricSummary {
  const flag = metricFlags[metric];
  const values = logs
    .filter((log) => log[flag])
    .map((log) => log[metric])
    .filter((value) => Number.isFinite(value));

  return {
    count: values.length,
    best: values.length ? Math.max(...values) : null,
    latest: values.length ? values[values.length - 1] : null
  };
}

function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1));
}

function maxOrZero(values: number[]): number {
  return values.length ? Math.max(...values) : 0;
}

function worstHowYouFelt(logs: TrainingLog[]): MonthSummary["worstHowYouFelt"] {
  if (logs.length === 0) return null;
  return howYouFeltLabel(Math.max(...logs.map((log) => log.fatigueLevel)));
}

function howYouFeltLabel(fatigueLevel: number): NonNullable<MonthSummary["worstHowYouFelt"]> {
  if (fatigueLevel >= 9) return "very_weak";
  if (fatigueLevel >= 7) return "weak";
  if (fatigueLevel >= 3) return "normal";
  if (fatigueLevel >= 1) return "strong";
  return "very_strong";
}

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}
