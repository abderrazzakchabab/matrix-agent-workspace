import { defineConfig } from '@playwright/test';

const DEFAULT_PHASE_B_DATABASE_URL =
  'postgresql://matrix_app:matrix_app_password@127.0.0.1:5432/matrix_test';
const DEFAULT_PHASE_B_MIGRATIONS_DATABASE_URL =
  'postgresql://matrix:matrix_test_password@127.0.0.1:5432/matrix_test';

function databaseTarget(value: string, variable: string): {
  host: string;
  name: string;
  username: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variable} must be a PostgreSQL URL`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variable} must be a PostgreSQL URL`);
  }
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!name.endsWith('_test')) {
    throw new Error(`${variable} must target a database ending in _test`);
  }
  return { host: url.host, name, username: decodeURIComponent(url.username) };
}

const hasPhaseBDatabase = process.env.PHASE_B_DATABASE_URL !== undefined;
const hasPhaseBMigrationsDatabase =
  process.env.PHASE_B_MIGRATIONS_DATABASE_URL !== undefined;
if (hasPhaseBDatabase !== hasPhaseBMigrationsDatabase) {
  throw new Error(
    'PHASE_B_DATABASE_URL and PHASE_B_MIGRATIONS_DATABASE_URL must be set together',
  );
}
const phaseBDatabaseUrl =
  process.env.PHASE_B_DATABASE_URL ?? DEFAULT_PHASE_B_DATABASE_URL;
const phaseBMigrationsDatabaseUrl =
  process.env.PHASE_B_MIGRATIONS_DATABASE_URL ??
  DEFAULT_PHASE_B_MIGRATIONS_DATABASE_URL;
const appDatabase = databaseTarget(phaseBDatabaseUrl, 'PHASE_B_DATABASE_URL');
const migrationsDatabase = databaseTarget(
  phaseBMigrationsDatabaseUrl,
  'PHASE_B_MIGRATIONS_DATABASE_URL',
);
if (
  appDatabase.host !== migrationsDatabase.host ||
  appDatabase.name !== migrationsDatabase.name
) {
  throw new Error('Phase B application and migration URLs must target the same test database');
}
if (!appDatabase.username || appDatabase.username === migrationsDatabase.username) {
  throw new Error('Phase B application and migration URLs must use distinct database roles');
}

const fixtureEnv: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  CONTROL_PLANE_URL: process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000',
  PHASE_B_DATABASE_URL: phaseBDatabaseUrl,
  PHASE_B_MIGRATIONS_DATABASE_URL: phaseBMigrationsDatabaseUrl,
  DATABASE_URL: phaseBDatabaseUrl,
  MIGRATIONS_DATABASE_URL: phaseBMigrationsDatabaseUrl,
  SYNAPSE_BASE_URL: process.env.SYNAPSE_BASE_URL ?? 'http://127.0.0.1:8008',
  SYNAPSE_URL: process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008',
  MODEL_FIXTURE_URL: process.env.MODEL_FIXTURE_URL ?? 'http://127.0.0.1:4010',
  GITHUB_FIXTURE_URL: process.env.GITHUB_FIXTURE_URL ?? 'http://127.0.0.1:4020',
  AI_GATEWAY_BASE_URL: process.env.AI_GATEWAY_BASE_URL ?? 'http://127.0.0.1:4010',
  AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? 'fixture-model-key',
  GITHUB_API_URL: process.env.GITHUB_API_URL ?? 'http://127.0.0.1:4020',
  GITHUB_OAUTH_CLIENT_ID: process.env.GITHUB_OAUTH_CLIENT_ID ?? 'phase-b-fixture-client',
  GITHUB_OAUTH_CLIENT_SECRET:
    process.env.GITHUB_OAUTH_CLIENT_SECRET ?? 'phase-b-fixture-client-secret',
  GITHUB_OAUTH_STATE_SECRET:
    process.env.GITHUB_OAUTH_STATE_SECRET ?? 'phase-b-fixture-state-secret',
  GITHUB_OAUTH_CALLBACK_URL:
    process.env.GITHUB_OAUTH_CALLBACK_URL ??
    'http://127.0.0.1:3000/api/github/oauth/callback',
  GITHUB_OAUTH_AUTHORIZE_URL:
    process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? 'http://127.0.0.1:4020/login/oauth/authorize',
  GITHUB_OAUTH_TOKEN_URL:
    process.env.GITHUB_OAUTH_TOKEN_URL ?? 'http://127.0.0.1:4020/login/oauth/access_token',
  GITHUB_OAUTH_SCOPES: process.env.GITHUB_OAUTH_SCOPES ?? 'read:user',
  ENVELOPE_KEY_HEX:
    process.env.ENVELOPE_KEY_HEX ??
    'phase-b-v1:9f6d8ec2e4a98c02f8ac677379f18037330d54f114118a7377367859f36747b5',
  ENVELOPE_KEY_VERSION: process.env.ENVELOPE_KEY_VERSION ?? 'phase-b-v1',
  INNGEST_DEV: process.env.INNGEST_DEV ?? 'http://127.0.0.1:8288',
  INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY ?? 'phase-b-fixture-event-key',
  PHASE_B_FIXTURE_MODE: process.env.PHASE_B_FIXTURE_MODE ?? '1',
  SSE_POLL_INTERVAL_MS: process.env.SSE_POLL_INTERVAL_MS ?? '25',
  SSE_HEARTBEAT_INTERVAL_MS: process.env.SSE_HEARTBEAT_INTERVAL_MS ?? '100',
};

Object.assign(process.env, fixtureEnv);

export default defineConfig({
  testDir: './apps',
  testMatch: '**/*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  workers: 1,
  use: {
    baseURL: fixtureEnv.CONTROL_PLANE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'pnpm --filter @matrix/control-plane exec next dev -H 0.0.0.0',
    url: `${fixtureEnv.CONTROL_PLANE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: fixtureEnv,
  },
});
