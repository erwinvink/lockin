import type { CoachContext, CoachWellnessDay, GarminWellnessDay } from "../coach/planner/types";
import { latestDayWith } from "../coach/planner/wellness-gate";
import { garminSnapshot } from "./garmin-client";

// The HRV gate reads the latest day with a reading (at most 2 days old) and
// the sleep gate the last three nights that have a score (wellness-gate.ts).
// At the 01:30 plan today's row has neither yet, so four days: the sidecar
// makes 4 serialized Garmin calls a day plus one body-battery call, ~17
// instead of ~29 for a week, inside the 10 s budget below (a timeout only
// means the coach plans without Garmin data).
const ENRICHMENT_DAYS = 4;
const ENRICHMENT_TIMEOUT_MS = 10_000;
// Chat asks the coach many times in a row; reuse one fetch per user for a while.
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

type NumericMetric = "sleepScore" | "sleepSeconds" | "hrvMs" | "bodyBattery" | "trainingReadiness" | "restingHr" | "hrvWeeklyAvgMs" | "hrvBaselineLowMs";

/**
 * A sidecar wellness row as the coach should see it: metrics whose Garmin
 * call failed (`unavailableMetrics`) and 0/"" placeholders become null, so a
 * hiccup or a watch without the metric never reads as a real low value.
 */
export function sanitizeWellnessForCoach(day: GarminWellnessDay): CoachWellnessDay {
  const unavailable = new Set(Array.isArray(day.unavailableMetrics) ? day.unavailableMetrics : []);
  const numeric = (field: NumericMetric): number | null => {
    const value = day[field];
    return !unavailable.has(field) && typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  const hrvStatus = typeof day.hrvStatus === "string" ? day.hrvStatus.trim() : "";
  // The 7-day average and the baseline's lower bound (newer sidecars) let the
  // HRV gate tell a below-baseline UNBALANCED status from an above-baseline one.
  const hrvWeeklyAvgMs = numeric("hrvWeeklyAvgMs");
  const hrvBaselineLowMs = numeric("hrvBaselineLowMs");
  return {
    date: String(day.date),
    sleepScore: numeric("sleepScore"),
    sleepSeconds: numeric("sleepSeconds"),
    hrvStatus: !unavailable.has("hrvStatus") && hrvStatus ? hrvStatus : null,
    hrvMs: numeric("hrvMs"),
    bodyBattery: numeric("bodyBattery"),
    trainingReadiness: numeric("trainingReadiness"),
    restingHr: numeric("restingHr"),
    ...(hrvWeeklyAvgMs !== null && hrvBaselineLowMs !== null ? { hrvWeeklyAvgMs, hrvBaselineLowMs } : {})
  };
}

function hasAnyMetric(day: CoachWellnessDay): boolean {
  return [day.sleepScore, day.sleepSeconds, day.hrvStatus, day.hrvMs, day.bodyBattery, day.trainingReadiness, day.restingHr]
    .some((value) => value !== null);
}

export type GarminEnricherOptions = {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  log?: (message: string) => void;
};

type CacheEntry = { at: number; wellness: CoachWellnessDay[] };

/**
 * Attach Garmin wellness to the coach context. Any sidecar failure means the
 * coach simply plans without Garmin data (logged, never blocking). A missing
 * userId never falls back to the sidecar's default (owner) account.
 */
export function createGarminEnricher(options: GarminEnricherOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const log = options.log ?? ((message: string) => console.warn(message));
  const cache = new Map<string, CacheEntry>();

  async function wellnessFor(userId: string): Promise<{ wellness: CoachWellnessDay[] } | { reason: string }> {
    const cached = cache.get(userId);
    if (cached && now() - cached.at < ttlMs) {
      return { wellness: cached.wellness };
    }
    try {
      const snapshot = await garminSnapshot(ENRICHMENT_DAYS, options.fetchImpl ?? fetch, {
        includeActivities: false,
        timeoutMs: ENRICHMENT_TIMEOUT_MS,
        userId
      });
      if (!snapshot.status.loggedIn) {
        return { reason: snapshot.status.lastError ?? "Garmin is not connected" };
      }
      if (snapshot.wellness.length === 0) {
        return { reason: snapshot.status.lastError ?? "Garmin returned no wellness days" };
      }
      const wellness = snapshot.wellness.map(sanitizeWellnessForCoach);
      if (!wellness.some(hasAnyMetric)) {
        // Every metric failed or is empty: nothing to coach on, and nothing
        // worth caching (the next request should try Garmin again).
        return { reason: "Garmin returned no usable wellness metrics" };
      }
      for (const [key, entry] of cache) {
        if (now() - entry.at >= ttlMs) cache.delete(key);
      }
      cache.set(userId, { at: now(), wellness });
      return { wellness };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : "Garmin request failed" };
    }
  }

  return async function enrichWithGarmin(context: CoachContext, userId?: string): Promise<CoachContext> {
    const cleanUserId = typeof userId === "string" ? userId.trim() : "";
    if (!cleanUserId) {
      log("Coach context sent without Garmin data: request has no userId.");
      return context;
    }

    const result = await wellnessFor(cleanUserId);
    if ("reason" in result) {
      log(`Coach context for ${cleanUserId} sent without Garmin data: ${result.reason}`);
      return context;
    }

    // The latest day that has a readiness value (at most 2 days old): at the
    // 01:30 plan today's row has none yet.
    const readiness = latestDayWith(result.wellness, context.profile.weekStart, (day) => typeof day.trainingReadiness === "number" && day.trainingReadiness > 0);
    context.garmin = { wellness: result.wellness };
    if (readiness && typeof readiness.trainingReadiness === "number" && readiness.trainingReadiness < 30) {
      context.readiness.riskFlags.push(`garmin: training readiness low on ${readiness.date}`);
    }
    return context;
  };
}
