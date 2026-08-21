import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Node 22+ ships its own global `localStorage` (behind the
// --localstorage-file flag; unset, every access resolves to `undefined`
// rather than a working Storage object). vitest's jsdom environment refuses
// to clobber a global that already exists, so jsdom's real, working
// localStorage never gets installed -- `window.localStorage` silently stays
// bound to Node's non-functional one. Replace it with a small in-memory
// Storage polyfill so tests (e.g. ThemeToggle, issue #72) can rely on it.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const memoryStorage = new MemoryStorage();
for (const target of [globalThis, window]) {
  Object.defineProperty(target, 'localStorage', {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
}

// jsdom does not implement matchMedia. ThemeToggle (issue #72) reads it on
// mount to fall back to the OS color-scheme preference, so any test that
// renders it (directly or via App/Login) needs this stubbed. Individual
// tests may override this with their own vi.fn() when they need to assert
// on a specific prefers-color-scheme value.
if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  cleanup();
  memoryStorage.clear();
});
