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

      // N=30 only reliably catches a mutated/reverted implementation
      // ~12/20 runs (a coin flip as a regression guard). Bumped to 60 per
      // review (Socrates NOTE): reliably 12/12 against the same mutant.
      const N = 60;
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

  // Regression (review of PR #82, BLOCKING #1, both Hobbes and Socrates):
  // the `${lockPath}.steal` meta-mutex that serializes steal attempts had
  // no staleness/recovery path of its own. If the process holding it
  // crashed (or any error path skipped its cleanup) before releasing it,
  // every future acquireLock call would hit EEXIST on the mutex forever --
  // across restarts, with no in-code recovery -- exactly the permanent
  // deadlock STALE_LOCK_MS exists to prevent for the main lock, reopened
  // one level up. Both reviewers reproduced this deterministically: seed a
  // stale `.lock` plus an orphaned `.lock.steal`, and every updateStore
  // call used to time out with both files still present.
  it('issue #51 BLOCKING #1 regression: an orphaned steal-mutex from a crashed holder does not permanently wedge the store', async () => {
    const lockPath = `${filePath}.lock`;
    const stealMutexPath = `${lockPath}.steal`;

    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    // A pid that does not correspond to any running process -- simulates a
    // `.steal` mutex left behind by a holder that crashed mid-steal before
    // ever releasing it. (Verified ESRCH for this pid on the CI/dev
    // platforms this suite targets.)
    writeFileSync(stealMutexPath, '999999\n', { flag: 'wx' });

    // Three consecutive calls, not just one -- proves this is durable
    // recovery, not a one-shot fluke.
    for (let i = 0; i < 3; i += 1) {
      const stored: StoredTransaction = {
        id: `tx-recover-${i}`,
        transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: i + 1 },
      };
      // Deliberately sequential (not Promise.all) -- proving recovery holds
      // up across repeated calls, not just the first.
      const result = await updateStore(filePath, appendMutator(stored), { timeoutMs: 2_000 });
      expect(result).toEqual(stored);
    }

    const final = await loadStore(filePath);
    expect(final.transactions.map((t) => t.id).sort()).toEqual([
      'tx-recover-0',
      'tx-recover-1',
      'tx-recover-2',
    ]);
    expect(existsSync(stealMutexPath)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  // Regression (review of PR #82, BLOCKING #2, Socrates): the steal-mutex's
  // `open('wx')` and its cleanup were in separate, non-nested try blocks --
  // a rejecting `close()` on the freshly-created mutex handle threw straight
  // out, skipping cleanup entirely and leaking the mutex file forever
  // (reproduced with an injected EIO on close()).
  it('issue #51 BLOCKING #2 regression: a rejecting close() on the steal-mutex handle does not leak the mutex file', async () => {
    const lockPath = `${filePath}.lock`;
    const stealMutexPath = `${lockPath}.steal`;

    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    vi.mocked(open).mockImplementation(
      // `as any`: fs.promises' overloaded `open` signature doesn't unify
      // cleanly through a hand-written wrapper; test-only fault injection.
      (async (...args: Parameters<typeof actualFs.open>) => {
        const handle = await actualFs.open(...args);
        if (args[0] === stealMutexPath && args[1] === 'wx') {
          return {
            ...handle,
            writeFile: handle.writeFile.bind(handle),
            close: async () => {
              // Close the real fd so the test itself doesn't leak one, but
              // report failure to the caller exactly like a rejecting
              // close() would (e.g. EIO flushing final buffered data).
              await handle.close().catch(() => {});
              throw Object.assign(new Error('simulated EIO on close'), { code: 'EIO' });
            },
          };
        }
        return handle;
      }) as any,
    );

    try {
      await expect(
        updateStore(filePath, appendMutator(txA), { timeoutMs: 500 }),
      ).rejects.toThrow(StorageError);

      // The mutex file must not be left behind despite the rejecting
      // close() -- otherwise every future acquireLock call against this
      // store would wedge on it (BLOCKING #1's failure mode, reintroduced
      // via a different trigger).
      expect(existsSync(stealMutexPath)).toBe(false);
    } finally {
      vi.mocked(open).mockReset();
    }
  });

  // Regression (review of PR #82, BLOCKING #3 from round 1, and BLOCKING
  // #1/#2 from round 2, Socrates + Hobbes): a stealer must never act on a
  // moments-old staleness decision, and closing that used to (round 2)
  // mean detaching lockPath via rename() while judging it -- which left
  // lockPath observably vacant and let exactly this scenario silently
  // resurrect a zombie lock or double-acquire (see reclaimStaleFile's own
  // doc comment for the full history). The round 3 fix never detaches
  // lockPath at all: it reads it in place, then re-checks its (dev, ino)
  // identity immediately before the one rename that can ever replace it.
  // This simulates the original (live, merely slow) holder releasing and an
  // ordinary, unrelated acquirer creating a brand new live lock in the gap
  // between the stealer's read-based staleness decision and that final
  // identity check -- the compare-and-swap must detect the identity change
  // and back off rather than clobber the new live lock.
  it('PR #82 round 2 BLOCKING 2 regression (Socrates + Hobbes, supersedes round 1 BLOCKING #3): a live lock created between the staleness decision and the steal is never clobbered', async () => {
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const liveHolderContent = 'live-holder-content\n';

    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    // acquireLock's own outer staleness check is the 1st lstat(lockPath);
    // reclaimStaleFile's initial read-in-place snapshot is the 2nd; its
    // final compare-and-swap identity check -- immediately before the
    // rename that would otherwise land the steal -- is the 3rd. Injecting
    // right before that 3rd call is exactly "the gap between the staleness
    // decision and the steal" this regression is about.
    let lockPathLstatCalls = 0;
    vi.mocked(lstat).mockImplementation(
      (async (...args: Parameters<typeof actualFs.lstat>) => {
        const [target] = args;
        if (target === lockPath) {
          lockPathLstatCalls += 1;
          if (lockPathLstatCalls === 3) {
            await actualFs.rm(lockPath, { force: true });
            await actualFs.writeFile(lockPath, liveHolderContent, { flag: 'wx' });
          }
        }
        return actualFs.lstat(...args);
      }) as any,
    );

    try {
      // The stealer must never proceed believing it holds a lock that's
      // actually still live -- it should back off and (since nothing ever
      // releases the simulated live lock) eventually time out loudly,
      // never silently clobbering it.
      await expect(
        updateStore(filePath, appendMutator(txA), { timeoutMs: 1_000 }),
      ).rejects.toThrow(/timed out.*lock/i);

      // The live lock's content must be exactly what the ordinary acquirer
      // wrote -- untouched by the failed steal attempt.
      expect(readFileSync(lockPath, 'utf-8')).toBe(liveHolderContent);
    } finally {
      vi.mocked(lstat).mockReset();
    }
  });

  // Regression (Hobbes, PR #82 round 2 BLOCKING 1): isStealMutexReclaimable's
  // parseable-pid branch used to have no time-based backstop at all --
  // process.kill(pid, 0) reading "alive" made a `.steal` mutex permanently
  // unreclaimable, full stop. This is not theoretical: entrypoint.sh runs
  // `exec su-exec node "$@"`, so node is PID 1 inside the Fly container --
  // every `.steal` file this app writes contains pid 1, and PID 1 reads as
  // alive after every restart, forever, on a /data volume that persists
  // across auto_stop_machines cycles. This test seeds a `.steal` mutex whose
  // recorded pid is this very test process (guaranteed to read as alive via
  // process.kill(pid, 0), standing in for the PID-1-forever-alive case) but
  // whose mtime is older than MAX_STEAL_MUTEX_AGE_MS -- the unconditional
  // time backstop must reclaim it regardless of pid liveness.
  it('PR #82 round 2 BLOCKING 1 regression: an orphaned steal-mutex whose pid reads as alive forever is still reclaimed once it exceeds the absolute age ceiling', async () => {
    const lockPath = `${filePath}.lock`;
    const stealMutexPath = `${lockPath}.steal`;

    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const staleLock = new Date(Date.now() - 60_000);
    utimesSync(lockPath, staleLock, staleLock);

    // A pid that is genuinely alive for the whole test (this process itself)
    // -- process.kill(pid, 0) reports it alive indefinitely, exactly like
    // PID 1 does inside the container. Without an unconditional time
    // backstop, this mutex would never be reclaimed.
    writeFileSync(stealMutexPath, `${process.pid}\n`, { flag: 'wx' });
    const ancientMutex = new Date(Date.now() - 120_000);
    utimesSync(stealMutexPath, ancientMutex, ancientMutex);

    const result = await updateStore(filePath, appendMutator(txA), { timeoutMs: 2_000 });
    expect(result).toEqual(txA);

    const final = await loadStore(filePath);
    expect(final.transactions.map((t) => t.id)).toEqual(['tx-a']);
    expect(existsSync(stealMutexPath)).toBe(false);
  });

  // Regression (Socrates, PR #82 round 2 BLOCKING 3): the one cleanup path
  // in this file left unguarded was the temp/tombstone file removal in the
  // steal primitive's `finally` -- a rejecting cleanup there threw straight
  // out of `finally`, discarding whatever the try block had already decided
  // (even a correct "not reclaimable, back off" `false`) and propagating a
  // raw error all the way out of acquireLock instead of letting the normal
  // retry loop recover gracefully. This forces exactly that: the lock is
  // released (not replaced) right before reclaimStaleFile's final
  // compare-and-swap identity check, so it must legitimately back off with
  // `false` and let the caller's loop re-acquire it fresh on the very next
  // iteration -- while the temp file's own best-effort cleanup is made to
  // reject with a simulated EIO. With the `.catch(() => {})` guard in place,
  // that rejection must not stop updateStore from completing successfully.
  it('PR #82 round 2 BLOCKING 3 regression: a rejecting cleanup of the steal primitive\'s private temp file does not mask a legitimate back-off/retry', async () => {
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    // Same call-counting trick as the round 2 BLOCKING 2 test above: the 3rd
    // lstat(lockPath) call is reclaimStaleFile's final identity check,
    // immediately before it would otherwise rename its temp file onto
    // lockPath. Here the original holder simply releases (no replacement),
    // so the identity check legitimately misses (ENOENT) and reclaimStaleFile
    // must back off with `false` -- at which point it needs to clean up the
    // private temp file it already created.
    let lockPathLstatCalls = 0;
    vi.mocked(lstat).mockImplementation(
      (async (...args: Parameters<typeof actualFs.lstat>) => {
        const [target] = args;
        if (target === lockPath) {
          lockPathLstatCalls += 1;
          if (lockPathLstatCalls === 3) {
            await actualFs.rm(lockPath, { force: true });
          }
        }
        return actualFs.lstat(...args);
      }) as any,
    );

    vi.mocked(rm).mockImplementation(
      (async (...args: Parameters<typeof actualFs.rm>) => {
        const [target] = args;
        if (typeof target === 'string' && target.includes('.steal-tmp')) {
          throw Object.assign(new Error('simulated EIO on temp-file cleanup'), { code: 'EIO' });
        }
        return actualFs.rm(...args);
      }) as any,
    );

    try {
      // Nothing else contends for the lock, so once reclaimStaleFile backs
      // off cleanly, acquireLock's own retry loop must claim the
      // now-genuinely-vacant lockPath on its very next iteration and
      // updateStore must succeed -- not throw, despite the injected EIO.
      const result = await updateStore(filePath, appendMutator(txA), { timeoutMs: 2_000 });
      expect(result).toEqual(txA);

      const final = await loadStore(filePath);
      expect(final.transactions.map((t) => t.id)).toEqual(['tx-a']);
    } finally {
      vi.mocked(lstat).mockReset();
      vi.mocked(rm).mockReset();
    }
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
