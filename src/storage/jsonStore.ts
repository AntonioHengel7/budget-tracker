import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createCategoryBudget } from '../domain/budget.js';
import type { CategoryBudget } from '../domain/budget.js';
import { createTransaction } from '../domain/transaction.js';
import type { Transaction } from '../domain/transaction.js';
import { emptyStore, SCHEMA_VERSION } from './schema.js';
import type { PersistedStore, StoredTransaction } from './schema.js';

/** Raised for any failure specific to reading/writing/parsing the store file. */
export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageError';
  }
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The domain constructors (createTransaction/createCategoryBudget) are
 * TypeScript-typed for string/number/boolean, but that's a compile-time-only
 * guarantee -- it does not check anything at runtime. A hand-edited JSON file
 * can put a string where a boolean is expected (JS truthiness would then
 * silently misinterpret it), an array where a string is expected (regex
 * .exec() coerces it into a "ghost" value instead of rejecting it), or omit
 * an array entirely (crashing .map() with a raw TypeError instead of the
 * promised StorageError). This checks each field's actual runtime type
 * before it is ever handed to a domain constructor, so every escape throws a
 * clean StorageError instead of silently corrupting data or leaking a raw
 * TypeError past this module's boundary.
 */
function assertFieldType(
  condition: boolean,
  filePath: string,
  field: string,
  expected: string,
): void {
  if (!condition) {
    const article = /^[aeiou]/i.test(expected) ? 'an' : 'a';
    throw new StorageError(
      `store file "${filePath}" has field "${field}" that is not ${article} ${expected}`,
    );
  }
}

function validateStoredTransaction(entry: unknown, filePath: string): StoredTransaction {
  if (!isPlainObject(entry)) {
    throw new StorageError(`store file "${filePath}" contains a malformed transaction entry`);
  }

  const { id, transaction } = entry;
  if (typeof id !== 'string' || id === '') {
    throw new StorageError(
      `store file "${filePath}" contains a transaction entry with a missing/invalid id`,
    );
  }
  if (!isPlainObject(transaction)) {
    throw new StorageError(
      `store file "${filePath}" contains a transaction entry (id "${id}") with no transaction body`,
    );
  }

  assertFieldType(typeof transaction.date === 'string', filePath, `transactions[${id}].date`, 'string');
  assertFieldType(
    typeof transaction.category === 'string',
    filePath,
    `transactions[${id}].category`,
    'string',
  );
  assertFieldType(typeof transaction.kind === 'string', filePath, `transactions[${id}].kind`, 'string');
  assertFieldType(
    typeof transaction.amountMinor === 'number',
    filePath,
    `transactions[${id}].amountMinor`,
    'number',
  );
  assertFieldType(
    transaction.note === undefined || typeof transaction.note === 'string',
    filePath,
    `transactions[${id}].note`,
    'string',
  );

  // Re-validated through the domain's own constructor -- never trust a
  // hand-edited or corrupted JSON file as pre-validated. Any ValidationError
  // createTransaction throws (e.g. a tampered negative amountMinor) is
  // deliberately left to propagate as-is, not wrapped.
  const validated: Transaction = createTransaction(
    transaction as unknown as Parameters<typeof createTransaction>[0],
  );
  return { id, transaction: validated };
}

function validateBudget(entry: unknown, filePath: string): CategoryBudget {
  if (!isPlainObject(entry)) {
    throw new StorageError(`store file "${filePath}" contains a malformed budget entry`);
  }

  const category = typeof entry.category === 'string' ? entry.category : '<unknown category>';
  assertFieldType(typeof entry.category === 'string', filePath, `budgets[${category}].category`, 'string');
  assertFieldType(
    typeof entry.rollover === 'boolean',
    filePath,
    `budgets[${category}].rollover`,
    'boolean',
  );
  assertFieldType(Array.isArray(entry.limits), filePath, `budgets[${category}].limits`, 'array');

  for (const [index, limit] of (entry.limits as unknown[]).entries()) {
    if (!isPlainObject(limit)) {
      throw new StorageError(
        `store file "${filePath}" has a malformed entry at budgets[${category}].limits[${index}]`,
      );
    }
    assertFieldType(
      typeof limit.effectiveFrom === 'string',
      filePath,
      `budgets[${category}].limits[${index}].effectiveFrom`,
      'string',
    );
    assertFieldType(
      typeof limit.amountMinor === 'number',
      filePath,
      `budgets[${category}].limits[${index}].amountMinor`,
      'number',
    );
  }

  // Re-validated through the domain's own constructor, same as transactions above.
  return createCategoryBudget(entry as unknown as Parameters<typeof createCategoryBudget>[0]);
}

