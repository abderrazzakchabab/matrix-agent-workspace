/**
 * Task 12 approval-driven GitHub collaboration workspace e2e.
 *
 * Runs against the write-enabled GitHub fixture (POST/PATCH routes in
 * tests/fixtures/github/wiremock.json) with the Phase A mobile fixture
 * browser session. The base playwright.config.ts `testMatch` only covers
 * `*.spec.ts`; Task 13 owns the committed config wiring, so until then this
 * spec is executed with a testMatch override:
 *
 *   EXPO_PUBLIC_GITHUB_INSTALLATION_ID=42 pnpm exec playwright test \
 *     apps/mobile/test/screens/github-workspace.e2e.tsx --config <task12 config>
 */
import { expect, test } from '@playwright/test';
import {
  approvePhaseCWriteGrant,
  resetPhaseAMobileDatabase,
  seedPhaseAMobileSpecialists,
  seedPhaseCGithubInstallation,
} from '../../../control-plane/test/e2e/phase-a-mobile-fixture';

const MOBILE_WEB_URL = process.env.MOBILE_WEB_URL ?? 'http://localhost:19006';
const SYNAPSE_URL = process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008';
const MODEL_FIXTURE_URL = process.env.MODEL_FIXTURE_URL ?? 'http://127.0.0.1:4010';
const GITHUB_FIXTURE_URL = process.env.GITHUB_FIXTURE_URL ?? 'http://127.0.0.1:4020';

interface GithubMutationRequest {
  method: string;
  path: string;
  authorizationClass: string;
}

function assertIsolatedTestDatabase(): void {
  const appValue = process.env.DATABASE_URL;
  const migrationsValue = process.env.MIGRATIONS_DATABASE_URL;
  if (!appValue || !migrationsValue) {
    throw new Error('Task 12 destructive setup requires explicit test database URLs');
  }
  const app = new URL(appValue);
  const migrations = new URL(migrationsValue);
  const appName = decodeURIComponent(app.pathname.replace(/^\/+/, ''));
  const migrationsName = decodeURIComponent(migrations.pathname.replace(/^\/+/, ''));
  if (
    !appName.endsWith('_test')
    || appName !== migrationsName
    || app.host !== migrations.host
    || !app.username
    || app.username === migrations.username
  ) {
    throw new Error('Task 12 destructive setup requires one isolated _test database');
  }
}

async function synapseLogin(): Promise<string> {
  const response = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'alice' },
      password: 'alice_secret',
    }),
  });
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { access_token: string }).access_token;
}

async function resolveAliceRoom(): Promise<string> {
  const response = await fetch(
    `${SYNAPSE_URL}/_matrix/client/v3/directory/room/${encodeURIComponent('#alice:example.test')}`,
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { room_id: string }).room_id;
}

async function approveWriteGrant(workspaceId: string): Promise<void> {
  expect(await approvePhaseCWriteGrant(workspaceId, 'acme/widget', 'issues:write')).toBe(1);
}

async function githubMutationRequests(): Promise<GithubMutationRequest[]> {
  const response = await fetch(`${GITHUB_FIXTURE_URL}/__fixture/state`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { mutationRequests: GithubMutationRequest[] }).mutationRequests;
}

async function githubMutationBodies(): Promise<Array<{ body: { title?: string } }>> {
  const response = await fetch(`${GITHUB_FIXTURE_URL}/__fixture/state`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { mutationBodies: Array<{ body: { title?: string } }> })
    .mutationBodies;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  assertIsolatedTestDatabase();
  await resetPhaseAMobileDatabase();
  for (const url of [MODEL_FIXTURE_URL, GITHUB_FIXTURE_URL]) {
    const response = await fetch(`${url}/__fixture/reset`, { method: 'POST' });
    expect(response.ok, await response.text()).toBe(true);
  }
});

