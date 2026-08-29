import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, signup } from '../api.js';

export interface SignupProps {
  readonly onSwitchToLogin?: () => void;
}

/**
 * Self-service signup form (#104). Deliberately does not auto-login on
 * success -- the account isn't usable until its email is verified (see
 * `Verify.tsx`), so a successful submit just shows the "check your email"
 * message the API returns, matching `POST /api/signup`'s identical response
 * shape for every success path (new signup, resend, silent-duplicate-email).
 */
export function Signup({ onSwitchToLogin }: SignupProps): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setPending(true);

    try {
      const body = await signup(username, email, password);
      setMessage(body.message);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('too many signup attempts -- try again in a bit');
      } else if (err instanceof ApiError && typeof err.message === 'string' && err.message !== '') {
        // Signup errors (invalid username, weak password, username taken,
        // ...) are validation-shaped and safe to show verbatim, unlike
        // Login's deliberately generic "invalid username or password".
        setError(err.message);
      } else {
        setError('could not sign up, try again');
      }
    } finally {
      setPending(false);
    }
  }

  if (message !== null) {
    return (
      <div className="login-page">
        <h1>Check your email</h1>
        <p>{message}</p>
        {onSwitchToLogin !== undefined ? (
          <p className="auth-switch">
            <button type="button" className="link-button" onClick={onSwitchToLogin}>
              Back to log in
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="login-page">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h1>Sign up</h1>
        <label htmlFor="signup-username">Username</label>
        <input
          id="signup-username"
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
        />
        <label htmlFor="signup-email">Email</label>
        <input
          id="signup-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
        />
        <label htmlFor="signup-password">Password</label>
        <input
          id="signup-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
        {error !== null ? <div role="alert">{error}</div> : null}
        <button type="submit" disabled={pending}>
          {pending ? 'Signing up…' : 'Sign up'}
        </button>
      </form>
      {onSwitchToLogin !== undefined ? (
        <p className="auth-switch">
          Already have an account?{' '}
          <button type="button" className="link-button" onClick={onSwitchToLogin}>
            Log in
          </button>
        </p>
      ) : null}
    </div>
  );
}