/**
 * `CategoryBudget` is designed as "one budget per category" -- every
 * consumer (setLimit's `store.budgets.find`, status/summary lookups) assumes
 * at most one entry matches a given category and silently takes only the
 * first/last match otherwise. Nothing upstream of this module can produce a
 * duplicate through the CLI (setLimit always replaces the single existing
 * entry for a category), but a hand-edited store file is not bound by that --
 * two entries sharing a category can slip in directly. Without this check,
 * `setLimit`'s `filter((budget) => budget.category !== updated.category)`
 * would silently drop BOTH pre-existing entries for that category on the
 * very next `limit set`, discarding one of them for good. Reject it here,
 * the same way every other malformed/inconsistent persisted state is
 * rejected on load, instead of letting it corrupt silently downstream.
 */
function assertNoDuplicateCategories(budgets: readonly CategoryBudget[], filePath: string): void {
  const seen = new Set<string>();
  for (const budget of budgets) {
    if (seen.has(budget.category)) {
      throw new StorageError(
        `store file "${filePath}" has more than one budget for category "${budget.category}" -- each category must have at most one budget`,
      );
    }
    seen.add(budget.category);
  }
}

/**
 * `rm` looks up a transaction by `id` and removes it, but ids are only
 * unique by convention (`crypto.randomUUID()` at creation time) -- nothing
 * upstream of this module enforces that at load time. Nothing in the CLI can
 * produce a duplicate through normal use, but a hand-edited or otherwise
 * corrupted store file is not bound by that -- two entries sharing an id can
 * slip in directly. Without this check, `rm`'s id lookup would have
 * undefined behavior on such a file (e.g. removing only the first match, or
 * both, depending on implementation details never meant to be relied upon).
 * Reject it here, the same way every other malformed/inconsistent persisted
 * state is rejected on load, instead of letting it corrupt silently
 * downstream.
 */
function assertNoDuplicateTransactionIds(
  transactions: readonly StoredTransaction[],
  filePath: string,
): void {
  const seen = new Set<string>();
  for (const { id } of transactions) {
    if (seen.has(id)) {
      throw new StorageError(
        `store file "${filePath}" has more than one transaction with id "${id}" -- each transaction id must be unique`,
      );
    }
    seen.add(id);
  }
}

/**
 * Loads the store at `filePath`. A missing file returns a fresh empty store
 * (not an error). Every persisted transaction and budget is re-validated
 * through the domain's own constructors before being returned, so a
 * hand-edited or corrupted file can never bypass domain invariants.
 */
