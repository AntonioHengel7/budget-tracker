import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Limits } from '../src/pages/Limits.js';

describe('Limits remove form (#83)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): void {
    globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
  }

  function submitRemove(category: string): void {
    fireEvent.change(screen.getByLabelText(/category to remove/i), { target: { value: category } });
    fireEvent.click(screen.getByRole('button', { name: /remove limit/i }));
  }

  it('calls DELETE /api/limits/:category and shows a confirmation on success', async () => {
    mockFetch((input) => {
      expect(String(input)).toBe('/api/limits/groceries');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ category: 'groceries', rollover: false, limits: [] }),
      } as Response);
    });

    render(<Limits />);
    submitRemove('groceries');

    await waitFor(() => expect(screen.getByText(/removed: groceries/i)).toBeInTheDocument());
  });

  it('shows an error and no confirmation when the category has no budget', async () => {
    mockFetch(() =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: 'no budget for category "nope"' }),
      } as Response),
    );

    render(<Limits />);
    submitRemove('nope');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('no budget for category "nope"'));
    expect(screen.queryByText(/removed:/i)).not.toBeInTheDocument();
  });
});
