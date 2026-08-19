import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { listTransactions } from '../../src/cli/commands/list.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-list-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('listTransactions', () => {
  it('lists all transactions sorted by date ascending when no filter given', async () => {
    await addTransaction(filePath, { amount: '2', category: 'b', kind: 'expense', date: '2026-08-02' });
    await addTransaction(filePath, { amount: '1', category: 'a', kind: 'expense', date: '2026-08-01' });

    const results = await listTransactions(filePath, {});
    expect(results.map((st) => st.transaction.date)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('filters by category, kind, date range, and note substring', async () => {
    await addTransaction(filePath, {
      amount: '10',
      category: 'groceries',
      kind: 'expense',
      date: '2026-08-01',
      note: 'weekly shop',
    });
    await addTransaction(filePath, { amount: '1000', category: 'salary', kind: 'income', date: '2026-08-05' });
    await addTransaction(filePath, { amount: '10', category: 'groceries', kind: 'expense', date: '2026-09-01' });

    const results = await listTransactions(filePath, {
      category: 'groceries',
      kind: 'expense',
      from: '2026-08-01',
      to: '2026-08-31',
      note: 'weekly',
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.transaction.date).toBe('2026-08-01');
  });

  it('trims whitespace in --category, matching the write-path trimming', async () => {
    await addTransaction(filePath, { amount: '10', category: 'groceries', kind: 'expense', date: '2026-08-01' });
    await addTransaction(filePath, { amount: '5', category: 'dining', kind: 'expense', date: '2026-08-02' });

    const trimmed = await listTransactions(filePath, { category: 'groceries' });
    const untrimmed = await listTransactions(filePath, { category: '  groceries  ' });

    expect(untrimmed).toEqual(trimmed);
    expect(untrimmed).toHaveLength(1);
    expect(untrimmed[0]?.transaction.category).toBe('groceries');
  });

  it('rejects an invalid --from date', async () => {
    await expect(listTransactions(filePath, { from: 'not-a-date' })).rejects.toThrow(ValidationError);
  });

  it('rejects an invalid --kind filter', async () => {
    await expect(listTransactions(filePath, { kind: 'transfer' })).rejects.toThrow(ValidationError);
  });
});
