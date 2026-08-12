import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getMatrixClient } from '../../../auth/matrix-token';
import { toErrorResponse, requireSession, withTenant } from '../../../auth/authorization';

export interface RoomSummary {
  roomId: string;
  homeserverUrl: string;
  displayName: string | null;
  workspaceId: string | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const matrix = getMatrixClient();
    const joined = await matrix.joinedRooms(auth.accessToken);

    const bindings = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT b.room_id, b.homeserver_url, b.workspace_id, r.display_name
           FROM room_bindings b
           LEFT JOIN rooms r
             ON r.room_id = b.room_id AND r.homeserver_url = b.homeserver_url`,
      );
      return rows as Array<{
        room_id: string;
        homeserver_url: string;
        workspace_id: string;
        display_name: string | null;
      }>;
    });

    const boundByRoom = new Map(bindings.map((b) => [b.room_id, b]));
    const seen = new Set<string>();
    const rooms: RoomSummary[] = [];

    for (const roomId of joined) {
      seen.add(roomId);
      const binding = boundByRoom.get(roomId);
      rooms.push({
        roomId,
        homeserverUrl: auth.homeserverUrl,
        displayName: binding?.display_name ?? null,
        workspaceId: binding?.workspace_id ?? null,
      });
    }
    for (const binding of bindings) {
      if (seen.has(binding.room_id)) continue;
      rooms.push({
        roomId: binding.room_id,
        homeserverUrl: binding.homeserver_url,
        displayName: binding.display_name ?? null,
        workspaceId: binding.workspace_id,
      });
    }

    return NextResponse.json({ requestId, rooms });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
