import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, login } from '../api.js';

export interface LoginProps {
  readonly onLoggedIn: (username: string) => void;
}

export function Login({ onLoggedIn }: LoginProps): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

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

  return (
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
  );
}
