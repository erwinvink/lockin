// Time-zone math shared by auto-planning and the coach context. Instants are
// converted to wall-clock parts with Intl, so DST days (23 or 25 hours) come
// out right without a date library.

export type LocalDateParts = { year: number; month: number; day: number; hour: number; minute: number };

export function localDateParts(date: Date, timeZone: string): LocalDateParts {
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

/** The instant of a wall-clock time in `timeZone` (day may overflow the month). */
export function zonedDateTimeToUTC(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  let guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  for (let index = 0; index < 3; index += 1) {
    const parts = localDateParts(guess, timeZone);
    const actual = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    guess = new Date(guess.getTime() + (wanted - actual));
  }
  return guess;
}

/** Local midnight at the start of the day that contains `instant`. */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  const parts = localDateParts(instant, timeZone);
  return zonedDateTimeToUTC(parts.year, parts.month, parts.day, 0, 0, timeZone);
}

/** The first local midnight after the day that contains `instant`. */
export function nextLocalMidnight(instant: Date, timeZone: string): Date {
  const parts = localDateParts(instant, timeZone);
  return zonedDateTimeToUTC(parts.year, parts.month, parts.day + 1, 0, 0, timeZone);
}

/** A valid IANA zone, or null. */
export function validTimeZone(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).format(new Date());
    return trimmed;
  } catch {
    return null;
  }
}
