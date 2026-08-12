import { describe, it, expect, beforeAll } from 'vitest';
import {
  SYNAPSE_BASE_URL,
  ALICE,
  setupFixture,
  postMatrixSession,
  deleteSession,
  getRooms,
  sessionCookie,
  countUsers,
} from './support';

let aliceToken: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  aliceToken = fixture.aliceToken;
});

describe('POST /api/auth/matrix/session', () => {
  it('rejects an invalid token with 401 MATRIX_TOKEN_INVALID and creates no user', async () => {
    const before = await countUsers();
    const res = await postMatrixSession({ accessToken: 'syt_bad_token' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('MATRIX_TOKEN_INVALID');
    expect(await countUsers()).toBe(before);
  });

  it('creates one user and an HTTP-only opaque session for a valid token', async () => {
    const res = await postMatrixSession({ accessToken: aliceToken });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
    const body = (await res.json()) as {
      user: { id: string; homeserverUrl: string };
      sessionExpiresAt: string;
    };
    expect(body.user.id).toBe(ALICE.userId);
    expect(body.user.homeserverUrl).toBe(SYNAPSE_BASE_URL);
    expect(body.sessionExpiresAt).toBeTruthy();
    expect(await countUsers()).toBe(1);
  });

  it('never trusts a client-supplied Matrix user ID as identity', async () => {
    const res = await postMatrixSession({
      accessToken: aliceToken,
      userId: '@evil:example.test',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    expect(body.user.id).toBe(ALICE.userId);
  });
});

describe('DELETE /api/auth/session', () => {
  it('revokes an opaque session so it can no longer be used', async () => {
    const res = await postMatrixSession({ accessToken: aliceToken });
    const cookie = sessionCookie(res);
    const del = await deleteSession(cookie);
    expect(del.status).toBe(200);
    const after = await getRooms(cookie);
    expect(after.status).toBe(401);
  });
});
