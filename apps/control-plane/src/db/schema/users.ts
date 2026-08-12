/** Column names and row shape for the `users` table. */
export const USERS = {
  table: 'users',
  id: 'id',
  matrixUserId: 'matrix_user_id',
  homeserverUrl: 'homeserver_url',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export interface UserRow {
  id: string;
  matrixUserId: string;
  homeserverUrl: string;
  createdAt: string;
  updatedAt: string;
}
