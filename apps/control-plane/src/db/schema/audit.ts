/**
 * Column names and row shapes for the `audit_records` table. Append-only and
 * tenant-scoped: the application role gets INSERT and SELECT only, and every
 * row carries the workspace key for RLS. `details` is always stored redacted —
 * payloads, tokens, and confirmation text are never persisted.
 */
export const AUDIT_RECORDS = {
  table: 'audit_records',
  id: 'id',
  workspaceId: 'workspace_id',
  actorUserId: 'actor_user_id',
  actorMatrixId: 'actor_matrix_id',
  scope: 'scope',
  repository: 'repository',
  operation: 'operation',
  argumentsHash: 'arguments_hash',
  approvalId: 'approval_id',
  commandId: 'command_id',
  outcome: 'outcome',
  details: 'details',
  createdAt: 'created_at',
} as const;

export interface AuditRecordRow {
  id: string;
  workspaceId: string;
  actorUserId: string;
  actorMatrixId: string | null;
  scope: string | null;
  repository: string | null;
  operation: string | null;
  argumentsHash: string | null;
  approvalId: string | null;
  commandId: string | null;
  outcome: string;
  details: Record<string, unknown>;
  createdAt: string;
}
