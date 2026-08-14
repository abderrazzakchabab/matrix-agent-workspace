/**
 * Shared in-memory GitHub fixture for the Phase C write-control tests. It
 * mirrors `tests/fixtures/github/server.ts` (the Docker fixture) so focused
 * test runs exercise the same request recording, authorization classes, and
 * write mappings without requiring Docker.
 */
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';

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

export interface RecordedRequest {
  method: string;
  path: string;
  authorizationClass: 'none' | 'oauth' | 'installation' | 'app' | 'invalid';
}

export interface RecordedMutation extends RecordedRequest {
  body: unknown;
}

export interface GithubFixture {
  baseUrl: string;
  state(): {
    requests: RecordedRequest[];
    mutationRequests: RecordedRequest[];
    mutationBodies: RecordedMutation[];
  };
  reset(): void;
  close(): Promise<void>;
}

const OAUTH_TOKEN = 'gho_fixture_read_token';
const INSTALLATION_TOKEN = 'ghs_fixture_read_token';

function authorizationClass(
  header: string | undefined,
): RecordedRequest['authorizationClass'] {
  if (!header) return 'none';
  const match = /^Bearer (.+)$/i.exec(header);
  if (!match) return 'invalid';
  const token = match[1]!;
  if (token === OAUTH_TOKEN) return 'oauth';
  if (token === INSTALLATION_TOKEN || token.startsWith('ghs_')) return 'installation';
  if (/^[^.]+\.[^.]+\.[^.]+$/.test(token)) return 'app';
  return 'invalid';
}

export async function startGithubFixture(): Promise<GithubFixture> {
  const fixtureUrl = new URL('../../../../tests/fixtures/github/wiremock.json', import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as { mappings: Mapping[] };
  let requests: RecordedRequest[] = [];
  let mutationRequests: RecordedRequest[] = [];
  let mutationBodies: RecordedMutation[] = [];

  function json(response: import('node:http').ServerResponse, status: number, body: unknown) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    const method = request.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      json(response, 200, { status: 'ok', fixture: 'github' });
      return;
    }
    if (method === 'GET' && url.pathname === '/__fixture/state') {
      json(response, 200, { requests, mutationRequests, mutationBodies });
      return;
    }
    if (method === 'POST' && url.pathname === '/__fixture/reset') {
      requests = [];
      mutationRequests = [];
      mutationBodies = [];
      json(response, 200, { reset: true });
      return;
    }

    const authClass = authorizationClass(request.headers.authorization);
    const item: RecordedRequest = { method, path: url.pathname, authorizationClass: authClass };
    requests.push(item);

    if (method !== 'GET' && (url.pathname.startsWith('/repos/') || url.pathname === '/graphql')) {
      mutationRequests.push(item);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      let body: unknown = null;
      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      mutationBodies.push({ ...item, body });
    }

    if (
      (url.pathname === '/installation/repositories' || url.pathname.startsWith('/repos/')) &&
      authClass !== 'installation'
    ) {
      json(response, 401, { message: 'GitHub fixture authorization rejected' });
      return;
    }

    const mapping = fixture.mappings.find((candidate) => {
      if (candidate.request.method !== method || candidate.request.urlPath !== url.pathname) {
        return false;
      }
      return Object.entries(candidate.request.queryParameters ?? {}).every(
        ([key, expected]) => url.searchParams.get(key) === expected.equalTo,
      );
    });
    if (!mapping) {
      json(response, 404, { message: 'GitHub fixture mapping not found' });
      return;
    }
    response.writeHead(mapping.response.status, mapping.response.headers ?? {});
    response.end(JSON.stringify(mapping.response.jsonBody));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state: () => ({ requests, mutationRequests, mutationBodies }),
    reset: () => {
      requests = [];
      mutationRequests = [];
      mutationBodies = [];
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
