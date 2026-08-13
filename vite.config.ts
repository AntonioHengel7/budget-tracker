import { defineConfig } from 'vitest/config';

// Filename is load-bearing: coverage-gate.sh's detect_language() globs for
// `vite.config.*` specifically — `vitest.config.ts` will not be detected.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // Must stay identical to .jome/coverage.json's `core` array — the coverage
      // gate's live-run path reads the whole-report total, not filtered by `core`,
      // so this `include` is what actually scopes the number. Guarded by
      // tests/config/coverage-scope.test.ts.
      include: ['src/domain/**/*.ts'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
    },
  },
});
