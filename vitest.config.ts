import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
  },
});
