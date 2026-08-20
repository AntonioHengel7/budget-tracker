import { budgetStatus } from '../../domain/budget.js';
import type { PeriodBudgetStatus } from '../../domain/budget.js';
import { parsePeriod } from '../../domain/period.js';
import { loadStore } from '../../storage/jsonStore.js';

export interface StatusOptions {
  readonly period: string;
}

/**
 * Computes budget status (limit, carry-in, spend, state) for every configured
 * category budget in `period`.
 *
 * Result rows are sorted by `category` (alphabetically) rather than left in
 * `store.budgets` array order. That underlying array order is incidental --
 * a `limit set` correction rebuilds it via filter+append (see
 * `limit.ts`'s `otherBudgets`), so it can shift a budget's position even
 * though nothing about the data itself changed. Row order is a presentation
 * concern, not a data invariant, so it's normalized here rather than
 * relying on storage order (see issue #14).
 */
export async function getStatus(
  filePath: string,
  options: StatusOptions,
): Promise<PeriodBudgetStatus[]> {
  const period = parsePeriod(options.period);
  const store = await loadStore(filePath);
  const transactions = store.transactions.map((st) => st.transaction);

  return store.budgets
    .map((budget) => budgetStatus(budget, transactions, period))
    .sort((a, b) => a.category.localeCompare(b.category));
}
