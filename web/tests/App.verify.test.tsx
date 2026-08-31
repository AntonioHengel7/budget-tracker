import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';

describe('App /verify route (#104)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
  });

  it('renders Verify at /verify unconditionally, regardless of the /api/me auth check outcome', async () => {
    window.history.pushState({}, '', '/verify?username=antonio&token=abc123');
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/verify')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ message: 'verified', username: 'antonio' }),
        });
      }
      if (url.includes('/api/me')) {
        // Even a *logged-in* /api/me result must not steer this route away
        // from Verify -- it's rendered unconditionally ahead of every
        // auth.status branch.
        return Promise.resolve({ ok: true, json: async () => ({ username: 'antonio' }) });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(<App />);

    await waitFor(() => expect(screen.getByText(/^verified$/i)).toBeInTheDocument());
    // Never falls through to the authenticated dashboard shell.
    expect(screen.queryByRole('button', { name: /log out/i })).not.toBeInTheDocument();
  });

  it('switching to signup mode from the logged-out login screen renders the Signup form', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/me')) {
        return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'authentication required' }) });
      }
      return Promise.reject(new Error(`unexpected fetch to ${url}`));
    }) as unknown as typeof fetch;

    render(<App />);

    const switchToSignup = await screen.findByRole('button', { name: /sign up/i });
    fireEvent.click(switchToSignup);

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();

    // ... and switching back from Signup's own "Log in" link returns to the
    // Login form -- exercises both directions of the login/signup toggle.
    const switchToLogin = await screen.findByRole('button', { name: /log in/i });
    fireEvent.click(switchToLogin);

    expect(await screen.findByLabelText(/^username$/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });
});
