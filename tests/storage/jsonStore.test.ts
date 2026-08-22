import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  // Every fs call `acquireLock`/`updateStore` makes is wrapped in a `vi.fn`
  // (not just `writeFile`) so the issue #51 race test below can inject
  // randomized latency on all of them -- that's what makes it actually
  // exercise many-stealers-racing-one-stale-lock interleavings, rather than
  // just the happy path.
  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rm: vi.fn(actual.rm),
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    readFile: vi.fn(actual.readFile),
  };
});

// Imported after the mock so jsonStore.ts picks up the mocked fs functions.
import { lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ValidationError } from '../../src/domain/errors.js';
import { loadStore, saveStore, StorageError, updateStore } from '../../src/storage/jsonStore.js';
import type { PersistedStore, StoredTransaction } from '../../src/storage/schema.js';

const mockedFsFns = [writeFile, rm, lstat, open, rename, readFile] as const;

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jsonstore-test-'));
  filePath = join(dir, 'budget.json');
  for (const fn of mockedFsFns) {
    vi.mocked(fn).mockClear();
  }
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const fn of mockedFsFns) {
    vi.mocked(fn).mockReset();
  }
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

  // Regression (issue #51): the stale-lock steal used to be a plain
  // "lstat-then-rm", not atomic w.r.t. other stealers racing the same
  // check. P1 could see the lock is stale, rm it, loop back, and create a
  // fresh live lock -- and then P2, having already decided "stale" from its
  // own earlier lstat (taken before P1 acted), would unconditionally rm
  // *whatever is currently at that path*, deleting P1's brand-new live lock
  // instead of the originally-stale one. A third racer (or P2 itself, next
  // loop) could then acquire the lock while P1 believed it still held it and
  // was mid-write -- reopening the exact lost-update race #9's locking was
  // built to close, just narrowed to the window right after a steal.
  //
  // This seeds a single stale lock and fires many concurrent updateStore
  // calls at it -- every one of them must go through the steal path at
  // (nearly) the same time, which is exactly the multi-stealer scenario
  // above. With the old code this can lose writes (two "holders" interleave
  // their load-modify-save cycles and one clobbers the other); with the
  // steal-mutex-serialized steal, only one stealer ever wins at a time, so
  // every single one of the N transactions must survive. At normal
  // (unthrottled) timing this alone doesn't reliably reproduce the old bug
  // -- real fs calls on a local disk are fast enough that the specific bad
  // interleaving is rare. The test below this one throttles every fs call
  // with randomized latency specifically to force that interleaving open;
  // this one is kept as a cheap, always-fast smoke test of the same
  // scenario at realistic speed.
  it('many concurrent updateStore calls racing to steal one stale lock never lose a write', async () => {
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const N = 30;
    const stored: StoredTransaction[] = Array.from({ length: N }, (_, i) => ({
      id: `tx-steal-${i}`,
      transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: i + 1 },
    }));

    const results = await Promise.all(
      stored.map((entry) => updateStore(filePath, appendMutator(entry), { timeoutMs: 5000 })),
    );

    expect(results.map((r) => r.id).sort()).toEqual(stored.map((s) => s.id).sort());

    const final = await loadStore(filePath);
    expect(final.transactions.map((t) => t.id).sort()).toEqual(stored.map((s) => s.id).sort());
    expect(final.transactions).toHaveLength(N);
    expect(existsSync(lockPath)).toBe(false);
  });

  // The test above proves the scenario is handled correctly at realistic
  // speed, but a check-then-act race like this one is inherently timing
  // dependent -- at natural fs speed on a local disk, the specific bad
  // interleaving described above (P2's unconditional rm executing *after*
  // P1 has already recreated a fresh lock) is rare enough that a naive,
  // still-buggy implementation can pass the test above almost every time
  // (verified directly against a pre-fix build of this file: the test above
  // passed 5/5 runs against the broken `lstat`-then-`rm` steal, and even a
  // first, *also* subtly-broken fix attempt -- rename()-a-token-onto-the-
  // lock-path with a post-rename read-back verify -- passed it consistently
  // too, despite still losing double-digit percentages of writes under
  // this jittered version).
  //
  // This test forces the race open deliberately: every fs call `acquireLock`
  // makes (`open`, `lstat`, `rm`, `rename`, `readFile`, `writeFile`) is
  // wrapped with a random 0-15ms delay before it actually runs, which
  // reorders how many concurrent stealers' operations interleave relative
  // to each other far more aggressively than real disk I/O ever would. If
  // any given racer's steal attempt is not correctly atomic w.r.t. every
  // other racer's steal attempt, this reliably surfaces it as lost writes
  // (verified: it reproduced the loss on both broken implementations above
  // in the majority of runs, at both N=20/8ms-jitter and N=40/15ms-jitter).
  // Against the current steal-mutex-serialized implementation this must
  // never lose a write, however the fs calls happen to interleave.
  it('issue #51 regression: many concurrent stealers under randomized fs latency never lose a write or double-hold the lock', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const jitter = () => new Promise<void>((resolve) => setTimeout(resolve, Math.random() * 15));
    const withJitter =
      <TArgs extends unknown[], TReturn>(real: (...args: TArgs) => Promise<TReturn>) =>
      async (...args: TArgs): Promise<TReturn> => {
        await jitter();
        return real(...args);
      };

    for (const [fn, real] of [
      [rm, actualFs.rm],
      [lstat, actualFs.lstat],
      [open, actualFs.open],
      [rename, actualFs.rename],
      [readFile, actualFs.readFile],
      [writeFile, actualFs.writeFile],
    ] as const) {
      // `as any`: fs.promises' overloaded signatures don't unify cleanly
      // through a single generic wrapper; this is test-only
      // latency-injection plumbing, not production code.
      vi.mocked(fn).mockImplementation(withJitter(real as any) as any);
    }

    try {
      const lockPath = `${filePath}.lock`;
      writeFileSync(lockPath, '99999\n', { flag: 'wx' });
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockPath, old, old);

      const N = 30;
      const stored: StoredTransaction[] = Array.from({ length: N }, (_, i) => ({
        id: `tx-jitter-${i}`,
        transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: i + 1 },
      }));

      const results = await Promise.all(
        stored.map((entry) => updateStore(filePath, appendMutator(entry), { timeoutMs: 15_000 })),
      );

      expect(results.map((r) => r.id).sort()).toEqual(stored.map((s) => s.id).sort());

      const final = await loadStore(filePath);
      expect(final.transactions.map((t) => t.id).sort()).toEqual(stored.map((s) => s.id).sort());
      expect(final.transactions).toHaveLength(N);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      for (const fn of mockedFsFns) {
        vi.mocked(fn).mockReset();
      }
    }
  }, 20_000);

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
