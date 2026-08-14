import { expect, test, type Page } from '@playwright/test';
import {
  resetPhaseAMobileDatabase,
  seedPhaseAMobileSpecialists,
} from '../../../control-plane/test/e2e/phase-a-mobile-fixture';

const MOBILE_WEB_URL = process.env.MOBILE_WEB_URL ?? 'http://localhost:19006';
const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://localhost:3000';
const SYNAPSE_URL = process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008';
const MODEL_FIXTURE_URL = process.env.MODEL_FIXTURE_URL ?? 'http://127.0.0.1:4010';
const GITHUB_FIXTURE_URL = process.env.GITHUB_FIXTURE_URL ?? 'http://127.0.0.1:4020';

interface RunLaunchResponse {
  runId: string;
  status: string;
}

interface ModelFixtureCall {
  specialistId: string;
  prompt: string;
  startedAt: number;
  finishedAt: number;
  status: number;
}

interface MatrixMessage {
  type?: string;
  content?: { body?: string };
}

function assertIsolatedTestDatabase(): void {
  const appValue = process.env.DATABASE_URL;
  const migrationsValue = process.env.MIGRATIONS_DATABASE_URL;
  if (!appValue || !migrationsValue) {
    throw new Error('Phase A destructive setup requires explicit test database URLs');
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
    throw new Error('Phase A destructive setup requires one isolated _test database');
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

async function timelineLabels(page: Page): Promise<string[]> {
  return page
    .getByRole('list')
    .getByRole('listitem')
    .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label') ?? ''));
}

function sequences(labels: string[]): number[] {
  return labels.map((label) => {
    const match = /^Sequence (\d+),/.exec(label);
    if (!match) throw new Error(`timeline row has no sequence label: ${label}`);
    return Number(match[1]);
  });
}

async function returnToComposer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Start another run' }).click();
  await expect(page.getByLabel('Run prompt')).toBeVisible();
}

async function launchRun(
  page: Page,
  options: { prompt: string; mode: 'Parallel' | 'Sequential' },
): Promise<RunLaunchResponse> {
  await page.getByLabel('Run prompt').fill(options.prompt);
  for (const specialist of ['Repository reader', 'Issue reader']) {
    const checkbox = page.getByRole('checkbox', { name: specialist });
    if (!(await checkbox.textContent())?.includes('✓')) await checkbox.click();
  }
  await page.getByRole('radio', { name: options.mode }).click();
  const startButton = page.getByRole('button', { name: 'Start run' });
  const composerState = {
    prompt: await page.getByLabel('Run prompt').inputValue(),
    selectedSpecialists: await page.getByText('✓').count(),
    boundDestination: await page.getByText('Bound destination').count(),
  };
  await expect(startButton, JSON.stringify(composerState)).toBeEnabled();
  const responsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && /\/api\/workspaces\/[^/]+\/runs$/.test(new URL(response.url()).pathname)
  ));
  await startButton.click();
  const response = await responsePromise;
  const text = await response.text();
  expect(response.status(), text).toBe(202);
  const run = JSON.parse(text) as RunLaunchResponse;
  await expect(page.getByText('Live progress')).toBeVisible();
  await expect(page.getByText(`Run ${run.runId}`)).toBeVisible();
  return run;
}

