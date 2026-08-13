import { defineConfig } from 'vitest/config';

// Test-only AES-256-GCM envelope key. The production default session cipher
// reads ENVELOPE_KEY_HEX from the environment; tests run without a .env file,
// so a deterministic key is injected here (never a production secret).
const TEST_ENVELOPE_KEY_HEX = '1:' + 'a3'.repeat(32);

export default defineConfig({
  resolve: {
    // Mobile component tests run against React Native Web's standards-based
    // accessibility output while the Expo app keeps native runtime imports.
    alias: { 'react-native': 'react-native-web' },
  },
  test: {
    globals: false,
    include: [
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      'packages/*/test/**/*.test.ts',
    ],
    // Integration tests share one Postgres/Synapse fixture and reset shared
    // tables; run files sequentially to avoid cross-file interference.
    fileParallelism: false,
    env: {
      ENVELOPE_KEY_HEX: TEST_ENVELOPE_KEY_HEX,
      ENVELOPE_KEY_VERSION: '1',
    },
  },
});
