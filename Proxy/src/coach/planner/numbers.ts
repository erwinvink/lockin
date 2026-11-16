/**
 * One decimal, for km and other planner numbers. The epsilon keeps a value
 * that floating point stores just below a half (45 * 1.15 = 51.749999...) on
 * the side it means (51.8).
 */
export function round1(value: number): number {
  return Math.round(value * 10 + 1e-9) / 10;
}

/** "1 day", "4 days": a count with its noun in plain words (never "day(s)"). */
export function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
