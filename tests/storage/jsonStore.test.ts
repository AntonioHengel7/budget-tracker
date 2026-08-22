import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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
import { loadStore, saveStore, StorageError, updateStore } from '../../src/storage/jsonStore.js';
import type { PersistedStore, StoredTransaction } from '../../src/storage/schema.js';

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

  // Regression (#8): `rm` looks up a transaction by id and removes it, but
  // ids are only unique by convention (crypto.randomUUID() at creation
  // time) -- nothing enforced that at load time. A hand-edited store file
  // with two transactions sharing an id used to load "successfully" and
  // leave `rm`'s id lookup with undefined behavior. loadStore must reject
  // the duplicate outright instead.
  it('rejects a store file with two transactions sharing the same id as StorageError', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [
          {
            id: 'dup',
            transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: 500 },
          },
          {
            id: 'dup',
            transaction: { date: '2026-08-02', category: 'salary', kind: 'income', amountMinor: 1000 },
          },
        ],
        budgets: [],
      }),
    );
    await expect(loadStore(filePath)).rejects.toThrow(StorageError);
    await expect(loadStore(filePath)).rejects.toThrow(/more than one transaction with id/);
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

  // Regression (#52): mkdir's { recursive: true } used no explicit mode,
  // so the store/lock directory ended up at the default (umask-dependent,
  // typically 0755) mode -- group/world-readable+executable, letting other
  // local users list the directory's filenames even though they can't read
  // the 0600 file contents. saveStore must create a freshly-created store
  // directory at 0700, matching the file's own tightened permissions.
  it('creates a fresh store directory with mode 0700, not the default umask-dependent mode', async () => {
    const freshDir = join(dir, 'nested', 'store-dir');
    const freshFilePath = join(freshDir, 'budget.json');

    await saveStore(freshFilePath, sampleStore);

    const mode = statSync(freshDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('a simulated write failure leaves no partial/corrupt file (atomic write via temp file + rename)', async () => {
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('simulated disk full'));

    await expect(saveStore(filePath, sampleStore)).rejects.toThrow(StorageError);

    // The real path must never have been touched.
    expect(readdirSync(dir)).toEqual([]);
  });
});

// Regression (issue #9): every mutating CLI command used to do an
// unlocked load-modify-save cycle, so two concurrent invocations against
// the same file could both load the same starting state and whichever
// saved last would silently overwrite the other's write. updateStore wraps
// the cycle in an exclusive lock file so this can no longer happen -- either
// the second invocation's load waits until the first has saved and released
// the lock (serializing the two updates, no data lost), or, if the lock
// can't be acquired in time, it fails loudly instead of racing unlocked.
describe('updateStore (issue #9: concurrent-write race)', () => {
  function appendMutator(stored: StoredTransaction) {
    return (store: PersistedStore) => ({
      store: { ...store, transactions: [...store.transactions, stored] },
      result: stored,
    });
  }

  const txA: StoredTransaction = {
    id: 'tx-a',
    transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: 100 },
  };
  const txB: StoredTransaction = {
    id: 'tx-b',
    transaction: { date: '2026-08-02', category: 'groceries', kind: 'expense', amountMinor: 200 },
  };

  it('two overlapping updateStore calls against the same file both persist -- neither write is silently lost', async () => {
    // Both start "concurrently" (before either has acquired the lock);
    // without the lock, both would load the same empty starting store and
    // the second save would clobber the first, leaving only one transaction.
    const [resultA, resultB] = await Promise.all([
      updateStore(filePath, appendMutator(txA)),
      updateStore(filePath, appendMutator(txB)),
    ]);

    expect([resultA, resultB]).toEqual(expect.arrayContaining([txA, txB]));

    const final = await loadStore(filePath);
    expect(final.transactions.map((t) => t.id).sort()).toEqual(['tx-a', 'tx-b']);
  });

  it('serializes many overlapping updateStore calls without dropping any of them', async () => {
    const stored: StoredTransaction[] = Array.from({ length: 8 }, (_, i) => ({
      id: `tx-${i}`,
      transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: i + 1 },
    }));

    await Promise.all(stored.map((entry) => updateStore(filePath, appendMutator(entry))));

    const final = await loadStore(filePath);
    expect(final.transactions.map((t) => t.id).sort()).toEqual(stored.map((s) => s.id).sort());
  });

  it('fails loudly with a StorageError (instead of silently proceeding unlocked) when the lock cannot be acquired within timeoutMs', async () => {
    // Simulate a concurrent holder by creating the lock file ourselves and
    // never releasing it.
    writeFileSync(`${filePath}.lock`, `${process.pid}\n`, { flag: 'wx' });

    await expect(
      updateStore(filePath, appendMutator(txA), { timeoutMs: 100 }),
    ).rejects.toThrow(StorageError);
    await expect(
      updateStore(filePath, appendMutator(txA), { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out.*lock/i);

    // The would-be write must never have been applied.
    const final = await loadStore(filePath);
    expect(final.transactions).toEqual([]);
  });

  it('treats a lock file far older than the stale threshold as abandoned and steals it, rather than waiting/failing forever', async () => {
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    // Back-date the lock well past the 30s staleness threshold so it reads
    // as belonging to a crashed holder rather than a live writer.
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const result = await updateStore(filePath, appendMutator(txA), { timeoutMs: 200 });
    expect(result).toEqual(txA);

    const final = await loadStore(filePath);
    expect(final.transactions).toEqual([txA]);
  });

  it('honours timeoutMs (does not busy-loop forever) when the lock path is a dangling symlink', async () => {
    // Regression (Hobbes, PR #50 round 1 BLOCKING): open(lockPath, 'wx')
    // fails EEXIST on a symlink even when its target doesn't exist, but the
    // old code inspected it with `stat` (which follows the link) and
    // treated the resulting ENOENT as "released, retry immediately" --
    // skipping both the deadline check and the sleep, forever. Any local
    // user who can write to the store directory could wedge every writer
    // at 100% CPU by dropping a dangling symlink at `<file>.lock`.
    const lockPath = `${filePath}.lock`;
    symlinkSync('/nonexistent-target', lockPath);

    const start = Date.now();
    await expect(
      updateStore(filePath, appendMutator(txA), { timeoutMs: 200 }),
    ).rejects.toThrow(/timed out.*lock/i);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  // Regression (#52): acquireLock has its own mkdir call site (separate
  // from saveStore's), also creating the containing directory when --file
  // points at a not-yet-created path. It must be tightened the same way.
  it('creates a fresh lock directory with mode 0700, not the default umask-dependent mode', async () => {
    const freshDir = join(dir, 'nested-lock', 'store-dir');
    const freshFilePath = join(freshDir, 'budget.json');

    await updateStore(freshFilePath, appendMutator(txA));

    const mode = statSync(freshDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('releases the lock even when the mutator throws, and does not persist a partial write', async () => {
    await expect(
      updateStore(filePath, () => {
        throw new ValidationError('mutator refuses to proceed');
      }),
    ).rejects.toThrow(ValidationError);

    expect(existsSync(`${filePath}.lock`)).toBe(false);

    // A subsequent call must be able to acquire the lock immediately (not
    // time out waiting on a lock the failed mutator forgot to release).
    const result = await updateStore(filePath, appendMutator(txA), { timeoutMs: 200 });
    expect(result).toEqual(txA);
  });
});