async function runMatrixMessages(
  accessToken: string,
  roomId: string,
  runId: string,
): Promise<string[]> {
  const response = await fetch(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=250`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { chunk: MatrixMessage[] }).chunk
    .filter((event) => event.type === 'm.room.message')
    .map((event) => event.content?.body ?? '')
    .filter((body) => body.includes(runId));
}

async function modelCalls(promptMarker: string): Promise<ModelFixtureCall[]> {
  const response = await fetch(`${MODEL_FIXTURE_URL}/__fixture/state`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  const state = JSON.parse(text) as { calls: ModelFixtureCall[] };
  return state.calls.filter((call) => call.prompt.includes(promptMarker));
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

test('Phase A mobile client authenticates, binds, replays, orders, fails safely, and cancels', async ({ page }) => {
  const aliceToken = await synapseLogin();
  const roomId = await resolveAliceRoom();
  const sseRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  page.on('request', (request) => {
    if (request.method() === 'GET' && /\/api\/runs\/[^/]+\/events/.test(request.url())) {
      sseRequests.push({ url: request.url(), headers: request.headers() });
    }
  });

  await page.goto(MOBILE_WEB_URL);
  await expect(page.getByText('Connect your Matrix account')).toBeVisible();
  await page.getByLabel('Homeserver URL').fill(SYNAPSE_URL);
  await page.getByLabel('Matrix access token').fill(aliceToken);
  const sessionResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/auth/matrix/session'
  ));
  await page.getByRole('button', { name: 'Sign in' }).click();
  const sessionResponse = await sessionResponsePromise;
  const sessionBody = await sessionResponse.text();
  expect(sessionResponse.status(), sessionBody).toBe(200);
  expect(JSON.parse(sessionBody)).toMatchObject({ user: { id: '@alice:example.test' } });

  const workspaceResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/api/workspaces'
  ));
  await page.getByLabel('Workspace name').fill('Phase A Mobile Acceptance');
  await page.getByRole('button', { name: 'Create and select workspace' }).click();
  const workspaceResponse = await workspaceResponsePromise;
  const workspaceBody = await workspaceResponse.text();
  expect(workspaceResponse.status(), workspaceBody).toBe(201);
  const { workspaceId } = JSON.parse(workspaceBody) as { workspaceId: string };
  await seedPhaseAMobileSpecialists(workspaceId);
  await expect(page.getByLabel(`Selected workspace Phase A Mobile Acceptance, ${workspaceId}`)).toBeVisible();

  await page.getByRole('button', { name: `Select room ${roomId}` }).click();
  const bindingResponsePromise = page.waitForResponse((response) => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname.includes('/api/rooms/')
    && new URL(response.url()).pathname.endsWith('/binding')
  ));
  await page.getByRole('button', { name: 'Bind room' }).click();
  const bindingResponse = await bindingResponsePromise;
  const bindingBody = await bindingResponse.text();
  expect(bindingResponse.status(), bindingBody).toBe(201);
  expect(JSON.parse(bindingBody)).toMatchObject({ roomId, workspaceId });
  await expect(page.getByLabel('Run prompt')).toBeVisible();

  // Parallel mode exposes per-specialist progress and survives a real client-side SSE drop.
  const parallel = await launchRun(page, {
    prompt: 'phase-a-parallel [fixture:slow] summarize repository activity',
    mode: 'Parallel',
  });
  await expect.poll(async () => (await timelineLabels(page)).length).toBeGreaterThanOrEqual(2);
  const reconnectControl = await page.evaluate(() => {
    const controls = (globalThis as typeof globalThis & {
      __phaseAMobileTest?: { forceSseDisconnect(): number | null };
    }).__phaseAMobileTest;
    return {
      available: controls !== undefined,
      savedSequence: controls?.forceSseDisconnect() ?? null,
    };
  });
  expect(reconnectControl.available).toBe(true);
  expect(reconnectControl.savedSequence).not.toBeNull();
  const savedSequence = reconnectControl.savedSequence!;
  expect(savedSequence).toBeGreaterThan(0);
  await expect.poll(() => sseRequests.filter((request) => request.url.includes(parallel.runId)).length)
    .toBeGreaterThanOrEqual(2);
  const parallelSse = sseRequests.filter((request) => request.url.includes(parallel.runId));
  const reconnect = parallelSse.at(-1)!;
  expect(new URL(reconnect.url).searchParams.get('after')).toBe(String(savedSequence));
  expect(reconnect.headers['last-event-id']).toBe(String(savedSequence));

  await expect(page.getByRole('status', { name: 'Run Completed' })).toHaveCount(1, { timeout: 60_000 });
  await expect.poll(async () => (
    (await runMatrixMessages(aliceToken, roomId, parallel.runId))
      .filter((body) => /Run (completed|failed|partially completed|cancelled)/.test(body))
  )).toHaveLength(1);
  expect(await runMatrixMessages(aliceToken, roomId, parallel.runId)).toEqual(
    expect.arrayContaining([expect.stringContaining('specialist.completed')]),
  );
  const parallelLabels = await timelineLabels(page);
  const parallelSequences = sequences(parallelLabels);
  expect(parallelSequences).toEqual(
    Array.from({ length: parallelSequences.length }, (_, index) => index + 1),
  );
  expect(new Set(parallelSequences).size).toBe(parallelSequences.length);
  expect(parallelLabels).toEqual(expect.arrayContaining([
    expect.stringMatching(/Repository reader, Running$/),
    expect.stringMatching(/Repository reader, Succeeded$/),
    expect.stringMatching(/Issue reader, Running$/),
    expect.stringMatching(/Issue reader, Succeeded$/),
  ]));
  const terminalSequence = Number(
    /^Sequence (\d+),/.exec(parallelLabels.find((label) => label.includes('Run completed')) ?? '')?.[1],
  );
  expect(terminalSequence).toBeGreaterThan(0);
  await expect(page.getByLabel(`Sequence ${terminalSequence} delivered to Matrix`)).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('status', { name: 'Run Completed' })).toHaveCount(1);
  const parallelCalls = await modelCalls('phase-a-parallel');
  expect(parallelCalls).toHaveLength(2);
  expect(Math.max(...parallelCalls.map((call) => call.startedAt))).toBeLessThan(
    Math.min(...parallelCalls.map((call) => call.finishedAt)),
  );

  // The existing deterministic provider failure remains visible as partial, never completed.
  await returnToComposer(page);
  await launchRun(page, {
    prompt: 'phase-a-partial [fixture:fail-issue] summarize repository activity',
    mode: 'Parallel',
  });
  await expect(page.getByRole('status', { name: 'Run Partially completed' })).toHaveCount(1, { timeout: 60_000 });
  expect(await timelineLabels(page)).toEqual(expect.arrayContaining([
    expect.stringMatching(/Issue reader, Failed$/),
  ]));
  await expect(page.getByRole('status', { name: 'Run Completed' })).toHaveCount(0);

  // Sequential mode starts each specialist only after its predecessor completes.
  await returnToComposer(page);
  await launchRun(page, {
    prompt: 'phase-a-sequential summarize repository activity',
    mode: 'Sequential',
  });
  await expect(page.getByRole('status', { name: 'Run Completed' })).toHaveCount(1, { timeout: 60_000 });
  const sequentialLabels = await timelineLabels(page);
  const repoStarted = sequentialLabels.findIndex((label) => /Repository reader, Running$/.test(label));
  const repoCompleted = sequentialLabels.findIndex((label) => /Repository reader, Succeeded$/.test(label));
  const issueStarted = sequentialLabels.findIndex((label) => /Issue reader, Running$/.test(label));
  const issueCompleted = sequentialLabels.findIndex((label) => /Issue reader, Succeeded$/.test(label));
  expect(repoStarted).toBeGreaterThanOrEqual(0);
  expect(repoStarted).toBeLessThan(repoCompleted);
  expect(repoCompleted).toBeLessThan(issueStarted);
  expect(issueStarted).toBeLessThan(issueCompleted);
  const sequentialCalls = (await modelCalls('phase-a-sequential')).sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  expect(sequentialCalls.map((call) => call.specialistId)).toEqual(['repo-reader', 'issue-reader']);
  expect(sequentialCalls[1]!.startedAt).toBeGreaterThanOrEqual(sequentialCalls[0]!.finishedAt);

  // Cancellation remains the sole final state; no late provider completion becomes a retry error.
  await returnToComposer(page);
  await launchRun(page, {
    prompt: 'phase-a-cancel [fixture:slow] summarize repository activity',
    mode: 'Sequential',
  });
  await page.getByRole('button', { name: 'Cancel run' }).click();
  await expect(page.getByRole('status', { name: 'Run Cancelled' })).toHaveCount(1, { timeout: 60_000 });
  await page.waitForTimeout(2_000);
  await expect(page.getByRole('status', { name: 'Run Cancelled' })).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Retry cancellation')).toHaveCount(0);
  expect((await timelineLabels(page)).filter((label) => label.includes('Retry scheduled'))).toHaveLength(0);
});