export async function loadStore(filePath: string): Promise<PersistedStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return emptyStore();
    }
    throw new StorageError(`failed to read store file "${filePath}": ${(err as Error).message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StorageError(`store file "${filePath}" contains invalid JSON`, { cause: err });
  }

  if (!isPlainObject(parsed)) {
    throw new StorageError(`store file "${filePath}" does not contain a JSON object`);
  }

  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StorageError(
      `store file "${filePath}" has unsupported schemaVersion ${JSON.stringify(
        parsed.schemaVersion,
      )}, expected ${SCHEMA_VERSION}`,
    );
  }

  const rawTransactions = parsed.transactions;
  if (rawTransactions !== undefined && !Array.isArray(rawTransactions)) {
    throw new StorageError(`store file "${filePath}" has a non-array "transactions" field`);
  }
  const transactions = (rawTransactions ?? []).map((entry: unknown) =>
    validateStoredTransaction(entry, filePath),
  );
  assertNoDuplicateTransactionIds(transactions, filePath);

  const rawBudgets = parsed.budgets;
  if (rawBudgets !== undefined && !Array.isArray(rawBudgets)) {
    throw new StorageError(`store file "${filePath}" has a non-array "budgets" field`);
  }
  const budgets = (rawBudgets ?? []).map((entry: unknown) => validateBudget(entry, filePath));
  assertNoDuplicateCategories(budgets, filePath);

  return { schemaVersion: SCHEMA_VERSION, transactions, budgets };
}

/**
 * Saves `store` to `filePath` atomically: writes to a temp file in the same
 * directory, then renames over the target. The real path is never written to
 * directly, so a failure mid-write can never leave a partial/corrupt file at
 * `filePath`. The final file is chmod'd 0600.
 */
export async function saveStore(filePath: string, store: PersistedStore): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  const json = JSON.stringify(store, null, 2);

  try {
    await mkdir(dir, { recursive: true });
    // flag: 'wx' -- exclusive create, fails instead of following a
    // pre-existing symlink at tempPath. The unguessable randomUUID() temp
    // name already makes this unlikely, but 'wx' closes it structurally
    // rather than relying on that alone.
    await writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    // writeFile's `mode` is subject to the process umask, which can only
    // clear bits -- in practice that already yields 0600 here since 0600 has
    // no group/other bits to clear. chmod explicitly anyway so the "saved
    // file has mode 0600" guarantee doesn't depend on umask behavior at all.
    await chmod(tempPath, 0o600);
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {
      // best-effort cleanup only -- the original error below is what matters
    });
    throw new StorageError(`failed to save store file "${filePath}": ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/**
 * Max time a caller waits for a concurrent writer to finish before giving
 * up. Chosen to comfortably exceed a single save's real duration (a small
 * JSON write + rename) while still failing fast enough that a CLI user
 * isn't left staring at a hung terminal.
 */
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** How often to re-check whether a held lock has been released. */
const LOCK_POLL_INTERVAL_MS = 20;

/**
 * A lock file older than this is treated as abandoned rather than held by a
 * live writer. Node CLI invocations are short-lived (single load-modify-save
 * cycle), so a lock surviving this long almost certainly means its owning
 * process died before reaching its `finally` cleanup (e.g. SIGKILL, power
 * loss) rather than that a save is still legitimately in progress. Without
 * this, a single crashed invocation would wedge every future invocation
 * against that file forever. The tradeoff -- a near-impossible false
 * positive if a single save somehow takes 30s -- is strictly better than a
 * permanent deadlock.
 */
const STALE_LOCK_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * How long a `.steal` meta-mutex (see `atomicSteal`/`acquireStealMutex`
 * below) is trusted as "still legitimately being created" when its content
 * can't be parsed into a pid. Its only legitimate writer does a single
 * `handle.writeFile()` of a few bytes immediately after `open('wx')`
 * succeeds -- nothing legitimate ever takes anywhere close to this long to
 * finish that. Used only as a fallback for the narrow window between a
 * writer's `open('wx')` and its `writeFile` landing (see `acquireStealMutex`);
 * once content *is* parseable, pid liveness (immediate, not time-based)
 * takes over.
 */
const STEAL_MUTEX_GRACE_MS = 5_000;

/**
 * Unconditional, finite ceiling on how long `isStealMutexReclaimable`'s
 * parseable-pid branch is allowed to keep saying "still alive, do not
 * reclaim" before a time-based backstop overrides it regardless.
 *
 * Regression (Hobbes, PR #82 round 2 BLOCKING 1): that branch used to have
 * no such backstop at all -- `process.kill(pid, 0)` reading "alive" made a
 * `.steal` mutex permanently unreclaimable, full stop. That is not
 * theoretical here: `entrypoint.sh` runs `exec su-exec node "$@"`, so node
 * is PID 1 inside the Fly container -- every `.steal` file this app itself
 * writes contains pid `1`, and PID 1 reads as alive after every restart,
 * forever, on a `/data` volume that persists across `auto_stop_machines`
 * cycles. A reused pid owned by a different user wedges the same way, since
 * `isProcessAlive` conservatively maps EPERM to "alive" too. Pid liveness is
 * still useful -- it lets a mutex be reclaimed *sooner* than a time-only
 * check would -- but it must never be the *only* thing standing between an
 * orphaned mutex and a permanent write-DoS. Set well above
 * `STEAL_MUTEX_GRACE_MS`: this only ever matters for the parseable-pid
 * branch, since nothing legitimate holds this mutex anywhere close to a
 * minute (it's a handful of fast fs calls).
 */
const MAX_STEAL_MUTEX_AGE_MS = 60_000;

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0: no signal is actually sent; the OS still validates the pid
    // and reports whether it could be signaled at all.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ESRCH') {
      return false;
    }
    // EPERM (alive, owned by another user) or anything else unexpected:
    // treat conservatively as alive -- never steal a mutex we can't prove
    // is dead.
    return true;
  }
}

