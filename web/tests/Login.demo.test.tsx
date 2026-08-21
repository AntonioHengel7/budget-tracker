import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Login } from '../src/pages/Login.js';

describe('Login demo mode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clicking "Try it out" calls POST /api/demo and invokes onLoggedIn with the returned username', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ username: 'demo-abcd1234' }),
    }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => expect(onLoggedIn).toHaveBeenCalledWith('demo-abcd1234'));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/demo',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('shows an error alert and does not call onLoggedIn when the demo request fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/could not start the demo/i));
    expect(onLoggedIn).not.toHaveBeenCalled();
  });

  it('shows a rate-limit message on a 429 response from the demo endpoint', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'too many demo requests, try again later' }),
    }) as unknown as typeof fetch;

    const onLoggedIn = vi.fn();
    render(<Login onLoggedIn={onLoggedIn} />);

    fireEvent.click(screen.getByRole('button', { name: /try it out/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many demo requests/i));
    expect(onLoggedIn).not.toHaveBeenCalled();
  });
});
