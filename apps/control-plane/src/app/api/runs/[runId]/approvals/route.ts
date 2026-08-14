/**
 * `POST /api/runs/:runId/approvals` — record an explicit human approval for a
 * pending GitHub mutation.
 *
 * The approval is bound to the exact run, workspace, session user, scope, and
 * command hash, and expires after a short TTL. The server rejects an approval
 * without an exact run in the caller's workspace, and explicit confirmation
 * text is required: Matrix prompt text can never approve a mutation.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  requireSession,
  toErrorResponse,
  withTenant,
} from '../../../../../auth/authorization';
import { WRITE_SCOPES } from '../../../../../github/write-authorization';
import {
  createApprovalService,
  databaseApprovalStore,
} from '../../../../../github/approval-service';
import { databaseAuditStore } from '../../../../../github/mutation-command';

const CreateApprovalBody = z.object({
  approvalType: z.literal('github_mutation'),
  scope: z.enum(WRITE_SCOPES),
  decision: z.enum(['approved', 'denied']),
  confirmationText: z.string().min(1).max(2000),
  commandHash: z.string().min(1).max(128),
});

const approvalService = createApprovalService({ store: databaseApprovalStore });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { runId } = await context.params;
    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = CreateApprovalBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid approval request',
            requestId,
          },
        },
        { status: 422 },
      );
    }
    const body = parsed.data;

    // The run must exist in the caller's workspace (RLS-enforced); an
    // inaccessible or missing run looks identical.
    const workspaceId = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT workspace_id FROM runs WHERE id = $1',
        [runId],
      );
      if (rows.length === 0) {
        throw Object.assign(new Error('Run not found'), {
          code: 'RUN_NOT_FOUND',
          status: 404,
        });
      }
      return rows[0].workspace_id as string;
    });

    const approval = await approvalService.approve({
      workspaceId,
      runId,
      userId: auth.userId,
      scope: body.scope,
      commandHash: body.commandHash,
      decision: body.decision,
      confirmationText: body.confirmationText,
    });

    await databaseAuditStore
      .record({
        workspaceId,
        actorUserId: auth.userId,
        actorMatrixId: auth.matrixUserId,
        scope: body.scope,
        approvalId: approval.id,
        outcome: 'approval_recorded',
        details: { decision: approval.decision },
      })
      .catch(() => undefined);

    return NextResponse.json(
      {
        requestId,
        approvalId: approval.id,
        status: approval.decision,
        expiresAt: approval.expiresAt,
        scope: approval.scope,
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
