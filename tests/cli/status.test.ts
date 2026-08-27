import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { setLimit } from '../../src/cli/commands/limit.js';
import { getStatus } from '../../src/cli/commands/status.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-status-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('getStatus', () => {
  it('reports status for every configured budget in the given period', async () => {
    await setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: '2026-08' });
    await addTransaction(filePath, { amount: '42.50', category: 'groceries', kind: 'expense', date: '2026-08-05' });

    const results = await getStatus(filePath, { period: '2026-08' });

    expect(results).toEqual([
      {
        period: '2026-08',
        category: 'groceries',
        limitMinor: 10000,
        carryInMinor: 0,
        availableMinor: 5750,
        spentMinor: 4250,
        state: 'under',
        pctUsed: 42.5,
      },
    ]);
  });

  it('returns an empty list when no budgets are configured', async () => {
    const results = await getStatus(filePath, { period: '2026-08' });
    expect(results).toEqual([]);
  });

  it('rejects an invalid period', async () => {
    await expect(getStatus(filePath, { period: 'not-a-period' })).rejects.toThrow(ValidationError);
  });

  // (#100) When a category's only limit's effectiveFrom is later than the
  // queried period, resolveLimit finds nothing -- state must be 'unset', not
  // a misleading 'over'/'at'/'under' against an implicit $0 ceiling.
  it('state is "unset" when queried before the category\'s limit takes effect', async () => {
    await setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: '2026-09' });

    const results = await getStatus(filePath, { period: '2026-08' });

    expect(results).toEqual([
      {
        period: '2026-08',
        category: 'groceries',
        limitMinor: 0,
        carryInMinor: 0,
        availableMinor: 0,
        spentMinor: 0,
        state: 'unset',
        pctUsed: null,
      },
    ]);
  });

  it('lists categories alphabetically regardless of underlying budget array order (#14)', async () => {
    // Set 'zebra' first, then 'apple' -- store.budgets ends up in insertion
    // order [zebra, apple], which is already non-alphabetical. Correcting
    // apple's limit goes through limit.ts's filter+rebuild (otherBudgets),
    // which re-appends apple at the end of the array -- leaving it
    // [zebra, apple] still, i.e. reverse-alphabetical. Without a stable
    // sort, getStatus would surface that incidental order verbatim.
    await setLimit(filePath, { category: 'zebra', amount: '50', effectiveFrom: '2026-08' });
    await setLimit(filePath, { category: 'apple', amount: '75', effectiveFrom: '2026-08' });
    // Correction: re-set apple's limit for the same effectiveFrom period.
    await setLimit(filePath, { category: 'apple', amount: '80', effectiveFrom: '2026-08' });

    const results = await getStatus(filePath, { period: '2026-08' });

    expect(results.map((s) => s.category)).toEqual(['apple', 'zebra']);
  });
});