/**
 * Atomically reclaims `path` (the main lock file, or its own `.steal`
 * meta-mutex) if, and only if, what is physically there *right now* is
 * still judged reclaimable -- without ever making `path` observably vacant.
 *
 * Three designs were tried and rejected before this one, each proven unsafe
 * by actually reproducing the failure, not just reasoned about in the
 * abstract. That history is kept here in full, on purpose: an earlier round
 * of this file deleted an equivalent rejection rationale and the rejected
 * design shipped again anyway one round later.
 *
 * 1. (Round 1) "Write a unique token to a temp file, `rename()` it onto
 *    `path`, then read `path` back and confirm it's still our token." Not
 *    race-free: `rename(src, path)` unconditionally replaces whatever is at
 *    `path`, so it is not itself exclusive -- two racers can each rename
 *    their own token in and read it straight back, both "winning".
 * 2. (Round 1) "Decide staleness via one `lstat`, then unconditionally `rm`
 *    based on that decision." Not race-free either: a live holder can
 *    release and an ordinary, unrelated acquirer can create a fresh live
 *    lock in the gap between the `lstat` and the `rm` -- the `rm` then
 *    deletes that new caller's live lock based on stale information, and
 *    the steal proceeds to also acquire. Two live holders.
 * 3. (Round 2, shipped, then reverted here) "`rename(path, tombstonePath)`
 *    to atomically detach whatever is at `path`, judge staleness from the
 *    detached snapshot, and -- if it turns out not to have been stale --
 *    `link()` it back onto `path`." This closed (1) and (2), but introduced
 *    a new problem review caught independently from two directions (PR #82
 *    round 2 BLOCKING 1/2, Socrates + Hobbes): the detach itself leaves
 *    `path` observably *vacant* for the duration of the staleness judgment,
 *    even on the branch where the lock turns out to be live. Reproduced two
 *    ways in that window: a live holder's `releaseLock()` landing during
 *    the vacancy is a silent no-op, and the restoring `link()` then
 *    resurrects a zombie lock nobody holds (30s outage); or an ordinary
 *    acquirer's `open(path, 'wx')` wins the vacancy while the original
 *    holder is still live, giving two simultaneous holders and, via the
 *    tombstone cleanup, silently deleting the *new* holder's only remaining
 *    link to its own lock.
 *
 * The fix: never detach `path` at all, and use filesystem identity
 * (device + inode), last-modified instant, and exact content -- not a
 * moments-old decision -- as the compare-and-swap token for the one moment
 * `path` actually changes:
 *
 * 1. Read `path`'s current stats and content directly, in place. `path` is
 *    never touched by this -- reads are inherently safe to do concurrently
 *    with anything else, so there is no vacancy window on this branch,
 *    structurally, not by chance of timing.
 * 2. If `isStillReclaimable` says no, we are done -- return `false`.
 *    Nothing was ever removed or replaced, so there is nothing to restore.
 * 3. If yes, write the replacement content into a private temp file (again,
 *    `path` itself still untouched), then re-`lstat` and re-`readFile`
 *    `path` by name one last time, right before the swap. If its
 *    `(dev, ino, mtimeMs, content)` no longer exactly matches what was read
 *    in step 1, some other holder or acquirer has since replaced `path` --
 *    back off (`false`) instead of clobbering whatever is there now.
 * 4. Only if every one of those still matches do we `rename(tempPath,
 *    path)` -- POSIX guarantees this is atomic and, critically, `path` is
 *    *never* missing at any point: it holds the old file right up until the
 *    instant the rename lands the new one.
 *
 * The gap between step 3's identity check and step 4's rename is not a true
 * hardware compare-and-swap (Node's `fs` module has no exchange-on-rename
 * primitive to close it completely), but it can no longer reproduce the
 * resurrection or double-hold failures above: the only two things that can
 * happen in that gap are (a) nothing changes and the rename proceeds
 * correctly, or (b) `path`'s identity changes again, which the *next*
 * caller's own read-then-check catches on its own next attempt. `path` is
 * at all times either the old file or the new one -- never absent, and
 * never judged from a copy that has drifted out of sync with what is
 * actually there.
 *
 * Why `(dev, ino)` alone is not enough (CI-only regression against PR #82
 * round 2 BLOCKING 2's own regression test, not reproducible on macOS/APFS
 * locally, root-caused by re-running that test with temporary instrumentation
 * logging the actual stat values on both sides of the check): every writer
 * that can ever occupy `path` -- an ordinary acquirer's `open(path, 'wx')`,
 * and this function's own `rename(tempPath, path)` -- does so only after the
 * previous occupant's directory entry is already gone, i.e. after an
 * `unlink`. Some filesystems' inode allocators (observed in CI; APFS's
 * monotonic catalog-ID allocation does not do this, which is why this could
 * not be reproduced locally) can hand the very next `open(..., 'wx')` after
 * an `unlink` the *same* inode number just freed, purely by allocator
 * coincidence -- a classic ABA: a brand new, unrelated live lock can end up
 * with the exact `(dev, ino)` the just-stolen stale lock had, with nothing
 * to do with actually being the same file. `mtimeMs` and `content` close
 * this at zero extra cost on the read-in-step-1 side (both are already
 * captured there for `isStillReclaimable`) and one extra `readFile` on the
 * read-in-step-3 side: a file that did not exist a moment ago cannot share
 * the old file's exact last-modified instant, and an ordinary acquirer's
 * fresh lock (or another racer's steal) never happens to hold byte-for-byte
 * the same content the stale file had.
 *
 * Every exit path -- success, "not reclaimable", CAS failure, or an
 * unexpected throw -- cleans up the private temp file exactly once, guarded
 * so a failing cleanup can never mask an already-successful steal
 * (regression, Socrates, PR #82 round 2 BLOCKING 3: the equivalent tombstone
 * cleanup in the round 2 design was the one *unguarded* cleanup in this
 * file, and an injected EIO on it discarded a successful steal's `true`
 * return, wedging a lock this process actually held for the full
 * STALE_LOCK_MS).
 */
