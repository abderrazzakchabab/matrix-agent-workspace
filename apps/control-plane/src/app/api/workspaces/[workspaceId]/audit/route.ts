/**
 * `GET /api/workspaces/:workspaceId/audit` — list the append-only audit trail
 * for grants, approvals, and mutation outcomes. Rows are tenant-scoped (RLS)
 * and payloads are stored redacted: tokens, confirmation text, and private
 * content never appear in responses. Cursor pagination is keyset-based.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, toErrorResponse, withTenant, assertWorkspaceAccess } from '../../../../../auth/authorization';
import {
  databaseAuditStore,
  decodeAuditCursor,
} from '../../../../../github/mutation-command';

class AuditQueryValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'AuditQueryValidationError';
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { workspaceId } = await context.params;
    const auth = await requireSession(request);

    await withTenant(auth.userId, async (client) => {
      await assertWorkspaceAccess(client, workspaceId);
    });

    const cursor = request.nextUrl.searchParams.get('cursor') ?? undefined;
    const limitParam = request.nextUrl.searchParams.get('limit');
    let limit: number | undefined;
    if (limitParam !== null) {
      const parsed = Number(limitParam);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new AuditQueryValidationError('Invalid audit limit');
      }
      limit = parsed;
    }
    if (cursor !== undefined) {
      decodeAuditCursor(cursor);
    }

    const page = await databaseAuditStore.list({
      userId: auth.userId,
      workspaceId,
      cursor,
      limit,
    });

    return NextResponse.json({
      requestId,
      items: page.items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
