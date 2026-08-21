import { useState } from 'react';
import type { FormEvent } from 'react';
import { setLimit, type CategoryBudget } from '../api.js';

export function Limits(): React.JSX.Element {
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [rollover, setRollover] = useState(false);
  // Tracks whether the user has explicitly interacted with the rollover
  // checkbox for the *currently selected category* in this form session.
  // The server (src/cli/commands/limit.ts) preserves a category's existing
  // `rollover` setting when the field is omitted from the request -- but
  // always sending the checkbox's current value would defeat that and
  // silently flip an existing `rollover: true` to `false` on any unrelated
  // edit (e.g. bumping the amount), or carry a *different* category's
  // touched state into this submission after a category switch. Only
  // include `rollover` in the request once the user has touched the box
  // for this category since the last category change or successful submit.
  const [rolloverTouched, setRolloverTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<CategoryBudget | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(null);
    try {
      const budget = await setLimit({
        category,
        amount,
        effectiveFrom,
        ...(rolloverTouched ? { rollover } : {}),
      });
      setSaved(budget);
      setRollover(false);
      setRolloverTouched(false);
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
          onChange={(event) => {
            setCategory(event.target.value);
            // The rollover checkbox's touched state is only meaningful for
            // the category it was set against -- switching categories
            // mid-session must not carry a prior category's rollover
            // choice into a submit for a different category.
            setRollover(false);
            setRolloverTouched(false);
          }}
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

        <label htmlFor="limit-rollover" className="checkbox-label">
          <input
            id="limit-rollover"
            type="checkbox"
            checked={rollover}
            onChange={(event) => {
              setRollover(event.target.checked);
              setRolloverTouched(true);
            }}
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