async function reclaimStaleFile(
  path: string,
  filePath: string,
  isStillReclaimable: (info: { content: string; mtimeMs: number }) => boolean,
): Promise<boolean> {
  let stats;
  let content: string;
  try {
    [stats, content] = await Promise.all([lstat(path), readFile(path, 'utf-8')]);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      // Already released (or reclaimed by someone else) since the caller's
      // own staleness check -- nothing to steal; its normal retry loop
      // handles this.
      return false;
    }
    throw new StorageError(
      `failed to inspect "${path}" for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  if (!isStillReclaimable({ content, mtimeMs: stats.mtimeMs })) {
    // Live (or not old enough yet) -- `path` was never touched, so there is
    // nothing to restore; just decline to steal it.
    return false;
  }

  const tempPath = `${path}.${process.pid}.${randomUUID()}.steal-tmp`;
  let tempCreated = false;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf-8');
    } finally {
      await handle.close();
    }

    // Compare-and-swap: only replace `path` if it still identifies the
    // exact file judged stale above. `lstat`, not `stat` -- the identity
    // check is about the directory entry itself, matching how staleness is
    // judged everywhere else in this file. `(dev, ino)` alone is not a
    // strong enough token -- see the ABA-via-inode-reuse note in this
    // function's doc comment -- so `mtimeMs` and `content` (both already
    // read once in step 1, at no extra cost there) are re-read and compared
    // too.
    let current;
    let currentContent: string;
    try {
      [current, currentContent] = await Promise.all([lstat(path), readFile(path, 'utf-8')]);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        // Released, with nobody holding it right now -- decline rather than
        // race a not-yet-visible concurrent creator; the caller's normal
        // open('wx') claims it cleanly on the next loop iteration.
        return false;
      }
      throw err;
    }

    if (
      current.dev !== stats.dev ||
      current.ino !== stats.ino ||
      current.mtimeMs !== stats.mtimeMs ||
      currentContent !== content
    ) {
      // A fresh acquirer or the live holder itself replaced `path` since
      // the snapshot above -- CAS fails closed. We never clobber it.
      return false;
    }

    await rename(tempPath, path);
    tempCreated = false; // renamed away -- nothing left at tempPath to clean up
    return true;
  } catch (err) {
    throw new StorageError(
      `failed to steal "${path}" for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    if (tempCreated) {
      await rm(tempPath, { force: true }).catch(() => {
        // best-effort cleanup only -- see the BLOCKING 3 regression note
        // above for why this must never reject.
      });
    }
  }
}

