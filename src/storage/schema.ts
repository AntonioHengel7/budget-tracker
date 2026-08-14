import type { CategoryBudget } from '../domain/budget.js';
import type { Transaction } from '../domain/transaction.js';

/**
 * Bumped whenever `PersistedStore`'s on-disk shape changes in a
 * backwards-incompatible way. `jsonStore.ts` rejects any file whose
 * `schemaVersion` doesn't match this exact literal.
 */
export const SCHEMA_VERSION = 1 as const;

/**
 * The domain layer's `Transaction` has no identity of its own by design —
 * storage introduces a synthetic id here so `rm`/`list` have something to
 * reference.
 */
export interface StoredTransaction {
  readonly id: string;
  readonly transaction: Transaction;
}

/** The full on-disk shape of the JSON store file. */
export interface PersistedStore {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly transactions: readonly StoredTransaction[];
  readonly budgets: readonly CategoryBudget[];
}

/** A fresh, empty store — used when no store file exists yet. */
export function emptyStore(): PersistedStore {
  return { schemaVersion: SCHEMA_VERSION, transactions: [], budgets: [] };
}
