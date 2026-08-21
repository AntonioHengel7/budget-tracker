import { useState } from 'react';

type Theme = 'light' | 'dark';

function getInitialTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') {
    return attr;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeToggle(): React.JSX.Element {
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  function handleClick(): void {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    // Persisting to localStorage is best-effort -- a storage failure
    // (blocked storage, private/incognito mode, quota exceeded, a
    // sandboxed iframe) must never prevent the DOM attribute and React
    // state from staying in sync with each other. Those two are the
    // source of truth for "what theme is currently showing"; the
    // localStorage write is just a nice-to-have persistence step.
    try {
      localStorage.setItem('theme', next);
    } catch {
      // ignore -- theme still applies for this session, just won't persist
    }
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button type="button" aria-label={label} onClick={handleClick}>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
