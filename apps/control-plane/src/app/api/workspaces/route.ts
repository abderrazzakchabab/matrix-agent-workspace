import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool, withTenant } from '../../../db/client';
import { toErrorResponse, requireSession } from '../../../auth/authorization';

const WorkspaceRequest = z.object({
  name: z.string().min(1).max(200),
  policy: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = WorkspaceRequest.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Invalid workspace', requestId } },
        { status: 422 },
      );
    }
    const { name, policy } = parsed.data;
    const workspaceId = `ws_${randomUUID()}`;

    await getPool().query('SELECT create_workspace($1, $2, $3, $4)', [
      workspaceId,
      auth.userId,
      name,
      JSON.stringify(policy ?? {}),
    ]);

    const created = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT status, created_at FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      return rows[0] as { status: string; created_at: string };
    });

    return NextResponse.json(
      {
        requestId,
        workspaceId,
        name,
        ownerId: auth.matrixUserId,
        status: created.status,
        createdAt: new Date(created.created_at).toISOString(),
      },
      { status: 201 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
