import type { IsoDate } from './date.js';
import type { Transaction, TransactionKind } from './transaction.js';

export interface TransactionFilter {
  readonly from?: IsoDate;
  readonly to?: IsoDate;
  readonly category?: string;
  readonly kind?: TransactionKind;
  readonly noteContains?: string;
}

/** Filters transactions by date range (inclusive both ends), exact category/kind, and note substring. */
export function filterTransactions(
  transactions: readonly Transaction[],
  filter: TransactionFilter,
): Transaction[] {
  return transactions.filter((tx) => {
    if (filter.from !== undefined && tx.date < filter.from) {
      return false;
    }
    if (filter.to !== undefined && tx.date > filter.to) {
      return false;
    }
    if (filter.category !== undefined && tx.category !== filter.category) {
      return false;
    }
    if (filter.kind !== undefined && tx.kind !== filter.kind) {
      return false;
    }
    if (filter.noteContains !== undefined) {
      const note = (tx.note ?? '').toLowerCase();
      if (!note.includes(filter.noteContains.toLowerCase())) {
        return false;
      }
    }
    return true;
  });
}
