import { describe, expect, it } from 'vitest';
import type { CategoryBudget } from '../../src/domain/budget.js';
import { budgetStatus, carryover, resolveLimit, spentInPeriod } from '../../src/domain/budget.js';
import { createTransaction } from '../../src/domain/transaction.js';
import type { Transaction } from '../../src/domain/transaction.js';

function expenseTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'expense', amountMinor });
}

function incomeTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'income', amountMinor });
}

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

  it('pctUsed is null when available === 0', () => {
    // Query a period before any limit takes effect: limitMinor is 0 and
    // there is no carry yet, so availableMinor is 0.
    const status = budgetStatus(budget, [], '2025-12');
    expect(status.availableMinor).toBe(0);
    expect(status.pctUsed).toBeNull();
  });
});
