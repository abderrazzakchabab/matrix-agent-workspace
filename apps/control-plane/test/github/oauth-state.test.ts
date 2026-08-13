import { describe, expect, it, vi } from 'vitest';
import { EnvelopeCipher, type EnvelopeKeyring } from '../../src/security/envelope-encryption';
import {
  InMemoryOAuthStateStore,
  createDatabaseOAuthStateStore,
  createGithubOAuthService,
  createOAuthStateService,
  databaseOAuthLinkStore,
  type OAuthLinkRecord,
  type OAuthLinkStore,
} from '../../src/github/oauth';
import { getAdminPool, runMigrations } from '../../src/db/client';

const keyring: EnvelopeKeyring = {
  currentVersion: 'test-v1',
  getKey(version) {
    return version === 'test-v1'
      ? { version, key: Buffer.from('1f'.repeat(32), 'hex') }
      : undefined;
  },
};

function stateService(now: () => number = () => Date.now()) {
  return createOAuthStateService({
    secret: 'state-signing-secret-for-tests',
    ttlMs: 60_000,
    now,
    store: new InMemoryOAuthStateStore(),
  });
}

describe('GitHub OAuth state', () => {
  it('is one-time and bound to both the authenticated Matrix user and session', async () => {
    const states = stateService();
    const binding = { userId: 'user-a', sessionId: 'matrix-session-a' };

    const replayed = await states.issue(binding);
    await expect(states.consume(replayed, binding)).resolves.toBeUndefined();
    await expect(states.consume(replayed, binding)).rejects.toMatchObject({
      status: 400,
      code: 'GITHUB_OAUTH_STATE_INVALID',
    });

    const wrongUser = await states.issue(binding);
    await expect(
      states.consume(wrongUser, { userId: 'user-b', sessionId: binding.sessionId }),
    ).rejects.toMatchObject({ status: 400, code: 'GITHUB_OAUTH_STATE_INVALID' });

    const wrongSession = await states.issue(binding);
    await expect(
      states.consume(wrongSession, { userId: binding.userId, sessionId: 'matrix-session-b' }),
    ).rejects.toMatchObject({ status: 400, code: 'GITHUB_OAUTH_STATE_INVALID' });

    await expect(states.consume('', binding)).rejects.toMatchObject({
      status: 400,
      code: 'GITHUB_OAUTH_STATE_INVALID',
    });
  });

  it('rejects expired state and consumes it so it cannot later be replayed', async () => {
    let now = 1_000;
    const states = stateService(() => now);
    const binding = { userId: 'user-a', sessionId: 'matrix-session-a' };
    const state = await states.issue(binding);
    now += 60_001;

    await expect(states.consume(state, binding)).rejects.toMatchObject({
      status: 400,
      code: 'GITHUB_OAUTH_STATE_EXPIRED',
    });
    await expect(states.consume(state, binding)).rejects.toMatchObject({
      status: 400,
      code: 'GITHUB_OAUTH_STATE_INVALID',
    });
  });

  it('persists encrypted single-use state durably and removes it atomically', async () => {
    await runMigrations();
    const userId = 'usr_github_oauth_state_test';
    const admin = getAdminPool();
    await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    await admin.query(
      `INSERT INTO users (id, matrix_user_id, homeserver_url)
       VALUES ($1, '@github-state:example.test', 'http://example.test')`,
      [userId],
    );
    try {
      const cipher = new EnvelopeCipher(keyring);
      const states = createOAuthStateService({
        secret: 'state-signing-secret-for-tests',
        store: createDatabaseOAuthStateStore(cipher),
      });
      const binding = { userId, sessionId: 'opaque-matrix-session-secret' };
      const state = await states.issue(binding);
      const { rows } = await admin.query(
        `SELECT oauth_subject, access_token_ciphertext, scopes
           FROM github_links
          WHERE user_id = $1`,
        [userId],
      );

      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).not.toContain(binding.sessionId);
      expect(rows[0].scopes).toEqual(['oauth_state']);
      await expect(states.consume(state, binding)).resolves.toBeUndefined();
      const remaining = await admin.query(
        'SELECT count(*)::int AS count FROM github_links WHERE user_id = $1',
        [userId],
      );
      expect(remaining.rows[0].count).toBe(0);
    } finally {
      await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });

  it('converts OAuth transport failures to a structured redacted error', async () => {
    const states = stateService();
    const binding = { userId: 'user-a', sessionId: 'matrix-session-a' };
    const oauth = createGithubOAuthService({
      config: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        callbackUrl: 'http://test.local/api/github/oauth/callback',
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        apiBaseUrl: 'https://api.github.test',
      },
      states,
      cipher: new EnvelopeCipher(keyring),
      links: { async upsert() {} },
      fetch: async () => {
        throw new Error('network failed with oauth-code-secret');
      },
    });
    const start = await oauth.start(binding);

    await expect(
      oauth.callback(binding, { state: start.state, code: 'oauth-code-secret' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'GITHUB_OAUTH_FAILED',
      message: 'GitHub OAuth failed',
    });
  });

  it('rejects configured OAuth scopes outside the Phase B read-only allowlist', () => {
    let error: unknown;
    try {
      createGithubOAuthService({
        config: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          callbackUrl: 'http://test.local/api/github/oauth/callback',
          authorizeUrl: 'https://github.test/login/oauth/authorize',
          tokenUrl: 'https://github.test/login/oauth/access_token',
          apiBaseUrl: 'https://api.github.test',
          scopes: ['read:user', 'repo'],
        },
        states: stateService(),
        cipher: new EnvelopeCipher(keyring),
        links: { async upsert() {} },
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      status: 500,
      code: 'GITHUB_OAUTH_SCOPE_NOT_ALLOWED',
      message: 'GitHub OAuth scope is not permitted',
    });
  });

  it('rejects broader scopes returned by GitHub before identity lookup or persistence', async () => {
    const saved: OAuthLinkRecord[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/login/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'gho_over_scoped_access_token',
            scope: 'read:user,repo',
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ id: 77, login: 'alice-gh' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const oauth = createGithubOAuthService({
      config: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        callbackUrl: 'http://test.local/api/github/oauth/callback',
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        apiBaseUrl: 'https://api.github.test',
        scopes: ['read:user'],
      },
      states: stateService(),
      cipher: new EnvelopeCipher(keyring),
      links: {
        async upsert(record) {
          saved.push(record);
        },
      },
      fetch: fetchMock,
    });
    const binding = { userId: 'user-a', sessionId: 'matrix-session-a' };
    const start = await oauth.start(binding);

    await expect(
      oauth.callback(binding, { state: start.state, code: 'oauth-code' }),
    ).rejects.toMatchObject({
      status: 502,
      code: 'GITHUB_OAUTH_SCOPE_NOT_ALLOWED',
      message: 'GitHub OAuth scope is not permitted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(0);
  });

  it('encrypts OAuth tokens before persistence without granting an installation', async () => {
    const saved: OAuthLinkRecord[] = [];
    const links: OAuthLinkStore = {
      async upsert(record) {
        saved.push(record);
      },
    };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/login/oauth/access_token')) {
        return new Response(
          JSON.stringify({
            access_token: 'gho_plaintext_access_token',
            refresh_token: 'ghr_plaintext_refresh_token',
            expires_in: 3600,
            scope: 'read:user',
            token_type: 'bearer',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 77, login: 'alice-gh' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    const states = stateService();
    const oauth = createGithubOAuthService({
      config: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        callbackUrl: 'http://test.local/api/github/oauth/callback',
        authorizeUrl: 'https://github.test/login/oauth/authorize',
        tokenUrl: 'https://github.test/login/oauth/access_token',
        apiBaseUrl: 'https://api.github.test',
        scopes: ['read:user'],
      },
      states,
      cipher: new EnvelopeCipher(keyring),
      links,
      fetch: fetchMock,
    });
    const binding = { userId: 'user-a', sessionId: 'matrix-session-a' };
    const start = await oauth.start(binding);
    const result = await oauth.callback(binding, { state: start.state, code: 'oauth-code' });

    const authorizationUrl = new URL(start.authorizationUrl);
    expect(authorizationUrl.searchParams.get('state')).toBe(start.state);
    expect(authorizationUrl.searchParams.get('scope')).toBe('read:user');
    expect(result).toEqual({ subject: '77', login: 'alice-gh', scopes: ['read:user'] });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      userId: 'user-a',
      workspaceId: null,
      subject: '77',
      scopes: ['read:user'],
    });
    expect(JSON.stringify(saved[0])).not.toContain('gho_plaintext_access_token');
    expect(JSON.stringify(saved[0])).not.toContain('ghr_plaintext_refresh_token');
    expect(saved[0]?.accessToken.keyVersion).toBe('test-v1');
    expect(saved[0]).not.toHaveProperty('installationId');
  });

  it('persists and reloads encrypted OAuth access and refresh tokens', async () => {
    await runMigrations();
    const userId = 'usr_github_oauth_tokens_test';
    const accessTokenPlaintext = 'gho_durable_plaintext_access_token';
    const refreshTokenPlaintext = 'ghr_durable_plaintext_refresh_token';
    const admin = getAdminPool();
    await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    await admin.query(
      `INSERT INTO users (id, matrix_user_id, homeserver_url)
       VALUES ($1, '@github-tokens:example.test', 'http://example.test')`,
      [userId],
    );
    try {
      const cipher = new EnvelopeCipher(keyring);
      const oauth = createGithubOAuthService({
        config: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          callbackUrl: 'http://test.local/api/github/oauth/callback',
          authorizeUrl: 'https://github.test/login/oauth/authorize',
          tokenUrl: 'https://github.test/login/oauth/access_token',
          apiBaseUrl: 'https://api.github.test',
          scopes: ['read:user'],
        },
        states: stateService(),
        cipher,
        links: databaseOAuthLinkStore,
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith('/login/oauth/access_token')) {
            return new Response(
              JSON.stringify({
                access_token: accessTokenPlaintext,
                refresh_token: refreshTokenPlaintext,
                expires_in: 3600,
                scope: 'read:user',
                token_type: 'bearer',
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.endsWith('/user')) {
            return new Response(JSON.stringify({ id: 88, login: 'durable-gh' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', { status: 404 });
        },
      });
      const binding = { userId, sessionId: 'matrix-session-for-durable-token-test' };
      const start = await oauth.start(binding);
      await oauth.callback(binding, { state: start.state, code: 'oauth-code' });

      const { rows } = await admin.query('SELECT * FROM github_links WHERE user_id = $1', [userId]);
      expect(rows).toHaveLength(1);
      const persisted = rows[0] as Record<string, unknown>;
      const serialized = JSON.stringify(persisted);
      expect(serialized).not.toContain(accessTokenPlaintext);
      expect(serialized).not.toContain(refreshTokenPlaintext);
      expect(persisted).toMatchObject({
        user_id: userId,
        workspace_id: null,
        oauth_subject: '88',
        token_key_version: 'test-v1',
        refresh_token_key_version: 'test-v1',
        scopes: ['read:user'],
      });

      await expect(
        cipher.decrypt({
          ciphertext: String(persisted.access_token_ciphertext),
          iv: String(persisted.access_token_iv),
          authTag: String(persisted.access_token_auth_tag),
          keyVersion: String(persisted.token_key_version),
        }),
      ).resolves.toBe(accessTokenPlaintext);
      await expect(
        cipher.decrypt({
          ciphertext: String(persisted.refresh_token_ciphertext),
          iv: String(persisted.refresh_token_iv),
          authTag: String(persisted.refresh_token_auth_tag),
          keyVersion: String(persisted.refresh_token_key_version),
        }),
      ).resolves.toBe(refreshTokenPlaintext);
    } finally {
      await admin.query('DELETE FROM users WHERE id = $1', [userId]);
    }
  });
});
