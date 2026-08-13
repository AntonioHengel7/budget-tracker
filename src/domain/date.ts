import { ValidationError } from './errors.js';
import type { Period } from './period.js';

/**
 * A calendar day, formatted "YYYY-MM-DD" (zero-padded so that plain string
 * comparison is equivalent to chronological comparison). Never a `Date`, never `Intl`.
 */
export type IsoDate = string;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Parses and validates a "YYYY-MM-DD" date string, rejecting calendar-invalid dates. */
export function parseIsoDate(input: string): IsoDate {
  const match = ISO_DATE_PATTERN.exec(input);
  if (!match) {
    throw new ValidationError(`date must match YYYY-MM-DD, got "${input}"`);
  }

  const yearStr = match[1] as string;
  const monthStr = match[2] as string;
  const dayStr = match[3] as string;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (month < 1 || month > 12) {
    throw new ValidationError(`date month must be between 01 and 12, got "${input}"`);
  }

  // month is bounds-checked above, so this index is always in range.
  const daysInMonth = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] as number);
  if (day < 1 || day > daysInMonth) {
    throw new ValidationError(`date day is out of range for ${yearStr}-${monthStr}, got "${input}"`);
  }

  return input;
}

/** Extracts the "YYYY-MM" period a date falls in. */
export function periodOf(date: IsoDate): Period {
  return date.slice(0, 7);
}
