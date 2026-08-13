/**
 * `POST /api/runs/:runId/cancel` — cooperative run cancellation.
 *
 * Records the cancellation intent immediately and returns
 * `202 { runId, status: "cancellation_requested" }`. Cancellation is
 * cooperative: the workflow checks the intent between steps and at provider
 * boundaries, aborts in-flight provider calls, and emits exactly one
 * terminal `run.cancelled` event. A queued run (workflow not yet started) is
 * finalized here; a running run transitions to `cancelling` and emits
 * `run.cancellation_requested` once. Repeats are idempotent; cancelling an
 * already-terminal run returns `409 RUN_ALREADY_TERMINAL`.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, toErrorResponse, withTenant } from '../../../../../auth/authorization';
import { appendEventWithClient } from '../../../../../db/repositories/event-repository';

class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Run not found');
    this.name = 'RunNotFoundError';
  }
}

class RunAlreadyTerminalError extends Error {
  readonly code = 'RUN_ALREADY_TERMINAL';
  readonly status = 409;
  constructor(status: string) {
    super(`Run is already ${status}`);
    this.name = 'RunAlreadyTerminalError';
  }
}

const TERMINAL_STATUSES = ['completed', 'partial', 'failed', 'cancelled'];

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ runId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { runId } = await context.params;
    const auth = await requireSession(request);

    const result = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT status, cancel_requested_at FROM runs WHERE id = $1 FOR UPDATE',
        [runId],
      );
      const run = rows[0] ?? null;
      if (!run) return { kind: 'not_found' as const };
      if (TERMINAL_STATUSES.includes(run.status)) {
        return { kind: 'terminal' as const, status: run.status as string };
      }

      // The row lock serializes concurrent cancels, so the pre-update read is
      // authoritative: only the first caller observes a NULL intent and emits.
      const newlyRecorded = run.cancel_requested_at === null;
      const updated = await client.query(
        `UPDATE runs
            SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancelling' END,
                updated_at = now()
          WHERE id = $1
          RETURNING status`,
        [runId],
      );
      const newStatus = (updated.rows[0]?.status as string | undefined) ?? (run.status as string);
      if (newlyRecorded) {
        if (newStatus === 'cancelled') {
          // Exactly one terminal cancellation event for a run cancelled before
          // the workflow started; the workflow never emits a second one.
          await appendEventWithClient(client, runId, {
            id: `evt_${randomUUID()}`,
            type: 'run.cancelled',
            version: 1,
            payload: { cancelledAt: new Date().toISOString() },
          });
        } else {
          await appendEventWithClient(client, runId, {
            id: `evt_${randomUUID()}`,
            type: 'run.cancellation_requested',
            version: 1,
            payload: {},
          });
        }
      }
      return { kind: 'updated' as const, status: newStatus };
    });

    if (result.kind === 'not_found') throw new RunNotFoundError();
    if (result.kind === 'terminal') throw new RunAlreadyTerminalError(result.status);

    return NextResponse.json(
      { requestId, runId, status: 'cancellation_requested' },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
