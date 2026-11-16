import { HARD_RUN_KINDS } from "./running-phase-limits";

/**
 * The planned week as the strength side sees it: offsets 1-6 (offset 0 is
 * today, which is locked), the full rest day, and which runs are hard work.
 */

/** The day offsets a weekly plan may use. */
export const PLANNED_OFFSETS: readonly number[] = [1, 2, 3, 4, 5, 6];

/**
 * Run kinds that are hard work for strength: a long, tempo, interval or hill
 * run, and a race (a hard effort; the same set as running-floors.ts, which a
 * test keeps equal).
 */
export const HARD_EFFORT_KINDS: ReadonlySet<string> = new Set([...HARD_RUN_KINDS, "race"]);

export function isHardRun(kind: unknown): boolean {
  return typeof kind === "string" && HARD_EFFORT_KINDS.has(kind);
}

/**
 * Offsets 1-6 with nothing on them. One of them must stay the full rest day
 * (no run, no strength): pass the run offsets to see where it can fall, or
 * the runs and the strength sessions together to check that it is there.
 */
export function freeOffsets(occupied: Iterable<number>): number[] {
  const taken = new Set(occupied);
  return PLANNED_OFFSETS.filter((offset) => !taken.has(offset));
}
