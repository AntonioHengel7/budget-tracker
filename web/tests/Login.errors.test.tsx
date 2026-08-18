import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../src/pages/Login.js';

describe('Login error branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Regression (Socrates, PR #24 round 1 BLOCKING (d)): Login.tsx's bypass
  // of api.ts's login() misreported a 429 (rate-limited) response as
  // "invalid credentials" -- the same generic message as a bad password.
  // It must now show a distinct message so a rate-limited user isn't told
  // their credentials are wrong.
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

  // Regression (Socrates, PR #24 round 1 BLOCKING (b)): Login.tsx's bypass
  // of api.ts's login() left a rejecting fetch (network failure) uncaught,
  // producing an unhandled promise rejection instead of a visible error
  // message.
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
