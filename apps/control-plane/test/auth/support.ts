import { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '../../src/auth/session-service';
import { getSynapseBaseUrl } from '../../src/auth/matrix-token';
import { getPool, getAdminPool, runMigrations } from '../../src/db/client';
import { withTenant } from '../../src/auth/authorization';
import { POST as postMatrixSessionHandler } from '../../src/app/api/auth/matrix/session/route';
import { DELETE as deleteSessionHandler } from '../../src/app/api/auth/session/route';
import { POST as postWorkspaceHandler } from '../../src/app/api/workspaces/route';
import { GET as getRoomsHandler } from '../../src/app/api/rooms/route';
import { POST as bindRoomHandler } from '../../src/app/api/rooms/[roomId]/binding/route';

export const SYNAPSE_BASE_URL = getSynapseBaseUrl();

export const ALICE = {
  localpart: 'alice',
  password: 'alice_secret',
  userId: '@alice:example.test',
};
export const BOB = {
  localpart: 'bob',
  password: 'bob_secret',
  userId: '@bob:example.test',
};

/** Log in to the Synapse fixture and return an access token. */
export async function synapseLogin(localpart: string, password: string): Promise<string> {
  const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: localpart },
      password,
    }),
  });
  if (!res.ok) throw new Error(`synapse login failed for ${localpart}: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Create a private room owned by the given token holder; returns the room id. */
export async function createRoom(token: string): Promise<string> {
  const res = await fetch(`${SYNAPSE_BASE_URL}/_matrix/client/v3/createRoom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: 'Alice Room', preset: 'private_chat' }),
  });
  if (!res.ok) throw new Error(`createRoom failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { room_id: string };
  return data.room_id;
}

/** Apply migrations and reset the control-plane database, returning fixture credentials. */
export async function setupFixture(): Promise<{ aliceToken: string; bobToken: string; roomId: string }> {
  await runMigrations();
  await resetDatabase();
  const aliceToken = await synapseLogin(ALICE.localpart, ALICE.password);
  const bobToken = await synapseLogin(BOB.localpart, BOB.password);
  const roomId = await createRoom(aliceToken);
  return { aliceToken, bobToken, roomId };
}

export async function resetDatabase(): Promise<void> {
  await getAdminPool().query(
    'TRUNCATE room_bindings, workspace_members, sessions, rooms, workspaces, users CASCADE',
  );
}

export async function countUsers(): Promise<number> {
  const { rows } = await getAdminPool().query('SELECT count(*)::int AS n FROM users');
  return rows[0].n as number;
}

export async function internalUserId(matrixUserId: string): Promise<string> {
  const { rows } = await getAdminPool().query(
    'SELECT id FROM users WHERE matrix_user_id = $1',
    [matrixUserId],
  );
  if (!rows[0]) throw new Error(`no user row for ${matrixUserId}`);
  return rows[0].id as string;
}

/** Workspace ids visible to the given matrix user under their RLS tenant context. */
export async function selectWorkspaceIdsAs(matrixUserId: string): Promise<string[]> {
  const userId = await internalUserId(matrixUserId);
  return withTenant(userId, async (client) => {
    const { rows } = await client.query('SELECT id FROM workspaces ORDER BY id');
    return rows.map((r) => r.id as string);
  });
}

/** Workspace ids visible with no tenant context set (RLS default deny). */
export async function selectWorkspaceIdsRaw(): Promise<string[]> {
  const { rows } = await getPool().query('SELECT id FROM workspaces ORDER BY id');
  return rows.map((r) => r.id as string);
}

function jsonRequest(
  path: string,
  method: string,
  body?: unknown,
  cookie?: string,
): NextRequest {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers['cookie'] = cookie;
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

export async function postMatrixSession(opts: {
  homeserverUrl?: string;
  accessToken: string;
  userId?: string;
}): Promise<Response> {
  const req = jsonRequest('/api/auth/matrix/session', 'POST', {
    homeserverUrl: opts.homeserverUrl ?? SYNAPSE_BASE_URL,
    accessToken: opts.accessToken,
    userId: opts.userId,
  });
  return postMatrixSessionHandler(req);
}

export async function postWorkspace(opts: {
  name: string;
  policy?: Record<string, unknown>;
  cookie?: string;
}): Promise<Response> {
  const req = jsonRequest(
    '/api/workspaces',
    'POST',
    { name: opts.name, policy: opts.policy },
    opts.cookie,
  );
  return postWorkspaceHandler(req);
}

export async function bindRoom(
  roomId: string,
  workspaceId: string,
  cookie: string,
): Promise<Response> {
  const req = jsonRequest(
    `/api/rooms/${encodeURIComponent(roomId)}/binding`,
    'POST',
    { workspaceId },
    cookie,
  );
  return bindRoomHandler(req, { params: Promise.resolve({ roomId }) });
}

export async function getRooms(cookie: string): Promise<Response> {
  return getRoomsHandler(jsonRequest('/api/rooms', 'GET', undefined, cookie));
}

export async function deleteSession(cookie: string): Promise<Response> {
  return deleteSessionHandler(jsonRequest('/api/auth/session', 'DELETE', undefined, cookie));
}

/** Extract the `matrix_session=<value>` cookie header value from a Set-Cookie. */
export function sessionCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = new RegExp(`(${SESSION_COOKIE}=[^;]+)`).exec(setCookie);
  if (!match) throw new Error(`no ${SESSION_COOKIE} cookie in Set-Cookie: ${setCookie}`);
  return match[1];
}
