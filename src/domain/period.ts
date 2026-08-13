import { ValidationError } from './errors.js';

/**
 * A calendar month, formatted "YYYY-MM" (zero-padded so that plain string
 * comparison is equivalent to chronological comparison). Never a `Date`.
 */
export type Period = string;

const PERIOD_PATTERN = /^(\d{4})-(\d{2})$/;

/** Parses and validates a "YYYY-MM" period string. */
export function parsePeriod(input: string): Period {
  const match = PERIOD_PATTERN.exec(input);
  if (!match) {
    throw new ValidationError(`period must match YYYY-MM, got "${input}"`);
  }

  const monthStr = match[2] as string;
  const month = Number(monthStr);
  if (month < 1 || month > 12) {
    throw new ValidationError(`period month must be between 01 and 12, got "${input}"`);
  }

  return input;
}

/** Returns the period immediately following `period`, rolling December into January. */
export function nextPeriod(period: Period): Period {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));

  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;

  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`;
}

/** Chronological comparator: negative if a < b, positive if a > b, 0 if equal. */
export function comparePeriod(a: Period, b: Period): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** All periods from `from` to `to`, inclusive of both ends. Empty if `to` precedes `from`. */
export function periodsBetween(from: Period, to: Period): Period[] {
  if (comparePeriod(to, from) < 0) {
    return [];
  }

  const result: Period[] = [];
  let cursor = from;
  while (comparePeriod(cursor, to) <= 0) {
    result.push(cursor);
    cursor = nextPeriod(cursor);
  }
  return result;
}
