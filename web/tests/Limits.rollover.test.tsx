import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Limits } from '../src/pages/Limits.js';

describe('Limits rollover field', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetchEchoingBody(): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = init?.body !== undefined ? JSON.parse(init.body as string) : {};
      const parsed = body as { category?: string; rollover?: boolean };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ category: parsed.category, rollover: parsed.rollover ?? false, limits: [] }),
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function fillForm(category: string, amount: string, effectiveFrom: string): void {
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: category } });
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText(/effective from/i), { target: { value: effectiveFrom } });
  }

  function submit(): void {
    fireEvent.click(screen.getByRole('button', { name: /set limit/i }));
  }

  function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const calls = fetchMock.mock.calls;
    const lastCall = calls[calls.length - 1] as [RequestInfo | URL, RequestInit | undefined];
    const init = lastCall[1];
    return JSON.parse(init?.body as string) as Record<string, unknown>;
  }

  // Regression (Socrates, PR #24 round 2 BLOCKING (2)): `rolloverTouched`
  // was never reset, so submitting once for one category with the rollover
  // checkbox checked, then changing the category field and submitting
  // again, carried the first category's "touched" state into the second
  // submission -- silently sending `rollover: true` for a category whose
  // checkbox the user never touched. Changing the category (or a
  // successful submit) must reset both `rollover` and `rolloverTouched`
  // back to their untouched initial state.
  it('does not carry a previous category\'s touched rollover state into a submit for a different category', async () => {
    const fetchMock = mockFetchEchoingBody();
    render(<Limits />);

    // First submission: category "food", rollover box explicitly checked.
    fillForm('food', '500', '2026-08');
    fireEvent.click(screen.getByLabelText(/rollover unspent balance/i));
    submit();

    await waitFor(() => expect(screen.getByText(/saved: food/i)).toBeInTheDocument());
    expect(lastRequestBody(fetchMock)).toMatchObject({ category: 'food', rollover: true });

    // Switch to a different category and submit again without touching the
    // checkbox at all -- the checkbox must visually reset too.
    fireEvent.change(screen.getByLabelText(/category/i), { target: { value: 'rent' } });
    expect(screen.getByLabelText(/rollover unspent balance/i)).not.toBeChecked();
    submit();

    await waitFor(() => expect(screen.getByText(/saved: rent/i)).toBeInTheDocument());
    const secondBody = lastRequestBody(fetchMock);
    expect(secondBody).toMatchObject({ category: 'rent' });
    expect(secondBody).not.toHaveProperty('rollover');
  });
});
