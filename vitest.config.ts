import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // Integration tests share one Postgres/Synapse fixture and reset shared
    // tables; run files sequentially to avoid cross-file interference.
    fileParallelism: false,
  },
});
