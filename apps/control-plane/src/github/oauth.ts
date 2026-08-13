import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { withTenant } from '../db/client';
import { GITHUB_LINKS } from '../db/schema/github';
import {
  getDefaultEnvelopeCipher,
  type EncryptedEnvelope,
  type EnvelopeCipher,
} from '../security/envelope-encryption';
import type { GithubFetch, GithubFetchResponse } from './read-client';

export interface OAuthSessionBinding {
  userId: string;
  sessionId: string;
}

interface StoredOAuthState {
  userId: string;
  sessionHash: string;
  expiresAt: number;
}

export interface OAuthStateStore {
  put(nonce: string, state: StoredOAuthState): Promise<void>;
  /** Atomically remove and return a nonce, or null when absent/already consumed. */
  take(nonce: string, userId: string): Promise<StoredOAuthState | null>;
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly states = new Map<string, StoredOAuthState>();

  async put(nonce: string, state: StoredOAuthState): Promise<void> {
    this.states.set(nonce, state);
  }

  async take(nonce: string, _userId: string): Promise<StoredOAuthState | null> {
    const state = this.states.get(nonce) ?? null;
    this.states.delete(nonce);
    return state;
  }
}

function oauthStateSubject(nonce: string): string {
  return `oauth_state:${createHash('sha256').update(nonce).digest('base64url')}`;
}

/**
 * Persist OAuth state in the existing tenant-owned GitHub link table. The
 * session binding is envelope-encrypted, and DELETE ... RETURNING makes state
 * consumption atomic across control-plane instances.
 */
export function createDatabaseOAuthStateStore(
  cipher: EnvelopeCipher = getDefaultEnvelopeCipher(),
): OAuthStateStore {
  return {
    async put(nonce, state) {
      const encrypted = await cipher.encrypt(JSON.stringify(state));
      await withTenant(state.userId, async (client) => {
        await client.query(
          `DELETE FROM ${GITHUB_LINKS.table}
            WHERE ${GITHUB_LINKS.userId} = $1
              AND ${GITHUB_LINKS.scopes} @> '["oauth_state"]'::jsonb
              AND ${GITHUB_LINKS.expiresAt} <= now()`,
          [state.userId],
        );
        await client.query(
          `INSERT INTO ${GITHUB_LINKS.table}
             (${GITHUB_LINKS.id}, ${GITHUB_LINKS.userId}, ${GITHUB_LINKS.workspaceId},
              ${GITHUB_LINKS.oauthSubject}, ${GITHUB_LINKS.accessTokenCiphertext},
              ${GITHUB_LINKS.accessTokenIv}, ${GITHUB_LINKS.accessTokenAuthTag},
              ${GITHUB_LINKS.tokenKeyVersion}, ${GITHUB_LINKS.expiresAt}, ${GITHUB_LINKS.scopes})
           VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, '["oauth_state"]'::jsonb)`,
          [
            `ghs_${randomUUID()}`,
            state.userId,
            oauthStateSubject(nonce),
            encrypted.ciphertext,
            encrypted.iv,
            encrypted.authTag,
            encrypted.keyVersion,
            new Date(state.expiresAt).toISOString(),
          ],
        );
      });
    },

    async take(nonce, userId) {
      const row = await withTenant(userId, async (client) => {
        const { rows } = await client.query(
          `DELETE FROM ${GITHUB_LINKS.table}
            WHERE ${GITHUB_LINKS.userId} = $1
              AND ${GITHUB_LINKS.oauthSubject} = $2
              AND ${GITHUB_LINKS.scopes} @> '["oauth_state"]'::jsonb
          RETURNING ${GITHUB_LINKS.accessTokenCiphertext} AS ciphertext,
                    ${GITHUB_LINKS.accessTokenIv} AS iv,
                    ${GITHUB_LINKS.accessTokenAuthTag} AS auth_tag,
                    ${GITHUB_LINKS.tokenKeyVersion} AS key_version`,
          [userId, oauthStateSubject(nonce)],
        );
        return rows[0] as Record<string, unknown> | undefined;
      });
      if (!row) return null;
      try {
        const plaintext = await cipher.decrypt({
          ciphertext: String(row.ciphertext),
          iv: String(row.iv),
          authTag: String(row.auth_tag),
          keyVersion: String(row.key_version),
        });
        const parsed = JSON.parse(plaintext) as StoredOAuthState;
        if (
          typeof parsed.userId !== 'string' ||
          typeof parsed.sessionHash !== 'string' ||
          typeof parsed.expiresAt !== 'number'
        ) {
          return null;
        }
        return parsed;
      } catch {
        return null;
      }
    },
  };
}

