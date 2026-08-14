import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
  // Re-validated through the domain's own constructor, same as transactions above.
  return createCategoryBudget(entry as unknown as Parameters<typeof createCategoryBudget>[0]);
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

  const rawBudgets = parsed.budgets;
  if (rawBudgets !== undefined && !Array.isArray(rawBudgets)) {
    throw new StorageError(`store file "${filePath}" has a non-array "budgets" field`);
  }
  const budgets = (rawBudgets ?? []).map((entry: unknown) => validateBudget(entry, filePath));

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
    await writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
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

export type { PersistedStore, StoredTransaction };
