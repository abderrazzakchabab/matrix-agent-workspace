/** Column names and row shape for the `workflow_checkpoints` table. */
export const WORKFLOW_CHECKPOINTS = {
  table: 'workflow_checkpoints',
  runId: 'run_id',
  checkpointKey: 'checkpoint_key',
  version: 'version',
  state: 'state',
  updatedAt: 'updated_at',
} as const;

export interface WorkflowCheckpointRow {
  runId: string;
  checkpointKey: string;
  version: number;
  state: Record<string, unknown>;
  updatedAt: string;
}
