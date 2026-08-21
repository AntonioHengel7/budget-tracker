import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { listTransactions, removeTransaction, type StoredTransaction } from '../api.js';
import { formatMinor } from '../money.js';

export function Transactions(): React.JSX.Element {
  const [transactions, setTransactions] = useState<readonly StoredTransaction[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState('');
  const [note, setNote] = useState('');

  async function refresh(): Promise<void> {
    try {
      const results = await listTransactions({
        ...(from !== '' ? { from } : {}),
        ...(to !== '' ? { to } : {}),
        ...(category !== '' ? { category } : {}),
        ...(kind !== '' ? { kind } : {}),
        ...(note !== '' ? { note } : {}),
      });
      setTransactions(results);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load transactions');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function handleFilterSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void refresh();
  }

  async function handleRemove(id: string): Promise<void> {
    try {
      await removeTransaction(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to remove transaction');
    }
  }

  return (
    <div>
      <h2>Transactions</h2>
      {error !== null ? <div role="alert">{error}</div> : null}

      <form onSubmit={handleFilterSubmit}>
        <label htmlFor="tx-from">From</label>
        <input id="tx-from" type="date" value={from} onChange={(event) => setFrom(event.target.value)} />

        <label htmlFor="tx-to">To</label>
        <input id="tx-to" type="date" value={to} onChange={(event) => setTo(event.target.value)} />

        <label htmlFor="tx-category">Category</label>
        <input
          id="tx-category"
          type="text"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        />

        <label htmlFor="tx-kind">Kind</label>
        <select id="tx-kind" value={kind} onChange={(event) => setKind(event.target.value)}>
          <option value="">Any</option>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>

        <label htmlFor="tx-note">Note contains</label>
        <input id="tx-note" type="text" value={note} onChange={(event) => setNote(event.target.value)} />

        <button type="submit">Filter</button>
      </form>

      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Category</th>
            <th>Kind</th>
            <th>Amount</th>
            <th>Note</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((st) => (
            <tr key={st.id}>
              <td>{st.transaction.date}</td>
              <td>{st.transaction.category}</td>
              <td>{st.transaction.kind}</td>
              <td className="numeric">{formatMinor(st.transaction.amountMinor)}</td>
              <td>{st.transaction.note ?? ''}</td>
              <td>
                <button type="button" onClick={() => void handleRemove(st.id)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
