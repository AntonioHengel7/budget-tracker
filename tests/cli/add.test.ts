import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { loadStore } from '../../src/storage/jsonStore.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-add-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('addTransaction', () => {
  it('adds a transaction and persists it to the store', async () => {
    const result = await addTransaction(filePath, {
      amount: '12.34',
      category: 'groceries',
      kind: 'expense',
      date: '2026-08-01',
      note: 'lunch',
    });

    expect(result.transaction).toEqual({
      date: '2026-08-01',
      category: 'groceries',
      kind: 'expense',
      amountMinor: 1234,
      note: 'lunch',
    });
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const store = await loadStore(filePath);
    expect(store.transactions).toEqual([{ id: result.id, transaction: result.transaction }]);
  });

  it('adds a transaction with no note', async () => {
    const result = await addTransaction(filePath, {
      amount: '5',
      category: 'misc',
      kind: 'expense',
      date: '2026-08-01',
    });
    expect('note' in result.transaction).toBe(false);
  });

  it('rejects an invalid amount', async () => {
    await expect(
      addTransaction(filePath, { amount: '-5', category: 'groceries', kind: 'expense', date: '2026-08-01' }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects an invalid kind', async () => {
    await expect(
      addTransaction(filePath, { amount: '5', category: 'groceries', kind: 'transfer', date: '2026-08-01' }),
    ).rejects.toThrow(ValidationError);
  });
});
