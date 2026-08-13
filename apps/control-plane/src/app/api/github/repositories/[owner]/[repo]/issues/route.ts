import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  requireSession,
  toErrorResponse,
  ValidationError,
} from '../../../../../../../auth/authorization';
import {
  acquireInstallationToken,
  authorizeRepositoryAccess,
} from '../../../../../../../github/app-auth';
import { createGithubReadClient } from '../../../../../../../github/read-client';

const REPOSITORY_NAME = /^[A-Za-z0-9_.-]+$/;

type RouteContext = { params: Promise<{ owner: string; repo: string }> };

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const { owner, repo } = await context.params;
    const workspaceId = request.nextUrl.searchParams.get('workspaceId');
    const installationId = request.nextUrl.searchParams.get('installationId') ?? undefined;
    const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
    if (!workspaceId) throw new ValidationError('workspaceId is required');
    if (!REPOSITORY_NAME.test(owner) || !REPOSITORY_NAME.test(repo)) {
      throw new ValidationError('Invalid repository');
    }
    if (cursor && !/^p[1-9][0-9]*$/.test(cursor)) {
      throw new ValidationError('Invalid GitHub pagination cursor');
    }
    const installation = await authorizeRepositoryAccess({
      userId: auth.userId,
      workspaceId,
      installationId,
      owner,
      repo,
    });
    const token = await acquireInstallationToken(installation);
    const page = await createGithubReadClient({ token }).listIssues(owner, repo, { cursor });
    return NextResponse.json({
      requestId,
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}

function methodNotAllowed(): NextResponse {
  const requestId = `req_${randomUUID()}`;
  return NextResponse.json(
    {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'GitHub mutations are not available',
        requestId,
      },
    },
    { status: 405, headers: { allow: 'GET' } },
  );
}

export async function POST(_request: NextRequest, _context: RouteContext): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function PUT(_request: NextRequest, _context: RouteContext): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function PATCH(_request: NextRequest, _context: RouteContext): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function DELETE(_request: NextRequest, _context: RouteContext): Promise<NextResponse> {
  return methodNotAllowed();
}
