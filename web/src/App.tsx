import { useEffect, useState } from 'react';
import { logout, me } from './api.js';
import { Login } from './pages/Login.js';
import { Signup } from './pages/Signup.js';
import { Verify } from './pages/Verify.js';
import { Dashboard } from './pages/Dashboard.js';
import { Transactions } from './pages/Transactions.js';
import { Limits } from './pages/Limits.js';
import { ThemeToggle } from './ThemeToggle.js';

type View = 'dashboard' | 'transactions' | 'limits';
type AuthMode = 'login' | 'signup';
type AuthState = { readonly status: 'checking' } | { readonly status: 'loggedOut' } | {
  readonly status: 'loggedIn';
  readonly username: string;
};

export function App(): React.JSX.Element {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const [view, setView] = useState<View>('dashboard');
  const [mode, setMode] = useState<AuthMode>('login');

  useEffect(() => {
    me()
      .then((result) => setAuth({ status: 'loggedIn', username: result.username }))
      .catch(() => setAuth({ status: 'loggedOut' }));
  }, []);

  function handleLoggedIn(username: string): void {
    setAuth({ status: 'loggedIn', username });
  }

  // #104: the server's existing SPA fallback already serves index.html for
  // any non-/api path, including /verify -- no server routing change is
  // needed. Rendered unconditionally, ahead of every auth.status branch
  // below, since a verification link can be clicked whether or not the
  // browser happens to already hold an unrelated logged-in session.
  const isVerifyRoute = window.location.pathname === '/verify';
  if (isVerifyRoute) {
    return (
      <div className="pre-auth-shell">
        <div className="theme-toggle-corner">
          <ThemeToggle />
        </div>
        <Verify />
      </div>
    );
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
    return (
      <div className="pre-auth-shell">
        <div className="theme-toggle-corner">
          <ThemeToggle />
        </div>
        {mode === 'login' ? (
          <Login onLoggedIn={handleLoggedIn} onSwitchToSignup={() => setMode('signup')} />
        ) : (
          <Signup onSwitchToLogin={() => setMode('login')} />
        )}
      </div>
    );
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
        <ThemeToggle />
        <span className="nav-user">
          {auth.username} · <button type="button" onClick={() => void handleLogout()}>Log out</button>
        </span>
      </nav>

      {view === 'dashboard' ? <Dashboard /> : null}
      {view === 'transactions' ? <Transactions /> : null}
      {view === 'limits' ? <Limits /> : null}
    </div>
  );
}
