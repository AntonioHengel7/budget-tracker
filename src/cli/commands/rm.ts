import { ValidationError } from '../../domain/errors.js';
import { updateStore } from '../../storage/jsonStore.js';
import type { StoredTransaction } from '../../storage/schema.js';

/** Removes the transaction with the given `id` from the store at `filePath`. */
export async function removeTransaction(filePath: string, id: string): Promise<StoredTransaction> {
  // Load-modify-save runs under updateStore's exclusive lock (issue #9) --
  // see add.ts for why this matters against concurrent CLI invocations.
  return updateStore(filePath, (store) => {
    const removed = store.transactions.find((st) => st.id === id);
    if (removed === undefined) {
      throw new ValidationError(`no transaction with id "${id}"`);
    }

    const transactions = store.transactions.filter((st) => st.id !== id);
    return { store: { ...store, transactions }, result: removed };
  });
}
