/**
 * `GET /api/workspaces/:workspaceId/audit` — list the append-only audit trail
 * for grants, approvals, and mutation outcomes. Rows are tenant-scoped (RLS)
 * and payloads are stored redacted: tokens, confirmation text, and private
 * content never appear in responses. Cursor pagination is keyset-based.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  requireSession,
  toErrorResponse,
  withTenant,
  assertWorkspaceAccess,
} from '../../../../../auth/authorization';
import { databaseAuditStore } from '../../../../../github/mutation-command';

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
    const limit = limitParam ? Number(limitParam) : undefined;

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
