/** Column names and row shape for the `run_events` table. */
export const RUN_EVENTS = {
  table: 'run_events',
  id: 'id',
  runId: 'run_id',
  sequence: 'sequence',
  eventType: 'event_type',
  eventVersion: 'event_version',
  payload: 'payload',
  visibility: 'visibility',
  createdAt: 'created_at',
} as const;

export interface RunEventRow {
  id: string;
  runId: string;
  sequence: number;
  eventType: string;
  eventVersion: number;
  payload: Record<string, unknown>;
  visibility: string;
  createdAt: string;
}
