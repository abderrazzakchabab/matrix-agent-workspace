/**
 * Terminal delivery acceptance tests.
 *
 * Completed, failed, partial, and cancelled runs each produce a distinct
 * terminal message delivered to the explicitly bound room. Progress events are
 * rendered with secrets redacted. Uses the real PostgreSQL fixture (outbox,
 * RLS, encrypted session, persisted binding) with an in-memory Matrix client.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdminPool } from '../../src/db/client';
import { createRun } from '../../src/db/repositories/run-repository';
import { publishEvent } from '../../src/events/event-service';
import { deliverPending } from '../../src/matrix/delivery-worker';
import type {
  MatrixDeliveryClient,
  MatrixSendParams,
  MatrixSendResult,
} from '../../src/matrix/client';
import { createSession } from '../../src/auth/session-service';
import { setupDb, createUser, createWorkspace } from '../db/support';

const HOMESERVER = 'https://example.test';
const ROOM_ID = '!room:example.test';

class FixtureMatrixClient implements MatrixDeliveryClient {
  sends: MatrixSendParams[] = [];

  async sendMessage(params: MatrixSendParams): Promise<MatrixSendResult> {
    this.sends.push(params);
    return { eventId: `m_evt_${this.sends.length}` };
  }
}

let ownerId: string;
let workspaceId: string;

beforeAll(async () => {
  await setupDb();
  ownerId = await createUser('@alice:example.test', HOMESERVER);
  workspaceId = await createWorkspace(ownerId, 'Terminal Delivery Workspace');
  await createSession(ownerId, 'syt_alice_terminal', new Date(Date.now() + 3600_000));
  await getAdminPool().query(
    'INSERT INTO rooms (room_id, homeserver_url) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [ROOM_ID, HOMESERVER],
  );
  await getAdminPool().query(
    `INSERT INTO room_bindings (room_id, homeserver_url, workspace_id, user_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [ROOM_ID, HOMESERVER, workspaceId, ownerId],
  );
});

async function deliverTerminal(
  status: 'completed' | 'failed' | 'partial' | 'cancelled',
  type: string,
): Promise<{ text: string; runId: string }> {
  const runId = `run_${randomUUID()}`;
  await createRun(
    { userId: ownerId, workspaceId },
    { id: runId, roomId: ROOM_ID, promptHash: 'hash', mode: 'parallel' },
  );
  await getAdminPool().query('UPDATE runs SET status = $1 WHERE id = $2', [status, runId]);
  await publishEvent({ userId: ownerId, workspaceId }, runId, {
    id: `evt_${randomUUID()}`,
    type,
    version: 1,
    payload: {
      completedSpecialists: ['repo-reader'],
      failedSpecialists: status === 'partial' ? [{ specialistId: 'issue-reader', errorCode: 'X' }] : [],
    },
  });

  const client = new FixtureMatrixClient();
  const report = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
  expect(report.delivered).toBe(1);
  expect(client.sends).toHaveLength(1);
  expect(client.sends[0].roomId).toBe(ROOM_ID);
  return { text: client.sends[0].body, runId };
}

describe('terminal message delivery', () => {
  it('sends a completed terminal message to the bound room', async () => {
    const { text, runId } = await deliverTerminal('completed', 'run.completed');
    expect(text).toContain('Run completed');
    expect(text).toContain(runId);
  });

  it('sends a failed terminal message to the bound room', async () => {
    const { text, runId } = await deliverTerminal('failed', 'run.failed');
    expect(text).toContain('Run failed');
    expect(text).toContain(runId);
  });

  it('sends a partial terminal message to the bound room', async () => {
    const { text, runId } = await deliverTerminal('partial', 'run.partial');
    expect(text).toContain('partial');
    expect(text).toContain(runId);
  });

  it('sends a cancelled terminal message to the bound room', async () => {
    const { text, runId } = await deliverTerminal('cancelled', 'run.cancelled');
    expect(text).toContain('Run cancelled');
    expect(text).toContain(runId);
  });
});

describe('progress message rendering', () => {
  it('redacts secret-shaped progress payload content', async () => {
    const runId = `run_${randomUUID()}`;
    await createRun(
      { userId: ownerId, workspaceId },
      { id: runId, roomId: ROOM_ID, promptHash: 'hash', mode: 'parallel' },
    );
    await publishEvent({ userId: ownerId, workspaceId }, runId, {
      id: `evt_${randomUUID()}`,
      type: 'specialist.progress',
      version: 1,
      payload: { specialistId: 'repo-reader', summary: 'result with token syt_secret_abc123' },
    });

    const client = new FixtureMatrixClient();
    await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(client.sends).toHaveLength(1);
    expect(client.sends[0].body).toContain('[REDACTED]');
    expect(client.sends[0].body).not.toContain('syt_secret_abc123');
  });
});
