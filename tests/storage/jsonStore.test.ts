import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
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

  // Regression (#52 round 2, Socrates BLOCKING 1 & 2): the round-1 fix chmod'd
  // the store directory unconditionally on every save, even when saveStore
  // did not create it. That silently tightened permissions on any
  // pre-existing directory the tool doesn't own (e.g. a project checkout used
  // as cwd), and threw EPERM on a directory the process can write to but
  // doesn't own (mkdir recursive is a no-op there, but chmod is not). The
  // chmod must only fire when mkdir actually created the directory.
  it('does not chmod a pre-existing store directory it did not create', async () => {
    const existingDir = join(dir, 'pre-existing');
    mkdirSync(existingDir, { mode: 0o755 });
    // Belt-and-suspenders: mkdirSync's mode is subject to umask too, so
    // assert the starting mode explicitly is 0o755 before relying on it.
    chmodSync(existingDir, 0o755);
    const existingFilePath = join(existingDir, 'budget.json');

    await saveStore(existingFilePath, sampleStore);

    const mode = statSync(existingDir).mode & 0o777;
    expect(mode).toBe(0o755);
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
  // current fencing design, multiple stealers *can* simultaneously believe
  // they hold the lock -- that is now allowed -- but the commit-time
  // fencing check makes any resulting inconsistency harmless (the loser
  // aborts without writing and retries instead), so every single one of the
  // N transactions must still survive. At normal (unthrottled) timing this
  // alone doesn't reliably reproduce the old bug
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
  // Against the current fencing-based design this must never lose a write,
  // however the fs calls happen to interleave and however many stealers
  // simultaneously believe they hold the lock -- that belief is allowed to
  // be wrong for more than one racer at once now; only the write itself
  // must never be lost.
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

  // Permanent regression test (round 4 redesign, issue #51): Socrates
  // (round 4 review, PR #82) proved the round-3 rename-based CAS steal is
  // not real mutual exclusion -- rename() unconditionally replaces whatever
  // is at the destination, so it cannot fail on a "busy" target. Switching
  // the grant from rename to unlink-then-open('wx') (this file's round-4
  // design) does not fully close this either for the case of two racers
  // racing the same stale lock: P1's rm+open('wx') can claim a fresh lock,
  // and P2's own already-in-flight rm (based on the same stale-lock
  // decision) can then delete P1's fresh claim and P2's own subsequent
  // open('wx') succeeds against the vacancy it just created -- both P1 and
  // P2 now believe they hold the lock. Round 4's fencing design accepts
  // this as allowed (no amount of CAS refinement on the *grant* can
  // structurally prevent it -- POSIX has no atomic "delete this directory
  // entry only if it still refers to inode X" syscall) and instead makes it
  // harmless: P1 must detect at commit time that it no longer holds the
  // real lock and abort-and-retry rather than write.
  //
  // This test forces that exact interleaving deterministically (not via
  // jitter/hope) with a barrier on open/rm, the same technique Socrates
  // used on rename() in the round 4 review to get 100% reproduction: the
  // second racer's `rm(lockPath)` call is held back until the first
  // racer's `open(lockPath, 'wx')` has already succeeded, guaranteeing the
  // straggler's unlink lands on the winner's just-created fresh lock file.
  // The invariant under test is the one that actually matters -- every
  // transaction either racer successfully "sent" ends up persisted, none
  // silently dropped -- not merely "no error is thrown" (the round-3 bug
  // produced no error at all).
  it('issue #51 round 4 permanent regression: a straggler unlinking a rival\'s just-claimed fresh lock never loses a write (deterministic forced interleaving)', async () => {
    const lockPath = `${filePath}.lock`;
    writeFileSync(lockPath, '99999\n', { flag: 'wx' });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

    let rmCallsOnLockPath = 0;
    let openCallsOnLockPath = 0;
    let releaseFirstOpen: () => void;
    const firstOpenSucceeded = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });

    vi.mocked(rm).mockImplementation(
      (async (...args: Parameters<typeof actualFs.rm>) => {
        const [target] = args;
        if (target === lockPath) {
          rmCallsOnLockPath += 1;
          if (rmCallsOnLockPath === 2) {
            // Force the second racer's clear-attempt to land only after the
            // first racer's open('wx') has already succeeded in claiming a
            // fresh lock -- the exact interleaving described above.
            await firstOpenSucceeded;
          }
        }
        return actualFs.rm(...args);
      }) as any,
    );

    vi.mocked(open).mockImplementation(
      (async (...args: Parameters<typeof actualFs.open>) => {
        const [target, flag] = args;
        const handle = await actualFs.open(...args);
        if (target === lockPath && flag === 'wx') {
          openCallsOnLockPath += 1;
          if (openCallsOnLockPath === 1) {
            releaseFirstOpen();
          }
        }
        return handle;
      }) as any,
    );

    try {
      const [resultA, resultB] = await Promise.all([
        updateStore(filePath, appendMutator(txA), { timeoutMs: 5_000 }),
        updateStore(filePath, appendMutator(txB), { timeoutMs: 5_000 }),
      ]);

      expect([resultA, resultB]).toEqual(expect.arrayContaining([txA, txB]));

      const final = await loadStore(filePath);
      expect(final.transactions.map((t) => t.id).sort()).toEqual(['tx-a', 'tx-b']);
    } finally {
      vi.mocked(rm).mockReset();
      vi.mocked(open).mockReset();
    }
  });

  // Narrower, fully deterministic regression test for the fencing check
  // itself (round 4 redesign, issue #51): rather than relying on real
  // concurrency/timing, this directly injects a lock replacement ("theft")
  // in between one updateStore call's lock acquisition and the moment its
  // write would commit. The original caller's write must never land while
  // it no longer holds the real lock; once the thief has released, the
  // caller's own bounded internal retry (still within the same timeoutMs
  // deadline -- updateStore's external contract does not change) must
  // succeed cleanly, ending with both changes reflected, not one
  // clobbering the other.
  it('issue #51 round 4 regression: fencing detects a lock replaced between acquisition and write-commit, never applies the stale write, and succeeds on retry once the thief releases', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const lockPath = `${filePath}.lock`;
    let theftDone = false;

    vi.mocked(writeFile).mockImplementation(
      (async (...args: Parameters<typeof actualFs.writeFile>) => {
        const [target] = args;
        const result = await actualFs.writeFile(...args);
        if (typeof target === 'string' && target.includes('.tmp') && !theftDone) {
          // Right after this call's own tempPath write lands (i.e. between
          // its lock acquisition and the point its write would otherwise
          // commit via saveStore's fencing-then-rename), simulate a full
          // concurrent "thief" lifecycle: steal the lock, persist its own
          // change directly, then release. Guarded by theftDone -- the
          // thief's own loadStore/saveStore below recurse back through this
          // same mocked writeFile (for its own tempPath), and must not
          // trigger a second, nested "theft".
          theftDone = true;
          await actualFs.rm(lockPath, { force: true }).catch(() => {});
          await actualFs.writeFile(lockPath, 'thief\n', { flag: 'wx', mode: 0o600 });
          const thiefView = await loadStore(filePath);
          await saveStore(filePath, {
            ...thiefView,
            transactions: [...thiefView.transactions, txB],
          });
          await actualFs.rm(lockPath, { force: true }).catch(() => {});
        }
        return result;
      }) as any,
    );

    try {
      const result = await updateStore(filePath, appendMutator(txA), { timeoutMs: 2_000 });
      expect(result).toEqual(txA);

      const final = await loadStore(filePath);
      // Neither write clobbered the other.
      expect(final.transactions.map((t) => t.id).sort()).toEqual(['tx-a', 'tx-b']);
    } finally {
      vi.mocked(writeFile).mockReset();
    }
  });

  // Regression for releaseLock's own identity check (round 4 redesign,
  // issue #51): a caller whose lock was stolen out from under it since
  // acquisition must never blindly `rm` whatever currently occupies
  // lockPath when it releases -- that would delete a rival's genuinely live
  // lock. This simulates exactly that: an ordinary (non-steal) acquire,
  // followed by a theft landing before this call's own write can commit
  // (so its fencing check correctly aborts it, and its own release in
  // updateStore's `finally` then runs against a lockPath that is no longer
  // this caller's). The thief here never releases, so this call cannot
  // succeed even on retry and eventually times out -- the interesting
  // assertion is that the thief's lock file is left completely untouched
  // throughout, proving release was a no-op rather than a blind `rm`.
  it('issue #51 round 4 regression: releaseLock is a no-op (not a blind rm) when this caller\'s lock was stolen before it could release', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const lockPath = `${filePath}.lock`;
    const thiefContent = 'thief-holds-this-now\n';

    vi.mocked(writeFile).mockImplementation(
      (async (...args: Parameters<typeof actualFs.writeFile>) => {
        const [target] = args;
        const result = await actualFs.writeFile(...args);
        if (typeof target === 'string' && target.includes('.tmp')) {
          // Steal the lock right after this call's own tempPath write
          // lands, before its fencing check -- and never release it, so
          // this call cannot succeed even on retry and must eventually
          // time out.
          await actualFs.rm(lockPath, { force: true }).catch(() => {});
          await actualFs.writeFile(lockPath, thiefContent, { flag: 'wx', mode: 0o600 });
        }
        return result;
      }) as any,
    );

    try {
      await expect(
        updateStore(filePath, appendMutator(txA), { timeoutMs: 300 }),
      ).rejects.toThrow(/timed out.*lock/i);

      // The thief's lock file must be exactly what it wrote -- untouched by
      // the stolen-from caller's own release.
      expect(readFileSync(lockPath, 'utf-8')).toBe(thiefContent);
    } finally {
      vi.mocked(writeFile).mockReset();
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

  // Regression (#52 round 2, Socrates BLOCKING 1 & 2): same fix as saveStore
  // above, applied to acquireLock's own mkdir/chmod call site.
  it('does not chmod a pre-existing lock directory it did not create', async () => {
    const existingDir = join(dir, 'pre-existing-lock');
    mkdirSync(existingDir, { mode: 0o755 });
    chmodSync(existingDir, 0o755);
    const existingFilePath = join(existingDir, 'budget.json');

    await updateStore(existingFilePath, appendMutator(txA));

    const mode = statSync(existingDir).mode & 0o777;
    expect(mode).toBe(0o755);
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

  // Regression for updateStore's inner catch around `saveStore` (issue #51):
  // that catch exists specifically to recognize `LockStolenError` and turn
  // it into a bounded retry -- anything else must still propagate out to
  // the caller as a genuine failure, not be swallowed or misreported as a
  // stolen-lock race. This is new machinery as of the round 4 fencing
  // redesign (pre-redesign, saveStore's own errors propagated with no
  // wrapping catch at this level at all) and, until this test, its `else`
  // branch (the rethrow) had never actually been exercised: every other
  // test either succeeds outright or hits the `LockStolenError` branch.
  it('issue #51 regression: a save failure that is not a stolen-lock race propagates out of updateStore as-is, not swallowed or retried as a theft', async () => {
    vi.mocked(rename).mockRejectedValueOnce(new Error('simulated rename failure'));

    await expect(
      updateStore(filePath, appendMutator(txA), { timeoutMs: 2_000 }),
    ).rejects.toThrow(/failed to save store file.*simulated rename failure/);

    // Must not have been silently treated as a stolen-lock retry: the lock
    // is still released (the outer `finally` always runs regardless of
    // which branch the inner catch took), and no partial write landed.
    expect(existsSync(`${filePath}.lock`)).toBe(false);
    const final = await loadStore(filePath);
    expect(final.transactions).toEqual([]);
  });

  // Regression for updateStore's own "repeatedly stolen" timeout message
  // (issue #51, Plato BLOCKING): the existing "many concurrent stealers"
  // tests above all eventually *succeed* (the thief always releases), so
  // none of them ever actually drive updateStore's own retry loop to its
  // deadline -- the only "timed out" message they were shown (by
  // instrumentation) to actually exercise is acquireLock's older, more
  // generic one (thrown while polling/waiting on a single still-live lock).
  // This forces every single attempt to be stolen from, with the thief
  // itself always releasing immediately after, so updateStore's retry loop
  // keeps completing full acquire-load-mutate-fenced-out cycles (never
  // getting stuck inside one acquireLock call polling a live lock) until
  // timeoutMs is genuinely exhausted at the deadline check between retries
  // -- the only path that produces this specific message.
  it('issue #51 regression: exhausting timeoutMs via repeated theft on every retry throws updateStore\'s own "repeatedly stolen" message, not acquireLock\'s generic one', async () => {
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const lockPath = `${filePath}.lock`;
    let thiefCount = 0;

    vi.mocked(writeFile).mockImplementation(
      (async (...args: Parameters<typeof actualFs.writeFile>) => {
        const [target] = args;
        const result = await actualFs.writeFile(...args);
        if (typeof target === 'string' && target.includes('.tmp')) {
          // Steal this caller's lock, then immediately release the thief's
          // own claim -- an unbounded stream of independent, well-behaved
          // stealers that each always win the race against this caller's
          // commit-time fencing check, but never themselves hold the lock
          // for long enough to make the caller's *next* acquireLock call
          // block waiting on a live lock.
          thiefCount += 1;
          await actualFs.rm(lockPath, { force: true }).catch(() => {});
          await actualFs.writeFile(lockPath, `${process.pid}\nthief-${thiefCount}\n`, {
            flag: 'wx',
            mode: 0o600,
          });
          await actualFs.rm(lockPath, { force: true }).catch(() => {});
        }
        return result;
      }) as any,
    );

    try {
      await expect(
        updateStore(filePath, appendMutator(txA), { timeoutMs: 300 }),
      ).rejects.toThrow(
        /timed out after \d+ms waiting for a lock on store file .* -- the lock was repeatedly stolen from this process before its write could commit, try again/,
      );
      expect(thiefCount).toBeGreaterThan(1);
    } finally {
      vi.mocked(writeFile).mockReset();
    }
  });
});
