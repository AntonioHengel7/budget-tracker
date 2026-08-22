import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from '../src/pages/Dashboard.js';

describe('Dashboard stat tiles and status pills', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(status: unknown[], summary: unknown): void {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => status,
        });
      }
      if (url.includes('/api/summary')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => summary,
        });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;
  }

  // Issue #80 item 1: Net's tile is colored by sign -- success (green-ish)
  // when the period ended up in the black, error (red-ish) when in the red.
  // Income always gets the success tint per spec; Expense stays neutral.
  it('colors the Net stat tile success when net is positive', async () => {
    mockFetch(
      [],
      {
        period: { period: '2026-08', incomeMinor: 50000, expenseMinor: 20000, netMinor: 30000 },
        byCategory: [],
      },
    );

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText(/summary/i)).toBeInTheDocument());

    const incomeValue = screen.getByText('500.00');
    expect(incomeValue).toHaveClass('stat-tile-value-success');

    const netValue = screen.getByText('300.00');
    expect(netValue).toHaveClass('stat-tile-value-success');
    expect(netValue).not.toHaveClass('stat-tile-value-error');

    const expenseValue = screen.getByText('200.00');
    expect(expenseValue).not.toHaveClass('stat-tile-value-success');
    expect(expenseValue).not.toHaveClass('stat-tile-value-error');
  });

  // Boundary case (Socrates, PR #81 round 1 BLOCKING (1)): netMinor === 0 is
  // the entire reason the predicate is `>= 0` rather than `> 0` -- without
  // this, a mutant flipping `>=` to `>` survives (all other tests use a
  // strictly positive or strictly negative netMinor, never exactly zero).
  it('colors the Net stat tile success (not error) when net is exactly zero', async () => {
    mockFetch(
      [],
      {
        period: { period: '2026-08', incomeMinor: 10000, expenseMinor: 10000, netMinor: 0 },
        byCategory: [],
      },
    );

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText(/summary/i)).toBeInTheDocument());

    const netValue = screen.getByText('0.00');
    expect(netValue).toHaveClass('stat-tile-value-success');
    expect(netValue).not.toHaveClass('stat-tile-value-error');
  });

  it('colors the Net stat tile error when net is negative', async () => {
    mockFetch(
      [],
      {
        period: { period: '2026-08', incomeMinor: 10000, expenseMinor: 40000, netMinor: -30000 },
        byCategory: [],
      },
    );

    render(<Dashboard />);

    await waitFor(() => expect(screen.getByText(/summary/i)).toBeInTheDocument());

    const netValue = screen.getByText('-300.00');
    expect(netValue).toHaveClass('stat-tile-value-error');
    expect(netValue).not.toHaveClass('stat-tile-value-success');
  });

  // Issue #80 item 4: each budget status row renders its state as a
  // `status-<state>` pill on a <span> nested inside the <td>, keyed off the
  // API's `state` field. Asserted structurally (not just via toHaveClass on
  // whatever element the text resolves to) because `.status-over` etc. now
  // carry pill layout (display: inline-block, padding, border-radius) --
  // if that class ever landed back on the <td> directly it would break the
  // table row layout, and a non-structural assertion wouldn't catch it
  // (Socrates, PR #81 round 1 BLOCKING (2)).
  it('renders each row\'s budget state as a pill <span> nested inside its <td>, not on the <td> itself', async () => {
    mockFetch(
      [
        {
          period: '2026-08',
          category: 'groceries',
          limitMinor: 10000,
          carryInMinor: 0,
          availableMinor: -500,
          spentMinor: 10500,
          state: 'over',
          pctUsed: 105,
        },
        {
          period: '2026-08',
          category: 'rent',
          limitMinor: 100000,
          carryInMinor: 0,
          availableMinor: 0,
          spentMinor: 100000,
          state: 'at',
          pctUsed: 100,
        },
        {
          period: '2026-08',
          category: 'fun',
          limitMinor: 5000,
          carryInMinor: 0,
          availableMinor: 2000,
          spentMinor: 3000,
          state: 'under',
          pctUsed: 60,
        },
      ],
      { period: { period: '2026-08', incomeMinor: 0, expenseMinor: 0, netMinor: 0 }, byCategory: [] },
    );

    render(<Dashboard />);

    const overPill = await screen.findByText('over');
    const atPill = screen.getByText('at');
    const underPill = screen.getByText('under');

    for (const [pill, statusClass] of [
      [overPill, 'status-over'],
      [atPill, 'status-at'],
      [underPill, 'status-under'],
    ] as const) {
      // The pill itself is a <span> carrying the status class...
      expect(pill.tagName).toBe('SPAN');
      expect(pill).toHaveClass(statusClass);

      // ...nested inside a <td> that does NOT carry the status class itself
      // (it must stay a plain table cell so the pill's inline-block/padding/
      // border-radius don't disturb table row layout).
      const cell = pill.closest('td');
      expect(cell).not.toBeNull();
      expect(cell?.tagName).toBe('TD');
      expect(cell).not.toHaveClass(statusClass);
    }
  });
});
