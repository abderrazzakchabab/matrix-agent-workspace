/**
 * `GET /api/runs/:runId` — run retrieval.
 *
 * Returns status, mode, bound room, specialist statuses, `lastSequence`,
 * `cancelRequestedAt`, and the terminal summary — visible only to the run
 * owner or workspace members (RLS-scoped). A missing or unauthorized run
 * returns `404 RUN_NOT_FOUND` without revealing whether it exists.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, toErrorResponse, withTenant } from '../../../../auth/authorization';

class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Run not found');
    this.name = 'RunNotFoundError';
  }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { runId } = await context.params;
    const auth = await requireSession(request);

    const run = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query('SELECT * FROM runs WHERE id = $1', [runId]);
      return rows[0] ?? null;
    });
    if (!run) throw new RunNotFoundError();

    const specialists = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT specialist_id, ordinal, status, attempt_count, output, error_code,
                started_at, completed_at
           FROM run_specialists
          WHERE run_id = $1
          ORDER BY ordinal`,
        [runId],
      );
      return rows.map((r) => ({
        specialistId: r.specialist_id as string,
        ordinal: r.ordinal as number,
        status: r.status as string,
        attemptCount: r.attempt_count as number,
        output: (r.output as Record<string, unknown> | null) ?? null,
        errorCode: (r.error_code as string | null) ?? null,
        startedAt: r.started_at as string | null,
        completedAt: r.completed_at as string | null,
      }));
    });

    const lastSequence = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT COALESCE(MAX(sequence), 0)::int AS last FROM run_events WHERE run_id = $1',
        [runId],
      );
      return rows[0].last as number;
    });

    return NextResponse.json({
      requestId,
      runId,
      status: run.status,
      mode: run.mode,
      workspaceId: run.workspace_id,
      roomId: run.room_id ?? null,
      specialists,
      lastSequence,
      cancelRequestedAt: run.cancel_requested_at ?? null,
      terminalSummary: run.terminal_summary ?? null,
    });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
