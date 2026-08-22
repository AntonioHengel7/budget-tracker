import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Limits } from '../src/pages/Limits.js';

describe('Limits rollover checkbox layout (issue #78 regression)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Regression (#78): the rollover checkbox's wrapping <label> previously
  // relied on the page-wide `label { display: flex; flex-direction: column }`
  // rule -- meant for stacked text-input labels -- which, combined with the
  // default align-items: stretch, stretched the checkbox itself to the
  // label's full width and inflated its focus ring to match. The fix scopes
  // that checkbox's label to a distinct `.checkbox-label` class (row layout,
  // centered), so it must NOT fall back to the bare/generic label pattern
  // used by every other (text-input) label on this form.
  it('wraps the checkbox in a row-oriented .checkbox-label, not the stacked text-input label pattern', () => {
    render(<Limits />);

    const checkbox = screen.getByLabelText(/rollover unspent balance/i);
    expect(checkbox).toHaveAttribute('type', 'checkbox');

    const wrappingLabel = checkbox.closest('label');
    expect(wrappingLabel).not.toBeNull();
    expect(wrappingLabel).toHaveClass('checkbox-label');

    // Every other label on this form is a stacked text-input label and must
    // NOT carry the checkbox's row-oriented class -- pinning that the two
    // layouts stay distinct rather than the fix leaking column-layout back
    // onto the checkbox (or row-layout onto the text inputs).
    const categoryLabel = screen.getByText('Category').closest('label');
    expect(categoryLabel).not.toHaveClass('checkbox-label');

    // The checkbox itself is the first element inside its label, immediately
    // followed by its text -- i.e. inline "checkbox then text", not a
    // stacked column.
    expect(wrappingLabel?.firstElementChild).toBe(checkbox);
    expect(wrappingLabel?.textContent?.trim()).toBe('Rollover unspent balance');
  });
});
