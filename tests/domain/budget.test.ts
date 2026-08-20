import { describe, expect, it } from 'vitest';
import type { CategoryBudget } from '../../src/domain/budget.js';
import {
  budgetStatus,
  carryover,
  createCategoryBudget,
  createCategoryLimit,
  resolveLimit,
  spentInPeriod,
} from '../../src/domain/budget.js';
import { ValidationError } from '../../src/domain/errors.js';
import { createTransaction } from '../../src/domain/transaction.js';
import type { Transaction } from '../../src/domain/transaction.js';

function expenseTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'expense', amountMinor });
}

function incomeTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'income', amountMinor });
}

describe('createCategoryLimit', () => {
  it('creates a valid limit', () => {
    expect(createCategoryLimit({ effectiveFrom: '2026-01', amountMinor: 1000 })).toEqual({
      effectiveFrom: '2026-01',
      amountMinor: 1000,
    });
  });

  // Regression (Hobbes, PR #4 BLOCKING 3a): a NaN limit amount used to sail
  // through untouched -- every comparison against NaN is false, so
  // budgetStatus would silently fall through to state: 'under' no matter
  // how much was spent. It must now be rejected at construction time.
  it('rejects a NaN amountMinor', () => {
    expect(() => createCategoryLimit({ effectiveFrom: '2026-01', amountMinor: NaN })).toThrow(
      ValidationError,
    );
  });

  it('rejects a negative amountMinor', () => {
    expect(() => createCategoryLimit({ effectiveFrom: '2026-01', amountMinor: -1 })).toThrow(
      ValidationError,
    );
  });

  it('rejects an amountMinor beyond the safe integer range', () => {
    expect(() => createCategoryLimit({ effectiveFrom: '2026-01', amountMinor: 1e300 })).toThrow(
      ValidationError,
    );
  });

  it('rejects a malformed effectiveFrom period', () => {
    expect(() => createCategoryLimit({ effectiveFrom: '2026-13', amountMinor: 1000 })).toThrow(
      ValidationError,
    );
  });
});

describe('createCategoryBudget', () => {
  it('creates a valid budget, validating each of its limits', () => {
    const budget = createCategoryBudget({
      category: 'groceries',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    });
    expect(budget).toEqual({
      category: 'groceries',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    });
  });

  it('rejects an empty category', () => {
    expect(() => createCategoryBudget({ category: '', rollover: true, limits: [] })).toThrow(
      ValidationError,
    );
  });

  it('rejects a category over 100 characters', () => {
    expect(() =>
      createCategoryBudget({ category: 'a'.repeat(101), rollover: true, limits: [] }),
    ).toThrow(ValidationError);
  });

  it('accepts a category of exactly 100 characters', () => {
    const category = 'a'.repeat(100);
    const budget = createCategoryBudget({ category, rollover: true, limits: [] });
    expect(budget.category).toBe(category);
  });

  // Regression (Hobbes, PR #4 BLOCKING 3a): a NaN limit nested inside a
  // budget's limit history must be rejected the same way a top-level one is.
  it('rejects a NaN amountMinor on any of its limits', () => {
    expect(() =>
      createCategoryBudget({
        category: 'groceries',
        rollover: true,
        limits: [{ effectiveFrom: '2026-01', amountMinor: NaN }],
      }),
    ).toThrow(ValidationError);
  });
});

describe('resolveLimit', () => {
  const budget: CategoryBudget = {
    category: 'groceries',
    rollover: true,
    limits: [
      { effectiveFrom: '2026-01', amountMinor: 10000 },
      { effectiveFrom: '2026-04', amountMinor: 15000 },
    ],
  };

  it('picks the latest limit with effectiveFrom <= period', () => {
    expect(resolveLimit(budget, '2026-03')).toEqual({ effectiveFrom: '2026-01', amountMinor: 10000 });
    expect(resolveLimit(budget, '2026-05')).toEqual({ effectiveFrom: '2026-04', amountMinor: 15000 });
    expect(resolveLimit(budget, '2026-04')).toEqual({ effectiveFrom: '2026-04', amountMinor: 15000 });
  });

  it('returns undefined when all limits start later', () => {
    expect(resolveLimit(budget, '2025-12')).toBeUndefined();
  });
});

