import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../src/pages/Login.js';

describe('Login', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('calls onLoggedIn with the username on a successful login', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: 'antonio' }),
    }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('antonio'));
  });

  it('shows an error message and does not call onLoggedIn on invalid credentials', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /log in/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/invalid/i));
    expect(onLoggedIn).not.toHaveBeenCalled();
  });
});
