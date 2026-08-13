import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, toErrorResponse } from '../../../../../auth/authorization';
import { getDefaultGithubOAuthService } from '../../../../../github/oauth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const oauth = getDefaultGithubOAuthService();
    const start = await oauth.start({ userId: auth.userId, sessionId: auth.sessionOpaqueId });
    const response = NextResponse.redirect(start.authorizationUrl, 302);
    response.headers.set('cache-control', 'no-store');
    response.headers.set('x-request-id', requestId);
    return response;
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
