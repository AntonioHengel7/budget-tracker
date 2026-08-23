import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Dashboard } from '../src/pages/Dashboard.js';
import { Transactions } from '../src/pages/Transactions.js';

// Issue #77: below ~360px viewport width the Transactions/Dashboard tables'
// unbounded min-content width (338px across 6 columns on Transactions)
// overflows the viewport (34px at 320px, 74px at 280px per Socrates'
// investigation), dragging the whole page into horizontal scroll. jsdom
// doesn't perform real layout, so an actual overflow measurement isn't
// available here -- instead this asserts the fix's two load-bearing parts:
// each table is wrapped in a `.table-wrapper` container, and that class
// carries `overflow-x: auto` in the stylesheet, which confines any
// remaining overflow to the table itself rather than the page.
describe('table horizontal overflow containment (#77)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defines .table-wrapper with overflow-x: auto in the shared stylesheet', () => {
    const cssPath = resolve(__dirname, '../src/index.css');
    const css = readFileSync(cssPath, 'utf-8');
    const match = css.match(/\.table-wrapper\s*{([^}]*)}/);
    expect(match).not.toBeNull();
    expect(match?.[1]).toMatch(/overflow-x:\s*auto/);
  });

  it('wraps the Transactions table in a .table-wrapper container', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      }),
    ) as unknown as typeof fetch;

    render(<Transactions />);

    const table = await waitFor(() => screen.getByRole('table'));
    expect(table.parentElement).not.toBeNull();
    expect(table.parentElement).toHaveClass('table-wrapper');
  });

  it('wraps the Dashboard budget status table in a .table-wrapper container', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/status')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [
            {
              period: '2026-08',
              category: 'groceries',
              limitMinor: 10000,
              carryInMinor: 0,
              availableMinor: 5000,
              spentMinor: 5000,
              state: 'under',
              pctUsed: 50,
            },
          ],
        });
      }
      if (url.includes('/api/summary')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            period: { period: '2026-08', incomeMinor: 0, expenseMinor: 0, netMinor: 0 },
            byCategory: [],
          }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(<Dashboard />);

    const table = await waitFor(() => screen.getByRole('table'));
    expect(table.parentElement).not.toBeNull();
    expect(table.parentElement).toHaveClass('table-wrapper');
  });
});
