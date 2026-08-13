import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const port = Number(process.env.GITHUB_FIXTURE_PORT ?? 4020);

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

interface RecordedRequest {
  method: string;
  path: string;
}

const fixturePath = new URL('./wiremock.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { mappings: Mapping[] };
let requests: RecordedRequest[] = [];
let mutationRequests: RecordedRequest[] = [];

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function record(method: string, path: string): void {
  const item = { method, path };
  requests.push(item);
  if (method !== 'GET' && (path.startsWith('/repos/') || path === '/graphql')) {
    mutationRequests.push(item);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://fixture.local');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/health') {
    json(response, 200, { status: 'ok', fixture: 'github' });
    return;
  }
  if (method === 'GET' && url.pathname === '/__fixture/state') {
    json(response, 200, { requests, mutationRequests });
    return;
  }
  if (method === 'POST' && url.pathname === '/__fixture/reset') {
    requests = [];
    mutationRequests = [];
    json(response, 200, { reset: true });
    return;
  }

  record(method, url.pathname);

  if (method === 'POST' && url.pathname === '/login/oauth/access_token') {
    json(response, 200, {
      access_token: 'gho_fixture_read_token',
      refresh_token: 'ghr_fixture_refresh_token',
      expires_in: 3600,
      scope: 'read:user',
      token_type: 'bearer',
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/user') {
    json(response, 200, { id: 9001, login: 'alice-gh' });
    return;
  }
  if (method === 'POST' && url.pathname === '/app/installations/42/access_tokens') {
    json(response, 201, {
      token: 'ghs_fixture_read_token',
      expires_at: '2035-01-01T00:00:00Z',
      permissions: { contents: 'read', issues: 'read', pull_requests: 'read' },
    });
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
  response.writeHead(mapping.response.status, mapping.response.headers);
  response.end(JSON.stringify(mapping.response.jsonBody));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`wiremock github fixture listening on ${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
