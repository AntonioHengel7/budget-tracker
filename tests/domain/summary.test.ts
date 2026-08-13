import { describe, expect, it } from 'vitest';
import { byCategory, periodSummary, runningBalance } from '../../src/domain/summary.js';
import { createTransaction } from '../../src/domain/transaction.js';
import type { Transaction } from '../../src/domain/transaction.js';

function expenseTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'expense', amountMinor });
}

function incomeTx(date: string, category: string, amountMinor: number): Transaction {
  return createTransaction({ date, category, kind: 'income', amountMinor });
}

describe('periodSummary', () => {
  it('nets income minus expense', () => {
    const transactions: Transaction[] = [
      incomeTx('2026-01-01', 'salary', 500000),
      expenseTx('2026-01-05', 'groceries', 15000),
      expenseTx('2026-01-10', 'dining', 5000),
      expenseTx('2026-02-01', 'groceries', 9999), // other period, excluded
    ];

    const summary = periodSummary(transactions, '2026-01');
    expect(summary).toEqual({
      period: '2026-01',
      incomeMinor: 500000,
      expenseMinor: 20000,
      netMinor: 480000,
    });
  });
});

describe('byCategory', () => {
  it('sorts by spend desc, ties by category asc', () => {
    const transactions: Transaction[] = [
      expenseTx('2026-01-01', 'dining', 1000),
      expenseTx('2026-01-02', 'groceries', 3000),
      expenseTx('2026-01-03', 'transport', 1000),
      expenseTx('2026-01-04', 'groceries', 500),
      incomeTx('2026-01-05', 'groceries', 999999), // income excluded
      expenseTx('2026-02-01', 'groceries', 5000), // other period, excluded
    ];

    expect(byCategory(transactions, '2026-01')).toEqual([
      { category: 'groceries', spentMinor: 3500 },
      { category: 'dining', spentMinor: 1000 },
      { category: 'transport', spentMinor: 1000 },
    ]);
  });

  it('breaks a tie in the other direction too (category b before category a is not assumed)', () => {
    const transactions: Transaction[] = [
      expenseTx('2026-01-01', 'zebra', 1000),
      expenseTx('2026-01-02', 'apple', 1000),
    ];

    expect(byCategory(transactions, '2026-01')).toEqual([
      { category: 'apple', spentMinor: 1000 },
      { category: 'zebra', spentMinor: 1000 },
    ]);
  });
});

describe('runningBalance', () => {
  it('accumulates chronologically', () => {
    const transactions: Transaction[] = [
      // deliberately out of date order in the input array
      expenseTx('2026-01-20', 'dining', 2000),
      incomeTx('2026-01-01', 'salary', 100000),
      expenseTx('2026-01-10', 'groceries', 15000),
    ];

    expect(runningBalance(transactions)).toBe(100000 - 15000 - 2000);
  });

  it('is 0 for an empty log', () => {
    expect(runningBalance([])).toBe(0);
  });

  it('sums correctly when two transactions share the same date', () => {
    const transactions: Transaction[] = [
      incomeTx('2026-01-01', 'salary', 1000),
      expenseTx('2026-01-01', 'groceries', 300),
    ];

    expect(runningBalance(transactions)).toBe(700);
  });
});