export class GithubOAuthStateError extends Error {
  readonly code: string;
  readonly status = 400;
  constructor(expired = false) {
    super(expired ? 'GitHub OAuth state expired' : 'Invalid GitHub OAuth state');
    this.name = 'GithubOAuthStateError';
    this.code = expired ? 'GITHUB_OAUTH_STATE_EXPIRED' : 'GITHUB_OAUTH_STATE_INVALID';
  }
}

export class GithubOAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code = 'GITHUB_OAUTH_FAILED', status = 502, message = 'GitHub OAuth failed') {
    super(message);
    this.name = 'GithubOAuthError';
    this.code = code;
    this.status = status;
  }
}

export interface OAuthStateService {
  issue(binding: OAuthSessionBinding): Promise<string>;
  consume(state: string, binding: OAuthSessionBinding): Promise<void>;
}

function sessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url');
}

function signature(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}

function equalSignature(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function createOAuthStateService(options: {
  secret: string;
  store: OAuthStateStore;
  ttlMs?: number;
  now?: () => number;
}): OAuthStateService {
  if (options.secret.length < 16) throw new Error('GitHub OAuth state secret is too short');
  const ttlMs = options.ttlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  return {
    async issue(binding) {
      const nonce = randomBytes(32).toString('base64url');
      await options.store.put(nonce, {
        userId: binding.userId,
        sessionHash: sessionHash(binding.sessionId),
        expiresAt: now() + ttlMs,
      });
      return `${nonce}.${signature(options.secret, nonce)}`;
    },

    async consume(state, binding) {
      const separator = state.lastIndexOf('.');
      if (separator <= 0) throw new GithubOAuthStateError();
      const nonce = state.slice(0, separator);
      const suppliedSignature = state.slice(separator + 1);
      if (!equalSignature(suppliedSignature, signature(options.secret, nonce))) {
        throw new GithubOAuthStateError();
      }
      const stored = await options.store.take(nonce, binding.userId);
      if (!stored) throw new GithubOAuthStateError();
      if (stored.expiresAt < now()) throw new GithubOAuthStateError(true);
      if (
        stored.userId !== binding.userId ||
        stored.sessionHash !== sessionHash(binding.sessionId)
      ) {
        throw new GithubOAuthStateError();
      }
    },
  };
}

export interface OAuthLinkRecord {
  userId: string;
  workspaceId: null;
  subject: string;
  login: string;
  accessToken: EncryptedEnvelope;
  refreshToken: EncryptedEnvelope | null;
  expiresAt: string | null;
  scopes: string[];
}

export interface OAuthLinkStore {
  upsert(record: OAuthLinkRecord): Promise<void>;
}

export const databaseOAuthLinkStore: OAuthLinkStore = {
  async upsert(record) {
    await withTenant(record.userId, async (client) => {
      await client.query(
        `INSERT INTO ${GITHUB_LINKS.table}
           (${GITHUB_LINKS.id}, ${GITHUB_LINKS.userId}, ${GITHUB_LINKS.workspaceId},
            ${GITHUB_LINKS.oauthSubject}, ${GITHUB_LINKS.accessTokenCiphertext},
            ${GITHUB_LINKS.accessTokenIv}, ${GITHUB_LINKS.accessTokenAuthTag},
            ${GITHUB_LINKS.tokenKeyVersion}, ${GITHUB_LINKS.refreshTokenCiphertext},
            ${GITHUB_LINKS.refreshTokenIv}, ${GITHUB_LINKS.refreshTokenAuthTag},
            ${GITHUB_LINKS.refreshTokenKeyVersion}, ${GITHUB_LINKS.expiresAt},
            ${GITHUB_LINKS.scopes})
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         ON CONFLICT (${GITHUB_LINKS.userId}, ${GITHUB_LINKS.oauthSubject}) DO UPDATE SET
           ${GITHUB_LINKS.workspaceId} = NULL,
           ${GITHUB_LINKS.accessTokenCiphertext} = EXCLUDED.${GITHUB_LINKS.accessTokenCiphertext},
           ${GITHUB_LINKS.accessTokenIv} = EXCLUDED.${GITHUB_LINKS.accessTokenIv},
           ${GITHUB_LINKS.accessTokenAuthTag} = EXCLUDED.${GITHUB_LINKS.accessTokenAuthTag},
           ${GITHUB_LINKS.tokenKeyVersion} = EXCLUDED.${GITHUB_LINKS.tokenKeyVersion},
           ${GITHUB_LINKS.refreshTokenCiphertext} = EXCLUDED.${GITHUB_LINKS.refreshTokenCiphertext},
           ${GITHUB_LINKS.refreshTokenIv} = EXCLUDED.${GITHUB_LINKS.refreshTokenIv},
           ${GITHUB_LINKS.refreshTokenAuthTag} = EXCLUDED.${GITHUB_LINKS.refreshTokenAuthTag},
           ${GITHUB_LINKS.refreshTokenKeyVersion} = EXCLUDED.${GITHUB_LINKS.refreshTokenKeyVersion},
           ${GITHUB_LINKS.expiresAt} = EXCLUDED.${GITHUB_LINKS.expiresAt},
           ${GITHUB_LINKS.scopes} = EXCLUDED.${GITHUB_LINKS.scopes},
           ${GITHUB_LINKS.updatedAt} = now()`,
        [
          `ghl_${randomUUID()}`,
          record.userId,
          record.subject,
          record.accessToken.ciphertext,
          record.accessToken.iv,
          record.accessToken.authTag,
          record.accessToken.keyVersion,
          record.refreshToken?.ciphertext ?? null,
          record.refreshToken?.iv ?? null,
          record.refreshToken?.authTag ?? null,
          record.refreshToken?.keyVersion ?? null,
          record.expiresAt,
          JSON.stringify(record.scopes),
        ],
      );
    });
  },
};

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  scopes?: string[];
}

