import { ValidationError } from './errors.js';

/**
 * Money is always represented as an integer number of minor units (e.g. cents).
 * Sign is carried by a transaction's `kind`, never by the number itself —
 * amounts here are always non-negative.
 */

const MAX_DECIMAL_PLACES = 2;

/**
 * Guards a value as a finite, non-negative, safe-integer number of minor
 * units. Exported so other domain modules (e.g. transaction.ts, budget.ts)
 * validate amounts against the exact same bar as money.ts's own arithmetic,
 * instead of re-implementing a laxer check.
 */
export function assertSafeNonNegativeInteger(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ValidationError(`${label} must be a finite number, got ${value}`);
  }
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${label} must be an integer number of minor units, got ${value}`);
  }
  if (Object.is(value, -0)) {
    throw new ValidationError(`${label} must not be -0`);
  }
  if (value < 0) {
    throw new ValidationError(`${label} must not be negative, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${label} exceeds the safe integer range: ${value}`);
  }
}

/**
 * Parses a decimal-string amount (e.g. "12.34") into integer minor units (1234).
 * Rejects more than 2 decimal places, non-numeric input, negative values, and -0.
 */
export function parseAmount(input: string): number {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new ValidationError('amount must not be empty');
  }

  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new ValidationError(`amount must be a non-negative decimal number, got "${input}"`);
  }

  const [, wholePart, fractionPartRaw = ''] = match;
  if (fractionPartRaw.length > MAX_DECIMAL_PLACES) {
    throw new ValidationError(
      `amount must have at most ${MAX_DECIMAL_PLACES} decimal places, got "${input}"`,
    );
  }

  const fractionPart = fractionPartRaw.padEnd(MAX_DECIMAL_PLACES, '0');
  const minor = Number(wholePart) * 100 + Number(fractionPart);

  assertSafeNonNegativeInteger(minor, 'amount');
  return minor;
}

/** Formats integer minor units back into a decimal string, e.g. 1234 -> "12.34". */
export function formatAmount(amountMinor: number): string {
  assertSafeNonNegativeInteger(amountMinor, 'amountMinor');
  const whole = Math.trunc(amountMinor / 100);
  const fraction = amountMinor % 100;
  return `${whole}.${String(fraction).padStart(2, '0')}`;
}

export function addMinor(a: number, b: number): number {
  assertSafeNonNegativeInteger(a, 'a');
  assertSafeNonNegativeInteger(b, 'b');
  const sum = a + b;
  assertSafeNonNegativeInteger(sum, 'a + b');
  return sum;
}

/**
 * Subtracts b from a. Result MAY be negative (e.g. overspend/carryover math) —
 * not validated as non-negative. No safe-integer recheck on the result: given
 * a, b are both already constrained to [0, MAX_SAFE_INTEGER] by the precondition
 * checks above, a - b is mathematically guaranteed to fall within
 * [MIN_SAFE_INTEGER, MAX_SAFE_INTEGER] — it cannot overflow.
 */
export function subMinor(a: number, b: number): number {
  assertSafeNonNegativeInteger(a, 'a');
  assertSafeNonNegativeInteger(b, 'b');
  return a - b;
}

export function sumMinor(values: readonly number[]): number {
  return values.reduce((total, value) => addMinor(total, value), 0);
}
