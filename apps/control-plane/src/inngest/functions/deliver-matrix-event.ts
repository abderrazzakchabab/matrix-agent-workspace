/**
 * Inngest trigger for outbox-backed Matrix delivery.
 *
 * `matrix.delivery.requested` carries the run owner's tenant context; the
 * function drains the pending outbox for that workspace using the owner's
 * encrypted session token. Delivery is idempotent per delivery key, so a
 * function retry never produces a duplicate logical send.
 */
import { inngest } from '../client';
import { deliverPending } from '../../matrix/delivery-worker';

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
): Promise<void> {
  if (!process.env.INNGEST_EVENT_KEY) return;
  await inngest.send({ name: MATRIX_DELIVERY_REQUESTED_EVENT, data });
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
