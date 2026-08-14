import { randomUUID } from 'node:crypto';
import { createTransaction } from '../../domain/transaction.js';
import type { Transaction } from '../../domain/transaction.js';
import { parseAmount } from '../../domain/money.js';
import { loadStore, saveStore } from '../../storage/jsonStore.js';
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

  const store = await loadStore(filePath);
  const stored: StoredTransaction = { id: randomUUID(), transaction };
  await saveStore(filePath, { ...store, transactions: [...store.transactions, stored] });

  return { id: stored.id, transaction };
}
