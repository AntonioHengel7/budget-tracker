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
    // The UI must drop into the logged-out state regardless of whether the
    // server call succeeds -- a failed POST /api/logout (network error, etc.)
    // should not leave the user stuck in the logged-in shell with a
    // non-functional Log out button. Worst case the session cookie lingers
    // server-side until its TTL, which is an accepted pre-existing tradeoff.
    try {
      await logout();
    } catch {
      // logout is best-effort -- always land on logged-out UI state
    } finally {
      setAuth({ status: 'loggedOut' });
    }
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