function isStealMutexReclaimable({
  content,
  mtimeMs,
}: {
  content: string;
  mtimeMs: number;
}): boolean {
  if (Date.now() - mtimeMs > MAX_STEAL_MUTEX_AGE_MS) {
    // Unconditional time backstop -- see MAX_STEAL_MUTEX_AGE_MS above. Pid
    // liveness below can only make reclaim happen *sooner* than this; it
    // must never be the only path to reclaiming an orphaned mutex.
    return true;
  }
  const holderPid = Number.parseInt(content, 10);
  if (Number.isInteger(holderPid) && holderPid > 0) {
    return !isProcessAlive(holderPid);
  }
  // Empty/malformed content: either genuinely orphaned mid-creation (a
  // writer that crashed between its `open('wx')` and its `writeFile`), or,
  // very briefly, a legitimate writer that hasn't finished that single
  // write yet. Fall back to a short, generous grace period rather than
  // either permanently refusing to reclaim it or reclaiming a
  // still-being-created file out from under its rightful creator.
  return Date.now() - mtimeMs > STEAL_MUTEX_GRACE_MS;
}

/**
 * Acquires `${lockPath}.steal`, a small, always-briefly-held meta-mutex that
 * serializes stale-lock steal *attempts* against `lockPath` across all
 * racers (see `tryStealStaleLock`), creating it fresh via exclusive
 * `open('wx')` -- or, if another holder's pid is provably dead (or its
 * content is old enough that nothing legitimate could still be mid-write,
 * or it has simply existed longer than any pid-liveness check should ever
 * be trusted for), atomically reclaiming it via `reclaimStaleFile`.
 *
 * Regression (issue #51 follow-up, review BLOCKING #1): the very first
 * version of this meta-mutex had no recovery path of its own at all -- if
 * its holder crashed (or any other error path skipped its cleanup) before
 * releasing it, every future `acquireLock` call would hit EEXIST on it
 * forever, across restarts, with no way out. That's exactly the permanent-
 * deadlock failure mode `STALE_LOCK_MS` exists to prevent for the main
 * lock, reintroduced one level up. This mutex gets the same
 * steal-when-abandoned treatment as the main lock, via the same
 * `reclaimStaleFile` primitive -- gated primarily on pid liveness
 * (immediate, since nothing legitimate ever holds this mutex for more than
 * a handful of fast fs calls), backstopped by `MAX_STEAL_MUTEX_AGE_MS` so
 * pid liveness alone can never make it unreclaimable forever (round 2
 * BLOCKING 1).
 */
