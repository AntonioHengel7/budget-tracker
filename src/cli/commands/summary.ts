import { parsePeriod } from '../../domain/period.js';
import { byCategory, periodSummary } from '../../domain/summary.js';
import type { CategorySpend, PeriodSummary } from '../../domain/summary.js';
import { loadStore } from '../../storage/jsonStore.js';

export interface SummaryOptions {
  readonly period: string;
}

export interface SummaryResult {
  readonly period: PeriodSummary;
  readonly byCategory: readonly CategorySpend[];
}

/** Computes the income/expense/net summary and per-category expense breakdown for `period`. */
export async function getSummary(filePath: string, options: SummaryOptions): Promise<SummaryResult> {
  const period = parsePeriod(options.period);
  const store = await loadStore(filePath);
  const transactions = store.transactions.map((st) => st.transaction);

  return {
    period: periodSummary(transactions, period),
    byCategory: byCategory(transactions, period),
  };
}
