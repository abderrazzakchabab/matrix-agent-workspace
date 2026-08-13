import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  requireSession,
  toErrorResponse,
  ValidationError,
} from '../../../../auth/authorization';
import {
  acquireInstallationToken,
  authorizeInstallationAccess,
} from '../../../../github/app-auth';
import { createGithubReadClient } from '../../../../github/read-client';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const workspaceId = request.nextUrl.searchParams.get('workspaceId');
    const installationId = request.nextUrl.searchParams.get('installationId');
    const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
    if (!workspaceId || !installationId) {
      throw new ValidationError('workspaceId and installationId are required');
    }
    if (cursor && !/^p[1-9][0-9]*$/.test(cursor)) {
      throw new ValidationError('Invalid GitHub pagination cursor');
    }
    const installation = await authorizeInstallationAccess({
      userId: auth.userId,
      workspaceId,
      installationId,
    });
    const token = await acquireInstallationToken(installation);
    const page = await createGithubReadClient({ token }).listRepositories({
      installationId,
      cursor,
    });
    const allowlist = new Set(
      installation.repositoryAllowlist.map((entry) => {
        const normalized = entry.trim().toLowerCase();
        return normalized.includes('/')
          ? normalized
          : `${installation.owner.toLowerCase()}/${normalized}`;
      }),
    );
    return NextResponse.json({
      requestId,
      items: page.items.filter((repository) => allowlist.has(repository.fullName.toLowerCase())),
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

export async function POST(_request: NextRequest): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function PUT(_request: NextRequest): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function PATCH(_request: NextRequest): Promise<NextResponse> {
  return methodNotAllowed();
}
export async function DELETE(_request: NextRequest): Promise<NextResponse> {
  return methodNotAllowed();
}
