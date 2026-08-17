import { useEffect, useState } from 'react';
import { logout, me } from './api.js';
import { Login } from './pages/Login.js';
import { Dashboard } from './pages/Dashboard.js';
import { Transactions } from './pages/Transactions.js';
import { Limits } from './pages/Limits.js';

type View = 'dashboard' | 'transactions' | 'limits';
type AuthState = { readonly status: 'checking' } | { readonly status: 'loggedOut' } | {
  readonly status: 'loggedIn';
  readonly username: string;
};

export function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [view, setView] = useState<View>('dashboard');

  useEffect(() => {
    me()
      .then((result) => setAuth({ status: 'loggedIn', username: result.username }))
      .catch(() => setAuth({ status: 'loggedOut' }));
  }, []);

  function handleLoggedIn(username: string): void {
    setAuth({ status: 'loggedIn', username });
  }

  async function handleLogout(): Promise<void> {
    await logout();
    setAuth({ status: 'loggedOut' });
  }

  if (auth.status === 'checking') {
    return <p>Loading...</p>;
  }

  if (auth.status === 'loggedOut') {
    return <Login onLoggedIn={handleLoggedIn} />;
  }

  return (
    <div>
      <nav>
        <button type="button" aria-current={view === 'dashboard'} onClick={() => setView('dashboard')}>
          Dashboard
        </button>
        <button
          type="button"
          aria-current={view === 'transactions'}
          onClick={() => setView('transactions')}
        >
          Transactions
        </button>
        <button type="button" aria-current={view === 'limits'} onClick={() => setView('limits')}>
          Limits
        </button>
        <span style={{ marginLeft: 'auto' }}>
          {auth.username} · <button type="button" onClick={() => void handleLogout()}>Log out</button>
        </span>
      </nav>

      {view === 'dashboard' ? <Dashboard /> : null}
      {view === 'transactions' ? <Transactions /> : null}
      {view === 'limits' ? <Limits /> : null}
    </div>
  );
}