test('GitHub workspace gates mutations behind grant, exact approval, and idempotency', async ({
  page,
}) => {
  const aliceToken = await synapseLogin();
  const roomId = await resolveAliceRoom();

  await page.goto(MOBILE_WEB_URL);
  await page.getByLabel('Homeserver URL').fill(SYNAPSE_URL);
  await page.getByLabel('Matrix access token').fill(aliceToken);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const workspaceResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/workspaces'
  ));
  await page.getByLabel('Workspace name').fill('Phase C Workspace');
  await page.getByRole('button', { name: 'Create and select workspace' }).click();
  const workspaceResponse = await workspaceResponsePromise;
  expect(workspaceResponse.status(), await workspaceResponse.text()).toBe(201);
  const { workspaceId } = (await workspaceResponse.json()) as { workspaceId: string };
  await seedPhaseAMobileSpecialists(workspaceId);
  await seedPhaseCGithubInstallation(workspaceId);

  await page.getByRole('button', { name: `Select room ${roomId}` }).click();
  await page.getByRole('button', { name: 'Bind room' }).click();
  await expect(page.getByLabel('Run prompt')).toBeVisible();

  // A run is required: approvals are bound to an exact run in the workspace.
  await page.getByLabel('Run prompt').fill('phase-c-workspace summarize repository activity');
  await page.getByRole('checkbox', { name: 'Repository reader' }).click();
  await page.getByRole('radio', { name: 'Parallel' }).click();
  const runResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/api\/workspaces\/[^/]+\/runs$/.test(new URL(response.url()).pathname)
  ));
  await page.getByRole('button', { name: 'Start run' }).click();
  const runResponse = await runResponsePromise;
  expect(runResponse.status(), await runResponse.text()).toBe(202);
  await expect(page.getByText('Live progress')).toBeVisible();

  // Open the collaboration workspace from the run.
  await page.getByRole('button', { name: 'GitHub workspace' }).click();
  await expect(page.getByText('acme/widget')).toBeVisible();
  await expect(page.getByText('Issue #6')).toBeVisible();
  await expect(page.getByText('Issue #7')).toBeVisible();
  await expect(page.getByText('Pull request #11')).toBeVisible();

  // No mutation control exists until a separate write grant is requested.
  await expect(page.getByLabel('Issue title')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm create issue' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Request write access' }).click();
  await expect(page.getByText('acme/widget · issues:write').first()).toBeVisible();

  // The grant is only pending: an explicit confirmation is recorded, but the
  // write gate blocks the mutation before GitHub is ever called.
  await page.getByLabel('Issue title').fill('E2E approval-gated issue');
  await page.getByLabel('Issue body').fill('Created through the approval-driven workspace');
  await page.getByRole('button', { name: 'Review create issue' }).click();
  await expect(
    page.getByText('I confirm create issue on acme/widget (issues:write)'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm create issue' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Mutation denied/i })).toBeVisible();
  expect(await githubMutationRequests()).toHaveLength(0);

  // Approving the grant (workspace administration, not the UI) unblocks the
  // exact same command; the retry reuses the same idempotency key.
  await approveWriteGrant(workspaceId);
  await page.getByRole('button', { name: 'Confirm create issue' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Mutation completed/i })).toBeVisible();
  await expect.poll(async () => (await githubMutationRequests()).length).toBe(1);
  const [mutation] = await githubMutationRequests();
  expect(mutation).toMatchObject({ method: 'POST', path: '/repos/acme/widget/issues' });
  expect((await githubMutationBodies())[0]?.body.title).toBe('E2E approval-gated issue');

  // Retrying with the same idempotency key replays the recorded command
  // without a second provider mutation.
  await page.getByRole('button', { name: 'Verify recorded result' }).click();
  await expect(page.getByRole('status').filter({ hasText: /already submitted/i })).toBeVisible();
  expect(await githubMutationRequests()).toHaveLength(1);

  // The redacted audit trail is visible and never contains tokens.
  await expect(page.getByText('Audit history')).toBeVisible();
  const auditList = page.getByRole('list', { name: 'Audit records' });
  await expect(auditList.getByText('grant_requested', { exact: true })).toBeVisible();
  await expect(auditList.getByText('denied', { exact: true })).toBeVisible();
  await expect(auditList.getByText('queued', { exact: true })).toBeVisible();
  await expect(auditList.getByText('completed', { exact: true })).toBeVisible();
  const content = await page.content();
  expect(content).not.toMatch(/ghp_|ghs_|gho_/);
});
