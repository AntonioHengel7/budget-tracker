import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Limits } from '../src/pages/Limits.js';

describe('Limits delete-with-confirmation (#100)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(
    statusRows: unknown[],
    deleteHandler?: (category: string) => Promise<Response>,
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';

      if (url.includes('/api/status') && method === 'GET') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => statusRows,
        } as Response);
      }

      if (url.startsWith('/api/limits/') && method === 'DELETE') {
        const category = decodeURIComponent(url.slice('/api/limits/'.length));
        if (deleteHandler !== undefined) {
          return deleteHandler(category);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ category, rollover: false, limits: [] }),
        } as Response);
      }

      return Promise.reject(new Error(`unexpected fetch to ${method} ${url}`));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const groceriesRow = {
    period: '2026-08',
    category: 'groceries',
    limitMinor: 10000,
    carryInMinor: 0,
    availableMinor: 5000,
    spentMinor: 5000,
    state: 'under',
    pctUsed: 50,
  };

  it('renders limits fetched from GET /api/status with a Delete button per row', async () => {
    mockFetch([groceriesRow]);

    render(<Limits />);

    await waitFor(() => expect(screen.getByText('groceries')).toBeInTheDocument());
    expect(screen.getByText('100.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('makes no DELETE request when window.confirm returns false', async () => {
    const fetchMock = mockFetch([groceriesRow]);
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<Limits />);
    await waitFor(() => expect(screen.getByText('groceries')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    expect(window.confirm).toHaveBeenCalledWith(
      'Remove the limit for "groceries"? This cannot be undone.',
    );
    // Only the initial GET /api/status call happened -- no DELETE.
    const deleteCalls = fetchMock.mock.calls.filter(
      (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCalls).toHaveLength(0);
    expect(screen.queryByText(/removed:/i)).not.toBeInTheDocument();
  });

  it('calls DELETE /api/limits/:category for the right category and shows "Removed: X" on success', async () => {
    const fetchMock = mockFetch([groceriesRow]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<Limits />);
    await waitFor(() => expect(screen.getByText('groceries')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() => expect(screen.getByText(/removed: groceries/i)).toBeInTheDocument());

    const deleteCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'DELETE',
    );
    expect(deleteCall).toBeDefined();
    expect(String(deleteCall?.[0])).toBe('/api/limits/groceries');
  });

  it('shows an error alert (without crashing) when the DELETE call fails', async () => {
    mockFetch([groceriesRow], () =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: async () => ({ error: 'no budget for category "groceries"' }),
      } as Response),
    );
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<Limits />);
    await waitFor(() => expect(screen.getByText('groceries')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /delete/i }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('no budget for category "groceries"'),
    );
    expect(screen.queryByText(/removed:/i)).not.toBeInTheDocument();
    // The row is still there -- a failed delete must not silently drop it.
    expect(screen.getByText('groceries')).toBeInTheDocument();
  });
});
