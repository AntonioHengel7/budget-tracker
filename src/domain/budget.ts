import { periodOf } from './date.js';
import { ValidationError } from './errors.js';
import { addMinor, assertSafeNonNegativeInteger, subMinor, sumMinor } from './money.js';
import type { Period } from './period.js';
import { comparePeriod, nextPeriod, parsePeriod } from './period.js';
import { parseCategory } from './transaction.js';
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
  const category = parseCategory(input.category);

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
 * limitMinor + carry, where `carry` may legitimately be negative (a prior
 * overspend rolled forward). addMinor/subMinor both require non-negative
 * operands, so the sign of `carry` picks which one actually applies here:
 * limitMinor + carry === limitMinor - (-carry) when carry < 0. Either way,
 * every step is safe-integer-guarded -- never a raw `+`.
 */
function addCarryToLimit(limitMinor: number, carry: number): number {
  return carry >= 0 ? addMinor(limitMinor, carry) : subMinor(limitMinor, -carry);
}

/**
 * available - spentMinor, where `available` (limit + carry, above) may
 * itself be negative when a prior overspend exceeds the current limit.
 * subMinor requires a non-negative first operand, so mirror the same sign
 * trick: available - spent === -((-available) + spent) when available < 0.
 */
function subtractSpentFromAvailable(available: number, spentMinor: number): number {
  return available >= 0 ? subMinor(available, spentMinor) : -addMinor(-available, spentMinor);
}

/**
 * The balance carried INTO `period`, per the recurrence:
 *   carry(p+1) = rollover ? (limit(p) + carry(p) - spent(p)) : 0
 * with carry = 0 in the first period that has a limit (and in any period at
 * or before it, since there is nothing to carry yet).
 *
 * `rollover` is a fixed property of the budget (not per-period), so when it
 * is false the result is always 0 -- no need to walk any periods at all.
 * When it is true, this walks the periods one at a time exactly as the
 * recurrence specifies, but routes every addition/subtraction through
 * addCarryToLimit/subtractSpentFromAvailable (which are themselves built on
 * money.ts's addMinor/subMinor) instead of raw `+`/`-`, so an unsafe-integer
 * accumulation fails loudly instead of silently losing precision.
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

  let carry = 0;
  let cursor = start;
  while (comparePeriod(cursor, period) < 0) {
    // resolveLimit is expected to succeed for cursor >= start, but Period is
    // just `type Period = string` -- nothing forces effectiveFrom or period
    // values to have gone through parsePeriod before reaching this function,
    // and CategoryBudget/CategoryLimit can be (and, in this repo's own test
    // suite, are) constructed as plain object literals that bypass
    // createCategoryBudget entirely. An unpadded value like "2026-1" sorts
    // differently than "2026-01" under plain string comparison, which can
    // break the "cursor is always covered" assumption. This is a public API
    // boundary, so fail with a clear ValidationError instead of trusting an
    // invariant a caller can violate.
    const limit = resolveLimit(budget, cursor);
    if (limit === undefined) {
      throw new ValidationError(
        `no limit resolved for period "${cursor}" in category "${budget.category}" -- effectiveFrom values must be zero-padded "YYYY-MM" strings (see parsePeriod)`,
      );
    }
    const spent = spentInPeriod(transactions, budget.category, cursor);
    carry = subtractSpentFromAvailable(addCarryToLimit(limit.amountMinor, carry), spent);
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
  const ceilingMinor = addCarryToLimit(limitMinor, carryInMinor);
  const spentMinor = spentInPeriod(transactions, budget.category, period);

  const state: BudgetState =
    spentMinor > ceilingMinor ? 'over' : spentMinor === ceilingMinor ? 'at' : 'under';
  const pctUsed = ceilingMinor === 0 ? null : (spentMinor / ceilingMinor) * 100;
  const availableMinor = subtractSpentFromAvailable(ceilingMinor, spentMinor);

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
