import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getMatrixClient } from '../../../../../auth/matrix-token';
import {
  toErrorResponse,
  requireSession,
  withTenant,
  assertWorkspaceAccess,
} from '../../../../../auth/authorization';

const BindingRequest = z.object({
  workspaceId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ roomId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { roomId } = await context.params;
    if (!roomId || !roomId.startsWith('!')) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid room id', requestId } },
        { status: 422 },
      );
    }

    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = BindingRequest.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', requestId } },
        { status: 422 },
      );
    }
    const { workspaceId } = parsed.data;

    // 1. Workspace access (RLS): only members can bind a room into a workspace.
    await withTenant(auth.userId, async (client) => {
      await assertWorkspaceAccess(client, workspaceId);
    });

    // 2. Synapse membership verification before persisting anything.
    const matrix = getMatrixClient();
    await matrix.assertMembership(auth.accessToken, roomId, auth.matrixUserId);

    // 3. Persist the binding and cache the room (tenant-scoped).
    await withTenant(auth.userId, async (client) => {
      await client.query('SELECT ensure_room($1, $2, $3)', [
        roomId,
        auth.homeserverUrl,
        null,
      ]);
      await client.query(
        `INSERT INTO room_bindings
           (room_id, homeserver_url, workspace_id, user_id, verified_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, room_id, homeserver_url)
         DO UPDATE SET workspace_id = EXCLUDED.workspace_id, verified_at = now()`,
        [roomId, auth.homeserverUrl, workspaceId, auth.userId],
      );
    });

    return NextResponse.json(
      { requestId, roomId, workspaceId, boundBy: auth.matrixUserId },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
