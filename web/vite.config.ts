import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ['tests/**/*.test.tsx', 'tests/**/*.test.ts'],
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      // main.tsx is a pure entry point (createRoot().render()) with no
      // branching logic — excluded as not meaningfully testable.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/main.tsx'],
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      reportOnFailure: true,
      // Floor set at the current measured baseline (statements/lines 57.51%,
      // branches 46.98%, functions 50.87%), rounded down for headroom. This
      // is a regression gate, not an aspirational target — src/pages/
      // Transactions.tsx and Dashboard.tsx are largely untested today; raise
      // these thresholds as coverage for those improves.
      thresholds: {
        statements: 55,
        branches: 45,
        functions: 48,
        lines: 55,
      },
    },
  },
});
