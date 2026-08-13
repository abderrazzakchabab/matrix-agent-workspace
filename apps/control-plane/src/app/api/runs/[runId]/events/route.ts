/**
 * `GET /api/runs/:runId/events` — replayable Server-Sent Events stream.
 *
 * Each frame is `id:<sequence>`, `event:<type>`, `data:<Event JSON>`. The
 * stream first replays events after `?after=` (equivalently the
 * `Last-Event-ID` header) in bounded batches, then follows live events with
 * heartbeat comments until the run reaches a terminal state, at which point it
 * closes. A missing or unauthorized run returns `404 RUN_NOT_FOUND` without
 * revealing whether it exists.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  requireSession,
  toErrorResponse,
  withTenant,
} from '../../../../../auth/authorization';
import { getRun } from '../../../../../db/repositories/run-repository';
import { listEventsPage, toRunEvent } from '../../../../../events/event-service';
import { encodeEventFrame, HEARTBEAT_FRAME, parseAfterValue } from '../../../../../events/sse-stream';

class RunNotFoundError extends Error {
  readonly code = 'RUN_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Run not found');
    this.name = 'RunNotFoundError';
  }
}

const TERMINAL_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);

export interface StreamRunEventsOptions {
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  replayLimit: number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface StreamTenant {
  userId: string;
  workspaceId: string;
}

/**
 * Emit replay + live event frames until the run terminates. Exported for
 * deterministic tests; the route wires the process defaults.
 */
export async function* streamRunEvents(
  tenant: StreamTenant,
  runId: string,
  after: number,
  opts: StreamRunEventsOptions,
): AsyncGenerator<string> {
  let cursor = after;
  let lastHeartbeatAt = 0;
  for (;;) {
    const page = await listEventsPage(tenant, runId, cursor, opts.replayLimit);
    for (const row of page.events) {
      yield encodeEventFrame(toRunEvent(row));
      cursor = row.sequence;
    }

    if (page.hasMore) continue; // bounded batch continuation

    const run = await getRun(tenant, runId);
    const terminal = run === null || TERMINAL_STATUSES.has(run.status);
    if (terminal) return; // terminal close

    const now = opts.now();
    if (now - lastHeartbeatAt >= opts.heartbeatIntervalMs) {
      yield HEARTBEAT_FRAME;
      lastHeartbeatAt = now;
    }
    await opts.sleep(opts.pollIntervalMs);
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
    const url = new URL(request.url);
    const afterParam = url.searchParams.get('after');
    const after =
      afterParam !== null
        ? parseAfterValue(afterParam)
        : parseAfterValue(request.headers.get('Last-Event-ID'));

    // Authorize up front and hide unauthorized/missing runs with a 404.
    const run = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, workspace_id, status FROM runs WHERE id = $1',
        [runId],
      );
      return rows[0] ?? null;
    });
    if (!run) throw new RunNotFoundError();

    const tenant: StreamTenant = {
      userId: auth.userId,
      workspaceId: run.workspace_id as string,
    };
    const stream = new ReadableStream({
      start(controller) {
        void (async () => {
          try {
            for await (const frame of streamRunEvents(tenant, runId, after, {
              pollIntervalMs: Number(process.env.SSE_POLL_INTERVAL_MS ?? 100),
              heartbeatIntervalMs: Number(process.env.SSE_HEARTBEAT_INTERVAL_MS ?? 15000),
              replayLimit: Number(process.env.SSE_REPLAY_LIMIT ?? 100),
              now: () => Date.now(),
              sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            })) {
              controller.enqueue(new TextEncoder().encode(frame));
            }
            controller.close();
          } catch (error) {
            console.error('[control-plane] sse stream error', error);
            controller.error(error);
          }
        })();
      },
    });

    return new NextResponse(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
