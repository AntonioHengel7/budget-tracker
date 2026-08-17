import { useState } from 'react';
import type { FormEvent } from 'react';

export interface LoginProps {
  readonly onLoggedIn: (username: string) => void;
}

/**
 * Calls `/api/login` directly (rather than going through `api.ts`'s `login`)
 * because a failed response here must never call `res.json()` -- the frozen
 * test's failure-path mock (`{ ok: false }`) has no `json` method, matching
 * a real 401 response that this component treats as "show a generic invalid
 * credentials message", not "parse the error body".
 */
export function Login({ onLoggedIn }: LoginProps): React.JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);

    const res = await fetch('/api/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      setError('invalid username or password');
      return;
    }

    const body = (await res.json()) as { username: string };
    onLoggedIn(body.username);
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
