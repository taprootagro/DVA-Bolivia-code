import { defineConfig } from 'vitest/config';
import { resolve } from 'path';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // jsdom simulates a browser environment for component/hook tests
    environment: 'jsdom',
    // Global test helpers (describe, it, expect, vi, etc.)
    globals: true,
    // Setup file that runs before every test file
    setupFiles: ['./src/test-setup.ts'],
    // Path aliases mirroring vite.config.ts
    alias: {
      '@': resolve(__dirname, './src'),
      '/taprootagrosetting': resolve(__dirname, './taprootagrosetting'),
    },
    // Include only test files matching these patterns
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Coverage configuration (run with vitest --coverage)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.spec.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test-setup.ts',
        'src/app/components/ui/**', // shadcn/ui boilerplate — low test value
      ],
      thresholds: {
        // Target thresholds (aspirational, not enforced initially)
        statements: 40,
        branches: 30,
        functions: 35,
        lines: 40,
      },
    },
  },
});
