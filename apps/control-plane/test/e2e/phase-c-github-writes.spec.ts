/**
 * Task 13 Phase C mutation end-to-end gate (control-plane half).
 *
 * Drives the real fixture stack (Synapse, Postgres, model, GitHub) through
 * the public HTTP API and proves:
 *
 * 1. Phase B credentials cannot write: a mutation POST without a separate
 *    repository+scope write grant is 403 WRITE_SCOPE_REQUIRED and never
 *    reaches GitHub; the grant starts `pending`; an exact, unexpired,
 *    hash-bound approval with explicit confirmation text is required.
 * 2. A granted + confirmed write produces exactly one issue/comment at the
 *    provider; a duplicate idempotency key replays the recorded command.
 * 3. A worker crash after the provider response but before the ack resumes
 *    from the persisted provider result — no second provider mutation.
 * 4. The audit trail records the mutation with redacted details; no secret,
 *    token, or approval payload appears in API or Matrix output.
 * 5. Matrix prompt content can never approve a mutation.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { getAdminPool, runMigrations, withTenant } from '../../src/db/client';
import { getDefaultEnvelopeCipher } from '../../src/security/envelope-encryption';
import { repositoryReaderProfile } from '../../src/agents/specialists/repository-reader';
import { issueReaderProfile } from '../../src/agents/specialists/issue-reader';
import { computeCommandHash } from '../../src/github/mutation-command';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:3000';
const SYNAPSE_URL = process.env.SYNAPSE_URL ?? 'http://127.0.0.1:8008';
const MODEL_FIXTURE_URL = process.env.MODEL_FIXTURE_URL ?? 'http://127.0.0.1:4010';
const GITHUB_FIXTURE_URL = process.env.GITHUB_FIXTURE_URL ?? 'http://127.0.0.1:4020';
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled']);
const REPOSITORY = 'acme/widget';
const SECRET_PATTERN = /ghp_|ghs_|gho_|ghr_|syt_|alice_secret/i;

interface RunResponse {
  runId: string;
  status: string;
}

interface GithubFixtureMutation {
  method: string;
  path: string;
  authorizationClass: 'none' | 'oauth' | 'installation' | 'app' | 'invalid';
}

interface GithubFixtureState {
  requests: GithubFixtureMutation[];
  mutationRequests: GithubFixtureMutation[];
  mutationBodies: Array<GithubFixtureMutation & { body: unknown }>;
}

interface MatrixMessage {
  type?: string;
  content?: { body?: string };
}

interface PhaseCContext {
  aliceToken: string;
  cookie: string;
  workspaceId: string;
  roomId: string;
  runId: string;
}

function assertIsolatedPhaseCDatabase(): void {
  const appValue = process.env.DATABASE_URL;
  const migrationsValue = process.env.MIGRATIONS_DATABASE_URL;
  if (!appValue || !migrationsValue) {
    throw new Error('Phase C destructive setup requires explicit test database URLs');
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
    throw new Error('Phase C destructive setup requires one isolated _test database');
  }
}

function sessionCookie(setCookie: string | undefined): string {
  const match = /(?:^|,\s*)(matrix_session=[^;]+)/.exec(setCookie ?? '');
  if (!match) throw new Error(`missing matrix_session cookie: ${setCookie ?? '(none)'}`);
  return match[1]!;
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
  const alias = encodeURIComponent('#alice:example.test');
  const response = await fetch(`${SYNAPSE_URL}/_matrix/client/v3/directory/room/${alias}`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { room_id: string }).room_id;
}

async function githubState(): Promise<GithubFixtureState> {
  const response = await fetch(`${GITHUB_FIXTURE_URL}/__fixture/state`);
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return JSON.parse(text) as GithubFixtureState;
}

async function mutationCount(): Promise<number> {
  return (await githubState()).mutationRequests.length;
}

async function sendRoomMessage(
  accessToken: string,
  roomId: string,
  body: string,
): Promise<void> {
  const txnId = `phase-c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await fetch(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ msgtype: 'm.text', body }),
    },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
}

async function roomMessageBodies(accessToken: string, roomId: string): Promise<string[]> {
  const response = await fetch(
    `${SYNAPSE_URL}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=250`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  const text = await response.text();
  expect(response.ok, text).toBe(true);
  return (JSON.parse(text) as { chunk: MatrixMessage[] }).chunk
    .filter((event) => event.type === 'm.room.message')
    .map((event) => event.content?.body ?? '');
}

async function waitForRun(
  request: APIRequestContext,
  cookie: string,
  runId: string,
): Promise<{ runId: string; status: string }> {
  const deadline = Date.now() + 60_000;
  let latest: { runId: string; status: string } | undefined;
  while (Date.now() < deadline) {
    const response = await request.get(`${CONTROL_PLANE_URL}/api/runs/${runId}`, {
      headers: { cookie },
    });
    expect(response.status()).toBe(200);
    latest = (await response.json()) as { runId: string; status: string };
    if (TERMINAL.has(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not terminate; last status=${latest?.status ?? 'unknown'}`);
}

async function waitForMatrixDelivery(runId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await getAdminPool().query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE status = 'pending')::int AS pending
         FROM outbox_messages WHERE aggregate_key = $1`,
      [runId],
    );
    const state = result.rows[0] as { total: number; pending: number };
    if (state.total > 0 && state.pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Matrix outbox did not settle for ${runId}`);
}

/** Create a workspace with seeded specialists/installation, a bound room, and
 * one completed run (approvals are bound to an exact run). */
