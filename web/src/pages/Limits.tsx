import { useState } from 'react';
import type { FormEvent } from 'react';
import { setLimit, type CategoryBudget } from '../api.js';

export function Limits(): React.JSX.Element {
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [rollover, setRollover] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<CategoryBudget | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(null);
    try {
      const budget = await setLimit({ category, amount, effectiveFrom, rollover });
      setSaved(budget);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to set limit');
    }
  }

  return (
    <div>
      <h2>Limits</h2>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <label htmlFor="limit-category">Category</label>
        <input
          id="limit-category"
          type="text"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          required
        />

        <label htmlFor="limit-amount">Amount</label>
        <input
          id="limit-amount"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          required
        />

        <label htmlFor="limit-effective-from">Effective from (YYYY-MM)</label>
        <input
          id="limit-effective-from"
          type="text"
          placeholder="2026-08"
          value={effectiveFrom}
          onChange={(event) => setEffectiveFrom(event.target.value)}
          required
        />

        <label htmlFor="limit-rollover">
          <input
            id="limit-rollover"
            type="checkbox"
            checked={rollover}
            onChange={(event) => setRollover(event.target.checked)}
          />
          Rollover unspent balance
        </label>

        {error !== null ? <div role="alert">{error}</div> : null}
        <button type="submit">Set limit</button>
      </form>

      {saved !== null ? (
        <p>
          Saved: {saved.category} (rollover: {saved.rollover ? 'yes' : 'no'})
        </p>
      ) : null}
    </div>
  );
}
