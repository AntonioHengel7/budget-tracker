import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

// Imported after the mock so jsonStore.ts picks up the mocked `writeFile`.
import { writeFile } from 'node:fs/promises';
import { ValidationError } from '../../src/domain/errors.js';
import { loadStore, saveStore, StorageError } from '../../src/storage/jsonStore.js';
import type { PersistedStore } from '../../src/storage/schema.js';

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonstore-test-'));
  filePath = join(dir, 'budget.json');
  vi.mocked(writeFile).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.mocked(writeFile).mockReset();
});

const sampleStore: PersistedStore = {
  schemaVersion: 1,
  transactions: [
    {
      id: 'tx-1',
      transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: 1500 },
    },
    {
      id: 'tx-2',
      transaction: {
        date: '2026-08-02',
        category: 'salary',
        kind: 'income',
        amountMinor: 100000,
        note: 'august pay',
      },
    },
  ],
  budgets: [
    {
      category: 'groceries',
      rollover: true,
      limits: [{ effectiveFrom: '2026-08', amountMinor: 20000 }],
    },
  ],
};

describe('jsonStore', () => {
  it('round-trip load/save preserves all data', async () => {
    await saveStore(filePath, sampleStore);
    const loaded = await loadStore(filePath);
    expect(loaded).toEqual(sampleStore);
  });

  it('missing file returns an empty default store, no error', async () => {
    const loaded = await loadStore(join(dir, 'does-not-exist.json'));
    expect(loaded).toEqual({ schemaVersion: 1, transactions: [], budgets: [] });
  });

  it('corrupt JSON throws StorageError, not a raw SyntaxError', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, '{not valid json');
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
    await expect(loadStore(filePath)).rejects.not.toThrow(SyntaxError);
  });

  it('wrong schemaVersion throws StorageError', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, transactions: [], budgets: [] }));
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
  });

  it('a hand-crafted tampered transaction (negative amountMinor) is rejected on load via createTransaction, not silently accepted', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [
          {
            id: 'tampered',
            transaction: {
              date: '2026-08-01',
              category: 'groceries',
              kind: 'expense',
              amountMinor: -500,
            },
          },
        ],
        budgets: [],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(ValidationError);
  });

  // Regressions (Socrates + Hobbes, PR #7 BLOCKING 2): the domain
  // constructors are only TypeScript-typed, which is compile-time-only and
  // enforces nothing at runtime -- a hand-edited file could put the wrong
  // JS type on a field and either silently corrupt data (JS truthiness on a
  // stringy "rollover") or crash with a raw TypeError instead of the
  // promised StorageError. loadStore must now type-check every field before
  // handing it to a domain constructor.
  it('rejects a non-boolean "rollover" field (e.g. the string "no") as StorageError, not silent truthy coercion', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [],
        budgets: [
          {
            category: 'groceries',
            rollover: 'no',
            limits: [{ effectiveFrom: '2026-08', amountMinor: 10000 }],
          },
        ],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
  });

  it('rejects a non-string "date" field (e.g. an array) as StorageError, not a raw TypeError or a silently coerced ghost value', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [
          {
            id: 'ghost',
            transaction: {
              date: ['2026-08-05'],
              category: 'groceries',
              kind: 'expense',
              amountMinor: 500,
            },
          },
        ],
        budgets: [],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
  });

  it('rejects a missing/non-array "limits" field as StorageError, not a raw TypeError from .map()', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [],
        budgets: [{ category: 'groceries', rollover: false, limits: undefined }],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
  });

  // Regression (#15): CategoryBudget is designed as "one budget per
  // category", but nothing enforced that at load time. A hand-edited (or
  // otherwise produced) store file with two entries sharing a category used
  // to load "successfully" and then silently collide the next time
  // setLimit's `filter((budget) => budget.category !== updated.category)`
  // ran -- dropping BOTH pre-existing entries and keeping only the one being
  // updated. loadStore must reject the duplicate outright instead.
  it('rejects a store file with two budgets sharing the same category as StorageError', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [],
        budgets: [
          {
            category: 'food',
            rollover: false,
            limits: [{ effectiveFrom: '2026-08', amountMinor: 10000 }],
          },
          {
            category: 'food',
            rollover: true,
            limits: [{ effectiveFrom: '2026-08', amountMinor: 25000 }],
          },
        ],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
    await expect(loadStore(filePath)).rejects.toThrow(/more than one budget/);
  });

  // Same defect, but via categories that only collide after the domain
  // constructor's own normalization (createCategoryBudget trims whitespace).
  // A naive raw-string comparison before construction would miss this.
  it('rejects two budgets whose categories collide only after trimming', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [],
        budgets: [
          {
            category: 'food',
            rollover: false,
            limits: [{ effectiveFrom: '2026-08', amountMinor: 10000 }],
          },
          {
            category: '  food  ',
            rollover: true,
            limits: [{ effectiveFrom: '2026-08', amountMinor: 25000 }],
          },
        ],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
  });

  it('saved file has mode 0600', async () => {
    await saveStore(filePath, sampleStore);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('a simulated write failure leaves no partial/corrupt file (atomic write via temp file + rename)', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('simulated disk full'));

    await expect(saveStore(filePath, sampleStore)).rejects.toThrow(StorageError);

    // The real path must never have been touched.
    expect(readdirSync(dir)).toEqual([]);
  });
});
