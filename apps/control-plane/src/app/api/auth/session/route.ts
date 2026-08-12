import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { toErrorResponse, requireSession } from '../../../../auth/authorization';
import { revokeSession, SESSION_COOKIE } from '../../../../auth/session-service';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    await revokeSession(auth.sessionOpaqueId);
    const cookie = `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure`;
    return NextResponse.json(
      { requestId, revoked: true },
      { headers: { 'Set-Cookie': cookie } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
