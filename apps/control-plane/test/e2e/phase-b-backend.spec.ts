import { test, expect, type APIRequestContext } from '@playwright/test';
import { getAdminPool, runMigrations, withTenant } from '../../src/db/client';
import { getDefaultEnvelopeCipher } from '../../src/security/envelope-encryption';
import { repositoryReaderProfile } from '../../src/agents/specialists/repository-reader';
import { issueReaderProfile } from '../../src/agents/specialists/issue-reader';
import { prReaderProfile } from '../../src/agents/specialists/pr-reader';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
const SYNAPSE_URL = process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008';
const MODEL_FIXTURE_URL = process.env.MODEL_FIXTURE_URL ?? 'http://127.0.0.1:4010';
const GITHUB_FIXTURE_URL = process.env.GITHUB_FIXTURE_URL ?? 'http://127.0.0.1:4020';
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);

interface RunResponse {
  runId: string;
  status: string;
  mode: 'parallel' | 'sequential';
  lastSequence: number;
  terminalSummary: Record<string, unknown> | null;
  specialists: Array<{
    specialistId: string;
    ordinal: number;
    status: string;
    attemptCount: number;
    output: Record<string, unknown> | null;
    errorCode: string | null;
  }>;
}

interface ModelFixtureCall {
  specialistId: string;
  prompt: string;
  startedAt: number;
  finishedAt: number;
  status: number;
}

interface ModelFixtureState {
  calls: ModelFixtureCall[];
}

interface GithubFixtureState {
  requests: Array<{
    method: string;
    path: string;
    authorizationClass: 'none' | 'oauth' | 'installation' | 'app' | 'invalid';
  }>;
  mutationRequests: Array<{
    method: string;
    path: string;
    authorizationClass: 'none' | 'oauth' | 'installation' | 'app' | 'invalid';
  }>;
}

interface MatrixMessage {
  sender?: string;
  type?: string;
  content?: { body?: string; msgtype?: string };
}

function sessionCookie(setCookie: string | undefined): string {
  const match = /(?:^|,\s*)(matrix_session=[^;]+)/.exec(setCookie ?? '');
  if (!match) throw new Error(`missing matrix_session cookie: ${setCookie ?? '(none)'}`);
  return match[1]!;
}

async function synapseLogin(user: string, password: string): Promise<string> {
  const response = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user },
      password,
    }),
  });
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { access_token: string }).access_token;
}

async function resolveAliceRoom(): Promise<string> {
  const alias = encodeURIComponent('#alice:example.test');
  const response = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/directory/room/${alias}`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { room_id: string }).room_id;
}

async function waitForRun(
  request: APIRequestContext,
  cookie: string,
  runId: string,
): Promise<RunResponse> {
  const deadline = Date.now() + 60_000;
  let latest: RunResponse | undefined;
  while (Date.now() < deadline) {
    const response = await request.get(`${CONTROL_PLANE_URL}/api/runs/${runId}`, {
      headers: { cookie },
    });
    expect(response.status()).toBe(200);
    latest = (await response.json()) as RunResponse;
    if (TERMINAL.has(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not terminate; last status=${latest?.status ?? 'unknown'}`);
}

