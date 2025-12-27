import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/**',
        'dist/**',
        'test/**',
        '*.config.ts',
        '*.config.js',
        'test-local.mjs',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 85,
        statements: 85,
      },
    },
    testMatch: ['**/test/**/*.test.ts'],
    typecheck: {
      enabled: true,
    },
  },
});
