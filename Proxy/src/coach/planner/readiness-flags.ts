import type { TrainingLog } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Readiness flags from pain and very weak feedback are time-based: a trigger
 * counts for 7 days, or 14 when no strength log followed it (the athlete has
 * not shown a pain-free session yet), and a later clean log clears it early.
 */
export const READINESS_WINDOWS = {
  triggerDays: 7,
  unconfirmedTriggerDays: 14,
  /** A later log at or below this pain (and not very weak) clears a pain flag. */
  cleanPainMax: 2,
  /** A later log below this fatigue level (Weak = 8) and with pain below 4 clears a very-weak flag. */
  cleanFatigueBelow: 7
} as const;

/** Flags that put readiness in recovery_needed. Month-level flags are watch items only. */
export const RECOVERY_NEEDED_FLAGS: ReadonlySet<string> = new Set(["recent_pain_level_4_or_higher", "recent_how_you_felt_very_weak"]);

/** The time-based recovery flags in force at `at` (logs after `at` are ignored). */
export function recoveryFlagsAt(sortedLogs: TrainingLog[], at: Date): string[] {
  const flags: string[] = [];
  const pain = unresolvedRecentTrigger(
    sortedLogs,
    at,
    (log) => log.painLevel >= 4,
    (log) => log.painLevel <= READINESS_WINDOWS.cleanPainMax && log.fatigueLevel < 9
  );
  if (pain) flags.push("recent_pain_level_4_or_higher");
  const veryWeak = unresolvedRecentTrigger(
    sortedLogs,
    at,
    (log) => log.fatigueLevel >= 9,
    (log) => log.fatigueLevel < READINESS_WINDOWS.cleanFatigueBelow && log.painLevel < 4
  );
  if (veryWeak) flags.push("recent_how_you_felt_very_weak");
  return flags;
}

/**
 * The latest trigger log still in force: inside the trigger window (7 days,
 * or 14 when no log at all followed it) and not followed by a clean log.
 * Logs are strength sessions, so the clearing log is of the same discipline.
 */
export function unresolvedRecentTrigger(
  sortedLogs: TrainingLog[],
  now: Date,
  isTrigger: (log: TrainingLog) => boolean,
  isClean: (log: TrainingLog) => boolean
): TrainingLog | null {
  const nowMs = now.getTime();
  const timed = sortedLogs
    .map((log) => ({ log, at: Date.parse(log.completedAt) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at <= nowMs);
  for (let index = timed.length - 1; index >= 0; index -= 1) {
    const { log, at } = timed[index];
    if (!isTrigger(log)) continue;
    const later = timed.slice(index + 1);
    const ageDays = (nowMs - at) / DAY_MS;
    const windowDays = later.length === 0 ? READINESS_WINDOWS.unconfirmedTriggerDays : READINESS_WINDOWS.triggerDays;
    if (ageDays > windowDays) return null;
    return later.some((entry) => isClean(entry.log)) ? null : log;
  }
  return null;
}
