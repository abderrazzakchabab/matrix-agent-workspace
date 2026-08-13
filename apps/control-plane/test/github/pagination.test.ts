import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGithubReadClient, type GithubReadClient } from '../../src/github/read-client';

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
let client: GithubReadClient;
const requestedPages: string[] = [];

beforeAll(async () => {
  const fixtureUrl = new URL('../../../../tests/fixtures/github/wiremock.json', import.meta.url);
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as { mappings: Mapping[] };
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.local');
    requestedPages.push(url.searchParams.get('page') ?? '');
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
  client = createGithubReadClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: 'ghs_fixture_read_token',
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('GitHub cursor pagination', () => {
  it('maps opaque pN cursors to GitHub pages and normalizes the next Link cursor', async () => {
    const first = await client.listIssues('acme', 'widget');
    const second = await client.listIssues('acme', 'widget', { cursor: first.nextCursor });

    expect(first.nextCursor).toBe('p2');
    expect(second.items[0]).toMatchObject({ number: 7, state: 'open' });
    expect(second.nextCursor).toBe('p3');
    expect(requestedPages).toEqual(['1', '2']);
  });

  it('converts transport failures to a structured GitHub read error', async () => {
    const failing = createGithubReadClient({
      token: 'ghs_transport_secret',
      fetch: async () => {
        throw new Error('socket failed with ghs_transport_secret');
      },
    });
    await expect(failing.listPullRequests('acme', 'widget')).rejects.toMatchObject({
      status: 502,
      code: 'GITHUB_READ_FAILED',
      message: 'GitHub read request failed',
    });
  });

  it('rejects malformed cursors before making an outbound request', async () => {
    const before = requestedPages.length;
    await expect(
      client.listIssues('acme', 'widget', { cursor: 'https://attacker.test/steal' }),
    ).rejects.toMatchObject({ status: 422, code: 'GITHUB_CURSOR_INVALID' });
    expect(requestedPages).toHaveLength(before);
  });
});
