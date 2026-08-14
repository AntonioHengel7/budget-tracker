import { budgetStatus } from '../../domain/budget.js';
import type { PeriodBudgetStatus } from '../../domain/budget.js';
import { parsePeriod } from '../../domain/period.js';
import { loadStore } from '../../storage/jsonStore.js';

export interface StatusOptions {
  readonly period: string;
}

/** Computes budget status (limit, carry-in, spend, state) for every configured category budget in `period`. */
export async function getStatus(
  filePath: string,
  options: StatusOptions,
): Promise<PeriodBudgetStatus[]> {
  const period = parsePeriod(options.period);
  const store = await loadStore(filePath);
  const transactions = store.transactions.map((st) => st.transaction);

  return store.budgets.map((budget) => budgetStatus(budget, transactions, period));
}
