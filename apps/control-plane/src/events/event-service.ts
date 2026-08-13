/**
 * Persisted event publishing.
 *
 * `publishEvent` allocates the next per-run `run_events.sequence` (via the
 * `append_run_event` SECURITY DEFINER helper) and, in the same transaction,
 * enqueues an outbox message for the bound Matrix room. The outbox delivery
 * key is `runId:sequence:roomId`, so a logical send is at most once per
 * `(run, sequence, room)` even across worker retries.
 *
 * Events are the source of truth for SSE replay; the outbox is consumed only
 * by the Matrix delivery worker.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTenant } from '../db/client';
import type { TenantContext } from '../db/repositories/run-repository';
import type { RunEventRow } from '../db/schema/events';
import { OUTBOX_MESSAGES } from '../db/schema/outbox';
import { dispatchMatrixDeliveryRequested } from '../inngest/functions/deliver-matrix-event';

export interface PublishEventInput {
  id: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  visibility?: string;
}

export interface PublishEventResult {
  sequence: number;
  outboxEnqueued: boolean;
}

/** JSON shape emitted on the SSE wire (matches the `RunEvent` contract). */
export interface RunEventJson {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  version: number;
  occurredAt: string;
  visibility: string;
  payload: Record<string, unknown>;
}

function normalizeOccurredAt(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    return value;
  }
  return new Date().toISOString();
}

/** Map a persisted event row to the JSON shape streamed to SSE clients. */
export function toRunEvent(row: RunEventRow): RunEventJson {
  return {
    id: row.id,
    runId: row.runId,
    sequence: row.sequence,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: normalizeOccurredAt(row.createdAt),
    visibility: row.visibility,
    payload: row.payload,
  };
}

function mapEventRow(row: Record<string, unknown>): RunEventRow {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    sequence: Number(row.sequence),
    eventType: row.event_type as string,
    eventVersion: Number(row.event_version),
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    visibility: row.visibility as string,
    createdAt: row.created_at as string,
  };
}

/**
 * Enqueue the Matrix delivery for an already-persisted event while the caller's
 * transaction is still open. Terminal workflow transitions use this helper so
 * status, terminal event, and delivery remain one atomic commit.
 */
export async function enqueueMatrixDeliveryWithClient(
  client: PoolClient,
  workspaceId: string,
  runId: string,
  sequence: number,
): Promise<boolean> {
  const roomRes = await client.query(
    'SELECT room_id FROM runs WHERE id = $1 AND workspace_id = $2',
    [runId, workspaceId],
  );
  const roomId = (roomRes.rows[0]?.room_id as string | null) ?? null;
  if (!roomId) return false;
  const inserted = await client.query(
    `INSERT INTO ${OUTBOX_MESSAGES.table}
       (${OUTBOX_MESSAGES.id}, ${OUTBOX_MESSAGES.workspaceId},
        ${OUTBOX_MESSAGES.aggregateKey}, ${OUTBOX_MESSAGES.destination},
        ${OUTBOX_MESSAGES.eventSequence}, ${OUTBOX_MESSAGES.deliveryKey},
        ${OUTBOX_MESSAGES.status}, ${OUTBOX_MESSAGES.attempts})
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', 0)
     ON CONFLICT (${OUTBOX_MESSAGES.deliveryKey}) DO NOTHING
     RETURNING ${OUTBOX_MESSAGES.id}`,
    [
      `om_${randomUUID()}`,
      workspaceId,
      runId,
      roomId,
      sequence,
      `${runId}:${sequence}:${roomId}`,
    ],
  );
  return inserted.rows.length > 0;
}

/**
 * Persist an event and enqueue its Matrix delivery atomically. Returns the
 * allocated sequence and whether an outbox message was enqueued (only when the
 * run has a bound room).
 */
export async function publishEvent(
  tenant: TenantContext,
  runId: string,
  input: PublishEventInput,
): Promise<PublishEventResult> {
  const result = await withTenant(tenant.userId, async (client) => {
    const seqRes = await client.query(
      'SELECT append_run_event($1, $2, $3, $4, $5, $6) AS sequence',
      [
        runId,
        input.id,
        input.type,
        input.version,
        JSON.stringify(input.payload),
        input.visibility ?? 'room_and_owner',
      ],
    );
    const sequence = Number(seqRes.rows[0].sequence);
    const outboxEnqueued = await enqueueMatrixDeliveryWithClient(
      client,
      tenant.workspaceId,
      runId,
      sequence,
    );
    return { sequence, outboxEnqueued };
  });

  // The outbox row is committed before the delivery trigger fires.
  await dispatchMatrixDeliveryRequested({
    workspaceId: tenant.workspaceId,
    userId: tenant.userId,
    runId,
  });
  return result;
}

export interface EventPage {
  events: RunEventRow[];
  hasMore: boolean;
  lastSequence: number;
}

/** Replay a bounded page of a run's events after `afterSequence`. */
export async function listEventsPage(
  tenant: TenantContext,
  runId: string,
  afterSequence = 0,
  limit = 100,
): Promise<EventPage> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM run_events
        WHERE run_id = $1 AND sequence > $2
        ORDER BY sequence ASC
        LIMIT $3`,
      [runId, afterSequence, limit + 1],
    );
    const hasMore = rows.length > limit;
    const events = (hasMore ? rows.slice(0, limit) : rows).map(mapEventRow);
    const lastSequence =
      events.length > 0 ? events[events.length - 1]!.sequence : afterSequence;
    return { events, hasMore, lastSequence };
  });
}
