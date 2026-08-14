/**
 * Column names and row shapes for the `mutation_approvals` table. An approval
 * is bound to the exact workspace, run, user, scope, and command hash and
 * expires; it is created only with explicit confirmation text from an
 * authenticated session, never from Matrix prompt text.
 */
export const MUTATION_APPROVALS = {
  table: 'mutation_approvals',
  id: 'id',
  workspaceId: 'workspace_id',
  runId: 'run_id',
  userId: 'user_id',
  scope: 'scope',
  commandHash: 'command_hash',
  decision: 'decision',
  confirmationText: 'confirmation_text',
  expiresAt: 'expires_at',
  createdAt: 'created_at',
} as const;

export type ApprovalDecision = 'approved' | 'denied';

export interface MutationApprovalRow {
  id: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  scope: 'issues:write' | 'pull_requests:write';
  commandHash: string;
  decision: ApprovalDecision;
  confirmationText: string;
  expiresAt: string;
  createdAt: string;
}
