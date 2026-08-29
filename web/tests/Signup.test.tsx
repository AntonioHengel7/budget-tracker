import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Signup } from '../src/pages/Signup.js';

describe('Signup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('submits username/email/password to POST /api/signup and shows the returned message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'check your email to verify your account' }),
    }) as unknown as typeof fetch;

    render(<Signup />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'antonio@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'longenoughpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() =>
      expect(screen.getByText(/check your email to verify your account/i)).toBeInTheDocument(),
    );
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/signup',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          username: 'antonio',
          email: 'antonio@example.com',
          password: 'longenoughpassword',
        }),
      }),
    );

    // No login form remains -- signup does not auto-login (the account
    // isn't usable until verified).
    expect(screen.queryByLabelText(/^username$/i)).not.toBeInTheDocument();
  });

  it('does not auto-navigate anywhere on success -- it just shows the check-your-email message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'check your email to verify your account' }),
    }) as unknown as typeof fetch;

    render(<Signup />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'antonio@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'longenoughpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    await waitFor(() =>
      expect(screen.getByText(/check your email to verify your account/i)).toBeInTheDocument(),
    );
    // No login/dashboard chrome ever appeared -- the success view is the
    // only thing rendered.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('renders a "Log in" switch link when onSwitchToLogin is provided, and calls it on click', () => {
    const onSwitchToLogin = vi.fn();
    render(<Signup onSwitchToLogin={onSwitchToLogin} />);

    fireEvent.click(screen.getByRole('button', { name: /log in/i }));
    expect(onSwitchToLogin).toHaveBeenCalled();
  });

  it('omits the switch link entirely when onSwitchToLogin is not provided', () => {
    render(<Signup />);
    expect(screen.queryByRole('button', { name: /log in/i })).not.toBeInTheDocument();
  });

  it('renders a working "Back to log in" link on the success view too, when onSwitchToLogin is provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: 'check your email to verify your account' }),
    }) as unknown as typeof fetch;

    const onSwitchToLogin = vi.fn();
    render(<Signup onSwitchToLogin={onSwitchToLogin} />);

    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'antonio' } });
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'antonio@example.com' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'longenoughpassword' } });
    fireEvent.click(screen.getByRole('button', { name: /sign up/i }));

    const backToLogin = await screen.findByRole('button', { name: /back to log in/i });
    fireEvent.click(backToLogin);
    expect(onSwitchToLogin).toHaveBeenCalled();
  });
});
