import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLimit } from '../../src/cli/commands/limit.js';
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
