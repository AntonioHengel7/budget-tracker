import { useEffect, useState } from 'react';
import { ApiError, verify } from '../api.js';

export interface VerifyProps {
  readonly onBackToLogin?: () => void;
}

type VerifyState =
  | { readonly status: 'pending' }
  | { readonly status: 'success'; readonly message: string }
  | { readonly status: 'error'; readonly message: string };

/**
 * Rendered for the `/verify` route (see `App.tsx`'s `isVerifyRoute` check --
 * the server's existing SPA fallback already serves `index.html` for this
 * path, no server routing change needed). Reads `username`/`token` straight
 * off `window.location.search` on mount, since this page is reached from a
 * plain emailed link, not client-side navigation with props.
 */
export function Verify({ onBackToLogin }: VerifyProps): React.JSX.Element {
  const [state, setState] = useState<VerifyState>({ status: 'pending' });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const username = params.get('username');
    const token = params.get('token');

    if (username === null || token === null) {
      setState({ status: 'error', message: 'this verification link is missing required information' });
      return;
    }

    verify(username, token)
      .then((body) => setState({ status: 'success', message: body.message }))
      .catch((err) => {
        const message =
          err instanceof ApiError && err.message !== ''
            ? err.message
            : 'could not verify your account, try again';
        setState({ status: 'error', message });
      });
  }, []);

  return (
    <div className="login-page">
      <h1>Verify your account</h1>
      {state.status === 'pending' ? <p>Verifying…</p> : null}
      {state.status === 'success' ? <p>{state.message}</p> : null}
      {state.status === 'error' ? <div role="alert">{state.message}</div> : null}
      {state.status !== 'pending' ? (
        <p className="auth-switch">
          {onBackToLogin !== undefined ? (
            <button type="button" className="link-button" onClick={onBackToLogin}>
              Back to log in
            </button>
          ) : (
            <a href="/">Back to log in</a>
          )}
        </p>
      ) : null}
    </div>
  );
}
