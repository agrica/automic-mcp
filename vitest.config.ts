import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'unit', include: ['tests/**/*.test.ts'], exclude: ['tests/e2e/**'] } },
      { test: { name: 'e2e', include: ['tests/e2e/**/*.test.ts'], testTimeout: 20_000 } },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'lcov'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
