import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { removeLimit, setLimit } from '../../src/cli/commands/limit.js';
import { getStatus } from '../../src/cli/commands/status.js';
import { resolveLimit } from '../../src/domain/budget.js';
import { loadStore } from '../../src/storage/jsonStore.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-limit-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('setLimit', () => {
  it('creates a new budget with a first limit', async () => {
    const budget = await setLimit(filePath, {
      category: 'groceries',
      amount: '100',
      effectiveFrom: '2026-08',
      rollover: true,
    });

    expect(budget).toEqual({
      category: 'groceries',
      rollover: true,
      limits: [{ effectiveFrom: '2026-08', amountMinor: 10000 }],
    });

    const store = await loadStore(filePath);
    expect(store.budgets).toEqual([budget]);
  });

  it('appends a superseding limit and preserves rollover when not specified', async () => {
    await setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: '2026-08', rollover: true });
    const updated = await setLimit(filePath, { category: 'groceries', amount: '150', effectiveFrom: '2026-09' });

    expect(updated.rollover).toBe(true);
    expect(updated.limits).toEqual([
      { effectiveFrom: '2026-08', amountMinor: 10000 },
      { effectiveFrom: '2026-09', amountMinor: 15000 },
    ]);
  });

  // Regression (Socrates + Hobbes, PR #7 BLOCKING 1): resolveLimit (domain,
  // frozen) breaks ties on equal effectiveFrom by keeping the FIRST match --
  // setting a limit twice at the same period used to append a second entry
  // instead of correcting the first, so the CLI printed the new amount but
  // status/resolveLimit silently kept serving the old one.
  it('replaces (not appends) a limit set again at the same effectiveFrom period', async () => {
    const first = await setLimit(filePath, {
      category: 'food',
      amount: '500',
      effectiveFrom: '2026-08',
    });
    expect(first.limits).toEqual([{ effectiveFrom: '2026-08', amountMinor: 50000 }]);

    const second = await setLimit(filePath, {
      category: 'food',
      amount: '600',
      effectiveFrom: '2026-08',
    });

    expect(second.limits).toEqual([{ effectiveFrom: '2026-08', amountMinor: 60000 }]);
    expect(resolveLimit(second, '2026-08')).toEqual({ effectiveFrom: '2026-08', amountMinor: 60000 });

    const status = await getStatus(filePath, { period: '2026-08' });
    expect(status).toEqual([
      expect.objectContaining({ category: 'food', limitMinor: 60000 }),
    ]);
  });

  it('rejects an invalid amount', async () => {
    await expect(
      setLimit(filePath, { category: 'groceries', amount: 'nope', effectiveFrom: '2026-08' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an invalid effectiveFrom period', async () => {
    await expect(
      setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: 'not-a-period' }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('removeLimit', () => {
  it('removes an existing budget by category', async () => {
    const budget = await setLimit(filePath, {
      category: 'groceries',
      amount: '100',
      effectiveFrom: '2026-08',
    });

    const removed = await removeLimit(filePath, 'groceries');
    expect(removed).toEqual(budget);

    const store = await loadStore(filePath);
    expect(store.budgets).toEqual([]);
  });

  it('rejects a category with no budget', async () => {
    await expect(removeLimit(filePath, 'nope')).rejects.toThrow(ValidationError);
  });

  it('does not affect other categories\' budgets or any transactions', async () => {
    await setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: '2026-08' });
    const rentBudget = await setLimit(filePath, { category: 'rent', amount: '1500', effectiveFrom: '2026-08' });
    const added = await addTransaction(filePath, {
      amount: '10',
      category: 'groceries',
      kind: 'expense',
      date: '2026-08-01',
    });

    await removeLimit(filePath, 'groceries');

    const store = await loadStore(filePath);
    expect(store.budgets).toEqual([rentBudget]);
    expect(store.transactions).toHaveLength(1);
    expect(store.transactions[0]?.id).toBe(added.id);
  });

  it('trims whitespace around the category, matching setLimit\'s trim behavior', async () => {
    await setLimit(filePath, { category: 'groceries', amount: '100', effectiveFrom: '2026-08' });

    const removed = await removeLimit(filePath, '  groceries  ');
    expect(removed.category).toBe('groceries');

    const store = await loadStore(filePath);
    expect(store.budgets).toEqual([]);
  });
});
