import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Verify } from '../src/pages/Verify.js';

function setSearch(search: string): void {
  window.history.pushState({}, '', `/verify${search}`);
}

describe('Verify', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('shows an error immediately, without calling the API, when username is missing from the query string', () => {
    setSearch('?token=abc123');
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    render(<Verify />);

    expect(screen.getByRole('alert')).toHaveTextContent(/missing required information/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows an error immediately, without calling the API, when token is missing from the query string', () => {
    setSearch('?username=antonio');
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    render(<Verify />);

    expect(screen.getByRole('alert')).toHaveTextContent(/missing required information/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('shows a loading state, then calls POST /api/verify and shows the success message', async () => {
    setSearch('?username=antonio&token=abc123');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'verified', username: 'antonio' }),
    }) as unknown as typeof fetch;

    render(<Verify />);

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/^verified$/i)).toBeInTheDocument());
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'antonio', token: 'abc123' }),
      }),
    );
  });

  it('shows an error message from the API on failure (e.g. expired token)', async () => {
    setSearch('?username=antonio&token=expired');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'verification link expired, sign up again' }),
    }) as unknown as typeof fetch;

    render(<Verify />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/verification link expired/i),
    );
  });

  it('shows a generic error message (not the raw network error) when the verify call rejects outright', async () => {
    setSearch('?username=antonio&token=abc123');
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    render(<Verify />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not verify your account/i),
    );
  });

  it('renders a "Back to log in" button (not a plain link) and calls onBackToLogin, when provided', async () => {
    setSearch('?username=antonio&token=abc123');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'verified', username: 'antonio' }),
    }) as unknown as typeof fetch;

    const onBackToLogin = vi.fn();
    render(<Verify onBackToLogin={onBackToLogin} />);

    await waitFor(() => expect(screen.getByText(/^verified$/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /back to log in/i }));
    expect(onBackToLogin).toHaveBeenCalled();
  });

  it('renders a link back to the login page', async () => {
    setSearch('?username=antonio&token=abc123');
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'verified', username: 'antonio' }),
    }) as unknown as typeof fetch;

    render(<Verify />);

    await waitFor(() => expect(screen.getByText(/^verified$/i)).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /back to log in/i })).toHaveAttribute('href', '/');
  });
});
