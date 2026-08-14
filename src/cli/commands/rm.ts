import { ValidationError } from '../../domain/errors.js';
import { loadStore, saveStore } from '../../storage/jsonStore.js';
import type { StoredTransaction } from '../../storage/schema.js';

/** Removes the transaction with the given `id` from the store at `filePath`. */
export async function removeTransaction(filePath: string, id: string): Promise<StoredTransaction> {
  const store = await loadStore(filePath);
  const removed = store.transactions.find((st) => st.id === id);
  if (removed === undefined) {
    throw new ValidationError(`no transaction with id "${id}"`);
  }

  const transactions = store.transactions.filter((st) => st.id !== id);
  await saveStore(filePath, { ...store, transactions });

  return removed;
}
