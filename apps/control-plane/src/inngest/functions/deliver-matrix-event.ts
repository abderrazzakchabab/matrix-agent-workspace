/**
 * Inngest trigger for outbox-backed Matrix delivery.
 *
 * `matrix.delivery.requested` carries the run owner's tenant context; the
 * function drains the pending outbox for that workspace using the owner's
 * encrypted session token. Delivery is idempotent per delivery key, so a
 * function retry never produces a duplicate logical send.
 */
import { inngest } from '../client';
import {
  deliverPending,
  sweepPendingMatrixDeliveries,
} from '../../matrix/delivery-worker';

export const MATRIX_DELIVERY_REQUESTED_EVENT = 'matrix.delivery.requested';

export interface MatrixDeliveryRequestedData {
  workspaceId: string;
  /** Internal `users.id` of the run owner whose token is used to send. */
  userId: string;
  runId: string;
}

export interface MatrixDeliveryRequestedEvent {
  name: typeof MATRIX_DELIVERY_REQUESTED_EVENT;
  data: MatrixDeliveryRequestedData;
}

/**
 * Emit the delivery trigger after an outbox enqueue commits. Without an event
 * key (local development/tests) the dispatch is a no-op so persistence is not
 * coupled to Inngest.
 */
export async function dispatchMatrixDeliveryRequested(
  data: MatrixDeliveryRequestedData,
): Promise<boolean> {
  if (!process.env.INNGEST_EVENT_KEY) return false;
  try {
    await inngest.send({ name: MATRIX_DELIVERY_REQUESTED_EVENT, data });
    return true;
  } catch {
    console.error(
      '[control-plane] Matrix delivery dispatch failed; pending outbox retained for sweep',
    );
    return false;
  }
}

export const deliverMatrixEvent = inngest.createFunction(
  {
    id: 'matrix-delivery',
    retries: 5,
    triggers: [{ event: MATRIX_DELIVERY_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as MatrixDeliveryRequestedData;
    return step.run('deliver-pending-matrix', async () => {
      return deliverPending(
        { userId: data.userId, workspaceId: data.workspaceId },
        {},
      );
    });
  },
);

export const sweepMatrixOutbox = inngest.createFunction(
  {
    id: 'matrix-delivery-sweeper',
    retries: 5,
    triggers: [{ cron: '* * * * *' }],
  },
  async ({ step }) => {
    return step.run('sweep-pending-matrix', async () => {
      return sweepPendingMatrixDeliveries();
    });
  },
);
