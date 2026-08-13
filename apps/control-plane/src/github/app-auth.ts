import { createSign } from 'node:crypto';
import { withTenant } from '../db/client';
import { GITHUB_INSTALLATIONS } from '../db/schema/github';
import {
  getDefaultEnvelopeCipher,
  type EncryptedEnvelope,
  type EnvelopeCipher,
} from '../security/envelope-encryption';
import type { GithubFetch, GithubFetchResponse } from './read-client';

export interface InstallationRecord {
  id: string;
  workspaceId: string;
  installationId: string;
  owner: string;
  repositoryAllowlist: string[];
  encryptedToken: EncryptedEnvelope | null;
  expiresAt: string | null;
}

export interface AuthorizedInstallation extends InstallationRecord {
  userId: string;
}

export interface InstallationAuthorizationStore {
  findInstallation(input: {
    userId: string;
    workspaceId: string;
    installationId?: string;
    owner?: string;
  }): Promise<InstallationRecord | null>;
  updateToken(input: {
    userId: string;
    installationRowId: string;
    encryptedToken: EncryptedEnvelope;
    expiresAt: string;
  }): Promise<void>;
}

export class GithubInstallationAccessError extends Error {
  readonly code = 'GITHUB_INSTALLATION_ACCESS_DENIED';
  readonly status = 403;
  constructor() {
    super('GitHub installation access denied');
    this.name = 'GithubInstallationAccessError';
  }
}

export class GithubRepositoryAccessError extends Error {
  readonly code = 'GITHUB_REPOSITORY_ACCESS_DENIED';
  readonly status = 403;
  constructor() {
    super('GitHub repository access denied');
    this.name = 'GithubRepositoryAccessError';
  }
}

export class GithubAppAuthenticationError extends Error {
  readonly code = 'GITHUB_APP_AUTHENTICATION_FAILED';
  readonly status = 502;
  constructor() {
    super('GitHub App authentication failed');
    this.name = 'GithubAppAuthenticationError';
  }
}

