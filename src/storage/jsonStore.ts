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
 * Thrown by `updateStore`'s fencing check (passed to `saveStore` as
 * `beforeCommit`) when the lock this caller acquired no longer matches what
 * is currently on disk at its lock path -- i.e. it was stolen since
 * acquisition. Never surfaced to callers of `updateStore` directly: caught
 * internally to trigger a bounded retry of the whole load-modify-save cycle
 * (see `updateStore`). Kept distinct from `StorageError` so `saveStore`'s own
 * catch block -- which wraps any other failure in a `StorageError` -- can
 * recognize and pass this through unwrapped instead, the same way
 * `acquireLock` already passes through `StorageError`s it doesn't want to
 * re-wrap behind a generic label.
 */
class LockStolenError extends Error {
  constructor() {
    super('lock was stolen before the write could commit');
    this.name = 'LockStolenError';
  }
}

/**
 * Saves `store` to `filePath` atomically: writes to a temp file in the same
 * directory, then renames over the target. The real path is never written to
 * directly, so a failure mid-write can never leave a partial/corrupt file at
 * `filePath`. The final file is chmod'd 0600.
 *
 * `options.beforeCommit`, if given, runs as the very last step before the
 * rename that actually makes this write externally visible -- this is where
 * `updateStore` plugs in its lock-fencing check (issue #51 round 4): re-verify
 * the caller still holds the lock it acquired, immediately before the point
 * of no return, rather than trying (and, across three prior rounds, failing)
 * to make the lock-steal race itself impossible. If `beforeCommit` throws a
 * `LockStolenError`, that is propagated as-is (not wrapped) so
 * `updateStore` can distinguish "abort and retry" from a genuine save
 * failure; the temp file is still cleaned up on that path exactly like any
 * other failure here.
 */
