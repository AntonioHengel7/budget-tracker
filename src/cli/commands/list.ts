import { parseIsoDate } from '../../domain/date.js';
import { ValidationError } from '../../domain/errors.js';
import { filterTransactions } from '../../domain/filter.js';
import type { TransactionFilter } from '../../domain/filter.js';
import type { TransactionKind } from '../../domain/transaction.js';
import { loadStore } from '../../storage/jsonStore.js';
import type { StoredTransaction } from '../../storage/schema.js';

export interface ListOptions {
  readonly from?: string;
  readonly to?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly note?: string;
}

function isTransactionKind(value: string): value is TransactionKind {
  return value === 'income' || value === 'expense';
}

function buildFilter(options: ListOptions): TransactionFilter {
  const filter: {
    from?: string;
    to?: string;
    category?: string;
    kind?: TransactionKind;
    noteContains?: string;
  } = {};

  if (options.from !== undefined) {
    filter.from = parseIsoDate(options.from);
  }
  if (options.to !== undefined) {
    filter.to = parseIsoDate(options.to);
  }
  if (options.category !== undefined) {
    filter.category = options.category.trim();
  }
  if (options.kind !== undefined) {
    if (!isTransactionKind(options.kind)) {
      throw new ValidationError(`kind must be "income" or "expense", got "${options.kind}"`);
    }
    filter.kind = options.kind;
  }
  if (options.note !== undefined) {
    filter.noteContains = options.note;
  }

  return filter;
}

/**
 * Lists stored transactions matching `options`, sorted by date ascending
 * (ties preserve insertion order).
 */
export async function listTransactions(
  filePath: string,
  options: ListOptions,
): Promise<StoredTransaction[]> {
  const store = await loadStore(filePath);
  const filter = buildFilter(options);

  const matches = store.transactions.filter(
    (st) => filterTransactions([st.transaction], filter).length > 0,
  );

  return [...matches].sort((a, b) =>
    a.transaction.date < b.transaction.date ? -1 : a.transaction.date > b.transaction.date ? 1 : 0,
  );
}
