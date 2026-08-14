import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addTransaction } from '../../src/cli/commands/add.js';
import { removeTransaction } from '../../src/cli/commands/rm.js';
import { loadStore } from '../../src/storage/jsonStore.js';
import { ValidationError } from '../../src/domain/errors.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-rm-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('removeTransaction', () => {
  it('removes an existing transaction by id', async () => {
    const added = await addTransaction(filePath, {
      amount: '5',
      category: 'misc',
      kind: 'expense',
      date: '2026-08-01',
    });

    const removed = await removeTransaction(filePath, added.id);
    expect(removed.id).toBe(added.id);

    const store = await loadStore(filePath);
    expect(store.transactions).toEqual([]);
  });

  it('rejects an unknown id', async () => {
    await expect(removeTransaction(filePath, 'nope')).rejects.toThrow(ValidationError);
  });
});
