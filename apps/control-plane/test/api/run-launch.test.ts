import { describe, it, expect, beforeAll, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { getAdminPool, withTenant } from '../../src/db/client';
import { POST as postRunHandler } from '../../src/app/api/workspaces/[workspaceId]/runs/route';
import { GET as getRunHandler } from '../../src/app/api/runs/[runId]/route';
import { POST as cancelRunHandler } from '../../src/app/api/runs/[runId]/cancel/route';
import { dispatchRunRequested } from '../../src/inngest/client';
import {
  setupFixture,
  ALICE,
  BOB,
  postMatrixSession,
  postWorkspace,
  bindRoom,
  sessionCookie,
  internalUserId,
} from '../auth/support';
import { repositoryReaderProfile } from '../../src/agents/specialists/repository-reader';
import { issueReaderProfile } from '../../src/agents/specialists/issue-reader';
import { computeExecutionKey } from '../../src/workflows/run-workflow';

vi.mock('../../src/inngest/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/inngest/client')>();
  return {
    ...actual,
    dispatchRunRequested: vi.fn(async () => undefined),
  };
});

const dispatchMock = vi.mocked(dispatchRunRequested);
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
type ApiErrorBody = { error: { code: string; message: string } };
type RunBody = {
  runId: string;
  status: string;
  roomId?: string;
  nextSequence?: number;
  requestId?: string;
  workspaceId?: string;
  mode?: string;
  lastSequence?: number;
  cancelRequestedAt?: string | null;
  terminalSummary?: Record<string, unknown> | null;
  specialists?: Array<{ specialistId: string; ordinal: number; status: string }>;
};
const readJson = async <T,>(res: NextResponse): Promise<T> => (await res.json()) as T;

let aliceCookie: string;
let bobCookie: string;
let aliceUserId: string;
let workspaceId: string;
let roomId: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  roomId = fixture.roomId;
  const aliceSession = await postMatrixSession({ accessToken: fixture.aliceToken });
  const bobSession = await postMatrixSession({ accessToken: fixture.bobToken });
  aliceCookie = sessionCookie(aliceSession);
  bobCookie = sessionCookie(bobSession);
  aliceUserId = await internalUserId(ALICE.userId);

  const ws = await postWorkspace({ name: 'Run Workspace', cookie: aliceCookie });
  expect(ws.status).toBe(201);
  workspaceId = (await readJson<{ workspaceId: string }>(ws)).workspaceId;

  const binding = await bindRoom(roomId, workspaceId, aliceCookie);
  expect(binding.status).toBe(201);

  // Seed the specialist catalog for this workspace (provisioning path).
  await withTenant(aliceUserId, async (client) => {
    for (const profile of [repositoryReaderProfile, issueReaderProfile]) {
      await client.query(
        `INSERT INTO specialist_agents
           (id, workspace_id, name, model, gateway_provider, system_policy,
            tools_allowlist, timeout_ms, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         ON CONFLICT (id) DO NOTHING`,
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
  });
});

