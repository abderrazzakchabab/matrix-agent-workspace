import { describe, it, expect, beforeAll } from 'vitest';
import {
  ALICE,
  setupFixture,
  postMatrixSession,
  postWorkspace,
  sessionCookie,
} from './support';

let aliceCookie: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  const res = await postMatrixSession({ accessToken: fixture.aliceToken });
  aliceCookie = sessionCookie(res);
});

describe('POST /api/workspaces', () => {
  it('creates a workspace for an authenticated user', async () => {
    const res = await postWorkspace({
      name: 'Test Workspace',
      policy: { readOnly: true },
      cookie: aliceCookie,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      workspaceId: string;
      name: string;
      ownerId: string;
      status: string;
      createdAt: string;
    };
    expect(body).toMatchObject({ name: 'Test Workspace', status: 'active' });
    expect(body.workspaceId).toMatch(/^ws_/);
    expect(body.ownerId).toBe(ALICE.userId);
    expect(body.createdAt).toBeTruthy();
  });

  it('rejects an anonymous request with 401', async () => {
    const res = await postWorkspace({ name: 'x' });
    expect(res.status).toBe(401);
  });

  it('rejects a blank name with 422', async () => {
    const res = await postWorkspace({ name: '', cookie: aliceCookie });
    expect(res.status).toBe(422);
  });
});
