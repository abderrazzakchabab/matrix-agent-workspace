/**
 * Column names and row shapes for the `github_mutation_commands` table. The
 * table is keyed by idempotency key (per workspace): duplicate enqueues and
 * worker retries return the existing command. The provider result is persisted
 * before the command is marked complete, so a crash between the two writes
 * never causes a second provider mutation.
 */
export const GITHUB_MUTATION_COMMANDS = {
  table: 'github_mutation_commands',
  id: 'id',
  workspaceId: 'workspace_id',
  runId: 'run_id',
  userId: 'user_id',
  idempotencyKey: 'idempotency_key',
  approvalId: 'approval_id',
  repository: 'repository',
  operation: 'operation',
  argumentsHash: 'arguments_hash',
  arguments: 'arguments',
  status: 'status',
  providerResult: 'provider_result',
  attempts: 'attempts',
  errorCode: 'error_code',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type MutationCommandStatus = 'queued' | 'completed' | 'failed';

export interface GithubMutationCommandRow {
  id: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  idempotencyKey: string;
  approvalId: string | null;
  repository: string;
  operation: 'create_issue' | 'update_issue' | 'comment_issue' | 'create_pr_comment';
  argumentsHash: string;
  arguments: Record<string, unknown>;
  status: MutationCommandStatus;
  providerResult: Record<string, unknown> | null;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}
