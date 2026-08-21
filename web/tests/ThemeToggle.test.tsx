import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeToggle } from '../src/ThemeToggle.js';

function mockMatchMedia(prefersDark: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia(false);
  });

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    localStorage.clear();
  });

  it('renders with an accessible name reflecting the current (light) state', () => {
    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: /switch to dark theme/i })).toBeInTheDocument();
  });

  it('clicking toggles data-theme on document.documentElement', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('clicking persists the new value to localStorage', () => {
    render(<ThemeToggle />);

    fireEvent.click(screen.getByRole('button'));
    expect(localStorage.getItem('theme')).toBe('dark');

    fireEvent.click(screen.getByRole('button'));
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('on mount, respects an existing localStorage value over OS preference', () => {
    // The inline head script in index.html reads localStorage and sets the
    // data-theme attribute before React ever mounts; ThemeToggle then reads
    // that attribute. This reproduces both steps.
    mockMatchMedia(true);
    localStorage.setItem('theme', 'light');
    document.documentElement.setAttribute('data-theme', localStorage.getItem('theme') ?? '');

    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: /switch to dark theme/i })).toBeInTheDocument();
  });

  it('falls back to OS preference when no data-theme attribute is set', () => {
    mockMatchMedia(true);

    render(<ThemeToggle />);

    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeInTheDocument();
  });
});
