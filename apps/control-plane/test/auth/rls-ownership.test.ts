import { describe, it, expect, beforeAll } from 'vitest';
import {
  ALICE,
  BOB,
  setupFixture,
  postMatrixSession,
  postWorkspace,
  bindRoom,
  sessionCookie,
  selectWorkspaceIdsAs,
  selectWorkspaceIdsRaw,
} from './support';

let roomId: string;
let aliceCookie: string;
let bobCookie: string;
let aliceWorkspaceId: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  roomId = fixture.roomId;
  aliceCookie = sessionCookie(await postMatrixSession({ accessToken: fixture.aliceToken }));
  bobCookie = sessionCookie(await postMatrixSession({ accessToken: fixture.bobToken }));

  const ws = await postWorkspace({ name: 'Alice Private Workspace', cookie: aliceCookie });
  aliceWorkspaceId = ((await ws.json()) as { workspaceId: string }).workspaceId;
});

describe('RLS tenant isolation', () => {
  it('lets the owner read their own workspace under their tenant context', async () => {
    const ids = await selectWorkspaceIdsAs(ALICE.userId);
    expect(ids).toContain(aliceWorkspaceId);
  });

  it('denies a second user read access to the first user\u2019s workspace', async () => {
    const ids = await selectWorkspaceIdsAs(BOB.userId);
    expect(ids).toEqual([]);
  });

  it('denies reads when no tenant context is set (RLS default deny)', async () => {
    expect(await selectWorkspaceIdsRaw()).toEqual([]);
  });

  it('denies binding a room to a workspace the user cannot access', async () => {
    const res = await bindRoom(roomId, aliceWorkspaceId, bobCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('WORKSPACE_ACCESS_DENIED');
  });
});
