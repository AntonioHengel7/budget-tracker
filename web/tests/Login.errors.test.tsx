import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../src/pages/Login.js';

// Covers the error branches added on top of the frozen Login.test.tsx:
// a 429 (rate-limited) response must show a distinct message rather than
// the generic invalid-credentials one, and a rejecting fetch (network
// failure) must be caught rather than becoming an unhandled rejection.
describe('Login error branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows a rate-limit message (not "invalid") on a 429 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'too many login attempts, try again later' }),
    }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many login attempts/i));
    expect(screen.getByRole('alert')).not.toHaveTextContent(/invalid/i);
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it('shows an error (not an unhandled rejection) when fetch rejects with a network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid/i));
    expect(onLoggedIn).not.toHaveBeenCalled();
  });
});
