import { periodOf } from './date.js';
import { sumMinor } from './money.js';
import type { Period } from './period.js';
import type { Transaction } from './transaction.js';

export interface PeriodSummary {
  readonly period: Period;
  readonly incomeMinor: number;
  readonly expenseMinor: number;
  readonly netMinor: number;
}

/** Nets income minus expense for transactions falling within `period`. */
export function periodSummary(transactions: readonly Transaction[], period: Period): PeriodSummary {
  const inPeriod = transactions.filter((tx) => periodOf(tx.date) === period);
  const incomeMinor = sumMinor(
    inPeriod.filter((tx) => tx.kind === 'income').map((tx) => tx.amountMinor),
  );
  const expenseMinor = sumMinor(
    inPeriod.filter((tx) => tx.kind === 'expense').map((tx) => tx.amountMinor),
  );

  return { period, incomeMinor, expenseMinor, netMinor: incomeMinor - expenseMinor };
}

export interface CategorySpend {
  readonly category: string;
  readonly spentMinor: number;
}

/** Per-category expense totals for `period`, sorted by spend desc, ties broken by category asc. */
export function byCategory(transactions: readonly Transaction[], period: Period): CategorySpend[] {
  const expenses = transactions.filter((tx) => tx.kind === 'expense' && periodOf(tx.date) === period);
  const categories = [...new Set(expenses.map((tx) => tx.category))];

  return categories
    .map((category) => ({
      category,
      spentMinor: sumMinor(
        expenses.filter((tx) => tx.category === category).map((tx) => tx.amountMinor),
      ),
    }))
    .sort((a, b) => b.spentMinor - a.spentMinor || (a.category < b.category ? -1 : 1));
}

/** Net balance across the whole transaction log, accumulated in chronological (date) order. */
export function runningBalance(transactions: readonly Transaction[]): number {
  const sorted = [...transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return sorted.reduce(
    (balance, tx) => (tx.kind === 'income' ? balance + tx.amountMinor : balance - tx.amountMinor),
    0,
  );
}