async function acquireStealMutex(stealMutexPath: string, filePath: string): Promise<boolean> {
  let created = false;
  try {
    const handle = await open(stealMutexPath, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(`${process.pid}\n`, 'utf-8');
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    if (created) {
      // We created the file but failed to fully commit our write to it --
      // never leave an indeterminate-content mutex file behind.
      await rm(stealMutexPath, { force: true }).catch(() => {
        // best-effort cleanup only
      });
    }
    if (!isErrnoException(err) || err.code !== 'EEXIST') {
      throw new StorageError(
        `failed to acquire steal-mutex for store file "${filePath}": ${(err as Error).message}`,
        { cause: err },
      );
    }
  }

  // Contended -- cheap gate before ever touching the mutex file: read its
  // current holder and only attempt the heavier `reclaimStaleFile` reclaim
  // if it's provably reclaimable. This keeps the overwhelmingly common
  // case -- the mutex genuinely held by a live racer for a few
  // milliseconds -- a single cheap read with zero churn on the mutex file.
  let stats;
  let content: string;
  try {
    [stats, content] = await Promise.all([
      lstat(stealMutexPath),
      readFile(stealMutexPath, 'utf-8'),
    ]);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      // Released between our open() and this read -- caller's normal poll
      // loop retries shortly.
      return false;
    }
    throw new StorageError(
      `failed to inspect steal-mutex for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  if (!isStealMutexReclaimable({ content, mtimeMs: stats.mtimeMs })) {
    // Genuinely still held by a live racer -- back off without touching it.
    return false;
  }

  // The cheap gate says reclaimable, but that snapshot is already moments
  // old -- `reclaimStaleFile` re-verifies against a fresh read (and, at
  // swap time, a fresh identity check) before actually acting.
  return reclaimStaleFile(stealMutexPath, filePath, isStealMutexReclaimable);
}

/**
 * Attempts to steal a lock file that has just been judged stale.
 *
 * Regression (issue #51): the original steal was a plain "check age, then
 * `rm`" -- not atomic w.r.t. other stealers racing the same check. That let
 * this happen: P1 sees the lock is stale, `rm`s it, loops back, and creates
 * a fresh live lock via `open('wx')`. P2, already past its own staleness
 * check on the *old* mtime (i.e. before P1 acted), then `rm`s what it still
 * believes is the stale lock -- but that unconditional `rm` actually deletes
 * P1's brand-new live lock. A third acquirer (or P2 itself, next loop) can
 * now acquire the lock while P1 believes it still holds it and is mid-write:
 * the exact lost-update race #9's locking was built to close, just narrowed
 * to the window right after a stale-lock steal.
 *
 * Closing this needs two distinct things, both provided by
 * `acquireStealMutex` + `reclaimStaleFile` above:
 *
 * - Other *stealers* racing the same stale lock must be excluded from each
 *   other, so one stealer can never clobber another stealer's already-won
 *   fresh lock. `acquireStealMutex` does this: only one racer is ever inside
 *   the block below for a given `lockPath` at a time.
 * - Even with only one stealer active, it must never act on a moments-old
 *   staleness *decision*, nor ever make `lockPath` observably vacant while
 *   deciding -- an ordinary (non-stealing) acquirer, or the original
 *   holder's own release, can happen at any instant (review BLOCKING #3
 *   from round 1, and BLOCKING #1/#2 from round 2, each reproduced
 *   directly). `reclaimStaleFile` closes this by never detaching
 *   `lockPath` and only ever swapping it via an identity-checked
 *   compare-and-swap immediately before the one atomic `rename` that can
 *   change it.
 */
async function tryStealStaleLock(lockPath: string, filePath: string): Promise<boolean> {
  const stealMutexPath = `${lockPath}.steal`;

  const acquiredMutex = await acquireStealMutex(stealMutexPath, filePath);
  if (!acquiredMutex) {
    // Another racer is already mid-steal against this lockPath (or we lost
    // a steal-mutex reclaim race to one) -- back off, the caller's normal
    // poll loop retries shortly.
    return false;
  }

  try {
    return await reclaimStaleFile(
      lockPath,
      filePath,
      ({ mtimeMs }) => Date.now() - mtimeMs > STALE_LOCK_MS,
    );
  } finally {
    await rm(stealMutexPath, { force: true }).catch(() => {
      // best-effort cleanup only -- must never reject and mask a successful
      // steal (issue #84: this was the one remaining unguarded cleanup in
      // this file, matching the exact BLOCKING 3 failure mode -- an injected
      // EIO here previously propagated straight out of this `finally`,
      // discarding whatever `reclaimStaleFile` had already legitimately
      // decided, including a successful steal this process actually won).
    });
  }
}

/**
 * Acquires an exclusive lock on `filePath` by creating `${filePath}.lock`
 * with the `wx` flag (O_CREAT | O_EXCL): the filesystem guarantees that
 * create fails with EEXIST if the file already exists, and that guarantee
 * holds across separate OS processes, not just separate calls within one
 * process -- which is what makes this safe against two independent CLI
 * invocations racing each other (issue #9), unlike an in-process mutex.
 *
 * While the lock is held elsewhere, this polls until it is released or
 * `timeoutMs` elapses. On timeout it throws a StorageError rather than ever
 * proceeding without the lock -- a loud, clear failure instead of silently
 * racing the other writer and possibly losing its update. A lock file older
 * than STALE_LOCK_MS is assumed to belong to a crashed holder and is stolen
 * -- atomically, via `tryStealStaleLock` (issue #51) -- rather than waited
 * out.
 */
async function acquireLock(filePath: string, timeoutMs: number): Promise<string> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;

  // Mirrors saveStore's own mkdir: --file may point at a not-yet-created
  // directory, and taking the lock must not narrow that existing behavior.
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        // Best-effort breadcrumb for a human debugging a stuck lock; never
        // relied on programmatically.
        await handle.writeFile(`${process.pid}\n`, 'utf-8');
      } finally {
        await handle.close();
      }
      return lockPath;
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EEXIST') {
        throw new StorageError(
          `failed to acquire lock for store file "${filePath}": ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    // lstat, not stat: the staleness decision is about the lock path
    // itself -- including a dangling symlink dropped at that path -- not
    // whatever a symlink there might point to.
    try {
      const lockStats = await lstat(lockPath);
      if (Date.now() - lockStats.mtimeMs > STALE_LOCK_MS) {
        if (await tryStealStaleLock(lockPath, filePath)) {
          return lockPath;
        }
        // else: lost the steal race to another concurrent stealer -- fall
        // through to the deadline check/sleep below and retry from the top
        // of the loop, exactly as if we'd found the lock still live.
      }
    } catch (statErr) {
      // A StorageError here already came from `tryStealStaleLock` (or
      // something it called) with its own precise, already-descriptive
      // message -- propagate it as-is instead of re-wrapping it behind a
      // generic "failed to inspect lock" label that would obscure which
      // operation actually failed.
      if (statErr instanceof StorageError) {
        throw statErr;
      }
      if (!isErrnoException(statErr) || statErr.code !== 'ENOENT') {
        throw new StorageError(
          `failed to inspect lock for store file "${filePath}": ${(statErr as Error).message}`,
          { cause: statErr },
        );
      }
      // else: the other writer released it between our attempts -- fall
      // through to the deadline check/sleep below and retry.
    }

    if (Date.now() >= deadline) {
      throw new StorageError(
        `timed out after ${timeoutMs}ms waiting for a lock on store file "${filePath}" -- another process is writing to it, try again`,
      );
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { force: true });
}

/**
 * Runs one load-modify-save cycle against `filePath` under an exclusive
 * lock, closing the lost-update race described in issue #9: previously
 * every mutating CLI command called loadStore then saveStore as two
 * independent steps, so two concurrent invocations could both load the same
 * starting state and whichever saved last would silently overwrite the
 * other's change. With the lock, a second invocation's `loadStore` cannot
 * start until the first invocation has saved and released the lock, so it
 * always observes the first invocation's write and layers its own update on
 * top instead of clobbering it. If the lock is unavailable within
 * `timeoutMs`, this throws (StorageError) instead of ever proceeding
 * unlocked.
 *
 * `mutator` receives the freshly loaded store (taken under the lock, so it
 * is never stale) and returns both the next store to persist and an
 * arbitrary `result` for the caller -- this lets commands like `add`/`rm`/
 * `limit set` return their own result shape (e.g. the new transaction's id)
 * without a second, redundant read.
 */
export async function updateStore<T>(
  filePath: string,
  mutator: (store: PersistedStore) => { store: PersistedStore; result: T },
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const lockPath = await acquireLock(filePath, options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  try {
    const current = await loadStore(filePath);
    const { store: next, result } = mutator(current);
    await saveStore(filePath, next);
    return result;
  } finally {
    await releaseLock(lockPath);
  }
}

export type { PersistedStore, StoredTransaction };
