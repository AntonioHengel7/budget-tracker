import { periodOf } from './date.js';
import { ValidationError } from './errors.js';
import { assertSafeNonNegativeInteger, subMinor, sumMinor } from './money.js';
import type { Period } from './period.js';
import { comparePeriod, nextPeriod, parsePeriod } from './period.js';
import type { Transaction } from './transaction.js';

/** A single limit amount, effective from a given period onward until superseded. */
export interface CategoryLimit {
  readonly effectiveFrom: Period;
  readonly amountMinor: number;
}

export interface CategoryLimitInput {
  readonly effectiveFrom: string;
  readonly amountMinor: number;
}

/** Validates and constructs a CategoryLimit, enforcing the same amount bar as money.ts. */
export function createCategoryLimit(input: CategoryLimitInput): CategoryLimit {
  const effectiveFrom = parsePeriod(input.effectiveFrom);
  assertSafeNonNegativeInteger(input.amountMinor, 'amountMinor');
  return { effectiveFrom, amountMinor: input.amountMinor };
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

export interface CategoryBudgetInput {
  readonly category: string;
  readonly rollover: boolean;
  readonly limits: readonly CategoryLimitInput[];
}

/** Validates and constructs a CategoryBudget, enforcing all entity invariants. */
export function createCategoryBudget(input: CategoryBudgetInput): CategoryBudget {
  const category = input.category.trim();
  if (category === '') {
    throw new ValidationError('category must not be empty');
  }

  return {
    category,
    rollover: input.rollover,
    limits: input.limits.map((limit) => createCategoryLimit(limit)),
  };
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
 *
 * `rollover` is a fixed property of the budget (not per-period), so when it
 * is false the result is always 0 -- no need to walk any periods at all.
 * When it is true, the recurrence telescopes: since every term is added
 * exactly once with a fixed +1 coefficient, carry(period) is equivalent to
 * (sum of limit(p) for p in [start, period)) - (sum of spent(p) for the same
 * range). That lets both accumulations run through sumMinor (which safe-
 * integer-guards every intermediate step via addMinor) instead of repeated
 * raw `+`/`-`, which had no such guard across iterations, and the final
 * combination -- which may legitimately go negative on overspend -- through
 * subMinor.
 */
export function carryover(
  budget: CategoryBudget,
  transactions: readonly Transaction[],
  period: Period,
): number {
  if (!budget.rollover) {
    return 0;
  }

  const start = firstLimitedPeriod(budget);
  if (start === undefined || comparePeriod(period, start) <= 0) {
    return 0;
  }

  const limitsAccrued: number[] = [];
  const spendsAccrued: number[] = [];
  let cursor = start;
  while (comparePeriod(cursor, period) < 0) {
    const limit = resolveLimit(budget, cursor);
    if (limit === undefined) {
      // coverage-skip: unreachable under the current algorithm -- cursor is
      // always >= start (the earliest effectiveFrom across budget.limits),
      // so resolveLimit is guaranteed to find at least that limit. Kept as
      // an explicit guard (Socrates, PR #4) so a future regression here
      // fails with a clear ValidationError instead of a raw TypeError from
      // an unsafe cast.
      throw new ValidationError(
        `no limit resolved for period "${cursor}" in category "${budget.category}" though it is within the budget's limited range`,
      );
    }
    limitsAccrued.push(limit.amountMinor);
    spendsAccrued.push(spentInPeriod(transactions, budget.category, cursor));
    cursor = nextPeriod(cursor);
  }

  const totalLimit = sumMinor(limitsAccrued);
  const totalSpent = sumMinor(spendsAccrued);
  return subMinor(totalLimit, totalSpent);
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
