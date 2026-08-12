/** Column names and row shape for the `sessions` table. */
export const SESSIONS = {
  table: 'sessions',
  id: 'id',
  sessionIdHash: 'session_id_hash',
  userId: 'user_id',
  ciphertext: 'matrix_access_token_ciphertext',
  iv: 'matrix_access_token_iv',
  authTag: 'matrix_access_token_auth_tag',
  keyVersion: 'token_key_version',
  expiresAt: 'expires_at',
  revokedAt: 'revoked_at',
  createdAt: 'created_at',
} as const;

export interface SessionRow {
  id: string;
  sessionIdHash: string;
  userId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
  expiresAt: string;
  revokedAt: string | null;
}