describe('spentInPeriod', () => {
  it('ignores income, other categories, and other periods', () => {
    const transactions: Transaction[] = [
      expenseTx('2026-01-05', 'groceries', 500),
      expenseTx('2026-01-20', 'groceries', 300),
      incomeTx('2026-01-10', 'groceries', 100000),
      expenseTx('2026-01-15', 'dining', 200),
      expenseTx('2026-02-01', 'groceries', 400),
    ];

    expect(spentInPeriod(transactions, 'groceries', '2026-01')).toBe(800);
  });
});

describe('carryover', () => {
  it('is 0 in the first period that has a limit', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    expect(carryover(budget, [], '2026-01')).toBe(0);
  });

  it('rollover:true carries unspent surplus forward', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    // No spending in 2026-01 -> full limit rolls into 2026-02.
    expect(carryover(budget, [], '2026-02')).toBe(1000);
  });

  it('rollover:true carries a NEGATIVE balance (overspend) forward', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    const transactions = [expenseTx('2026-01-10', 'x', 1500)];
    expect(carryover(budget, transactions, '2026-02')).toBe(-500);
  });

  it('rollover:false resets carryover to 0 on both surplus and overspend', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: false,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    const surplusTransactions: Transaction[] = [];
    const overspendTransactions = [expenseTx('2026-01-10', 'x', 1500)];

    expect(carryover(budget, surplusTransactions, '2026-02')).toBe(0);
    expect(carryover(budget, overspendTransactions, '2026-02')).toBe(0);
  });

  it('folds correctly across a gap month with no transactions', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    // 2026-02 is a gap month: no transactions logged at all, but the limit
    // still accrues since rollover is on.
    // carry(2026-02) = 1000 + 0 - 0 = 1000
    // carry(2026-03) = 1000 + 1000 - 0 = 2000
    expect(carryover(budget, [], '2026-03')).toBe(2000);
  });

  // Regression (Hobbes, PR #4 BLOCKING 3b): the old recurrence accumulated
  // via raw `+`/`-` with no safe-integer check across iterations, so large-
  // but-individually-safe amounts could silently exceed
  // Number.MAX_SAFE_INTEGER after a few periods and produce an imprecise
  // number instead of failing. Each per-period step now routes through
  // addMinor/subMinor (via addCarryToLimit/subtractSpentFromAvailable),
  // which guard this.
  it('throws instead of silently exceeding the safe integer range while accumulating', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 5_000_000_000_000_000 }],
    };
    // Two periods with no spending push the accumulated total
    // (5e15 + 5e15 = 1e16) past Number.MAX_SAFE_INTEGER.
    expect(() => carryover(budget, [], '2026-03')).toThrow(ValidationError);
  });

  // A prior overspend (negative carry) must combine correctly with a later
  // period's limit -- addMinor/subMinor only accept non-negative operands,
  // so this exercises the sign-flip path in addCarryToLimit.
  it('correctly combines a carried-forward negative balance with a later limit', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
    };
    const transactions = [
      expenseTx('2026-01-10', 'x', 1500), // overspend by 500 in month 1
      expenseTx('2026-02-10', 'x', 200),
    ];
    // carry(2026-02) = 1000 + 0 - 1500 = -500
    // carry(2026-03) = 1000 + (-500) - 200 = 300
    expect(carryover(budget, transactions, '2026-03')).toBe(300);
  });

  // A deep-enough overspend can leave the combined "available" balance
  // itself negative even after adding a later period's limit -- exercises
  // the sign-flip path in subtractSpentFromAvailable.
  it('handles an available balance that stays negative after a later limit is added', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 100 }],
    };
    const transactions = [expenseTx('2026-01-10', 'x', 10000)];
    // carry(2026-02) = 100 + 0 - 10000 = -9900
    // carry(2026-03) = 100 + (-9900) - 0 = -9800
    expect(carryover(budget, transactions, '2026-03')).toBe(-9800);
  });

  it('is correct when the limit changes mid-stream', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [
        { effectiveFrom: '2026-01', amountMinor: 1000 },
        { effectiveFrom: '2026-02', amountMinor: 2000 },
      ],
    };
    // carry(2026-02) = limit(2026-01)=1000 + 0 - 0 = 1000
    // carry(2026-03) = limit(2026-02)=2000 + 1000 - 0 = 3000
    expect(carryover(budget, [], '2026-03')).toBe(3000);
  });

  // Regression (Socrates, PR #4 round 3 BLOCKING 1): CategoryBudget can be
  // (and, throughout this very file, is) constructed as a plain object
  // literal that bypasses createCategoryBudget/parsePeriod entirely. An
  // unpadded effectiveFrom like "2026-1" sorts differently than a proper
  // "2026-01" under the plain string comparison every function in this
  // module relies on: nextPeriod("2026-1") produces "2026-02" (string
  // concatenation has no idea "2026-1" should have meant "2026-01"), and
  // comparePeriod("2026-1", "2026-02") > 0 -- so resolveLimit fails to find
  // a limit it logically should have, at a cursor mid-loop. This must throw
  // a ValidationError, not dereference `undefined` via an unsafe cast.
  it('throws a ValidationError (not a raw TypeError) when an unpadded effectiveFrom desyncs string ordering mid-loop', () => {
    const budget: CategoryBudget = {
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-1', amountMinor: 100 }],
    };
    expect(() => carryover(budget, [], '2027-01')).toThrow(ValidationError);
  });
});

