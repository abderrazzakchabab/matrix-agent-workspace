/**
 * Column names and row shapes for the `github_write_grants` table. A grant is
 * repository- and scope-specific: one row per (workspace, repository, scope)
 * with a `pending | approved | revoked` lifecycle. A grant never contains a
 * token or a command hash — it only authorizes a write scope.
 */
export const GITHUB_WRITE_GRANTS = {
  table: 'github_write_grants',
  id: 'id',
  workspaceId: 'workspace_id',
  grantedBy: 'granted_by',
  repository: 'repository',
  scope: 'scope',
  status: 'status',
  approvedAt: 'approved_at',
  expiresAt: 'expires_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export type WriteGrantStatus = 'pending' | 'approved' | 'revoked';

export interface GithubWriteGrantRow {
  id: string;
  workspaceId: string;
  grantedBy: string;
  repository: string;
  scope: 'issues:write' | 'pull_requests:write';
  status: WriteGrantStatus;
  approvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
