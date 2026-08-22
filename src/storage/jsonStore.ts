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
 * rather than waited out.
 */
async function acquireLock(filePath: string, timeoutMs: number): Promise<string> {
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
        await rm(lockPath, { force: true });
      }
    } catch (statErr) {
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
