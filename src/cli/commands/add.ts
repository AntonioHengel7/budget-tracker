import { randomUUID } from 'node:crypto';
import { createTransaction } from '../../domain/transaction.js';
import type { Transaction } from '../../domain/transaction.js';
import { parseAmount } from '../../domain/money.js';
import { updateStore } from '../../storage/jsonStore.js';
import type { StoredTransaction } from '../../storage/schema.js';

export interface AddOptions {
  readonly amount: string;
  readonly category: string;
  readonly kind: string;
  readonly date: string;
  readonly note?: string;
}

export interface AddResult {
  readonly id: string;
  readonly transaction: Transaction;
}

/** Validates and appends a new transaction to the store at `filePath`. */
export async function addTransaction(filePath: string, options: AddOptions): Promise<AddResult> {
  const amountMinor = parseAmount(options.amount);
  const transaction = createTransaction({
    date: options.date,
    category: options.category,
    kind: options.kind,
    amountMinor,
    ...(options.note !== undefined ? { note: options.note } : {}),
  });

  // Load-modify-save runs under updateStore's exclusive lock (issue #9) so a
  // concurrent CLI invocation against the same file can't load this same
  // stale state and have its own write silently clobbered by whichever
  // invocation saves last.
  return updateStore(filePath, (store) => {
    const stored: StoredTransaction = { id: randomUUID(), transaction };
    return {
      store: { ...store, transactions: [...store.transactions, stored] },
      result: { id: stored.id, transaction },
    };
  });
}
