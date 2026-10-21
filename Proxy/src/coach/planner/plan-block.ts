import type { CoachContext, CoachRequest } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The plan block the planned week belongs to, as `{ block }` to spread into
 * the coach context; empty when the app sent no (or an unreadable) block
 * start. Both dates are local midnights, so rounding the day difference
 * absorbs DST. A start after weekStart (clock skew) still reads as week 1.
 */
export function planBlockContext(
  request: Pick<CoachRequest, "planBlockStartedAt" | "weekStart">
): Pick<CoachContext, "block"> {
  const startedAt = request.planBlockStartedAt;
  const start = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  const weekStart = Date.parse(request.weekStart);
  if (!Number.isFinite(start) || !Number.isFinite(weekStart)) return {};
  const days = Math.max(0, Math.round((weekStart - start) / DAY_MS));
  return { block: { startedAt: startedAt as string, weekInBlock: Math.floor(days / 7) + 1 } };
}
