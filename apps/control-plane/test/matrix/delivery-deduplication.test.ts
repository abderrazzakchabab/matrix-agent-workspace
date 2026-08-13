/**
 * Matrix delivery deduplication acceptance tests.
 *
 * The outbox-backed worker must send one logical message per
 * `(run_id, sequence, room_id)` delivery key: a second worker run is a no-op,
 * and a transient Matrix 5xx/429 is retried without duplicating the logical
 * send. Delivery failures never rerun agent work — the worker only touches the
 * outbox. Uses the real PostgreSQL fixture (outbox, RLS, encrypted session)
 * with an in-memory Matrix client fixture.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdminPool } from '../../src/db/client';
import { createRun } from '../../src/db/repositories/run-repository';
import { publishEvent } from '../../src/events/event-service';
import { deliverPending } from '../../src/matrix/delivery-worker';
import {
  MatrixSendError,
  type MatrixDeliveryClient,
  type MatrixSendParams,
  type MatrixSendResult,
} from '../../src/matrix/client';
import { createSession } from '../../src/auth/session-service';
import { setupDb, createUser, createWorkspace } from '../db/support';

const HOMESERVER = 'https://example.test';
const ROOM_ID = '!room:example.test';

class FixtureMatrixClient implements MatrixDeliveryClient {
  sends: MatrixSendParams[] = [];
  attempts: MatrixSendParams[] = [];
  private failWith = new Map<string, { status: number; remaining: number }>();

  get sentKeys(): string[] {
    return this.sends.map((s) => s.deliveryKey);
  }

  get attemptedKeys(): string[] {
    return this.attempts.map((s) => s.deliveryKey);
  }

  failNext(key: string, status: number): void {
    const current = this.failWith.get(key) ?? { status, remaining: 0 };
    this.failWith.set(key, { status, remaining: current.remaining + 1 });
  }

  async sendMessage(params: MatrixSendParams): Promise<MatrixSendResult> {
    this.attempts.push(params);
    const failure = this.failWith.get(params.deliveryKey);
    if (failure && failure.remaining > 0) {
      failure.remaining -= 1;
      throw new MatrixSendError(
        'boom',
        failure.status,
        failure.status === 429 || failure.status >= 500,
      );
    }
    this.sends.push(params);
    return { eventId: `m_evt_${this.sends.length}` };
  }
}

let ownerId: string;
let workspaceId: string;

beforeAll(async () => {
  await setupDb();
  ownerId = await createUser('@alice:example.test', HOMESERVER);
  workspaceId = await createWorkspace(ownerId, 'Delivery Workspace');
  // Encrypted Matrix session token the worker must decrypt from persistence.
  await createSession(ownerId, 'syt_alice_delivery', new Date(Date.now() + 3600_000));
  // Persisted room + explicit binding.
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

async function makeRunWithProgressEvent(): Promise<{ runId: string; deliveryKey: string }> {
  const runId = `run_${randomUUID()}`;
  await createRun(
    { userId: ownerId, workspaceId },
    { id: runId, roomId: ROOM_ID, promptHash: 'hash', mode: 'parallel' },
  );
  const { sequence } = await publishEvent(
    { userId: ownerId, workspaceId },
    runId,
    {
      id: `evt_${randomUUID()}`,
      type: 'specialist.progress',
      version: 1,
      payload: { specialistId: 'repo-reader', summary: 'working' },
    },
  );
  return { runId, deliveryKey: `${runId}:${sequence}:${ROOM_ID}` };
}

describe('Matrix delivery deduplication', () => {
  it('sends one message for one (run, sequence, room) key across two worker runs', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const client = new FixtureMatrixClient();

    const first = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(first.delivered).toBe(1);

    const second = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(second.delivered).toBe(0);

    expect(client.sentKeys).toEqual([deliveryKey]);
    expect(client.attemptedKeys).toEqual([deliveryKey]);
  });

  it('throws on a transient Matrix 503 so Inngest retries the drain without duplicating the logical send', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const client = new FixtureMatrixClient();
    client.failNext(deliveryKey, 503);

    await expect(
      deliverPending({ userId: ownerId, workspaceId }, { matrix: client }),
    ).rejects.toMatchObject({ status: 503 });
    expect(client.sentKeys).toEqual([]);

    // Inngest re-invokes the drain on retry; the still-pending message sends once.
    const second = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(second.delivered).toBe(1);

    expect(client.sentKeys).toEqual([deliveryKey]);
    expect(client.attemptedKeys).toEqual([deliveryKey, deliveryKey]);
  });

  it('marks a non-retryable Matrix 403 as failed and never resends it', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const client = new FixtureMatrixClient();
    client.failNext(deliveryKey, 403);

    const first = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(first.failed).toBe(1);

    const second = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(second.delivered).toBe(0);

    expect(client.sentKeys).toEqual([]);
    expect(client.attemptedKeys).toEqual([deliveryKey]);
  });

  it('never changes the run status when delivery fails', async () => {
    const { runId, deliveryKey } = await makeRunWithProgressEvent();
    await getAdminPool().query("UPDATE runs SET status = 'running' WHERE id = $1", [runId]);

    const client = new FixtureMatrixClient();
    client.failNext(deliveryKey, 403);
    await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });

    const { rows } = await getAdminPool().query('SELECT status FROM runs WHERE id = $1', [runId]);
    expect(rows[0].status).toBe('running');
  });
});