function jsonRequest(path: string, method: string, body?: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function postRun(
  wsId: string,
  cookie: string | undefined,
  body: Record<string, unknown>,
): Promise<NextResponse> {
  const req = jsonRequest(`/api/workspaces/${wsId}/runs`, 'POST', body, cookie);
  return postRunHandler(req, { params: Promise.resolve({ workspaceId: wsId }) });
}

async function getRun(runId: string, cookie: string | undefined): Promise<NextResponse> {
  const req = jsonRequest(`/api/runs/${runId}`, 'GET', undefined, cookie);
  return getRunHandler(req, { params: Promise.resolve({ runId }) });
}

async function cancelRun(runId: string, cookie: string | undefined): Promise<NextResponse> {
  const req = jsonRequest(`/api/runs/${runId}/cancel`, 'POST', {}, cookie);
  return cancelRunHandler(req, { params: Promise.resolve({ runId }) });
}

const validBody = (): Record<string, unknown> => ({
  roomId,
  prompt: 'Summarize the open issues',
  mode: 'parallel',
  specialistIds: ['repo-reader', 'issue-reader'],
  githubContext: { repository: 'acme/widget' },
});

describe('POST /api/workspaces/:workspaceId/runs', () => {
  it('returns 401 without a session', async () => {
    const res = await postRun(workspaceId, undefined, validBody());
    expect(res.status).toBe(401);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('denies non-members with 403 WORKSPACE_ACCESS_DENIED', async () => {
    const res = await postRun(workspaceId, bobCookie, validBody());
    expect(res.status).toBe(403);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('WORKSPACE_ACCESS_DENIED');
  });

  it('rejects an unbound room with 409 ROOM_NOT_BOUND', async () => {
    const res = await postRun(workspaceId, aliceCookie, {
      ...validBody(),
      roomId: '!unbound:example.test',
    });
    expect(res.status).toBe(409);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('ROOM_NOT_BOUND');
  });

  it('rejects unknown specialists with 422 INVALID_SPECIALIST_CONFIGURATION', async () => {
    const res = await postRun(workspaceId, aliceCookie, {
      ...validBody(),
      specialistIds: ['repo-reader', 'missing-reader'],
    });
    expect(res.status).toBe(422);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('INVALID_SPECIALIST_CONFIGURATION');
  });

  it('rejects a request without a room with 422 VALIDATION_ERROR', async () => {
    const body = validBody();
    delete body.roomId;
    const res = await postRun(workspaceId, aliceCookie, body);
    expect(res.status).toBe(422);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('VALIDATION_ERROR');
  });

  it('creates a queued run with a snapshot, prompt hash, and workflow event', async () => {
    dispatchMock.mockClear();
    const res = await postRun(workspaceId, aliceCookie, validBody());
    expect(res.status).toBe(202);
    const body = await readJson<RunBody>(res);
    expect(body).toMatchObject({
      runId: expect.stringMatching(/^run_/),
      status: 'queued',
      roomId,
      nextSequence: 1,
    });
    expect(body.requestId).toMatch(/^req_/);

    const runId = body.runId as string;
    const { rows } = await getAdminPool().query(
      'SELECT * FROM runs WHERE id = $1',
      [runId],
    );
    expect(rows).toHaveLength(1);
    const run = rows[0];
    expect(run.prompt_hash).toBe(sha256('Summarize the open issues'));
    expect(run.mode).toBe('parallel');
    expect(run.status).toBe('queued');
    expect(run.config_snapshot.promptInjectionMode).toBe('fail_run');
    expect(run.config_snapshot.specialists.map((s: { id: string }) => s.id)).toEqual([
      'repo-reader',
      'issue-reader',
    ]);
    expect(run.config_snapshot.specialists[0].toolsAllowlist).toEqual(['read_repository']);

    const specialists = await getAdminPool().query(
      'SELECT specialist_id, ordinal FROM run_specialists WHERE run_id = $1 ORDER BY ordinal',
      [runId],
    );
    expect(specialists.rows.map((r) => r.specialist_id)).toEqual([
      'repo-reader',
      'issue-reader',
    ]);

    const events = await getAdminPool().query(
      'SELECT sequence, event_type FROM run_events WHERE run_id = $1 ORDER BY sequence',
      [runId],
    );
    expect(
      events.rows.map((r) => ({ sequence: Number(r.sequence), event_type: r.event_type })),
    ).toEqual([{ sequence: 1, event_type: 'run.queued' }]);

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const dispatched = dispatchMock.mock.calls[0][0];
    expect(dispatched).toMatchObject({
      name: 'agent.run.requested',
      data: {
        runId,
        workspaceId,
        userId: aliceUserId,
        prompt: 'Summarize the open issues',
      },
    });
    expect(dispatched.data.executionKey).toBe(
      computeExecutionKey(runId, run.prompt_hash, run.config_snapshot),
    );
  });

  it('replays an existing run for the same idempotency key without a second run', async () => {
    const first = await postRun(workspaceId, aliceCookie, {
      ...validBody(),
      idempotencyKey: 'idem-run-1',
    });
    expect(first.status).toBe(202);
    const firstBody = await readJson<RunBody>(first);

    // Only the first request dispatches the workflow event; the replay must not.
    dispatchMock.mockClear();
    const second = await postRun(workspaceId, aliceCookie, {
      ...validBody(),
      idempotencyKey: 'idem-run-1',
    });
    expect(second.status).toBe(200);
    const secondBody = await readJson<RunBody>(second);
    expect(secondBody.runId).toBe(firstBody.runId);

    const { rows } = await getAdminPool().query(
      'SELECT count(*)::int AS n FROM runs WHERE workspace_id = $1 AND idempotency_key = $2',
      [workspaceId, 'idem-run-1'],
    );
    expect(rows[0].n).toBe(1);
    expect(dispatchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/runs/:runId', () => {
  it('returns the run with specialist statuses and sequence cursor', async () => {
    const created = await postRun(workspaceId, aliceCookie, validBody());
    const runId = (await readJson<RunBody>(created)).runId;

    const res = await getRun(runId, aliceCookie);
    expect(res.status).toBe(200);
    const body = await readJson<RunBody>(res);
    expect(body).toMatchObject({
      runId,
      status: 'queued',
      mode: 'parallel',
      workspaceId,
      roomId,
      lastSequence: 1,
      cancelRequestedAt: null,
    });
    expect((body.specialists ?? []).map((s: { specialistId: string }) => s.specialistId)).toEqual([
      'repo-reader',
      'issue-reader',
    ]);
    expect((body.specialists ?? []).map((s: { ordinal: number }) => s.ordinal)).toEqual([0, 1]);
  });

  it('hides the run from non-members with 404 without revealing existence', async () => {
    const created = await postRun(workspaceId, aliceCookie, validBody());
    const runId = (await readJson<RunBody>(created)).runId;

    const res = await getRun(runId, bobCookie);
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('returns 404 for a missing run', async () => {
    const res = await getRun('run_does_not_exist', aliceCookie);
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('RUN_NOT_FOUND');
  });

  it('requires a session', async () => {
    const res = await getRun('run_anything', undefined);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/runs/:runId/cancel', () => {
  it('cancels a queued run cooperatively with one terminal event', async () => {
    const created = await postRun(workspaceId, aliceCookie, validBody());
    const runId = (await readJson<RunBody>(created)).runId;

    const res = await cancelRun(runId, aliceCookie);
    expect(res.status).toBe(202);
    const body = await readJson<RunBody>(res);
    expect(body).toMatchObject({ runId, status: 'cancellation_requested' });

    const { rows } = await getAdminPool().query(
      'SELECT status, cancel_requested_at FROM runs WHERE id = $1',
      [runId],
    );
    expect(rows[0].status).toBe('cancelled');
    expect(rows[0].cancel_requested_at).not.toBeNull();

    const events = await getAdminPool().query(
      'SELECT event_type FROM run_events WHERE run_id = $1 ORDER BY sequence',
      [runId],
    );
    expect(
      events.rows.filter((r) => r.event_type === 'run.cancelled'),
    ).toHaveLength(1);

    const second = await cancelRun(runId, aliceCookie);
    expect(second.status).toBe(409);
    expect((await readJson<ApiErrorBody>(second)).error.code).toBe('RUN_ALREADY_TERMINAL');

    const after = await getAdminPool().query(
      "SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND event_type = 'run.cancelled'",
      [runId],
    );
    expect(after.rows[0].n).toBe(1);

    const fetched = await getRun(runId, aliceCookie);
    expect((await readJson<RunBody>(fetched)).status).toBe('cancelled');
  });

  it('records intent for a running run and emits one cancellation_requested event', async () => {
    const created = await postRun(workspaceId, aliceCookie, validBody());
    const runId = (await readJson<RunBody>(created)).runId;
    await getAdminPool().query("UPDATE runs SET status = 'running' WHERE id = $1", [runId]);

    const res = await cancelRun(runId, aliceCookie);
    expect(res.status).toBe(202);
    expect(await readJson<RunBody>(res)).toMatchObject({
      runId,
      status: 'cancellation_requested',
    });

    const { rows } = await getAdminPool().query(
      'SELECT status FROM runs WHERE id = $1',
      [runId],
    );
    expect(rows[0].status).toBe('cancelling');

    const events = await getAdminPool().query(
      'SELECT event_type FROM run_events WHERE run_id = $1 ORDER BY sequence',
      [runId],
    );
    expect(
      events.rows.filter((r) => r.event_type === 'run.cancellation_requested'),
    ).toHaveLength(1);

    // Repeating the cancel records intent only once.
    const second = await cancelRun(runId, aliceCookie);
    expect(second.status).toBe(202);
    const again = await getAdminPool().query(
      "SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND event_type = 'run.cancellation_requested'",
      [runId],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it('denies cancellation by non-members with 404', async () => {
    const created = await postRun(workspaceId, aliceCookie, validBody());
    const runId = (await readJson<RunBody>(created)).runId;

    const res = await cancelRun(runId, bobCookie);
    expect(res.status).toBe(404);
    expect((await readJson<ApiErrorBody>(res)).error.code).toBe('RUN_NOT_FOUND');
  });
});
