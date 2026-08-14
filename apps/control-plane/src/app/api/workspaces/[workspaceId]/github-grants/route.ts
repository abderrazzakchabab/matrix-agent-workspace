/**
 * `POST /api/workspaces/:workspaceId/github-grants` — request a separate
 * repository+scope write grant.
 *
 * Phase B read authorization never implies write authorization: a grant row
 * (status `pending`) is created only for an authenticated workspace member,
 * and the mutation gate accepts it only after it is approved. Grant rows are
 * repository- and scope-specific and RLS-isolated per workspace.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireSession,
  toErrorResponse,
  withTenant,
  assertWorkspaceAccess,
} from '../../../../../auth/authorization';
import { WRITE_SCOPES } from '../../../../../github/write-authorization';
import { databaseWriteGrantStore } from '../../../../../github/write-authorization';
import { databaseAuditStore } from '../../../../../github/mutation-command';
import { parseRepository } from '../../../../../github/mutation-command';

const CreateGrantBody = z.object({
  repository: z.string().min(1).max(200),
  scope: z.enum(WRITE_SCOPES),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { workspaceId } = await context.params;
    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = CreateGrantBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid grant request',
            requestId,
          },
        },
        { status: 422 },
      );
    }
    const body = parsed.data;
    // Reject anything that is not a plain `owner/repo` name.
    parseRepository(body.repository);

    await withTenant(auth.userId, async (client) => {
      await assertWorkspaceAccess(client, workspaceId);
    });

    const grant = await databaseWriteGrantStore.createGrant({
      userId: auth.userId,
      id: `grt_${randomUUID()}`,
      workspaceId,
      grantedBy: auth.userId,
      repository: body.repository,
      scope: body.scope,
    });

    await databaseAuditStore
      .record({
        workspaceId,
        actorUserId: auth.userId,
        actorMatrixId: auth.matrixUserId,
        scope: body.scope,
        repository: body.repository,
        outcome: 'grant_requested',
        details: { status: grant.status },
      })
      .catch(() => undefined);

    return NextResponse.json(
      {
        requestId,
        grantId: grant.id,
        status: grant.status,
        repository: grant.repository,
        scope: grant.scope,
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
