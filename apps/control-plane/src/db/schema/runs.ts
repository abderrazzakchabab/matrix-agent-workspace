/** Column names and row shape for the `runs` and `run_specialists` tables. */
export const RUNS = {
  table: 'runs',
  id: 'id',
  workspaceId: 'workspace_id',
  ownerId: 'owner_id',
  roomId: 'room_id',
  promptHash: 'prompt_hash',
  mode: 'mode',
  status: 'status',
  configSnapshot: 'config_snapshot',
  idempotencyKey: 'idempotency_key',
  cancelRequestedAt: 'cancel_requested_at',
  terminalSummary: 'terminal_summary',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export const RUN_SPECIALISTS = {
  table: 'run_specialists',
  runId: 'run_id',
  specialistId: 'specialist_id',
  ordinal: 'ordinal',
  status: 'status',
  attemptCount: 'attempt_count',
  output: 'output',
  errorCode: 'error_code',
  startedAt: 'started_at',
  completedAt: 'completed_at',
} as const;

export type RunMode = 'parallel' | 'sequential';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'partial';

export interface RunRow {
  id: string;
  workspaceId: string;
  ownerId: string;
  roomId: string | null;
  promptHash: string;
  mode: RunMode;
  status: RunStatus;
  configSnapshot: Record<string, unknown>;
  idempotencyKey: string | null;
  cancelRequestedAt: string | null;
  terminalSummary: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunSpecialistRow {
  runId: string;
  specialistId: string;
  ordinal: number;
  status: string;
  attemptCount: number;
  output: Record<string, unknown> | null;
  errorCode: string | null;
  startedAt: string | null;
  completedAt: string | null;
}