function parseAllowlist(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string') {
    try {
      return parseAllowlist(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return [];
}

function rowToInstallation(row: Record<string, unknown>): InstallationRecord {
  const hasToken =
    typeof row.token_ciphertext === 'string' &&
    typeof row.token_iv === 'string' &&
    typeof row.token_auth_tag === 'string' &&
    typeof row.token_key_version === 'string';
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    installationId: String(row.installation_id),
    owner: String(row.owner),
    repositoryAllowlist: parseAllowlist(row.repository_allowlist),
    encryptedToken: hasToken
      ? {
          ciphertext: row.token_ciphertext as string,
          iv: row.token_iv as string,
          authTag: row.token_auth_tag as string,
          keyVersion: row.token_key_version as string,
        }
      : null,
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
  };
}

export const databaseInstallationStore: InstallationAuthorizationStore = {
  async findInstallation({ userId, workspaceId, installationId, owner }) {
    return withTenant(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ${GITHUB_INSTALLATIONS.table}
          WHERE ${GITHUB_INSTALLATIONS.workspaceId} = $1
            AND ($2::text IS NULL OR ${GITHUB_INSTALLATIONS.installationId} = $2)
            AND ($3::text IS NULL OR lower(${GITHUB_INSTALLATIONS.owner}) = lower($3))
          ORDER BY ${GITHUB_INSTALLATIONS.createdAt}
          LIMIT 1`,
        [workspaceId, installationId ?? null, owner ?? null],
      );
      return rows[0] ? rowToInstallation(rows[0] as Record<string, unknown>) : null;
    });
  },

  async updateToken({ userId, installationRowId, encryptedToken, expiresAt }) {
    await withTenant(userId, async (client) => {
      await client.query(
        `UPDATE ${GITHUB_INSTALLATIONS.table}
            SET ${GITHUB_INSTALLATIONS.tokenCiphertext} = $2,
                ${GITHUB_INSTALLATIONS.tokenIv} = $3,
                ${GITHUB_INSTALLATIONS.tokenAuthTag} = $4,
                ${GITHUB_INSTALLATIONS.tokenKeyVersion} = $5,
                ${GITHUB_INSTALLATIONS.expiresAt} = $6,
                ${GITHUB_INSTALLATIONS.updatedAt} = now()
          WHERE ${GITHUB_INSTALLATIONS.id} = $1`,
        [
          installationRowId,
          encryptedToken.ciphertext,
          encryptedToken.iv,
          encryptedToken.authTag,
          encryptedToken.keyVersion,
          expiresAt,
        ],
      );
    });
  },
};

export async function authorizeInstallationAccess(
  input: { userId: string; workspaceId: string; installationId?: string; owner?: string },
  store: InstallationAuthorizationStore = databaseInstallationStore,
): Promise<AuthorizedInstallation> {
  const installation = await store.findInstallation(input);
  if (!installation) throw new GithubInstallationAccessError();
  return { ...installation, userId: input.userId };
}

export function assertRepositoryAllowed(
  installation: Pick<InstallationRecord, 'owner' | 'repositoryAllowlist'>,
  owner: string,
  repo: string,
): void {
  if (installation.owner.toLowerCase() !== owner.toLowerCase()) {
    throw new GithubRepositoryAccessError();
  }
  const fullName = `${owner}/${repo}`.toLowerCase();
  const allowed = installation.repositoryAllowlist.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    return normalized === fullName || normalized === repo.toLowerCase();
  });
  if (!allowed) throw new GithubRepositoryAccessError();
}

export async function authorizeRepositoryAccess(
  input: {
    userId: string;
    workspaceId: string;
    installationId?: string;
    owner: string;
    repo: string;
  },
  store: InstallationAuthorizationStore = databaseInstallationStore,
): Promise<AuthorizedInstallation> {
  const installation = await authorizeInstallationAccess(
    {
      userId: input.userId,
      workspaceId: input.workspaceId,
      installationId: input.installationId,
      owner: input.owner,
    },
    store,
  );
  assertRepositoryAllowed(installation, input.owner, input.repo);
  return installation;
}

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl: string;
}

export function githubAppConfigFromEnv(): GithubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!appId || !privateKey) throw new GithubAppAuthenticationError();
  return {
    appId,
    privateKey,
    apiBaseUrl: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
  };
}

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function createGithubAppJwt(
  config: Pick<GithubAppConfig, 'appId' | 'privateKey'>,
  now: () => number = Date.now,
): string {
  const issuedAt = Math.floor(now() / 1000) - 60;
  const header = base64Url({ alg: 'RS256', typ: 'JWT' });
  const payload = base64Url({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: config.appId });
  const unsigned = `${header}.${payload}`;
  try {
    const signer = createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(config.privateKey).toString('base64url')}`;
  } catch {
    throw new GithubAppAuthenticationError();
  }
}

export interface InstallationTokenOptions {
  config?: GithubAppConfig;
  cipher?: EnvelopeCipher;
  fetch?: GithubFetch;
  now?: () => number;
}

export async function acquireInstallationToken(
  installation: AuthorizedInstallation,
  store: InstallationAuthorizationStore = databaseInstallationStore,
  options: InstallationTokenOptions = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const cipher = options.cipher ?? getDefaultEnvelopeCipher();
  if (
    installation.encryptedToken &&
    installation.expiresAt &&
    new Date(installation.expiresAt).getTime() > now() + 60_000
  ) {
    const rotated = await cipher.decryptAndReencrypt(installation.encryptedToken);
    if (rotated.envelope !== installation.encryptedToken) {
      await store.updateToken({
        userId: installation.userId,
        installationRowId: installation.id,
        encryptedToken: rotated.envelope,
        expiresAt: installation.expiresAt,
      });
    }
    return rotated.plaintext;
  }

  const config = options.config ?? githubAppConfigFromEnv();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const jwt = createGithubAppJwt(config, now);
  const repositories = [
    ...new Set(
      installation.repositoryAllowlist.flatMap((entry) => {
        const [entryOwner, entryRepo, extra] = entry.trim().split('/');
        if (extra !== undefined) return [];
        if (entryRepo === undefined) return entryOwner ? [entryOwner] : [];
        return entryOwner?.toLowerCase() === installation.owner.toLowerCase() && entryRepo
          ? [entryRepo]
          : [];
      }),
    ),
  ];
  if (repositories.length === 0 || repositories.length > 500) {
    throw new GithubRepositoryAccessError();
  }
  let response: GithubFetchResponse;
  try {
    response = await fetchImpl(
      `${config.apiBaseUrl}/app/installations/${encodeURIComponent(installation.installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${jwt}`,
          'content-type': 'application/json',
          'user-agent': 'matrix-agent-workspace-control-plane',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify({ repositories }),
        redirect: 'error',
      },
    );
  } catch {
    throw new GithubAppAuthenticationError();
  }
  if (!response.ok) throw new GithubAppAuthenticationError();
  let body: {
    token?: unknown;
    expires_at?: unknown;
    permissions?: Record<string, unknown>;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new GithubAppAuthenticationError();
  }
  if (typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
    throw new GithubAppAuthenticationError();
  }
  if (Object.values(body.permissions ?? {}).some((permission) => permission === 'write')) {
    throw new GithubAppAuthenticationError();
  }
  const encryptedToken = await cipher.encrypt(body.token);
  const expiresAt = new Date(body.expires_at).toISOString();
  await store.updateToken({
    userId: installation.userId,
    installationRowId: installation.id,
    encryptedToken,
    expiresAt,
  });
  return body.token;
}
