import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, toErrorResponse } from '../../../../../auth/authorization';
import { getDefaultGithubOAuthService } from '../../../../../github/oauth';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const state = request.nextUrl.searchParams.get('state') ?? '';
    const code = request.nextUrl.searchParams.get('code') ?? '';
    const result = await getDefaultGithubOAuthService().callback(
      { userId: auth.userId, sessionId: auth.sessionOpaqueId },
      { state, code },
    );
    const successRedirect = process.env.GITHUB_OAUTH_SUCCESS_REDIRECT;
    if (successRedirect) {
      const url = new URL(successRedirect);
      url.searchParams.set('github', 'linked');
      const response = NextResponse.redirect(url, 302);
      response.headers.set('cache-control', 'no-store');
      response.headers.set('x-request-id', requestId);
      return response;
    }
    return NextResponse.json(
      { requestId, linked: true, github: { subject: result.subject, login: result.login } },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
