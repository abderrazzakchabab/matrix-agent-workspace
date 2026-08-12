/**
 * Column names and row shapes for the `github_installations` and `github_links`
 * tables. Token plaintext never reaches these rows: only ciphertext, IV, auth
 * tag, and key version are persisted.
 */
export const GITHUB_INSTALLATIONS = {
  table: 'github_installations',
  id: 'id',
  workspaceId: 'workspace_id',
  installationId: 'installation_id',
  owner: 'owner',
  repositoryAllowlist: 'repository_allowlist',
  tokenCiphertext: 'token_ciphertext',
  tokenIv: 'token_iv',
  tokenAuthTag: 'token_auth_tag',
  tokenKeyVersion: 'token_key_version',
  expiresAt: 'expires_at',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export const GITHUB_LINKS = {
  table: 'github_links',
  id: 'id',
  userId: 'user_id',
  workspaceId: 'workspace_id',
  oauthSubject: 'oauth_subject',
  accessTokenCiphertext: 'access_token_ciphertext',
  accessTokenIv: 'access_token_iv',
  accessTokenAuthTag: 'access_token_auth_tag',
  tokenKeyVersion: 'token_key_version',
  refreshTokenCiphertext: 'refresh_token_ciphertext',
  refreshTokenIv: 'refresh_token_iv',
  refreshTokenAuthTag: 'refresh_token_auth_tag',
  refreshTokenKeyVersion: 'refresh_token_key_version',
  expiresAt: 'expires_at',
  scopes: 'scopes',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
} as const;

export interface GithubInstallationRow {
  id: string;
  workspaceId: string;
  installationId: string;
  owner: string;
  repositoryAllowlist: string[];
  tokenCiphertext: string | null;
  tokenIv: string | null;
  tokenAuthTag: string | null;
  tokenKeyVersion: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GithubLinkRow {
  id: string;
  userId: string;
  workspaceId: string | null;
  oauthSubject: string;
  accessTokenCiphertext: string;
  accessTokenIv: string;
  accessTokenAuthTag: string;
  tokenKeyVersion: string;
  refreshTokenCiphertext: string | null;
  refreshTokenIv: string | null;
  refreshTokenAuthTag: string | null;
  refreshTokenKeyVersion: string | null;
  expiresAt: string | null;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
}