async function setupPhaseCWorkspace(
  request: APIRequestContext,
  label: string,
  prompt: string,
): Promise<PhaseCContext> {
  const aliceToken = await synapseLogin();
  const session = await request.post(`${CONTROL_PLANE_URL}/api/auth/matrix/session`, {
    data: { homeserverUrl: SYNAPSE_URL, accessToken: aliceToken },
  });
  expect(session.status(), await session.text()).toBe(200);
  const cookie = sessionCookie(session.headers()['set-cookie']);

  const workspaceResponse = await request.post(`${CONTROL_PLANE_URL}/api/workspaces`, {
    headers: { cookie },
    data: {
      name: label,
      policy: { readOnly: true, failurePolicy: 'partial', promptInjectionMode: 'fail_run' },
    },
  });
  expect(workspaceResponse.status(), await workspaceResponse.text()).toBe(201);
  const { workspaceId } = (await workspaceResponse.json()) as { workspaceId: string };

  const admin = getAdminPool();
  const userResult = await admin.query(
    "SELECT id FROM users WHERE matrix_user_id = '@alice:example.test'",
  );
  const userId = userResult.rows[0]?.id as string | undefined;
  if (!userId) throw new Error('Alice control-plane user was not created');
  await withTenant(userId, async (client) => {
    for (const profile of [repositoryReaderProfile, issueReaderProfile]) {
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
       VALUES ($1, $2, '42', 'acme', '["acme/widget"]'::jsonb,
               $3, $4, $5, $6, '2035-01-01T00:00:00Z')`,
      [
        `ghi_phase_c_${workspaceId}`,
        workspaceId,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
      ],
    );
  });

  const roomId = await resolveAliceRoom();
  const binding = await request.post(
    `${CONTROL_PLANE_URL}/api/rooms/${encodeURIComponent(roomId)}/binding`,
    { headers: { cookie }, data: { workspaceId } },
  );
  expect(binding.status(), await binding.text()).toBe(201);

  const run = await request.post(`${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/runs`, {
    headers: { cookie },
    data: {
      roomId,
      prompt,
      mode: 'parallel',
      specialistIds: ['repo-reader', 'issue-reader'],
      githubContext: { repository: REPOSITORY },
      idempotencyKey: `${label}-run`,
    },
  });
  expect(run.status(), await run.text()).toBe(202);
  const { runId } = (await run.json()) as RunResponse;
  const terminal = await waitForRun(request, cookie, runId);
  expect(terminal.status).toBe('completed');

  return { aliceToken, cookie, workspaceId, roomId, runId };
}

/** Workspace administration outside the API: flip a pending grant to approved. */
async function approveWriteGrant(
  workspaceId: string,
  repository: string,
  scope: string,
): Promise<void> {
  const result = await getAdminPool().query(
    `UPDATE github_write_grants
        SET status = 'approved', approved_at = now(),
            expires_at = now() + interval '1 day', updated_at = now()
      WHERE workspace_id = $1 AND repository = $2 AND scope = $3`,
    [workspaceId, repository, scope],
  );
  expect(result.rowCount).toBe(1);
}

async function requestGrant(
  request: APIRequestContext,
  cookie: string,
  workspaceId: string,
  scope: 'issues:write' | 'pull_requests:write' = 'issues:write',
): Promise<{ grantId: string; status: string }> {
  const response = await request.post(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/github-grants`,
    { headers: { cookie }, data: { repository: REPOSITORY, scope } },
  );
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { grantId: string; status: string };
}

async function recordApproval(
  request: APIRequestContext,
  cookie: string,
  runId: string,
  input: {
    scope: 'issues:write' | 'pull_requests:write';
    decision: 'approved' | 'denied';
    confirmationText: string;
    commandHash: string;
  },
): Promise<{ approvalId: string; status: string; expiresAt: string }> {
  const response = await request.post(`${CONTROL_PLANE_URL}/api/runs/${runId}/approvals`, {
    headers: { cookie },
    data: { approvalType: 'github_mutation', ...input },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { approvalId: string; status: string; expiresAt: string };
}

async function postMutation(
  request: APIRequestContext,
  cookie: string,
  workspaceId: string,
  body: {
    idempotencyKey: string;
    approvalId: string;
    operation: string;
    arguments: Record<string, unknown>;
    runId?: string;
  },
) {
  return request.post(`${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/github/mutations`, {
    headers: { cookie },
    data: { repository: REPOSITORY, ...body },
  });
}

async function auditTrail(
  request: APIRequestContext,
  cookie: string,
  workspaceId: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await request.get(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/audit`,
    { headers: { cookie } },
  );
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { items: Array<Record<string, unknown>> }).items;
}

test.describe.configure({ mode: 'serial' });

// specialist_agents.id is globally unique and the workflow registry resolves
// canonical profile ids, so the whole file shares one workspace (each spec
// file truncates and re-seeds in its own beforeAll; files run serially).
let context: PhaseCContext;

test.beforeAll(async ({ request }) => {
  assertIsolatedPhaseCDatabase();
  await runMigrations();
  await getAdminPool().query('TRUNCATE rooms, users CASCADE');
  for (const url of [MODEL_FIXTURE_URL, GITHUB_FIXTURE_URL]) {
    const response = await fetch(`${url}/__fixture/reset`, { method: 'POST' });
    expect(response.ok, await response.text()).toBe(true);
  }
  context = await setupPhaseCWorkspace(
    request,
    'Phase C API Acceptance',
    'phase-c-api summarize repository activity',
  );
});

test('Phase C writes require a separate grant and exact approval and mutate GitHub once', async ({
  request,
}) => {
  const { cookie, workspaceId, runId } = context;
  const issueArguments = { title: 'Phase C gate issue', body: 'phase-c-secret-free body' };
  const issueHash = computeCommandHash('create_issue', issueArguments);

  // 1. Phase B credentials alone cannot write: no grant exists yet.
  const phaseBOnly = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-denied-no-grant',
    approvalId: 'apr_nonexistent',
    runId,
    operation: 'create_issue',
    arguments: issueArguments,
  });
  expect(phaseBOnly.status(), await phaseBOnly.text()).toBe(403);
  expect((await phaseBOnly.json()).error.code).toBe('WRITE_SCOPE_REQUIRED');
  expect(await mutationCount()).toBe(0);

  // 2. The separate repository+scope grant starts pending and still blocks.
  const grant = await requestGrant(request, cookie, workspaceId);
  expect(grant).toMatchObject({ status: 'pending', repository: REPOSITORY });
  const approval = await recordApproval(request, cookie, runId, {
    scope: 'issues:write',
    decision: 'approved',
    confirmationText: 'I confirm create issue on acme/widget (issues:write)',
    commandHash: issueHash,
  });
  expect(approval.status).toBe('approved');
  const pendingGrant = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-denied-pending-grant',
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: issueArguments,
  });
  expect(pendingGrant.status(), await pendingGrant.text()).toBe(403);
  expect((await pendingGrant.json()).error.code).toBe('WRITE_SCOPE_REQUIRED');
  expect(await mutationCount()).toBe(0);

  // 3. With the grant approved, the exact confirmed command executes once.
  await approveWriteGrant(workspaceId, REPOSITORY, 'issues:write');
  const created = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-create-issue',
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: issueArguments,
  });
  expect(created.status(), await created.text()).toBe(202);
  const createdBody = (await created.json()) as { commandId: string; status: string };
  expect(createdBody.status).toBe('completed');
  expect(Object.keys(createdBody).sort()).toEqual(['commandId', 'requestId', 'status']);
  expect(JSON.stringify(createdBody)).not.toMatch(SECRET_PATTERN);
  expect(await mutationCount()).toBe(1);
  const [issueMutation] = (await githubState()).mutationBodies;
  expect(issueMutation).toMatchObject({
    method: 'POST',
    path: '/repos/acme/widget/issues',
    authorizationClass: 'installation',
  });
  expect((issueMutation?.body as { title?: string }).title).toBe('Phase C gate issue');

  // 4. A repeated request with the same idempotency key returns the same
  //    recorded result without a second provider mutation.
  const replay = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-create-issue',
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: issueArguments,
  });
  expect(replay.status(), await replay.text()).toBe(200);
  expect(await replay.json()).toMatchObject({
    commandId: createdBody.commandId,
    status: 'completed',
  });
  expect(await mutationCount()).toBe(1);

  // 5. The exact approval cannot be reused for a changed command, and a
  //    denied approval never reaches GitHub.
  const changed = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-changed-command',
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: { title: 'Phase C gate issue (changed)' },
  });
  expect(changed.status(), await changed.text()).toBe(409);
  expect((await changed.json()).error.code).toBe('APPROVAL_MISMATCH');

  const commentArguments = { issueNumber: 7, body: 'Phase C gate comment' };
  const commentHash = computeCommandHash('comment_issue', commentArguments);
  const deniedApproval = await recordApproval(request, cookie, runId, {
    scope: 'issues:write',
    decision: 'denied',
    confirmationText: 'I do not confirm this comment',
    commandHash: commentHash,
  });
  const denied = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-denied-approval',
    approvalId: deniedApproval.approvalId,
    runId,
    operation: 'comment_issue',
    arguments: commentArguments,
  });
  expect(denied.status(), await denied.text()).toBe(409);
  expect((await denied.json()).error.code).toBe('APPROVAL_DENIED');
  expect(await mutationCount()).toBe(1);

  // 6. A confirmed comment write produces exactly one provider comment.
  const commentApproval = await recordApproval(request, cookie, runId, {
    scope: 'issues:write',
    decision: 'approved',
    confirmationText: 'I confirm comment on issue on acme/widget (issues:write)',
    commandHash: commentHash,
  });
  const comment = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-comment-issue',
    approvalId: commentApproval.approvalId,
    runId,
    operation: 'comment_issue',
    arguments: commentArguments,
  });
  expect(comment.status(), await comment.text()).toBe(202);
  expect(((await comment.json()) as { status: string }).status).toBe('completed');
  expect(await mutationCount()).toBe(2);
  expect((await githubState()).mutationRequests).toContainEqual({
    method: 'POST',
    path: '/repos/acme/widget/issues/7/comments',
    authorizationClass: 'installation',
  });

  // 7. The audit trail records grant, approval, and mutation outcomes with
  //    redacted details — no tokens, arguments, or confirmation text leak.
  const trail = await auditTrail(request, cookie, workspaceId);
  const outcomes = trail.map((row) => String(row.outcome));
  for (const expected of [
    'grant_requested',
    'approval_recorded',
    'queued',
    'completed',
    'denied',
  ]) {
    expect(outcomes).toContain(expected);
  }
  const completedRows = trail.filter(
    (row) => row.commandId === createdBody.commandId && row.outcome === 'completed',
  );
  expect(completedRows).toHaveLength(1);
  expect(completedRows[0]).toMatchObject({
    approvalId: approval.approvalId,
    repository: REPOSITORY,
    operation: 'create_issue',
    scope: 'issues:write',
    argumentsHash: issueHash,
  });
  const auditJson = JSON.stringify(trail);
  expect(auditJson).toContain('[REDACTED]');
  expect(auditJson).not.toMatch(SECRET_PATTERN);
  expect(auditJson).not.toContain('phase-c-secret-free body');
  expect(auditJson).not.toContain('I confirm create issue');

  // 8. Matrix output for the run carries no secret-shaped content either.
  await waitForMatrixDelivery(runId);
  const matrixBodies = await roomMessageBodies(context.aliceToken, context.roomId);
  expect(matrixBodies.some((body) => body.includes(runId))).toBe(true);
  expect(matrixBodies.join('\n')).not.toMatch(SECRET_PATTERN);
});

test('a worker crash after the provider response resumes without a second mutation', async ({
  request,
}) => {
  const { cookie, workspaceId, runId } = context;
  // The grant was requested and approved in the previous (serial) test.
  const mutationsBefore = await mutationCount();

  const crashArguments = { title: 'Phase C crash window issue' };
  const crashHash = computeCommandHash('create_issue', crashArguments);
  const approval = await recordApproval(request, cookie, runId, {
    scope: 'issues:write',
    decision: 'approved',
    confirmationText: 'I confirm create issue on acme/widget (issues:write)',
    commandHash: crashHash,
  });

  // The deterministic fixture control crashes the worker after the provider
  // result is persisted but before the command is marked complete.
  const crashKey = 'phase-c-crash [fixture:crash-after-provider]';
  const crashed = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: crashKey,
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: crashArguments,
  });
  expect(crashed.status(), await crashed.text()).toBe(500);
  expect((await crashed.json()).error.code).toBe('INTERNAL_ERROR');
  expect(await mutationCount()).toBe(mutationsBefore + 1);

  // The provider result was persisted before the crash point.
  const persisted = await getAdminPool().query(
    `SELECT id, status, provider_result FROM github_mutation_commands
      WHERE workspace_id = $1 AND idempotency_key = $2`,
    [workspaceId, crashKey],
  );
  expect(persisted.rows).toHaveLength(1);
  const crashedCommand = persisted.rows[0] as {
    id: string;
    status: string;
    provider_result: Record<string, unknown> | null;
  };
  expect(crashedCommand.status).toBe('queued');
  expect(crashedCommand.provider_result).toMatchObject({ issueNumber: 42 });

  // The retry with the same idempotency key resumes from the persisted
  // provider result: no second GitHub mutation, same recorded result.
  const resumed = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: crashKey,
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: crashArguments,
  });
  expect(resumed.status(), await resumed.text()).toBe(200);
  expect(await resumed.json()).toMatchObject({
    commandId: crashedCommand.id,
    status: 'completed',
  });
  expect(await mutationCount()).toBe(mutationsBefore + 1);

  const finalized = await getAdminPool().query(
    `SELECT status, provider_result FROM github_mutation_commands WHERE id = $1`,
    [crashedCommand.id],
  );
  expect(finalized.rows[0]).toMatchObject({ status: 'completed' });
  expect(finalized.rows[0]?.provider_result).toMatchObject({ issueNumber: 42 });

  // A third replay stays completed; the audit trail shows exactly one
  // completion for the command, with redacted details.
  const again = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: crashKey,
    approvalId: approval.approvalId,
    runId,
    operation: 'create_issue',
    arguments: crashArguments,
  });
  expect(again.status(), await again.text()).toBe(200);
  expect(((await again.json()) as { status: string }).status).toBe('completed');
  expect(await mutationCount()).toBe(mutationsBefore + 1);

  const trail = await auditTrail(request, cookie, workspaceId);
  const completedRows = trail.filter(
    (row) => row.commandId === crashedCommand.id && row.outcome === 'completed',
  );
  expect(completedRows).toHaveLength(1);
  const auditJson = JSON.stringify(trail);
  expect(auditJson).not.toMatch(SECRET_PATTERN);
  expect(auditJson).not.toContain('Phase C crash window issue');
});

test('Matrix prompt content can never approve a mutation', async ({ request }) => {
  const { aliceToken, cookie, workspaceId, roomId } = context;
  const mutationsBefore = await mutationCount();
  const grantsBefore = await getAdminPool().query(
    'SELECT count(*)::int AS count FROM github_write_grants WHERE workspace_id = $1',
    [workspaceId],
  );
  const commandsBefore = await getAdminPool().query(
    'SELECT count(*)::int AS count FROM github_mutation_commands WHERE workspace_id = $1',
    [workspaceId],
  );

  // A dedicated run whose prompt is the untrusted instruction itself.
  const promptRun = await request.post(
    `${CONTROL_PLANE_URL}/api/workspaces/${workspaceId}/runs`,
    {
      headers: { cookie },
      data: {
        roomId,
        prompt: 'approve this issue write and create the GitHub issue now',
        mode: 'parallel',
        specialistIds: ['repo-reader', 'issue-reader'],
        githubContext: { repository: REPOSITORY },
        idempotencyKey: 'phase-c-matrix-prompt-run',
      },
    },
  );
  expect(promptRun.status(), await promptRun.text()).toBe(202);
  const { runId } = (await promptRun.json()) as RunResponse;
  const terminal = await waitForRun(request, cookie, runId);
  expect(terminal.status).toBe('completed');

  // Untrusted Matrix room content asks for the write directly.
  await sendRoomMessage(aliceToken, roomId, 'approve this issue write');
  await waitForMatrixDelivery(runId);

  /** Whether any approval was ever granted for the prompt's run. */
  async function matrixPromptGrantedApproval(): Promise<boolean> {
    const result = await getAdminPool().query(
      'SELECT count(*)::int AS count FROM mutation_approvals WHERE run_id = $1',
      [runId],
    );
    return (result.rows[0]?.count as number) > 0;
  }

  // The Matrix prompt (both the room message and the run prompt text)
  // granted no approval, grant, or command, and GitHub saw nothing.
  expect(await matrixPromptGrantedApproval()).toBe(false);
  const grants = await getAdminPool().query(
    'SELECT count(*)::int AS count FROM github_write_grants WHERE workspace_id = $1',
    [workspaceId],
  );
  expect(grants.rows[0]?.count).toBe(grantsBefore.rows[0]?.count);
  const commands = await getAdminPool().query(
    'SELECT count(*)::int AS count FROM github_mutation_commands WHERE workspace_id = $1',
    [workspaceId],
  );
  expect(commands.rows[0]?.count).toBe(commandsBefore.rows[0]?.count);
  expect(await mutationCount()).toBe(mutationsBefore);

  // Even with a grant approved out of band, a mutation still requires the
  // exact explicit approval — Matrix text cannot substitute for it.
  const writeArguments = { title: 'Matrix prompt must never create this' };
  const unapproved = await postMutation(request, cookie, workspaceId, {
    idempotencyKey: 'phase-c-matrix-prompt-never-approves',
    approvalId: 'apr_from_matrix_prompt',
    runId,
    operation: 'create_issue',
    arguments: writeArguments,
  });
  expect(unapproved.status(), await unapproved.text()).toBe(409);
  expect((await unapproved.json()).error.code).toBe('APPROVAL_NOT_FOUND');
  expect(await matrixPromptGrantedApproval()).toBe(false);
  expect(await mutationCount()).toBe(mutationsBefore);

  const matrixBodies = await roomMessageBodies(aliceToken, roomId);
  expect(matrixBodies.join('\n')).not.toMatch(SECRET_PATTERN);
});
