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
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getAdminPool } from '../../src/db/client';
import { createRun } from '../../src/db/repositories/run-repository';
import { publishEvent } from '../../src/events/event-service';
import {
  deliverPending,
  sweepPendingMatrixDeliveries,
} from '../../src/matrix/delivery-worker';
import { inngest } from '../../src/inngest/client';
import {
  MatrixSendError,
  SynapseDeliveryClient,
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

async function waitForBlockedTenantClaim(): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const { rows } = await getAdminPool().query(
      `SELECT EXISTS (
         SELECT 1
           FROM pg_stat_activity
          WHERE usename = 'matrix_app'
            AND wait_event_type = 'Lock'
       ) AS blocked`,
    );
    if (rows[0]?.blocked === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for blocked Matrix outbox claim');
}

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

  it('sweeps a committed message after its immediate dispatch fails', async () => {
    const runId = `run_${randomUUID()}`;
    await createRun(
      { userId: ownerId, workspaceId },
      { id: runId, roomId: ROOM_ID, promptHash: 'hash', mode: 'parallel' },
    );
    const previousEventKey = process.env.INNGEST_EVENT_KEY;
    process.env.INNGEST_EVENT_KEY = 'fixture-event-key';
    const send = vi.spyOn(inngest, 'send').mockRejectedValueOnce(new Error('unavailable'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const published = await publishEvent(
        { userId: ownerId, workspaceId },
        runId,
        {
          id: `evt_${randomUUID()}`,
          type: 'specialist.started',
          version: 1,
          payload: { specialistId: 'repo-reader' },
        },
      );
      const pending = await getAdminPool().query(
        'SELECT status FROM outbox_messages WHERE delivery_key = $1',
        [`${runId}:${published.sequence}:${ROOM_ID}`],
      );
      expect(pending.rows).toEqual([{ status: 'pending' }]);

      const client = new FixtureMatrixClient();
      const swept = await sweepPendingMatrixDeliveries({ matrix: client });
      expect(swept.delivered).toBe(1);
      expect(client.sentKeys).toEqual([`${runId}:${published.sequence}:${ROOM_ID}`]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      log.mockRestore();
      if (previousEventKey === undefined) delete process.env.INNGEST_EVENT_KEY;
      else process.env.INNGEST_EVENT_KEY = previousEventKey;
    }
  });

  it('isolates retryable tenant failures and retries them after persisted backoff', async () => {
    const first = await makeRunWithProgressEvent();
    const secondOwnerId = await createUser(`@bob-${randomUUID()}:example.test`, HOMESERVER);
    const secondWorkspaceId = await createWorkspace(secondOwnerId, 'Second Delivery Workspace');
    const secondRoomId = `!room-${randomUUID()}:example.test`;
    await createSession(
      secondOwnerId,
      'syt_bob_delivery',
      new Date(Date.now() + 3600_000),
    );
    await getAdminPool().query(
      'INSERT INTO rooms (room_id, homeserver_url) VALUES ($1, $2)',
      [secondRoomId, HOMESERVER],
    );
    await getAdminPool().query(
      `INSERT INTO room_bindings (room_id, homeserver_url, workspace_id, user_id)
       VALUES ($1, $2, $3, $4)`,
      [secondRoomId, HOMESERVER, secondWorkspaceId, secondOwnerId],
    );
    const secondRunId = `run_${randomUUID()}`;
    await createRun(
      { userId: secondOwnerId, workspaceId: secondWorkspaceId },
      { id: secondRunId, roomId: secondRoomId, promptHash: 'hash', mode: 'parallel' },
    );
    const secondEvent = await publishEvent(
      { userId: secondOwnerId, workspaceId: secondWorkspaceId },
      secondRunId,
      {
        id: `evt_${randomUUID()}`,
        type: 'specialist.progress',
        version: 1,
        payload: { specialistId: 'repo-reader', summary: 'working' },
      },
    );
    const secondDeliveryKey = `${secondRunId}:${secondEvent.sequence}:${secondRoomId}`;
    const client = new FixtureMatrixClient();
    client.failNext(first.deliveryKey, 503);

    const swept = await sweepPendingMatrixDeliveries({ matrix: client });
    expect(swept.delivered).toBe(1);
    expect(client.sentKeys).toEqual([secondDeliveryKey]);

    const deferred = await getAdminPool().query(
      `SELECT status, attempts, next_attempt_at > now() AS deferred
         FROM outbox_messages WHERE delivery_key = $1`,
      [first.deliveryKey],
    );
    expect(deferred.rows).toEqual([{ status: 'pending', attempts: 1, deferred: true }]);

    const immediateSweep = await sweepPendingMatrixDeliveries({ matrix: client });
    expect(immediateSweep.delivered).toBe(0);
    expect(client.attemptedKeys).toHaveLength(2);

    await getAdminPool().query(
      `UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second'
        WHERE delivery_key = $1`,
      [first.deliveryKey],
    );
    const retried = await sweepPendingMatrixDeliveries({ matrix: client });
    expect(retried.delivered).toBe(1);
    expect(new Set(client.sentKeys)).toEqual(
      new Set([first.deliveryKey, secondDeliveryKey]),
    );
    expect(client.attemptedKeys.filter((key) => key === first.deliveryKey)).toHaveLength(2);
    expect(client.attemptedKeys.filter((key) => key === secondDeliveryKey)).toHaveLength(1);

    const delivered = await getAdminPool().query(
      `SELECT status, attempts, next_attempt_at
         FROM outbox_messages WHERE delivery_key = $1`,
      [first.deliveryKey],
    );
    expect(delivered.rows).toEqual([
      { status: 'delivered', attempts: 2, next_attempt_at: null },
    ]);
  });

  it('stops a tenant drain behind a deferred earlier sequence', async () => {
    const { runId, deliveryKey } = await makeRunWithProgressEvent();
    const laterEvent = await publishEvent(
      { userId: ownerId, workspaceId },
      runId,
      {
        id: `evt_${randomUUID()}`,
        type: 'run.completed',
        version: 1,
        payload: { summary: 'done' },
      },
    );
    const laterDeliveryKey = `${runId}:${laterEvent.sequence}:${ROOM_ID}`;
    const client = new FixtureMatrixClient();
    client.failNext(deliveryKey, 503);

    await expect(
      deliverPending({ userId: ownerId, workspaceId }, { matrix: client }),
    ).rejects.toMatchObject({ status: 503 });
    expect(client.attemptedKeys).toEqual([deliveryKey]);

    const immediate = await deliverPending(
      { userId: ownerId, workspaceId },
      { matrix: client },
    );
    expect(immediate.delivered).toBe(0);
    expect(client.attemptedKeys).toEqual([deliveryKey]);

    await getAdminPool().query(
      `UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second'
        WHERE delivery_key = $1`,
      [deliveryKey],
    );
    const retried = await deliverPending(
      { userId: ownerId, workspaceId },
      { matrix: client },
    );
    expect(retried.delivered).toBe(2);
    expect(client.sentKeys).toEqual([deliveryKey, laterDeliveryKey]);
    expect(client.attemptedKeys).toEqual([deliveryKey, deliveryKey, laterDeliveryKey]);
  });

  it('rejects a stale later candidate after an earlier sequence is deferred', async () => {
    const { runId, deliveryKey } = await makeRunWithProgressEvent();
    const laterEvent = await publishEvent(
      { userId: ownerId, workspaceId },
      runId,
      {
        id: `evt_${randomUUID()}`,
        type: 'run.completed',
        version: 1,
        payload: { summary: 'done' },
      },
    );
    const laterDeliveryKey = `${runId}:${laterEvent.sequence}:${ROOM_ID}`;
    const lockClient = await getAdminPool().connect();
    const client = new FixtureMatrixClient();
    let drain: Promise<{ delivered: number }> | undefined;
    let transactionOpen = false;

    try {
      await lockClient.query('BEGIN');
      transactionOpen = true;
      await lockClient.query(
        'SELECT id FROM outbox_messages WHERE delivery_key = $1 FOR UPDATE',
        [deliveryKey],
      );

      drain = deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
      await waitForBlockedTenantClaim();
      await lockClient.query(
        `UPDATE outbox_messages
            SET attempts = attempts + 1,
                next_attempt_at = now() + interval '5 seconds'
          WHERE delivery_key = $1`,
        [deliveryKey],
      );
      await lockClient.query('COMMIT');
      transactionOpen = false;

      expect((await drain).delivered).toBe(0);
      expect(client.attemptedKeys).toEqual([]);
      const later = await getAdminPool().query(
        'SELECT status FROM outbox_messages WHERE delivery_key = $1',
        [laterDeliveryKey],
      );
      expect(later.rows).toEqual([{ status: 'pending' }]);
    } finally {
      if (transactionOpen) await lockClient.query('ROLLBACK').catch(() => undefined);
      lockClient.release();
      await drain?.catch(() => undefined);
    }
  });

  it('defers rejected fetch transport failures for retry', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const fetchMock = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        deliverPending(
          { userId: ownerId, workspaceId },
          { matrix: new SynapseDeliveryClient(undefined, 100) },
        ),
      ).rejects.toMatchObject({ status: 0, retryable: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const deferred = await getAdminPool().query(
        `SELECT status, attempts, next_attempt_at > now() AS deferred
           FROM outbox_messages WHERE delivery_key = $1`,
        [deliveryKey],
      );
      expect(deferred.rows).toEqual([{ status: 'pending', attempts: 1, deferred: true }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('times out Matrix transport and defers the delivery for retry', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error('missing abort signal'));
          return;
        }
        const rejectOnAbort = () => reject(signal.reason);
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(
        deliverPending(
          { userId: ownerId, workspaceId },
          { matrix: new SynapseDeliveryClient(undefined, 5) },
        ),
      ).rejects.toMatchObject({ status: 0, retryable: true });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);

      const deferred = await getAdminPool().query(
        `SELECT status, attempts, next_attempt_at > now() AS deferred
           FROM outbox_messages WHERE delivery_key = $1`,
        [deliveryKey],
      );
      expect(deferred.rows).toEqual([{ status: 'pending', attempts: 1, deferred: true }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('throws on a transient Matrix 503 and defers the next drain attempt', async () => {
    const { deliveryKey } = await makeRunWithProgressEvent();
    const client = new FixtureMatrixClient();
    client.failNext(deliveryKey, 503);

    await expect(
      deliverPending({ userId: ownerId, workspaceId }, { matrix: client }),
    ).rejects.toMatchObject({ status: 503 });
    expect(client.sentKeys).toEqual([]);

    const deferred = await getAdminPool().query(
      `SELECT status, attempts, next_attempt_at > now() AS deferred
         FROM outbox_messages WHERE delivery_key = $1`,
      [deliveryKey],
    );
    expect(deferred.rows).toEqual([{ status: 'pending', attempts: 1, deferred: true }]);

    const second = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(second.delivered).toBe(0);

    await getAdminPool().query(
      `UPDATE outbox_messages SET next_attempt_at = now() - interval '1 second'
        WHERE delivery_key = $1`,
      [deliveryKey],
    );
    const third = await deliverPending({ userId: ownerId, workspaceId }, { matrix: client });
    expect(third.delivered).toBe(1);

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
