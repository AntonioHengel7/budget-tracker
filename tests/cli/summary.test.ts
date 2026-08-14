import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { getSummary } from '../../src/cli/commands/summary.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-summary-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getSummary', () => {
  it('summarizes income/expense/net and per-category spend for a period', async () => {
    await addTransaction(filePath, { amount: '1000', category: 'salary', kind: 'income', date: '2026-08-01' });
    await addTransaction(filePath, { amount: '42.50', category: 'groceries', kind: 'expense', date: '2026-08-05' });
    await addTransaction(filePath, { amount: '10', category: 'transport', kind: 'expense', date: '2026-09-01' });

    const result = await getSummary(filePath, { period: '2026-08' });

    expect(result.period).toEqual({
      period: '2026-08',
      incomeMinor: 100000,
      expenseMinor: 4250,
      netMinor: 95750,
    });
    expect(result.byCategory).toEqual([{ category: 'groceries', spentMinor: 4250 }]);
  });

  it('rejects an invalid period', async () => {
    await expect(getSummary(filePath, { period: 'not-a-period' })).rejects.toThrow(ValidationError);
  });
});
