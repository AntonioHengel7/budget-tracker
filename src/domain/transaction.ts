import { parseIsoDate } from './date.js';
import type { IsoDate } from './date.js';
import { ValidationError } from './errors.js';
import { assertSafeNonNegativeInteger } from './money.js';

/**
 * Sign lives in `kind`, never in `amountMinor` — `amountMinor` is always a
 * strictly positive integer number of minor units (e.g. cents).
 */
export type TransactionKind = 'income' | 'expense';

const TRANSACTION_KINDS: readonly TransactionKind[] = ['income', 'expense'];
const MAX_NOTE_LENGTH = 200;
const MAX_CATEGORY_LENGTH = 100;

export interface Transaction {
  readonly date: IsoDate;
  readonly category: string;
  readonly kind: TransactionKind;
  readonly amountMinor: number;
  readonly note?: string;
}

export interface TransactionInput {
  readonly date: string;
  readonly category: string;
  readonly kind: string;
  readonly amountMinor: number;
  readonly note?: string;
}

function isTransactionKind(value: string): value is TransactionKind {
  return (TRANSACTION_KINDS as readonly string[]).includes(value);
}

/**
 * Trims and validates a category string, enforcing non-empty and a maximum
 * length, returning the normalized value -- same shape as `parseIsoDate`,
 * not the void-returning `assert*` guards elsewhere in this codebase (e.g.
 * `assertSafeNonNegativeInteger`, `assertValidUsername`). Exported so
 * budget.ts validates categories against the exact same bar as
 * transaction.ts, instead of re-implementing a laxer check.
 */
export function parseCategory(category: string): string {
  const trimmed = category.trim();
  if (trimmed === '') {
    throw new ValidationError('category must not be empty');
  }
  if (trimmed.length > MAX_CATEGORY_LENGTH) {
    throw new ValidationError(
      `category must be at most ${MAX_CATEGORY_LENGTH} characters, got ${trimmed.length}`,
    );
  }
  return trimmed;
}

/** Validates and constructs a Transaction, enforcing all entity invariants. */
export function createTransaction(input: TransactionInput): Transaction {
  assertSafeNonNegativeInteger(input.amountMinor, 'amountMinor');
  if (input.amountMinor <= 0) {
    throw new ValidationError(
      `amountMinor must be a positive integer number of minor units, got ${input.amountMinor}`,
    );
  }

  const category = parseCategory(input.category);

  if (!isTransactionKind(input.kind)) {
    throw new ValidationError(`kind must be "income" or "expense", got "${input.kind}"`);
  }
  const kind = input.kind;

  const date = parseIsoDate(input.date);

  let note: string | undefined;
  if (input.note !== undefined) {
    const trimmed = input.note.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) {
      throw new ValidationError(
        `note must be at most ${MAX_NOTE_LENGTH} characters, got ${trimmed.length}`,
      );
    }
    note = trimmed;
  }

  const base = { date, category, kind, amountMinor: input.amountMinor };
  return note === undefined ? base : { ...base, note };
}
