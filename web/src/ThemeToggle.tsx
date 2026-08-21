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
    localStorage.setItem('theme', next);
    setTheme(next);
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button type="button" aria-label={label} onClick={handleClick}>
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
