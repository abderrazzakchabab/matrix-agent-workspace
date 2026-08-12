/** Column names and row shape for the `workspaces` and `workspace_members` tables. */
export const WORKSPACES = {
  table: 'workspaces',
  id: 'id',
  ownerId: 'owner_id',
  name: 'name',
  policy: 'policy',
  status: 'status',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export const WORKSPACE_MEMBERS = {
  table: 'workspace_members',
  workspaceId: 'workspace_id',
  userId: 'user_id',
  role: 'role',
  createdAt: 'created_at',
} as const;

export type WorkspaceStatus = 'active' | 'archived';

export interface WorkspaceRow {
  id: string;
  ownerId: string;
  name: string;
  policy: Record<string, unknown>;
  status: WorkspaceStatus;
  createdAt: string;
  updatedAt: string;
}
