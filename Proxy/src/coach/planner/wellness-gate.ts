import { daysBetween } from "./season";
import type { CoachWellnessDay } from "./types";

/**
 * The Garmin wellness gate, read by the running guardrails and the coach
 * read's HRV signal. HRV-guided training mainly moves the timing of hard
 * sessions (Duking 2021: no performance gain over fixed plans), so a tripped
 * gate keeps quality runs out of the next 48 hours, never the whole week.
 *
 * - HRV: only below the athlete's baseline trips it. Garmin's LOW and POOR
 *   are below it; UNBALANCED means the 7-day average sits outside the
 *   baseline range in either direction, so it trips only when the 7-day
 *   average is below the range (when the sidecar sends both numbers). The
 *   latest day with a reading counts while it is at most 2 days old: at the
 *   01:30 nightly plan today's row has no reading yet.
 * - Sleep: a score below 50 on 2 of the last 3 nights that have a score
 *   (today's has none yet at night). One poor night is not a gate.
 */
export const WELLNESS_GATE_LIMITS = {
  belowBaselineStatuses: ["LOW", "POOR"],
  /** A reading (HRV, sleep score, training readiness, resting HR) counts while it is at most this many days old, measured from its own day. */
  maxReadingAgeDays: 2,
  poorSleepScoreBelow: 50,
  poorNightsNeeded: 2,
  /** The last this-many nights that have a sleep score, none more than this many days back. */
  nightsWindow: 3,
  /** A tripped gate keeps quality runs out of this many hours from the start of today. */
  gateHours: 48
} as const;

export type HrvVersusBaseline = "below" | "not_below" | "unknown";

export type WellnessGate = {
  /** Why the gate tripped, one sentence each. */
  reasons: string[];
  /** Athlete-facing: what keeps the next 48 hours easy. */
  why: string;
  /** Future day offsets inside the next 48 hours (today, offset 0, is locked). */
  offsets: number[];
};

/** HRV against the athlete's own baseline on one wellness day. */
export function hrvVersusBaseline(day: CoachWellnessDay): HrvVersusBaseline {
  const status = day.hrvStatus?.trim().toUpperCase() ?? "";
  if ((WELLNESS_GATE_LIMITS.belowBaselineStatuses as readonly string[]).includes(status)) return "below";
  const average = day.hrvWeeklyAvgMs;
  const low = day.hrvBaselineLowMs;
  if (typeof average === "number" && average > 0 && typeof low === "number" && low > 0) return average < low ? "below" : "not_below";
  // UNBALANCED without the numbers can be above or below the baseline.
  return status === "BALANCED" ? "not_below" : "unknown";
}

/**
 * The most recent day that has the reading (`has`), or null when there is
 * none or it is more than 2 days old. At the 01:30 nightly plan today's row
 * has no readings yet, so this is usually yesterday's.
 */
export function latestDayWith(wellness: CoachWellnessDay[], weekStart: string, has: (day: CoachWellnessDay) => boolean): CoachWellnessDay | null {
  const latest = [...wellness].filter(has).sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  if (!latest) return null;
  const daysAgo = daysOld(latest, weekStart);
  return Number.isFinite(daysAgo) && daysAgo <= WELLNESS_GATE_LIMITS.maxReadingAgeDays ? latest : null;
}

/** The most recent day with an HRV reading (a status, or the 7-day average with the baseline's lower bound), at most 2 days old. */
export function latestHrvDay(wellness: CoachWellnessDay[], weekStart: string): CoachWellnessDay | null {
  return latestDayWith(wellness, weekStart, hasHrvReading);
}

/** The gate as of the first day of the rolling week (`weekStart`), or null when it does not trip. */
export function wellnessGate(wellness: CoachWellnessDay[], weekStart: string): WellnessGate | null {
  const limits = WELLNESS_GATE_LIMITS;
  const reasons: string[] = [];
  const why: string[] = [];

  const hrvDay = latestHrvDay(wellness, weekStart);
  if (hrvDay && hrvVersusBaseline(hrvDay) === "below") {
    const status = hrvDay.hrvStatus?.trim().toUpperCase() ?? "";
    const date = hrvDay.date.slice(0, 10);
    reasons.push(
      (limits.belowBaselineStatuses as readonly string[]).includes(status)
        ? `HRV status ${status} on ${date} (below the athlete's baseline).`
        : `The 7-day HRV average of ${hrvDay.hrvWeeklyAvgMs} ms is below the baseline range (from ${hrvDay.hrvBaselineLowMs} ms) on ${date}.`
    );
    why.push("HRV below your baseline");
  }

  // The last 3 nights that have a score, by date (none more than 3 days back).
  const scoredNights = wellness
    .filter((day) => typeof day.sleepScore === "number" && day.sleepScore > 0 && daysOld(day, weekStart) <= limits.nightsWindow)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-limits.nightsWindow);
  const poorNights = scoredNights.filter((day) => (day.sleepScore ?? 0) < limits.poorSleepScoreBelow);
  if (poorNights.length >= limits.poorNightsNeeded) {
    const nights = poorNights.map((day) => `${day.sleepScore} on ${day.date.slice(0, 10)}`).join(", ");
    reasons.push(`Sleep score below ${limits.poorSleepScoreBelow} on ${poorNights.length} of the last ${limits.nightsWindow} nights (${nights}).`);
    why.push(`poor sleep on ${poorNights.length} of the last ${limits.nightsWindow} nights`);
  }

  if (reasons.length === 0) return null;
  return {
    reasons,
    why: why.join(" and "),
    offsets: [1, 2, 3, 4, 5, 6].filter((offset) => offset * 24 < limits.gateHours)
  };
}

function hasHrvReading(day: CoachWellnessDay): boolean {
  if ((day.hrvStatus?.trim() ?? "").length > 0) return true;
  const positive = (value: number | null | undefined) => typeof value === "number" && value > 0;
  return positive(day.hrvWeeklyAvgMs) && positive(day.hrvBaselineLowMs);
}

/** Whole days from the wellness day (a calendar date) to the week start; NaN for an unreadable date. */
function daysOld(day: CoachWellnessDay, weekStart: string): number {
  return daysBetween(`${day.date.slice(0, 10)}T00:00:00Z`, weekStart);
}
