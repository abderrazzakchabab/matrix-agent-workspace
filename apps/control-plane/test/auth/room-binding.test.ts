import { describe, it, expect, beforeAll } from 'vitest';
import {
  ALICE,
  BOB,
  setupFixture,
  postMatrixSession,
  postWorkspace,
  bindRoom,
  sessionCookie,
} from './support';

let roomId: string;
let aliceCookie: string;
let bobCookie: string;
let aliceWorkspaceId: string;
let bobWorkspaceId: string;

beforeAll(async () => {
  const fixture = await setupFixture();
  roomId = fixture.roomId;
  aliceCookie = sessionCookie(await postMatrixSession({ accessToken: fixture.aliceToken }));
  bobCookie = sessionCookie(await postMatrixSession({ accessToken: fixture.bobToken }));

  const aliceWs = await postWorkspace({ name: 'Alice Workspace', cookie: aliceCookie });
  aliceWorkspaceId = ((await aliceWs.json()) as { workspaceId: string }).workspaceId;
  const bobWs = await postWorkspace({ name: 'Bob Workspace', cookie: bobCookie });
  bobWorkspaceId = ((await bobWs.json()) as { workspaceId: string }).workspaceId;
});

describe('POST /api/rooms/:roomId/binding', () => {
  it('binds a room when Synapse confirms membership', async () => {
    const res = await bindRoom(roomId, aliceWorkspaceId, aliceCookie);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      roomId,
      workspaceId: aliceWorkspaceId,
      boundBy: ALICE.userId,
    });
  });

  it('rejects a room with 403 ROOM_MEMBERSHIP_REQUIRED when Synapse membership verification fails', async () => {
    // bob is a valid Synapse user but is not a member of alice's room
    const res = await bindRoom(roomId, bobWorkspaceId, bobCookie);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ROOM_MEMBERSHIP_REQUIRED');
  });
});
