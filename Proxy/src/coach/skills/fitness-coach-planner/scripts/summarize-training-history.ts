import type { MetricSummary, MonthSummary, TrainingLog, TrendSummary } from "./types";

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
    maxPain: maxOrZero(monthLogs.map((log) => log.painLevel)),
    maxFatigue: maxOrZero(monthLogs.map((log) => log.fatigueLevel))
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

function delta(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}
