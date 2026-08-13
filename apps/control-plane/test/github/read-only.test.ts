import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGithubReadClient,
  type GithubReadClient,
} from '../../src/github/read-client';
import {
  acquireInstallationToken,
  authorizeRepositoryAccess,
  type InstallationAuthorizationStore,
} from '../../src/github/app-auth';
import { EnvelopeCipher, type EnvelopeKeyring } from '../../src/security/envelope-encryption';
import * as repositoriesRoute from '../../src/app/api/github/repositories/route';
import * as issuesRoute from '../../src/app/api/github/repositories/[owner]/[repo]/issues/route';
import * as pullsRoute from '../../src/app/api/github/repositories/[owner]/[repo]/pulls/route';

interface Mapping {
  request: {
    method: string;
    urlPath: string;
    queryParameters?: Record<string, { equalTo: string }>;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    jsonBody: unknown;
  };
}

let server: Server;
let baseUrl = '';
let client: GithubReadClient;
const requests: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  const fixtureUrl = new URL('../../../../tests/fixtures/github/wiremock.json', import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as { mappings: Mapping[] };
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    requests.push({ method: request.method ?? 'GET', url: url.pathname });
    const mapping = fixture.mappings.find((candidate) => {
      if (candidate.request.method !== request.method || candidate.request.urlPath !== url.pathname) {
        return false;
      }
      return Object.entries(candidate.request.queryParameters ?? {}).every(
        ([key, expected]) => url.searchParams.get(key) === expected.equalTo,
      );
    });
    if (!mapping) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'fixture mapping not found' }));
      return;
    }
    response.writeHead(mapping.response.status, mapping.response.headers);
    response.end(JSON.stringify(mapping.response.jsonBody));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = createGithubReadClient({ baseUrl, token: 'ghs_fixture_read_token' });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('GitHub read-only client', () => {
  it('normalizes authorized repositories, issues, pull requests, files, and reviews', async () => {
    const repositories = await client.listRepositories({ installationId: '42' });
    const issues = await client.listIssues('acme', 'widget');
    const pulls = await client.listPullRequests('acme', 'widget');
    const files = await client.listPullRequestFiles('acme', 'widget', 11);
    const reviews = await client.listPullRequestReviews('acme', 'widget', 11);

    expect(repositories.items[0]).toMatchObject({
      id: 101,
      fullName: 'acme/widget',
      owner: 'acme',
      private: true,
      defaultBranch: 'main',
    });
    expect(issues.items[0]).toMatchObject({ number: 6, state: 'closed', author: 'octo' });
    expect(pulls.items[0]).toMatchObject({ number: 11, state: 'open', head: 'safe-widget' });
    expect(files.items[0]).toMatchObject({ filename: 'src/widget.ts', changes: 5 });
    expect(reviews.items[0]).toMatchObject({ state: 'approved', author: 'reviewer-gh' });
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  });

  it('requires tenant installation access and an explicit repository allowlist entry', async () => {
    const store: InstallationAuthorizationStore = {
      async findInstallation({ workspaceId }) {
        if (workspaceId !== 'workspace-a') return null;
        return {
          id: 'inst-row-1',
          workspaceId,
          installationId: '42',
          owner: 'acme',
          repositoryAllowlist: ['acme/widget'],
          encryptedToken: null,
          expiresAt: null,
        };
      },
      async updateToken() {},
    };

    await expect(
      authorizeRepositoryAccess(
        { userId: 'user-a', workspaceId: 'workspace-a', owner: 'acme', repo: 'widget' },
        store,
      ),
    ).resolves.toMatchObject({ installationId: '42' });
    await expect(
      authorizeRepositoryAccess(
        { userId: 'user-a', workspaceId: 'workspace-b', owner: 'acme', repo: 'widget' },
        store,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'GITHUB_INSTALLATION_ACCESS_DENIED' });
    await expect(
      authorizeRepositoryAccess(
        { userId: 'user-a', workspaceId: 'workspace-a', owner: 'acme', repo: 'secret' },
        store,
      ),
    ).rejects.toMatchObject({ status: 403, code: 'GITHUB_REPOSITORY_ACCESS_DENIED' });
  });

  it('acquires a repository-scoped App token and encrypts it before caching', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyring: EnvelopeKeyring = {
      currentVersion: 'app-v1',
      getKey(version) {
        return version === 'app-v1'
          ? { version, key: Buffer.from('2a'.repeat(32), 'hex') }
          : undefined;
      },
    };
    const updates: unknown[] = [];
    const store: InstallationAuthorizationStore = {
      async findInstallation() {
        return null;
      },
      async updateToken(input) {
        updates.push(input);
      },
    };
    let requestedBody: unknown;
    const token = await acquireInstallationToken(
      {
        id: 'inst-row-1',
        userId: 'user-a',
        workspaceId: 'workspace-a',
        installationId: '42',
        owner: 'acme',
        repositoryAllowlist: ['acme/widget'],
        encryptedToken: null,
        expiresAt: null,
      },
      store,
      {
        config: {
          appId: '123',
          privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
          apiBaseUrl: 'https://api.github.test',
        },
        cipher: new EnvelopeCipher(keyring),
        fetch: async (_input, init) => {
          expect(init?.method).toBe('POST');
          expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
          requestedBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({
              token: 'ghs_plaintext_installation_token',
              expires_at: '2030-01-01T00:00:00Z',
              permissions: { contents: 'read', issues: 'read', pull_requests: 'read' },
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          );
        },
      },
    );

    expect(token).toBe('ghs_plaintext_installation_token');
    expect(requestedBody).toEqual({ repositories: ['widget'] });
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates)).not.toContain('ghs_plaintext_installation_token');
  });

  it('converts GitHub App transport failures to a structured error', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyring: EnvelopeKeyring = {
      currentVersion: 'app-v1',
      getKey(version) {
        return version === 'app-v1'
          ? { version, key: Buffer.from('2a'.repeat(32), 'hex') }
          : undefined;
      },
    };
    await expect(
      acquireInstallationToken(
        {
          id: 'inst-row-1',
          userId: 'user-a',
          workspaceId: 'workspace-a',
          installationId: '42',
          owner: 'acme',
          repositoryAllowlist: ['acme/widget'],
          encryptedToken: null,
          expiresAt: null,
        },
        { async findInstallation() { return null; }, async updateToken() {} },
        {
          config: {
            appId: '123',
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            apiBaseUrl: 'https://api.github.test',
          },
          cipher: new EnvelopeCipher(keyring),
          fetch: async () => {
            throw new Error('network failure with signed app JWT');
          },
        },
      ),
    ).rejects.toMatchObject({
      status: 502,
      code: 'GITHUB_APP_AUTHENTICATION_FAILED',
      message: 'GitHub App authentication failed',
    });
  });

  it('rejects every mutation method on every Phase B repository route before any GitHub outbound request', async () => {
    const before = requests.length;
    const context = { params: Promise.resolve({ owner: 'acme', repo: 'widget' }) };
    const methods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
    const routeCases = [
      {
        path: '/api/github/repositories',
        handlers: repositoriesRoute,
        invoke(method: (typeof methods)[number], request: NextRequest) {
          return repositoriesRoute[method](request);
        },
      },
      {
        path: '/api/github/repositories/acme/widget/issues',
        handlers: issuesRoute,
        invoke(method: (typeof methods)[number], request: NextRequest) {
          return issuesRoute[method](request, context);
        },
      },
      {
        path: '/api/github/repositories/acme/widget/pulls',
        handlers: pullsRoute,
        invoke(method: (typeof methods)[number], request: NextRequest) {
          return pullsRoute[method](request, context);
        },
      },
    ];

    const responses = await Promise.all(
      routeCases.flatMap(({ path, handlers, invoke }) =>
        methods.map((method) => {
          expect(handlers[method]).toBeTypeOf('function');
          return invoke(method, new NextRequest(`http://test.local${path}`, { method }));
        }),
      ),
    );

    expect(responses).toHaveLength(routeCases.length * methods.length);
    expect(responses.every((response) => response.status === 405)).toBe(true);
    expect(requests).toHaveLength(before);
  });
});
