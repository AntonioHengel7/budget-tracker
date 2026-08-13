import { periodOf } from './date.js';
import type { Period } from './period.js';
import { comparePeriod, nextPeriod } from './period.js';
import type { Transaction } from './transaction.js';
import { sumMinor } from './money.js';

/** A single limit amount, effective from a given period onward until superseded. */
export interface CategoryLimit {
  readonly effectiveFrom: Period;
  readonly amountMinor: number;
}

/**
 * A category's budget configuration: its limit history and whether unspent
 * (or overspent) balance rolls forward into the next period.
 */
export interface CategoryBudget {
  readonly category: string;
  readonly rollover: boolean;
  readonly limits: readonly CategoryLimit[];
}

export type BudgetState = 'over' | 'at' | 'under';

export interface PeriodBudgetStatus {
  readonly period: Period;
  readonly category: string;
  readonly limitMinor: number;
  readonly carryInMinor: number;
  readonly availableMinor: number;
  readonly spentMinor: number;
  readonly state: BudgetState;
  readonly pctUsed: number | null;
}

/** Picks the latest limit with `effectiveFrom <= period`; undefined if all limits start later. */
export function resolveLimit(budget: CategoryBudget, period: Period): CategoryLimit | undefined {
  let latest: CategoryLimit | undefined;
  for (const limit of budget.limits) {
    if (comparePeriod(limit.effectiveFrom, period) <= 0) {
      if (latest === undefined || comparePeriod(limit.effectiveFrom, latest.effectiveFrom) > 0) {
        latest = limit;
      }
    }
  }
  return latest;
}

/** Sums expense transactions for `category` within `period`. Income never counts. */
export function spentInPeriod(
  transactions: readonly Transaction[],
  category: string,
  period: Period,
): number {
  return sumMinor(
    transactions
      .filter(
        (tx) => tx.kind === 'expense' && tx.category === category && periodOf(tx.date) === period,
      )
      .map((tx) => tx.amountMinor),
  );
}

function firstLimitedPeriod(budget: CategoryBudget): Period | undefined {
  let earliest: Period | undefined;
  for (const limit of budget.limits) {
    if (earliest === undefined || comparePeriod(limit.effectiveFrom, earliest) < 0) {
      earliest = limit.effectiveFrom;
    }
  }
  return earliest;
}

/**
 * The balance carried INTO `period`, per the recurrence:
 *   carry(p+1) = rollover ? (limit(p) + carry(p) - spent(p)) : 0
 * with carry = 0 in the first period that has a limit (and in any period at
 * or before it, since there is nothing to carry yet).
 */
export function carryover(
  budget: CategoryBudget,
  transactions: readonly Transaction[],
  period: Period,
): number {
  const start = firstLimitedPeriod(budget);
  if (start === undefined || comparePeriod(period, start) <= 0) {
    return 0;
  }

  let carry = 0;
  let cursor = start;
  while (comparePeriod(cursor, period) < 0) {
    // cursor is always >= start (the earliest effectiveFrom), so a limit is
    // guaranteed to resolve here.
    const limitMinor = (resolveLimit(budget, cursor) as CategoryLimit).amountMinor;
    const spent = spentInPeriod(transactions, budget.category, cursor);
    carry = budget.rollover ? limitMinor + carry - spent : 0;
    cursor = nextPeriod(cursor);
  }
  return carry;
}

/** Full budget status for `category` in `period`: limit, carry-in, spend, and state. */
export function budgetStatus(
  budget: CategoryBudget,
  transactions: readonly Transaction[],
  period: Period,
): PeriodBudgetStatus {
  const limit = resolveLimit(budget, period);
  const limitMinor = limit?.amountMinor ?? 0;
  const carryInMinor = carryover(budget, transactions, period);
  const availableMinor = limitMinor + carryInMinor;
  const spentMinor = spentInPeriod(transactions, budget.category, period);

  const state: BudgetState =
    spentMinor > availableMinor ? 'over' : spentMinor === availableMinor ? 'at' : 'under';
  const pctUsed = availableMinor === 0 ? null : (spentMinor / availableMinor) * 100;

  return {
    period,
    category: budget.category,
    limitMinor,
    carryInMinor,
    availableMinor,
    spentMinor,
    state,
    pctUsed,
  };
}