export function githubOAuthConfigFromEnv(): GithubOAuthConfig {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const callbackUrl = process.env.GITHUB_OAUTH_CALLBACK_URL;
  if (!clientId || !clientSecret || !callbackUrl) {
    throw new GithubOAuthError('GITHUB_OAUTH_NOT_CONFIGURED', 500, 'GitHub OAuth is not configured');
  }
  return {
    clientId,
    clientSecret,
    callbackUrl,
    authorizeUrl: process.env.GITHUB_OAUTH_AUTHORIZE_URL ?? 'https://github.com/login/oauth/authorize',
    tokenUrl: process.env.GITHUB_OAUTH_TOKEN_URL ?? 'https://github.com/login/oauth/access_token',
    apiBaseUrl: (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, ''),
    scopes: (process.env.GITHUB_OAUTH_SCOPES ?? 'read:user')
      .split(/[ ,]+/)
      .map((scope) => scope.trim())
      .filter(Boolean),
  };
}

export interface GithubOAuthService {
  start(binding: OAuthSessionBinding): Promise<{ state: string; authorizationUrl: string }>;
  callback(
    binding: OAuthSessionBinding,
    input: { state: string; code: string },
  ): Promise<{ subject: string; login: string; scopes: string[] }>;
}

export function createGithubOAuthService(options: {
  config: GithubOAuthConfig;
  states: OAuthStateService;
  cipher: EnvelopeCipher;
  links: OAuthLinkStore;
  fetch?: GithubFetch;
  now?: () => number;
}): GithubOAuthService {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  return {
    async start(binding) {
      const state = await options.states.issue(binding);
      const url = new URL(options.config.authorizeUrl);
      url.searchParams.set('client_id', options.config.clientId);
      url.searchParams.set('redirect_uri', options.config.callbackUrl);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', (options.config.scopes ?? ['read:user']).join(' '));
      return { state, authorizationUrl: url.toString() };
    },

    async callback(binding, input) {
      if (!input.state || !input.code) {
        throw new GithubOAuthError(
          'GITHUB_OAUTH_CALLBACK_INVALID',
          400,
          'GitHub OAuth callback is missing required parameters',
        );
      }
      await options.states.consume(input.state, binding);
      let tokenResponse: GithubFetchResponse;
      try {
        tokenResponse = await fetchImpl(options.config.tokenUrl, {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: options.config.clientId,
            client_secret: options.config.clientSecret,
            code: input.code,
            redirect_uri: options.config.callbackUrl,
          }),
          redirect: 'error',
        });
      } catch {
        throw new GithubOAuthError();
      }
      if (!tokenResponse.ok) throw new GithubOAuthError();
      let token: {
        access_token?: unknown;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
        error?: unknown;
      };
      try {
        token = (await tokenResponse.json()) as typeof token;
      } catch {
        throw new GithubOAuthError();
      }
      if (typeof token.access_token !== 'string' || token.error) throw new GithubOAuthError();

      let userResponse: GithubFetchResponse;
      try {
        userResponse = await fetchImpl(`${options.config.apiBaseUrl}/user`, {
          method: 'GET',
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token.access_token}`,
            'user-agent': 'matrix-agent-workspace-control-plane',
            'x-github-api-version': '2022-11-28',
          },
          redirect: 'error',
        });
      } catch {
        throw new GithubOAuthError();
      }
      if (!userResponse.ok) throw new GithubOAuthError();
      let user: { id?: unknown; login?: unknown };
      try {
        user = (await userResponse.json()) as typeof user;
      } catch {
        throw new GithubOAuthError();
      }
      if ((typeof user.id !== 'number' && typeof user.id !== 'string') || typeof user.login !== 'string') {
        throw new GithubOAuthError();
      }

      const accessToken = await options.cipher.encrypt(token.access_token);
      const refreshToken =
        typeof token.refresh_token === 'string'
          ? await options.cipher.encrypt(token.refresh_token)
          : null;
      const scopes =
        typeof token.scope === 'string'
          ? token.scope.split(',').map((scope) => scope.trim()).filter(Boolean)
          : [];
      const expiresAt =
        typeof token.expires_in === 'number'
          ? new Date(now() + token.expires_in * 1000).toISOString()
          : null;
      const subject = String(user.id);
      await options.links.upsert({
        userId: binding.userId,
        workspaceId: null,
        subject,
        login: user.login,
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
      });
      return { subject, login: user.login, scopes };
    },
  };
}

let defaultStateService: OAuthStateService | undefined;
let defaultOAuthService: GithubOAuthService | undefined;

export function getDefaultOAuthStateService(): OAuthStateService {
  if (!defaultStateService) {
    const secret = process.env.GITHUB_OAUTH_STATE_SECRET ?? process.env.GITHUB_OAUTH_CLIENT_SECRET;
    if (!secret) {
      throw new GithubOAuthError('GITHUB_OAUTH_NOT_CONFIGURED', 500, 'GitHub OAuth is not configured');
    }
    defaultStateService = createOAuthStateService({
      secret,
      store: createDatabaseOAuthStateStore(),
    });
  }
  return defaultStateService;
}

export function getDefaultGithubOAuthService(): GithubOAuthService {
  if (!defaultOAuthService) {
    defaultOAuthService = createGithubOAuthService({
      config: githubOAuthConfigFromEnv(),
      states: getDefaultOAuthStateService(),
      cipher: getDefaultEnvelopeCipher(),
      links: databaseOAuthLinkStore,
    });
  }
  return defaultOAuthService;
}
