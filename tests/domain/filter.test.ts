import { describe, expect, it } from 'vitest';
import { filterTransactions } from '../../src/domain/filter.js';
import { createTransaction } from '../../src/domain/transaction.js';
import type { Transaction } from '../../src/domain/transaction.js';

const transactions: Transaction[] = [
  createTransaction({ date: '2026-01-01', category: 'groceries', kind: 'expense', amountMinor: 100 }),
  createTransaction({ date: '2026-01-15', category: 'dining', kind: 'expense', amountMinor: 200 }),
  createTransaction({ date: '2026-01-31', category: 'groceries', kind: 'income', amountMinor: 300 }),
  createTransaction({
    date: '2026-02-01',
    category: 'groceries',
    kind: 'expense',
    amountMinor: 400,
    note: 'Monthly Costco run',
  }),
];

describe('filterTransactions', () => {
  it('applies a date range inclusive of both ends', () => {
    const result = filterTransactions(transactions, { from: '2026-01-01', to: '2026-01-31' });
    expect(result).toHaveLength(3);
    expect(result.every((tx) => tx.date >= '2026-01-01' && tx.date <= '2026-01-31')).toBe(true);
  });

  it('excludes transactions before the "from" bound', () => {
    const result = filterTransactions(transactions, { from: '2026-01-16' });
    expect(result.every((tx) => tx.date >= '2026-01-16')).toBe(true);
    expect(result.some((tx) => tx.date === '2026-01-01')).toBe(false);
  });

  it('excludes transactions after the "to" bound', () => {
    const result = filterTransactions(transactions, { to: '2026-01-15' });
    expect(result.every((tx) => tx.date <= '2026-01-15')).toBe(true);
    expect(result.some((tx) => tx.date === '2026-02-01')).toBe(false);
  });

  it('matches category exactly', () => {
    const result = filterTransactions(transactions, { category: 'groceries' });
    expect(result).toHaveLength(3);
    expect(result.every((tx) => tx.category === 'groceries')).toBe(true);
  });

  it('matches kind exactly', () => {
    const result = filterTransactions(transactions, { kind: 'income' });
    expect(result).toHaveLength(1);
    expect(result[0]?.amountMinor).toBe(300);
  });

  it('matches note substring case-insensitively', () => {
    const result = filterTransactions(transactions, { noteContains: 'costco' });
    expect(result).toHaveLength(1);
    expect(result[0]?.note).toBe('Monthly Costco run');
  });

  it('excludes transactions with no note when filtering by note substring', () => {
    const result = filterTransactions(transactions, { noteContains: 'anything' });
    expect(result).toHaveLength(0);
  });
});
