import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './apps',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  use: {
    baseURL: process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm --filter @matrix/control-plane dev',
        port: 3000,
        reuseExistingServer: !process.env.CI,
      },
});
