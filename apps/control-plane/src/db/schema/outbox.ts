/** Column names and row shape for the `outbox_messages` table. */
export const OUTBOX_MESSAGES = {
  table: 'outbox_messages',
  id: 'id',
  workspaceId: 'workspace_id',
  aggregateKey: 'aggregate_key',
  destination: 'destination',
  eventSequence: 'event_sequence',
  deliveryKey: 'delivery_key',
  status: 'status',
  attempts: 'attempts',
  nextAttemptAt: 'next_attempt_at',
  providerEventId: 'provider_event_id',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type OutboxStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface OutboxMessageRow {
  id: string;
  workspaceId: string;
  aggregateKey: string;
  destination: string;
  eventSequence: number;
  deliveryKey: string;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  providerEventId: string | null;
  createdAt: string;
  updatedAt: string;
}
