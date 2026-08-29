import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Signup } from '../src/pages/Signup.js';

async function submit(username: string, email: string, password: string): Promise<void> {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: username } });
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  fireEvent.change(screen.getByLabelText(/password/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /sign up/i }));
}

describe('Signup error branches', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the server-provided error message on a 409 (username taken)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'username already taken' }),
    }) as unknown as typeof fetch;

    render(<Signup />);
    await submit('antonio', 'antonio@example.com', 'longenoughpassword');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/username already taken/i));
  });

  it('shows a rate-limit message on a 429 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'too many signup attempts, try again later' }),
    }) as unknown as typeof fetch;

    render(<Signup />);
    await submit('antonio', 'antonio@example.com', 'longenoughpassword');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many signup attempts/i));
  });

  it('shows an error (not an unhandled rejection) when fetch rejects with a network error', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    render(<Signup />);
    await submit('antonio', 'antonio@example.com', 'longenoughpassword');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not sign up/i));
  });

  it('shows a generic message when the error response has no parseable body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json');
      },
    }) as unknown as typeof fetch;

    render(<Signup />);
    await submit('antonio', 'antonio@example.com', 'short');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
