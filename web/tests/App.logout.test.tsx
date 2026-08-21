import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

describe('App logout', () => {
  let unhandledRejections: unknown[] = [];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(() => {
    vi.restoreAllMocks();
    unhandledRejections = [];
    onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
  });

  // Regression (Socrates, PR #24 round 2 BLOCKING (1)): handleLogout's
  // `try { await logout(); } finally { setAuth(...) }` re-threw logout()'s
  // rejection past the finally block, and the `void handleLogout()` call
  // site at the Log out button discarded that now-rejecting promise --
  // producing an unhandled promise rejection whenever /api/logout fails
  // (network error, 500, etc). It must land on the logged-out UI state
  // without ever surfacing an unhandled rejection.
  it('lands on the logged-out UI state, with no unhandled rejection, when /api/logout fails', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ username: 'antonio' }),
        });
      }
      if (url.includes('/api/logout')) {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(<App />);

    const logoutButton = await screen.findByRole('button', { name: /log out/i });
    logoutButton.click();

    await waitFor(() => expect(screen.getByLabelText(/username/i)).toBeInTheDocument());

    // Give any stray unhandled rejection a macrotask to surface before we assert.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(unhandledRejections).toEqual([]);
  });

  // Regression (Socrates, PR #75 round 1 NOTE): nothing pinned the theme
  // toggle's location inside the authenticated nav row -- the entire point
  // of moving it out of the pre-auth-only corner placement.
  it('renders the theme toggle inside nav once logged in', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/me')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ username: 'antonio' }),
        });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(<App />);

    await screen.findByRole('button', { name: /log out/i });
    expect(
      screen.getByRole('button', { name: /switch to .* theme/i }).closest('nav'),
    ).not.toBeNull();
  });
});
