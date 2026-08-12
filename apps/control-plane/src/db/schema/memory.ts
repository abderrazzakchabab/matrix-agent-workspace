/** Column names and row shape for the `agent_memories` table. */
export const AGENT_MEMORIES = {
  table: 'agent_memories',
  id: 'id',
  workspaceId: 'workspace_id',
  sourceRunId: 'source_run_id',
  sourceEventId: 'source_event_id',
  textHash: 'text_hash',
  content: 'content',
  embedding: 'embedding',
  classification: 'classification',
  createdAt: 'created_at',
} as const;

export interface AgentMemoryRow {
  id: string;
  workspaceId: string;
  sourceRunId: string | null;
  sourceEventId: string | null;
  textHash: string;
  content: string;
  embedding: number[] | null;
  classification: string | null;
  createdAt: string;
}