async function waitForStatus(
  request: APIRequestContext,
  cookie: string,
  runId: string,
  expected: string,
): Promise<RunResponse> {
  const deadline = Date.now() + 30_000;
  let latest: RunResponse | undefined;
  while (Date.now() < deadline) {
    const response = await request.get(`${CONTROL_PLANE_URL}/api/runs/${runId}`, {
      headers: { cookie },
    });
    expect(response.status()).toBe(200);
    latest = (await response.json()) as RunResponse;
    if (latest.status === expected) return latest;
    if (TERMINAL.has(latest.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`run ${runId} did not reach ${expected}; last status=${latest?.status ?? 'unknown'}`);
}

async function launchRun(
  request: APIRequestContext,
  cookie: string,
  workspaceId: string,
  roomId: string,
  input: {
    prompt: string;
    mode: 'parallel' | 'sequential';
    specialistIds?: string[];
    idempotencyKey: string;
  },
): Promise<{ runId: string; status: string }> {
  const response = await request.post(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/runs`,
    {
      headers: { cookie },
      data: {
        roomId,
        prompt: input.prompt,
        mode: input.mode,
        specialistIds: input.specialistIds ?? ['repo-reader', 'issue-reader', 'pr-reader'],
        githubContext: { repository: 'acme/widget' },
        idempotencyKey: input.idempotencyKey,
      },
    },
  );
  expect(response.status(), await response.text()).toBe(202);
  return (await response.json()) as { runId: string; status: string };
}

function parseSse(text: string): Array<{ sequence: number; type: string; data: unknown }> {
  return text
    .split(/\n\n+/)
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('id:'))
    .map((frame) => {
      const lines = frame.split('\n');
      const sequence = Number(
        lines.find((line) => line.startsWith('id:'))?.slice(3).trim(),
      );
      const type = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? '';
      const data = JSON.parse(
        lines.find((line) => line.startsWith('data:'))?.slice(5).trim() ?? '{}',
      );
      return { sequence, type, data };
    });
}

async function readSse(cookie: string, runId: string, after = 0) {
  const response = await fetch(
    `${CONTROL_PLANE_URL}/api/runs/${runId}/events?after=${after}`,
    { headers: { cookie } },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return parseSse(await response.text());
}

async function roomMessages(accessToken: string, roomId: string): Promise<MatrixMessage[]> {
  const response = await fetch(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=250`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { chunk: MatrixMessage[] }).chunk;
}

async function waitForMatrixTerminal(
  accessToken: string,
  roomId: string,
  runId: string,
): Promise<string[]> {
  const deadline = Date.now() + 30_000;
  let bodies: string[] = [];
  while (Date.now() < deadline) {
    bodies = (await roomMessages(accessToken, roomId))
      .filter((event) => event.type === 'm.room.message')
      .map((event) => event.content?.body ?? '')
      .filter((body) => body.includes(runId));
    if (bodies.some((body) => /Run (completed|failed|partially completed|cancelled)/.test(body))) {
      return bodies;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`no Matrix terminal message for ${runId}; messages=${JSON.stringify(bodies)}`);
}

async function seedWorkspaceIntegrations(workspaceId: string): Promise<string> {
  const admin = getAdminPool();
  const userResult = await admin.query(
    "SELECT id FROM users WHERE matrix_user_id = '@alice:example.test'",
  );
  const userId = userResult.rows[0]?.id as string | undefined;
  if (!userId) throw new Error('Alice control-plane user was not created');

  await withTenant(userId, async (client) => {
    for (const profile of [repositoryReaderProfile, issueReaderProfile, prReaderProfile]) {
      await client.query(
        `INSERT INTO specialist_agents
           (id, workspace_id, name, model, gateway_provider, system_policy,
            tools_allowlist, timeout_ms, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [
          profile.id,
          workspaceId,
          profile.name,
          profile.model,
          profile.gatewayProvider,
          JSON.stringify({ systemPolicy: profile.systemPolicy }),
          JSON.stringify(profile.toolsAllowlist),
          profile.timeoutMs,
        ],
      );
    }

    const encrypted = await getDefaultEnvelopeCipher().encrypt('ghs_fixture_read_token');
    await client.query(
      `INSERT INTO github_installations
         (id, workspace_id, installation_id, owner, repository_allowlist,
          token_ciphertext, token_iv, token_auth_tag, token_key_version, expires_at)
       VALUES ('ghi_phase_b', $1, '42', 'acme', '["acme/widget"]'::jsonb,
               $2, $3, $4, $5, '2035-01-01T00:00:00Z')`,
      [
        workspaceId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
      ],
    );
  });
  return userId;
}

async function modelState(): Promise<ModelFixtureState> {
  return (await (await fetch(`${MODEL_FIXTURE_URL}/__fixture/state`)).json()) as ModelFixtureState;
}

async function githubState(): Promise<GithubFixtureState> {
  return (await (await fetch(`${GITHUB_FIXTURE_URL}/__fixture/state`)).json()) as GithubFixtureState;
}

function callsFor(state: ModelFixtureState, promptMarker: string): ModelFixtureCall[] {
  return state.calls.filter((call) => call.prompt.includes(promptMarker));
}

function terminalBodies(bodies: string[]): string[] {
  return bodies.filter((body) => /Run (completed|failed|partially completed|cancelled)/.test(body));
}

function assertIsolatedPhaseBDatabase(): void {
  const appValue = process.env.DATABASE_URL;
  const migrationsValue = process.env.MIGRATIONS_DATABASE_URL;
  if (
    !appValue ||
    !migrationsValue ||
    appValue !== process.env.PHASE_B_DATABASE_URL ||
    migrationsValue !== process.env.PHASE_B_MIGRATIONS_DATABASE_URL
  ) {
    throw new Error('Phase B destructive setup requires explicit PHASE_B test database URLs');
  }
  const app = new URL(appValue);
  const migrations = new URL(migrationsValue);
  const appName = decodeURIComponent(app.pathname.replace(/^\/+/, ''));
  const migrationsName = decodeURIComponent(migrations.pathname.replace(/^\/+/, ''));
  if (
    !appName.endsWith('_test') ||
    appName !== migrationsName ||
    app.host !== migrations.host ||
    !app.username ||
    app.username === migrations.username
  ) {
    throw new Error('Phase B destructive setup requires one isolated _test database');
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  assertIsolatedPhaseBDatabase();
  await runMigrations();
  await getAdminPool().query('TRUNCATE rooms, users CASCADE');
  for (const url of [MODEL_FIXTURE_URL, GITHUB_FIXTURE_URL]) {
    const response = await fetch(`${url}/__fixture/reset`, { method: 'POST' });
    expect(response.ok, await response.text()).toBe(true);
  }
});

test('Phase B backend contract is durable, replayable, Matrix-first, and GitHub read-only', async ({
  request,
}) => {
  // Authenticate the seeded Matrix user through the public Synapse and control-plane routes.
  const aliceToken = await synapseLogin('alice', 'alice_secret');
  const whoami = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/account/whoami`, {
    headers: { authorization: `Bearer ${aliceToken}` },
  });
  expect(whoami.status).toBe(200);
  expect(await whoami.json()).toMatchObject({ user_id: '@alice:example.test' });

  const session = await request.post(`${CONTROL_PLANE_URL}/api/auth/matrix/session`, {
    data: { homeserverUrl: SYNAPSE_URL, accessToken: aliceToken },
  });
  expect(session.status(), await session.text()).toBe(200);
  expect(await session.json()).toMatchObject({ user: { id: '@alice:example.test' } });
  const cookie = sessionCookie(session.headers()['set-cookie']);

  const workspaceResponse = await request.post(`${CONTROL_PLANE_URL}/api/workspaces`, {
    headers: { cookie },
    data: {
      name: 'Phase B Acceptance',
      policy: { readOnly: true, failurePolicy: 'partial', promptInjectionMode: 'fail_run' },
    },
  });
  expect(workspaceResponse.status(), await workspaceResponse.text()).toBe(201);
  const { workspaceId } = (await workspaceResponse.json()) as { workspaceId: string };
  await seedWorkspaceIntegrations(workspaceId);

  const roomId = await resolveAliceRoom();
  const binding = await request.post(
    `${CONTROL_PLANE_URL}/api/rooms/${encodeURIComponent(roomId)}/binding`,
    { headers: { cookie }, data: { workspaceId } },
  );
  expect(binding.status(), await binding.text()).toBe(201);
  expect(await binding.json()).toMatchObject({ roomId, workspaceId, boundBy: '@alice:example.test' });

  // Parallel specialists overlap and share no prior output; sequential specialists preserve order.
  const parallel = await launchRun(request, cookie, workspaceId, roomId, {
    prompt: 'phase-b-parallel summarize repository activity',
    mode: 'parallel',
    idempotencyKey: 'phase-b-parallel-key',
  });
  const sequential = await launchRun(request, cookie, workspaceId, roomId, {
    prompt: 'phase-b-sequential summarize repository activity',
    mode: 'sequential',
    idempotencyKey: 'phase-b-sequential-key',
  });
  const [parallelResult, sequentialResult] = await Promise.all([
    waitForRun(request, cookie, parallel.runId),
    waitForRun(request, cookie, sequential.runId),
  ]);
  expect(parallelResult).toMatchObject({ status: 'completed', mode: 'parallel' });
  expect(sequentialResult).toMatchObject({ status: 'completed', mode: 'sequential' });
  expect(parallelResult.specialists.map((item) => item.specialistId)).toEqual([
    'repo-reader',
    'issue-reader',
    'pr-reader',
  ]);
  expect(sequentialResult.specialists.map((item) => item.ordinal)).toEqual([0, 1, 2]);
  expect(parallelResult.specialists[1]?.output?.summary).toContain('prior=none');
  expect(sequentialResult.specialists[1]?.output?.summary).toContain('prior=repo-reader');

  const timings = await modelState();
  const parallelCalls = callsFor(timings, 'phase-b-parallel');
  const sequentialCalls = callsFor(timings, 'phase-b-sequential').sort(
    (left, right) => left.startedAt - right.startedAt,
  );
  expect(parallelCalls).toHaveLength(3);
  expect(Math.max(...parallelCalls.map((call) => call.startedAt))).toBeLessThan(
    Math.min(...parallelCalls.map((call) => call.finishedAt)),
  );
  expect(sequentialCalls.map((call) => call.specialistId)).toEqual([
    'repo-reader',
    'issue-reader',
    'pr-reader',
  ]);
  expect(sequentialCalls[1]!.startedAt).toBeGreaterThanOrEqual(sequentialCalls[0]!.finishedAt);
  expect(sequentialCalls[2]!.startedAt).toBeGreaterThanOrEqual(sequentialCalls[1]!.finishedAt);

  // Reconnect the persisted SSE stream from a saved sequence with no duplicate replay.
  const firstReplay = await readSse(cookie, parallel.runId);
  expect(firstReplay.length).toBeGreaterThan(3);
  expect(firstReplay.map((event) => event.sequence)).toEqual(
    Array.from({ length: firstReplay.length }, (_, index) => index + 1),
  );
  const savedSequence = firstReplay[2]!.sequence;
  const reconnected = await readSse(cookie, parallel.runId, savedSequence);
  expect(reconnected.map((event) => event.sequence)).toEqual(
    firstReplay.filter((event) => event.sequence > savedSequence).map((event) => event.sequence),
  );
  expect(new Set(reconnected.map((event) => event.sequence)).size).toBe(reconnected.length);

  const parallelMatrix = await waitForMatrixTerminal(aliceToken, roomId, parallel.runId);
  expect(parallelMatrix.some((body) => body.includes('specialist.completed'))).toBe(true);
  expect(terminalBodies(parallelMatrix)).toHaveLength(1);

  // A deterministic specialist failure is visible as a partial run and durable failed result.
  const partial = await launchRun(request, cookie, workspaceId, roomId, {
    prompt: 'phase-b-partial [fixture:fail-issue] summarize repository activity',
    mode: 'parallel',
    specialistIds: ['repo-reader', 'issue-reader'],
    idempotencyKey: 'phase-b-partial-key',
  });
  const partialResult = await waitForRun(request, cookie, partial.runId);
  expect(partialResult.status).toBe('partial');
  expect(partialResult.specialists).toEqual([
    expect.objectContaining({ specialistId: 'repo-reader', status: 'completed' }),
    expect.objectContaining({
      specialistId: 'issue-reader',
      status: 'failed',
      errorCode: 'PROVIDER_PERMANENT',
    }),
  ]);
  expect(terminalBodies(await waitForMatrixTerminal(aliceToken, roomId, partial.runId))).toHaveLength(1);

  // Retry the same public request key: it resolves to the original run without another dispatch.
  const idempotentRetry = await request.post(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/runs`,
    {
      headers: { cookie },
      data: {
        roomId,
        prompt: 'phase-b-parallel summarize repository activity',
        mode: 'parallel',
        specialistIds: ['repo-reader', 'issue-reader', 'pr-reader'],
        githubContext: { repository: 'acme/widget' },
        idempotencyKey: 'phase-b-parallel-key',
      },
    },
  );
  expect(idempotentRetry.status()).toBe(200);
  expect(await idempotentRetry.json()).toMatchObject({ runId: parallel.runId, status: 'completed' });

  // Simulate a worker interruption after a committed specialist checkpoint; retry resumes once.
  const interrupted = await launchRun(request, cookie, workspaceId, roomId, {
    prompt: 'phase-b-interrupt [fixture:interrupt-once] summarize repository activity',
    mode: 'sequential',
    idempotencyKey: 'phase-b-interrupt-key',
  });
  const interruptedResult = await waitForRun(request, cookie, interrupted.runId);
  expect(interruptedResult.status).toBe('completed');
  expect(interruptedResult.specialists).toHaveLength(3);
  const interruptionRows = await getAdminPool().query(
    `SELECT checkpoint_key FROM workflow_checkpoints
      WHERE run_id = $1 AND checkpoint_key = 'fixture:interruption'`,
    [interrupted.runId],
  );
  expect(interruptionRows.rows).toHaveLength(1);
  const interruptedCalls = callsFor(await modelState(), 'phase-b-interrupt');
  expect(interruptedCalls.filter((call) => call.specialistId === 'repo-reader')).toHaveLength(1);
  expect(interruptedCalls.filter((call) => call.specialistId === 'issue-reader')).toHaveLength(1);
  expect(interruptedCalls.filter((call) => call.specialistId === 'pr-reader')).toHaveLength(1);
  const interruptionEvents = await getAdminPool().query(
    `SELECT event_type, count(*)::int AS count
       FROM run_events WHERE run_id = $1
      GROUP BY event_type`,
    [interrupted.runId],
  );
  expect(
    interruptionEvents.rows.find((row) => row.event_type === 'run.completed')?.count,
  ).toBe(1);
  expect(
    interruptionEvents.rows.find((row) => row.event_type === 'specialist.completed')?.count,
  ).toBe(3);
  const interruptionMatrix = await waitForMatrixTerminal(
    aliceToken,
    roomId,
    interrupted.runId,
  );
  expect(terminalBodies(interruptionMatrix)).toHaveLength(1);
  const deliveryKeys = await getAdminPool().query(
    `SELECT count(*)::int AS total,
            count(DISTINCT delivery_key)::int AS distinct_count,
            count(*) FILTER (WHERE status = 'delivered')::int AS delivered
       FROM outbox_messages WHERE aggregate_key = $1`,
    [interrupted.runId],
  );
  expect(deliveryKeys.rows[0].total).toBe(deliveryKeys.rows[0].distinct_count);
  expect(deliveryKeys.rows[0].delivered).toBe(deliveryKeys.rows[0].total);

  // Cooperative cancellation emits and delivers one terminal cancellation and remains retrievable.
  const cancelled = await launchRun(request, cookie, workspaceId, roomId, {
    prompt: 'phase-b-cancel [fixture:slow] summarize repository activity',
    mode: 'sequential',
    idempotencyKey: 'phase-b-cancel-key',
  });
  await waitForStatus(request, cookie, cancelled.runId, 'running');
  const cancelResponse = await request.post(
    `${CONTROL_PLANE_URL}/api/runs/${cancelled.runId}/cancel`,
    { headers: { cookie }, data: {} },
  );
  expect(cancelResponse.status(), await cancelResponse.text()).toBe(202);
  const cancelledResult = await waitForRun(request, cookie, cancelled.runId);
  expect(cancelledResult.status).toBe('cancelled');
  const cancelledSse = await readSse(cookie, cancelled.runId);
  expect(cancelledSse.filter((event) => event.type === 'run.cancelled')).toHaveLength(1);
  expect(terminalBodies(await waitForMatrixTerminal(aliceToken, roomId, cancelled.runId))).toHaveLength(1);

  // Link the Matrix identity to GitHub OAuth, then read through an authorized installation.
  for (const path of ['/user', '/installation/repositories']) {
    const unauthorized = await fetch(`${GITHUB_FIXTURE_URL}${path}`);
    expect(unauthorized.status).toBe(401);
  }
  const oauthStart = await request.get(`${CONTROL_PLANE_URL}/api/github/oauth/start`, {
    headers: { cookie },
    maxRedirects: 0,
  });
  expect(oauthStart.status()).toBe(302);
  const authorization = new URL(oauthStart.headers().location!);
  const oauthState = authorization.searchParams.get('state');
  expect(oauthState).toBeTruthy();
  const oauthCallback = await request.get(
    `${CONTROL_PLANE_URL}/api/github/oauth/callback?code=fixture-code&state=${encodeURIComponent(oauthState!)}`,
    { headers: { cookie } },
  );
  expect(oauthCallback.status(), await oauthCallback.text()).toBe(200);
  expect(await oauthCallback.json()).toMatchObject({
    linked: true,
    github: { subject: '9001', login: 'alice-gh' },
  });

  const repositories = await request.get(
    `${CONTROL_PLANE_URL}/api/github/repositories?workspaceId=${workspaceId}&installationId=42`,
    { headers: { cookie } },
  );
  expect(repositories.status(), await repositories.text()).toBe(200);
  expect(await repositories.json()).toMatchObject({
    items: [expect.objectContaining({ fullName: 'acme/widget' })],
  });
  const issues = await request.get(
    `${CONTROL_PLANE_URL}/api/github/repositories/acme/widget/issues?workspaceId=${workspaceId}&installationId=42&cursor=p2`,
    { headers: { cookie } },
  );
  expect(issues.status(), await issues.text()).toBe(200);
  expect(await issues.json()).toMatchObject({
    items: [expect.objectContaining({ number: 7, state: 'open' })],
  });
  const pulls = await request.get(
    `${CONTROL_PLANE_URL}/api/github/repositories/acme/widget/pulls?workspaceId=${workspaceId}&installationId=42`,
    { headers: { cookie } },
  );
  expect(pulls.status(), await pulls.text()).toBe(200);
  expect(await pulls.json()).toMatchObject({
    items: [expect.objectContaining({ number: 11, state: 'open' })],
  });

  const authorizedGithub = await githubState();
  expect(authorizedGithub.requests).toContainEqual({
    method: 'GET',
    path: '/user',
    authorizationClass: 'oauth',
  });
  for (const path of [
    '/installation/repositories',
    '/repos/acme/widget/issues',
    '/repos/acme/widget/pulls',
  ]) {
    expect(authorizedGithub.requests).toContainEqual({
      method: 'GET',
      path,
      authorizationClass: 'installation',
    });
  }

  const mutationRoutes = [
    `${CONTROL_PLANE_URL}/api/github/repositories?workspaceId=${workspaceId}&installationId=42`,
    `${CONTROL_PLANE_URL}/api/github/repositories/acme/widget/issues?workspaceId=${workspaceId}&installationId=42`,
    `${CONTROL_PLANE_URL}/api/github/repositories/acme/widget/pulls?workspaceId=${workspaceId}&installationId=42`,
  ];
  for (const route of mutationRoutes) {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const mutation = await request[method](route, {
        headers: { cookie },
        data: { title: 'must not be sent' },
      });
      expect(mutation.status()).toBe(405);
    }
  }
  const absentMutationRoute = await request.post(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/github/mutations`,
    { headers: { cookie }, data: { operation: 'create_issue' } },
  );
  expect(absentMutationRoute.status()).toBe(404);
  expect((await githubState()).mutationRequests).toHaveLength(0);

  // Durable terminal results remain available after every stream and delivery completes.
  const durable = await request.get(`${CONTROL_PLANE_URL}/api/runs/${interrupted.runId}`, {
    headers: { cookie },
  });
  expect(durable.status()).toBe(200);
  expect(await durable.json()).toMatchObject({
    runId: interrupted.runId,
    status: 'completed',
    terminalSummary: expect.objectContaining({ status: 'completed' }),
    specialists: [
      expect.objectContaining({ specialistId: 'repo-reader', status: 'completed' }),
      expect.objectContaining({ specialistId: 'issue-reader', status: 'completed' }),
      expect.objectContaining({ specialistId: 'pr-reader', status: 'completed' }),
    ],
  });
});
