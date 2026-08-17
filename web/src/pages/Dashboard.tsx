import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import {
  addTransaction,
  getStatus,
  getSummary,
  type PeriodBudgetStatus,
  type SummaryResult,
} from '../api.js';
import { formatMinor } from '../money.js';

export function Dashboard(): React.JSX.Element {
  const [status, setStatus] = useState<readonly PeriodBudgetStatus[]>([]);
  const [summary, setSummary] = useState<SummaryResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [note, setNote] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function refresh(): Promise<void> {
    try {
      // No explicit period -- the server defaults to the current period
      // itself (via shared/clock.ts's currentPeriod()), the same way the CLI
      // does, so the client never needs to duplicate that date logic.
      const [statusResult, summaryResult] = await Promise.all([getStatus(), getSummary()]);
      setStatus(statusResult);
      setSummary(summaryResult);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'failed to load dashboard data');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitError(null);
    try {
      await addTransaction({
        amount,
        category,
        kind,
        ...(note !== '' ? { note } : {}),
      });
      setAmount('');
      setCategory('');
      setNote('');
      await refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'failed to add transaction');
    }
  }

  return (
    <div>
      <h2>Dashboard</h2>
      {loadError !== null ? <div role="alert">{loadError}</div> : null}

      {summary !== null ? (
        <section>
          <h3>Summary ({summary.period.period})</h3>
          <p>Income: {formatMinor(summary.period.incomeMinor)}</p>
          <p>Expense: {formatMinor(summary.period.expenseMinor)}</p>
          <p>Net: {formatMinor(summary.period.netMinor)}</p>
        </section>
      ) : null}

      <section>
        <h3>Budget status</h3>
        {status.length === 0 ? (
          <p>No budgets set.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Limit</th>
                <th>Spent</th>
                <th>Available</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {status.map((row) => (
                <tr key={row.category}>
                  <td>{row.category}</td>
                  <td>{formatMinor(row.limitMinor)}</td>
                  <td>{formatMinor(row.spentMinor)}</td>
                  <td>{formatMinor(row.availableMinor)}</td>
                  <td className={`status-${row.state}`}>{row.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h3>Add transaction</h3>
        <form onSubmit={(event) => void handleSubmit(event)}>
          <label htmlFor="dash-amount">Amount</label>
          <input
            id="dash-amount"
            type="text"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />

          <label htmlFor="dash-category">Category</label>
          <input
            id="dash-category"
            type="text"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            required
          />

          <label htmlFor="dash-kind">Kind</label>
          <select
            id="dash-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'expense' | 'income')}
          >
            <option value="expense">Expense</option>
            <option value="income">Income</option>
          </select>

          <label htmlFor="dash-note">Note</label>
          <input
            id="dash-note"
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />

          {submitError !== null ? <div role="alert">{submitError}</div> : null}
          <button type="submit">Add transaction</button>
        </form>
      </section>
    </div>
  );
}