export async function saveStore(
  filePath: string,
  store: PersistedStore,
  options: { beforeCommit?: () => Promise<void> } = {},
): Promise<void> {
  const dir = dirname(filePath);
  const tempPath = join(dir, `.${basename(filePath)}.${randomUUID()}.tmp`);
  const json = JSON.stringify(store, null, 2);

  try {
    // mkdir's `mode` only applies to directories it actually creates -- under
    // a permissive umask, the created dir's mode can still end up looser than
    // 0o700. `created` is truthy only when this call actually made `dir`
    // (undefined if it already existed), so the follow-up chmod re-asserts
    // 0700 solely on a directory this code just created -- never on a
    // pre-existing directory the tool doesn't own (e.g. the caller's cwd when
    // `--file`/BUDGET_FILE resolves there).
    const created = await mkdir(dir, { recursive: true, mode: 0o700 });
    if (created) {
      await chmod(dir, 0o700);
    }
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
    if (options.beforeCommit) {
      await options.beforeCommit();
    }
    await rename(tempPath, filePath);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {
      // best-effort cleanup only -- the original error below is what matters
    });
    if (err instanceof LockStolenError || err instanceof StorageError) {
      // Already a precise, purpose-built error (a fencing abort, or a
      // StorageError raised by beforeCommit itself) -- propagate it as-is
      // instead of re-wrapping it behind a generic "failed to save" label
      // that would obscure which operation actually failed. Mirrors the
      // same pattern in `acquireLock` for `StorageError`s it doesn't
      // re-wrap.
      throw err;
    }
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
 * History of designs tried, and rejected, for stealing an abandoned lock
 * file -- kept here in full, on purpose, across every round: an earlier
 * round of this file deleted an equivalent rejection rationale and the
 * rejected design shipped again anyway one round later.
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
 * 3. (Round 2, shipped, then reverted) "`rename(path, tombstonePath)` to
 *    atomically detach whatever is at `path`, judge staleness from the
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
 * 4. (Round 3, shipped, then reverted here) Never detach `path`; instead use
 *    filesystem identity (device + inode), last-modified instant, and exact
 *    content as a read-then-compare-and-swap token for the one moment
 *    `path` actually changes, guarded by a `${lockPath}.steal` meta-mutex
 *    (itself acquired the same way) that serialized *stealers* against each
 *    other. This closed the round-2 vacancy problem, but round 4 review
 *    (Socrates, verified by execution + mutation testing, not just reading)
 *    proved it still is not real mutual exclusion: `rename()` is not
 *    exclusive, it cannot fail on a "busy" target, so two racers who both
 *    read the *same unchanged pre-state* before either renames can *both*
 *    pass the CAS and *both* successfully `rename` -- both then believe
 *    they hold whatever they just renamed onto. Reproduced empirically:
 *    seeding a stale lock + an orphaned `.steal` meta-mutex and running
 *    concurrent `updateStore` calls under this file's jitter-fault-injection
 *    test harness lost up to 8/20 writes silently (no error surfaced). Worse,
 *    the `.steal` mutex was added specifically to serialize stealers around
 *    this weakness, but it hands *itself* out through the exact same flawed
 *    primitive in its own orphaned-mutex-reclaim branch -- the bug simply
 *    recurses one level up, onto the mutex meant to prevent it. Switching
 *    the grant from `rename` to `unlink`-then-`open('wx')` does not fully
 *    close this either for that same orphaned-mutex-reclaim case: with no
 *    arbiter above it, two racers can still interleave `unlink` and
 *    `open('wx')` such that a straggler's `unlink` deletes a rival's
 *    already-successful fresh claim, and the straggler's own subsequent
 *    `open('wx')` then succeeds against the vacancy it just created -- same
 *    double-grant, just via a different sequence. This is structural: POSIX
 *    has no atomic "delete this directory entry only if it still refers to
 *    inode X" syscall, so no amount of refining the CAS *check* can make an
 *    unconditional-delete-based grant safe when an unbounded number of
 *    independent processes can each decide to steal concurrently with no
 *    serializing arbiter.
 *
 * Round 4's fix is a different strategy entirely, not another patch on the
 * same one: stop trying to prevent the acquire-time steal race from ever
 * producing two processes that each *believe* they hold the lock -- that
 * has now failed four times running, for a structural reason no CAS
 * refinement can close. Instead, make that belief cheap to hold and
 * harmless to be wrong about:
 *
 * - The steal itself goes back to the simplest possible sequence -- best-
 *   effort `rm` of the stale lock, then `open(lockPath, 'wx')` to claim it
 *   (see `stealStaleLock`/`tryCreateLockFile` below). No meta-mutex, no
 *   temp-file CAS. Two racers *can* end up both believing they hold the
 *   lock, exactly as in the failure mode above -- this is now allowed.
 * - Every lock acquisition (ordinary or steal) captures its filesystem
 *   identity `(dev, ino)` via `handle.stat()` on the still-open handle (see
 *   `LockHandle`) -- not a separate by-name `lstat`, which would reopen a
 *   TOCTOU gap between "the file we just created" and "the file currently
 *   at that path".
 * - `updateStore` re-verifies, as the very last step before the write
 *   actually commits (immediately before `saveStore`'s internal rename --
 *   see `saveStore`'s `beforeCommit` hook), that the lock's *current*
 *   on-disk identity still matches what was captured at acquire time. A
 *   mismatch (or the lock simply being gone) means it was stolen since
 *   acquisition; the write is aborted (never committed) and the whole
 *   load-modify-save cycle is retried, bounded by the same `timeoutMs`
 *   deadline the call already had.
 * - `releaseLock` is identity-checked too (see `currentLockIdentityMatches`):
 *   it only removes the lock file if its current identity still matches
 *   what this caller captured at acquire time, never blindly whatever is
 *   currently there. If this caller was stolen from, releasing is a no-op.
 *
 * Trace the exact round-4 failure mode above through this design: P1 and P2
 * both see the same stale lock, both `rm`+`open('wx')`. If P1's `open`
 * succeeds first and P2's `rm` then executes before P2's own `open`, P2
 * will delete P1's fresh lock and then successfully create its own -- both
 * P1 and P2 now *believe* they hold the lock. This is allowed to happen; it
 * is no longer a correctness bug. When P1 eventually reaches its fencing
 * check, it will see the lock's current identity is P2's inode, not P1's --
 * P1 aborts without writing and retries. P2, unaware anything happened,
 * proceeds normally, writes, and releases correctly (identity-checked,
 * matches its own capture). No write is ever lost; P1 simply loses a round
 * and retries once P2's (now genuinely live, fresh) lock is released.
 *
 * The residual gap between the fencing check and the write actually landing
 * (and the identical gap in `releaseLock`'s own check-then-`rm`) is the same
 * class of inherent, non-closable-via-Node's-`fs` gap round 3 already
 * accepted for its own check-then-`rename` gap (Node has no atomic "act only
 * if identity X still holds" primitive at all) -- it is not glossed over
 * here either. The fencing check closes the *acquire-time* steal race this
 * design targets: it catches a theft that happened at any point before the
 * check itself runs. It does not, and cannot, catch a theft that lands
 * strictly *after* the check has already passed but before the write it
 * guards actually commits -- that narrow window is a genuinely open, accepted
 * residual, not something the *next* fencing check retroactively closes for
 * the write already in flight when it opened. What bounds the damage is
 * that any inconsistency it produces is itself just another instance of the
 * same acquire-time race, so it is in turn caught by whichever fencing check
 * (this caller's own retry, or a would-be victim's own commit-time check)
 * next observes it -- the residual is narrow and self-limiting, not closed.
 */

/**
 * Filesystem identity of a claimed lock file, captured at acquire time.
 * `(dev, ino)` alone is not sufficient: on Linux (this app's actual Fly
 * deployment, ext4; also `ubuntu-latest` CI), an unlinked inode can be
 * handed straight back to the very next `open('wx')` in the same directory
 * -- so after `stealStaleLock`'s `rm` + `open('wx')`, a completely different
 * process's fresh lock can end up with the exact same `(dev, ino)` this
 * caller captured for the lock it lost. `token` -- a `randomUUID()` minted
 * fresh per acquisition and written into the lock file's own content (see
 * `tryCreateLockFile`) -- is the actual discriminator: a `randomUUID()`
 * collision between two independent acquisitions is not a realistic risk,
 * unlike inode or pid reuse (this file's own history already notes pid
 * content collides under PID 1 in the Fly container, which is why the pid
 * written alongside it is a human-debugging breadcrumb only, never
 * compared).
 */
interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly token: string;
}

/** A successfully claimed lock: its path, plus the identity it was claimed with. */
interface LockHandle {
  readonly lockPath: string;
  readonly identity: LockIdentity;
}

/**
 * Extracts the `randomUUID()` fencing token from a lock file's content
 * (issue #51: see the `LockIdentity` doc comment for why `(dev, ino)` alone
 * is defeatable by inode reuse). Content is written as `${pid}\n${token}\n`
 * by `tryCreateLockFile` -- the pid line is a human-debugging breadcrumb
 * only and is never compared. Content that doesn't match this shape (e.g. a
 * lock file some other process/tool dropped at that path) simply yields no
 * token, which -- compared against any real captured identity -- is just
 * another form of mismatch, the same as a missing file or a different
 * token.
 */
function parseLockToken(content: string): string | null {
  const token = content.split('\n')[1]?.trim();
  return token ? token : null;
}

/**
 * Attempts to atomically create `lockPath` via exclusive `open(..., 'wx')`,
 * capturing its filesystem identity via `handle.stat()` -- an fstat on the
 * still-open handle, not a separate by-name `lstat`, which would reopen a
 * TOCTOU gap between "the file we just created" and "the file currently at
 * that path" -- before writing a fresh `randomUUID()` fencing token (plus a
 * best-effort pid breadcrumb) and closing. Returns `null` on `EEXIST`
 * (someone else holds, or just claimed, the path) so the caller can fall
 * back to its normal poll/retry logic; any other failure is a
 * `StorageError`.
 */
async function tryCreateLockFile(lockPath: string, filePath: string): Promise<LockHandle | null> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return null;
    }
    throw new StorageError(
      `failed to acquire lock for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  try {
    const stats = await handle.stat();
    const token = randomUUID();
    // pid line is a best-effort breadcrumb for a human debugging a stuck
    // lock; never relied on programmatically. The token line is the actual
    // fencing discriminator -- see the LockIdentity doc comment.
    await handle.writeFile(`${process.pid}\n${token}\n`, 'utf-8');
    return { lockPath, identity: { dev: stats.dev, ino: stats.ino, token } };
  } catch (err) {
    throw new StorageError(
      `failed to acquire lock for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    // A failing close() must never discard an already-successful
    // acquisition (issue #51, Socrates BLOCKING): by this point open+stat
    // +writeFile have all already succeeded, so the lock file legitimately
    // exists on disk and is legitimately ours. If close() itself then
    // rejects (e.g. a real/injected EIO on the fd), letting that rejection
    // escape here would replace the successful return value above with a
    // raw, non-StorageError exception -- and leave that legitimately-ours
    // lock file orphaned on disk with nothing tracking it, wedging every
    // future acquirer against it for the full STALE_LOCK_MS. Best-effort
    // only, matching this file's other guarded cleanups.
    await handle.close().catch(() => {});
  }
}

/**
 * Attempts to steal a lock file that has just been judged stale (issue #51,
 * round 4 -- see the design history above for why this is deliberately the
 * simplest possible sequence, with no meta-mutex and no CAS): best-effort
 * clear it, then race to claim the vacancy via `open('wx')`. Two racers can
 * interleave here such that a straggler's `rm` deletes a rival's
 * already-successful fresh claim, and the straggler's own `open('wx')` then
 * succeeds against the vacancy it just created -- that is allowed; it is
 * made harmless by `updateStore`'s commit-time fencing check and
 * `releaseLock`'s identity check, not prevented here.
 */
async function stealStaleLock(lockPath: string, filePath: string): Promise<LockHandle | null> {
  await rm(lockPath, { force: true }).catch(() => {
    // Best-effort clear only. If this races a concurrent steal/release and
    // loses (or the file is already gone), the open('wx') below simply
    // fails EEXIST and this attempt cleanly falls through to the caller's
    // normal poll/retry loop, exactly as if the lock had still been live.
  });
  return tryCreateLockFile(lockPath, filePath);
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
 * via `stealStaleLock` (issue #51) rather than waited out; see the design
 * history above for why the resulting lock's identity, not just its path,
 * is what actually matters now.
 */
async function acquireLock(filePath: string, timeoutMs: number): Promise<LockHandle> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;

  // Mirrors saveStore's own mkdir: --file may point at a not-yet-created
  // directory, and taking the lock must not narrow that existing behavior.
  // Same gated-chmod rationale as saveStore: only re-assert 0700 on a
  // directory this call actually created (`created` truthy), never on a
  // pre-existing directory the tool doesn't own.
  const lockDir = dirname(lockPath);
  try {
    const created = await mkdir(lockDir, { recursive: true, mode: 0o700 });
    if (created) {
      await chmod(lockDir, 0o700);
    }
  } catch (err) {
    throw new StorageError(
      `failed to acquire lock for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  for (;;) {
    const created = await tryCreateLockFile(lockPath, filePath);
    if (created) {
      return created;
    }

    // lstat, not stat: the staleness decision is about the lock path
    // itself -- including a dangling symlink dropped at that path -- not
    // whatever a symlink there might point to.
    try {
      const lockStats = await lstat(lockPath);
      if (Date.now() - lockStats.mtimeMs > STALE_LOCK_MS) {
        const stolen = await stealStaleLock(lockPath, filePath);
        if (stolen) {
          return stolen;
        }
        // else: lost the vacancy to another racer (another stealer, or an
        // ordinary acquirer) -- fall through to the deadline check/sleep
        // below and retry from the top of the loop, exactly as if we'd
        // found the lock still live.
      }
    } catch (statErr) {
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

/**
 * Checks whether `lockPath`'s *current* on-disk identity (a fresh `lstat` by
 * name, plus its content's fencing token) still matches `identity` -- the
 * shared primitive behind both `updateStore`'s commit-time fencing check and
 * `releaseLock`'s identity check (issue #51). `(dev, ino)` is checked first
 * as a cheap early-out, but is not sufficient on its own -- an unlinked
 * inode can be handed straight back to the very next `open('wx')` in the
 * same directory (see the `LockIdentity` doc comment) -- so a match also
 * requires the file's content to carry the exact `randomUUID()` token this
 * caller captured at acquire time. A missing lock file (ENOENT) counts as
 * "no longer matches", the same as any other identity mismatch.
 */
async function currentLockIdentityMatches(
  lockPath: string,
  identity: LockIdentity,
  filePath: string,
): Promise<boolean> {
  try {
    const stats = await lstat(lockPath);
    if (stats.dev !== identity.dev || stats.ino !== identity.ino) {
      return false;
    }
    const content = await readFile(lockPath, 'utf-8');
    return parseLockToken(content) === identity.token;
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return false;
    }
    throw new StorageError(
      `failed to inspect lock for store file "${filePath}": ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Releases `lock` -- but only if `lock.lockPath`'s current identity still
 * matches what this caller captured at acquire time (issue #51 round 4).
 * If it does not match, this caller was stolen from since acquiring, and
 * what currently occupies `lockPath` belongs to someone else entirely;
 * blindly `rm`ing it (the pre-round-4 behavior) would delete a rival's live
 * lock. Releasing is then a no-op instead.
 */
async function releaseLock(lock: LockHandle, filePath: string): Promise<void> {
  const stillOurs = await currentLockIdentityMatches(lock.lockPath, lock.identity, filePath);
  if (!stillOurs) {
    return;
  }
  await rm(lock.lockPath, { force: true });
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
 *
 * Issue #51 round 4: the lock this call acquires is not guaranteed to still
 * be genuinely, exclusively held by the time the write is ready to commit --
 * see the design history above `LockIdentity` for why that is now an
 * accepted possibility rather than something acquisition alone can prevent.
 * Immediately before `saveStore` commits (its `beforeCommit` hook), this
 * re-verifies the lock's identity is unchanged; if it was stolen, the write
 * is never applied and the entire cycle (re-acquire, re-load, re-modify,
 * re-save) retries from scratch, bounded by the same `timeoutMs` deadline
 * this call already had. This is purely internal: the external contract --
 * `updateStore` eventually resolves with the mutator's result, or throws
 * after timing out -- is unchanged.
 */
export async function updateStore<T>(
  filePath: string,
  mutator: (store: PersistedStore) => { store: PersistedStore; result: T },
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const lock = await acquireLock(filePath, Math.max(0, deadline - Date.now()));
    let stolen = false;
    try {
      const current = await loadStore(filePath);
      const { store: next, result } = mutator(current);
      try {
        await saveStore(filePath, next, {
          beforeCommit: async () => {
            const stillOurs = await currentLockIdentityMatches(lock.lockPath, lock.identity, filePath);
            if (!stillOurs) {
              throw new LockStolenError();
            }
          },
        });
      } catch (err) {
        if (err instanceof LockStolenError) {
          stolen = true;
        } else {
          throw err;
        }
      }
      if (!stolen) {
        return result;
      }
    } finally {
      // A failing release must never override an already-successful
      // `result` this try block was about to return -- a `finally` block
      // that itself throws replaces whatever the `try` was about to return,
      // per JS semantics. Same defect shape as tryCreateLockFile's close()
      // guard above, one level up: releaseLock is already a no-op when this
      // caller's lock was stolen, but if its internal identity check hits a
      // genuine (non-ENOENT) I/O error, that must not mask a write that
      // already fully landed. Best-effort/swallowed here on purpose --
      // errors from the load/mutate/save cycle itself (the rest of the
      // `try`) are not caught by this and still propagate normally.
      await releaseLock(lock, filePath).catch(() => {});
    }

    if (Date.now() >= deadline) {
      throw new StorageError(
        `timed out after ${timeoutMs}ms waiting for a lock on store file "${filePath}" -- the lock was repeatedly stolen from this process before its write could commit, try again`,
      );
    }
    // else: loop back and retry the whole load-modify-save cycle -- the
    // next acquireLock call will find the thief's now-genuinely-live lock
    // and either wait it out or, if it too goes stale, steal it in turn.
  }
}

export type { PersistedStore, StoredTransaction };
