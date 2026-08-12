import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getMatrixClient } from '../../../../../auth/matrix-token';
import {
  createSession,
  upsertMatrixUser,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '../../../../../auth/session-service';
import { getSynapseBaseUrl } from '../../../../../auth/matrix-token';
import { toErrorResponse } from '../../../../../auth/authorization';

const MatrixSessionRequest = z.object({
  homeserverUrl: z.string().min(1),
  accessToken: z.string().min(1),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const json = await request.json().catch(() => null);
    const parsed = MatrixSessionRequest.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid request body', requestId } },
        { status: 422 },
      );
    }
    const { accessToken } = parsed.data;

    // Identity is established only by the configured Synapse `/whoami`; the
    // client-supplied homeserver URL and any client-supplied user id are never
    // used as identity. The session is scoped to the verified homeserver.
    const matrix = getMatrixClient();
    const whoami = await matrix.whoami(accessToken);
    const homeserverUrl = getSynapseBaseUrl();

    const userId = await upsertMatrixUser(whoami.userId, homeserverUrl);
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    const { opaqueId } = await createSession(userId, accessToken, expiresAt);

    const cookie = `${SESSION_COOKIE}=${opaqueId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure`;

    return NextResponse.json(
      {
        requestId,
        user: { id: whoami.userId, homeserverUrl },
        sessionExpiresAt: expiresAt.toISOString(),
      },
      { headers: { 'Set-Cookie': cookie } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
