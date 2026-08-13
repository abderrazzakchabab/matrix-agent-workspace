/**
 * Outbox-backed Matrix delivery worker.
 *
 * Claims pending outbox messages for the tenant's workspace (only messages
 * whose run is owned by the tenant, so each owner's encrypted session token is
 * resolvable under RLS), loads the room from the persisted explicit binding,
 * renders the event, and sends it through the injected Matrix client.
 *
 * Delivery semantics:
 * - a message is delivered at most once per `(run_id, sequence, room_id)` key;
 * - transient Matrix 5xx/429 failures schedule a bounded backoff retry without
 *   duplicating the logical send (the delivery key is the Matrix txn id);
 * - non-retryable failures and poison messages are marked terminal and never
 *   resend; the run's status is never touched, so a failed delivery never
 *   reruns agent work.
 */
import type { PoolClient } from 'pg';
import { withTenant } from '../db/client';
import type { TenantContext } from '../db/repositories/run-repository';
import { OUTBOX_MESSAGES } from '../db/schema/outbox';
import { renderMessage } from './message-renderer';
import {
  getMatrixDeliveryClient,
  isMatrixTokenUnavailable,
  isRetryableMatrixError,
  resolveMatrixAccessToken,
  type MatrixDeliveryClient,
} from './client';

export interface DeliveryOptions {
  matrix?: MatrixDeliveryClient;
  backoff?: (attempt: number) => number;
  maxAttempts?: number;
  batchSize?: number;
  now?: () => number;
}

export interface DeliveryReport {
  delivered: number;
  retried: number;
  failed: number;
  skipped: number;
}

const DEFAULT_BACKOFF = (attempt: number): number =>
  Math.min(1000 * 2 ** Math.max(0, attempt - 1), 30_000);

function emptyReport(): DeliveryReport {
  return { delivered: 0, retried: 0, failed: 0, skipped: 0 };
}

interface OutboxMessageRow {
  id: string;
  aggregateKey: string;
  destination: string;
  eventSequence: number;
  deliveryKey: string;
  status: string;
  attempts: number;
}

function mapOutboxRow(row: Record<string, unknown>): OutboxMessageRow {
  return {
    id: row.id as string,
    aggregateKey: row.aggregate_key as string,
    destination: row.destination as string,
    eventSequence: Number(row.event_sequence),
    deliveryKey: row.delivery_key as string,
    status: row.status as string,
    attempts: Number(row.attempts),
  };
}

/** Mark a message terminal so it is never claimed again. */
async function markTerminal(
  client: PoolClient,
  messageId: string,
  status: 'failed' | 'dead',
  attempts: number,
): Promise<void> {
  await client.query(
    `UPDATE ${OUTBOX_MESSAGES.table}
        SET ${OUTBOX_MESSAGES.status} = $1,
            ${OUTBOX_MESSAGES.attempts} = $2,
            ${OUTBOX_MESSAGES.nextAttemptAt} = NULL,
            ${OUTBOX_MESSAGES.updatedAt} = now()
      WHERE ${OUTBOX_MESSAGES.id} = $3`,
    [status, attempts, messageId],
  );
}

interface DeliverOneOptions {
  matrix: MatrixDeliveryClient;
  backoff: (attempt: number) => number;
  maxAttempts: number;
  now: () => number;
}