describe('budgetStatus', () => {
  const budget: CategoryBudget = {
    category: 'x',
    rollover: false,
    limits: [{ effectiveFrom: '2026-01', amountMinor: 1000 }],
  };

  it('state is "over" when spent > available', () => {
    const status = budgetStatus(budget, [expenseTx('2026-01-05', 'x', 1200)], '2026-01');
    expect(status.state).toBe('over');
    expect(status.pctUsed).toBe(120);
  });

  it('state is "at" when spent === available', () => {
    const status = budgetStatus(budget, [expenseTx('2026-01-05', 'x', 1000)], '2026-01');
    expect(status.state).toBe('at');
    expect(status.pctUsed).toBe(100);
  });

  it('state is "under" otherwise', () => {
    const status = budgetStatus(budget, [expenseTx('2026-01-05', 'x', 500)], '2026-01');
    expect(status.state).toBe('under');
    expect(status.pctUsed).toBe(50);
  });

  // Regression (#31): availableMinor used to return the period's spending
  // ceiling (limitMinor + carryInMinor) unconditionally -- never subtracting
  // spentMinor -- so "available" reported the same number regardless of how
  // much had already been spent. It must report what's actually left to
  // spend, while state/pctUsed keep using the ceiling unchanged.
  it('availableMinor reflects remaining spend, not just the ceiling', () => {
    const status = budgetStatus(budget, [expenseTx('2026-01-05', 'x', 250)], '2026-01');
    expect(status.availableMinor).toBe(status.limitMinor + status.carryInMinor - status.spentMinor);
    expect(status.availableMinor).toBe(750);
  });

  it('pctUsed is null when available === 0', () => {
    // Query a period before any limit takes effect: limitMinor is 0 and
    // there is no carry yet, so availableMinor is 0.
    const status = budgetStatus(budget, [], '2025-12');
    expect(status.availableMinor).toBe(0);
    expect(status.pctUsed).toBeNull();
  });

  // Regression (Socrates, PR #4 round 3 BLOCKING 2): availableMinor used to
  // be a raw `limitMinor + carryInMinor`, the same unguarded-addition defect
  // class already fixed in carryover itself via addCarryToLimit. Reachable
  // through the fully validated public API, no object-literal bypass needed:
  // a large-but-individually-safe limit, once carried forward a period,
  // combines with the next period's limit to exceed
  // Number.MAX_SAFE_INTEGER.
  it('throws instead of silently exceeding the safe integer range when combining limit and carry', () => {
    const bigLimitBudget = createCategoryBudget({
      category: 'x',
      rollover: true,
      limits: [{ effectiveFrom: '2026-01', amountMinor: 5_000_000_000_000_000 }],
    });
    // carryInMinor into 2026-02 is 5e15 (the full limit rolls forward, no
    // spending yet); limitMinor for 2026-02 is also 5e15 -- their sum
    // (1e16) exceeds Number.MAX_SAFE_INTEGER.
    expect(() => budgetStatus(bigLimitBudget, [], '2026-02')).toThrow(ValidationError);
  });
});
