import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, login, startDemo } from '../api.js';

export interface LoginProps {
  readonly onLoggedIn: (username: string) => void;
  /** Optional so every existing caller (e.g. tests rendering <Login> alone) keeps working unchanged. */
  readonly onSwitchToSignup?: () => void;
}

export function Login({ onLoggedIn, onSwitchToSignup }: LoginProps): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [demoPending, setDemoPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    try {
      const body = await login(username, password);
      onLoggedIn(body.username);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('too many login attempts -- try again in a few minutes');
      } else {
        // Covers 401s, any other non-2xx status, and network failures (fetch
        // rejecting outright), all of which are indistinguishable from the
        // user's point of view: something about this attempt didn't work.
        setError('invalid username or password');
      }
    }
  }

  async function handleDemo(): Promise<void> {
    setError(null);
    setDemoPending(true);
    try {
      const body = await startDemo();
      onLoggedIn(body.username);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'too many demo requests -- try again in a bit'
          : 'could not start the demo, try again',
      );
    } finally {
      setDemoPending(false);
    }
  }

  return (
    <div className="login-page">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <h1>Log in</h1>
        <label htmlFor="login-username">Username</label>
        <input
          id="login-username"
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
        />
        <label htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        {error !== null ? <div role="alert">{error}</div> : null}
        <button type="submit">Log in</button>
      </form>
      {onSwitchToSignup !== undefined ? (
        <p className="auth-switch">
          Don&apos;t have an account?{' '}
          <button type="button" className="link-button" onClick={onSwitchToSignup}>
            Sign up
          </button>
        </p>
      ) : null}
      <div className="login-divider">
        <span>or</span>
      </div>
      <button
        type="button"
        className="demo-button"
        disabled={demoPending}
        onClick={() => void handleDemo()}
      >
        {demoPending ? 'Starting demo…' : 'Try it out — sample data, no signup'}
      </button>
    </div>
  );
}