/** Deliver a single outbox message in its own transaction. */
async function deliverOne(
  tenant: TenantContext,
  messageId: string,
  opts: DeliverOneOptions,
): Promise<keyof DeliveryReport> {
  return withTenant(tenant.userId, async (client) => {
    const claimed = await client.query(
      `SELECT * FROM ${OUTBOX_MESSAGES.table} WHERE ${OUTBOX_MESSAGES.id} = $1 FOR UPDATE`,
      [messageId],
    );
    if (claimed.rows.length === 0) return 'skipped';
    const msg = mapOutboxRow(claimed.rows[0]);
    if (msg.status !== 'pending') return 'skipped';

    const runId = msg.aggregateKey;
    const roomId = msg.destination;

    // Load the run (RLS-scoped) and verify the tenant owns it.
    const runRes = await client.query(
      'SELECT owner_id, workspace_id FROM runs WHERE id = $1 AND workspace_id = $2',
      [runId, tenant.workspaceId],
    );
    const run = runRes.rows[0];
    if (!run) {
      await markTerminal(client, msg.id, 'dead', msg.attempts);
      return 'failed';
    }
    if ((run.owner_id as string) !== tenant.userId) return 'skipped';

    // Load the persisted explicit binding: the room must be bound to this
    // workspace by the run owner. The outbox destination is not trusted alone.
    const bindingRes = await client.query(
      'SELECT homeserver_url FROM room_bindings WHERE room_id = $1 AND workspace_id = $2 AND user_id = $3',
      [roomId, tenant.workspaceId, run.owner_id as string],
    );
    const binding = bindingRes.rows[0];
    if (!binding) {
      await markTerminal(client, msg.id, 'dead', msg.attempts);
      return 'failed';
    }

    // Load the event payload to render.
    const eventRes = await client.query(
      'SELECT event_type, payload FROM run_events WHERE run_id = $1 AND sequence = $2',
      [runId, msg.eventSequence],
    );
    const eventRow = eventRes.rows[0];
    if (!eventRow) {
      await markTerminal(client, msg.id, 'dead', msg.attempts);
      return 'failed';
    }

    // Decrypt the owner's session token.
    let token: { accessToken: string; homeserverUrl: string; matrixUserId: string };
    try {
      token = await resolveMatrixAccessToken(client, run.owner_id as string);
    } catch (error) {
      if (isMatrixTokenUnavailable(error)) {
        await markTerminal(client, msg.id, 'failed', msg.attempts);
        return 'failed';
      }
      throw error;
    }

    const body = renderMessage({
      runId,
      sequence: msg.eventSequence,
      type: eventRow.event_type as string,
      payload: (eventRow.payload as Record<string, unknown> | null) ?? {},
    });

    try {
      const result = await opts.matrix.sendMessage({
        accessToken: token.accessToken,
        homeserverUrl: binding.homeserver_url as string,
        roomId,
        body,
        deliveryKey: msg.deliveryKey,
      });
      await client.query(
        `UPDATE ${OUTBOX_MESSAGES.table}
            SET ${OUTBOX_MESSAGES.status} = 'delivered',
                ${OUTBOX_MESSAGES.providerEventId} = $1,
                ${OUTBOX_MESSAGES.attempts} = ${OUTBOX_MESSAGES.attempts} + 1,
                ${OUTBOX_MESSAGES.nextAttemptAt} = NULL,
                ${OUTBOX_MESSAGES.updatedAt} = now()
          WHERE ${OUTBOX_MESSAGES.id} = $2`,
        [result.eventId, msg.id],
      );
      return 'delivered';
    } catch (error) {
      const attempts = msg.attempts + 1;
      if (isRetryableMatrixError(error)) {
        if (attempts >= opts.maxAttempts) {
          await markTerminal(client, msg.id, 'dead', attempts);
          return 'failed';
        }
        await client.query(
          `UPDATE ${OUTBOX_MESSAGES.table}
              SET ${OUTBOX_MESSAGES.attempts} = $1,
                  ${OUTBOX_MESSAGES.nextAttemptAt} = to_timestamp($2 / 1000.0),
                  ${OUTBOX_MESSAGES.updatedAt} = now()
            WHERE ${OUTBOX_MESSAGES.id} = $3`,
          [attempts, opts.now() + opts.backoff(attempts), msg.id],
        );
        return 'retried';
      }
      await markTerminal(client, msg.id, 'failed', attempts);
      return 'failed';
    }
  });
}

/**
 * Deliver all currently-pending Matrix messages for the tenant's workspace.
 * `tenant.userId` must be the run owner whose encrypted token is used to send.
 */
export async function deliverPending(
  tenant: TenantContext,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const matrix = options.matrix ?? getMatrixDeliveryClient();
  const backoff = options.backoff ?? DEFAULT_BACKOFF;
  const maxAttempts = options.maxAttempts ?? 5;
  const batchSize = options.batchSize ?? 100;
  const now = options.now ?? (() => Date.now());

  const candidates = await withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT o.${OUTBOX_MESSAGES.id}
         FROM ${OUTBOX_MESSAGES.table} o
         JOIN runs r ON r.id = o.${OUTBOX_MESSAGES.aggregateKey}
        WHERE o.${OUTBOX_MESSAGES.workspaceId} = $1
          AND r.owner_id = $2
          AND o.${OUTBOX_MESSAGES.status} = 'pending'
          AND (o.${OUTBOX_MESSAGES.nextAttemptAt} IS NULL
               OR o.${OUTBOX_MESSAGES.nextAttemptAt} <= now())
        ORDER BY o.${OUTBOX_MESSAGES.eventSequence} ASC, o.${OUTBOX_MESSAGES.createdAt} ASC
        LIMIT $3`,
      [tenant.workspaceId, tenant.userId, batchSize],
    );
    return rows.map((r) => r.id as string);
  });

  const report = emptyReport();
  const deliverOptions: DeliverOneOptions = { matrix, backoff, maxAttempts, now };
  for (const id of candidates) {
    const outcome = await deliverOne(tenant, id, deliverOptions);
    report[outcome] += 1;
  }
  return report;
}
