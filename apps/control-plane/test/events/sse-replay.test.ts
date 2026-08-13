/**
 * SSE replay acceptance tests.
 *
 * Exercises the persisted event publisher and the `GET /api/runs/:runId/events`
 * stream: replay after `?after=`, `Last-Event-ID` resume, authorization that
 * hides unauthorized run existence with 404, heartbeat comments that never
 * alter the sequence, and a terminal close. The stream is driven against the
 * real PostgreSQL fixture (RLS included); no Synapse HTTP call is needed.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getAdminPool } from '../../src/db/client';
import { createRun } from '../../src/db/repositories/run-repository';
import { publishEvent } from '../../src/events/event-service';
import { GET as getEventsHandler } from '../../src/app/api/runs/[runId]/events/route';
import { createSession, SESSION_COOKIE } from '../../src/auth/session-service';
import { setupDb, createUser, createWorkspace } from '../db/support';

let aliceUserId: string;
let bobUserId: string;
let aliceCookie: string;
let bobCookie: string;
let workspaceId: string;

beforeAll(async () => {
  process.env.SSE_POLL_INTERVAL_MS = '10';
  process.env.SSE_HEARTBEAT_INTERVAL_MS = '10';
  await setupDb();
  aliceUserId = await createUser('@alice:example.test');
  bobUserId = await createUser('@bob:example.test');
  workspaceId = await createWorkspace(aliceUserId, 'SSE Workspace');
  const alice = await createSession(aliceUserId, 'syt_alice_sse', new Date(Date.now() + 3600_000));
  const bob = await createSession(bobUserId, 'syt_bob_sse', new Date(Date.now() + 3600_000));
  aliceCookie = `${SESSION_COOKIE}=${alice.opaqueId}`;
  bobCookie = `${SESSION_COOKIE}=${bob.opaqueId}`;
});

async function makeRun(): Promise<string> {
  const runId = `run_${randomUUID()}`;
  await createRun(
    { userId: aliceUserId, workspaceId },
    { id: runId, roomId: '!alice:example.test', promptHash: 'hash', mode: 'parallel' },
  );
  return runId;
}

async function publish(
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<number> {
  const { sequence } = await publishEvent(
    { userId: aliceUserId, workspaceId },
    runId,
    { id: `evt_${randomUUID()}`, type, version: 1, payload },
  );
  return sequence;
}

async function markTerminal(runId: string, status = 'completed'): Promise<void> {
  await getAdminPool().query('UPDATE runs SET status = $1 WHERE id = $2', [status, runId]);
}

function eventsRequest(
  runId: string,
  opts: { after?: number; lastEventId?: string; cookie?: string } = {},
): NextRequest {
  const qs = opts.after !== undefined ? `?after=${opts.after}` : '';
  const headers: Record<string, string> = {};
  if (opts.lastEventId !== undefined) headers['Last-Event-ID'] = opts.lastEventId;
  if (opts.cookie !== undefined) headers['cookie'] = opts.cookie;
  return new NextRequest(`http://test.local/api/runs/${runId}/events${qs}`, { headers });
}

interface ParsedFrame {
  id?: number;
  event?: string;
  comment?: string;
}

function parseFrame(raw: string): ParsedFrame {
  let id: number | undefined;
  let event: string | undefined;
  let comment: string | undefined;
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) comment = line.slice(1).trim();
    else if (line.startsWith('id:')) id = Number(line.slice(3).trim());
    else if (line.startsWith('event:')) event = line.slice(6).trim();
  }
  return { id, event, comment };
}

/** Incremental SSE frame reader that skips heartbeat/comment frames. */
class FrameReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buffer = '';
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  private async pull(timeoutMs: number): Promise<void> {
    if (this.done) return;
    const result = await Promise.race([
      this.reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`SSE frame timeout after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]);
    if (result.done) {
      this.done = true;
      return;
    }
    this.buffer += this.decoder.decode(result.value, { stream: true });
  }

  private shiftFrame(): ParsedFrame | null {
    const idx = this.buffer.indexOf('\n\n');
    if (idx === -1) return null;
    const raw = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 2);
    return parseFrame(raw);
  }

  async nextDataSequence(timeoutMs = 5000): Promise<number | null> {
    for (;;) {
      let frame = this.shiftFrame();
      while (frame === null) {
        if (this.done) return null;
        await this.pull(timeoutMs);
        frame = this.shiftFrame();
      }
      if (frame.id !== undefined) return frame.id;
    }
  }

  async nextHeartbeat(timeoutMs = 5000): Promise<string | null> {
    for (;;) {
      let frame = this.shiftFrame();
      while (frame === null) {
        if (this.done) return null;
        await this.pull(timeoutMs);
        frame = this.shiftFrame();
      }
      if (frame.comment !== undefined) return frame.comment;
    }
  }

  async waitClose(timeoutMs = 5000): Promise<void> {
    while (!this.done) await this.pull(timeoutMs);
  }
}

async function readAllSequences(res: { body: ReadableStream<Uint8Array> | null }): Promise<number[]> {
  const reader = new FrameReader(res.body as ReadableStream<Uint8Array>);
  const out: number[] = [];
  for (;;) {
    const seq = await reader.nextDataSequence();
    if (seq === null) break;
    out.push(seq);
  }
  return out;
}

describe('GET /api/runs/:runId/events', () => {
  it('replays events after ?after=, then streams a live event and closes on terminal', async () => {
    const runId = await makeRun();
    await publish(runId, 'run.queued');
    await publish(runId, 'run.started');
    await publish(runId, 'specialist.started', { specialistId: 'repo-reader' });
    await publish(runId, 'specialist.completed', { specialistId: 'repo-reader' });
    // Run is still non-terminal: the stream must stay open after replay.

    const res = await getEventsHandler(
      eventsRequest(runId, { after: 2, cookie: aliceCookie }),
      { params: Promise.resolve({ runId }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = new FrameReader(res.body as ReadableStream<Uint8Array>);
    // Replayed history first.
    expect(await reader.nextDataSequence()).toBe(3);
    expect(await reader.nextDataSequence()).toBe(4);

    // A live event arrives while the stream is open, then the run terminates.
    await publish(runId, 'run.completed', { completedSpecialists: ['repo-reader'] });
    await markTerminal(runId, 'completed');

    expect(await reader.nextDataSequence()).toBe(5);
    await reader.waitClose();
  });

  it('resumes from Last-Event-ID', async () => {
    const runId = await makeRun();
    for (let i = 1; i <= 5; i += 1) await publish(runId, 'specialist.progress', { index: i });
    await markTerminal(runId, 'completed');

    const res = await getEventsHandler(
      eventsRequest(runId, { lastEventId: '4', cookie: aliceCookie }),
      { params: Promise.resolve({ runId }) },
    );
    expect(res.status).toBe(200);
    expect(await readAllSequences(res)).toEqual([5]);
  });

  it('hides an unauthorized run with 404 without revealing existence', async () => {
    const runId = await makeRun();
    await publish(runId, 'run.queued');

    const res = await getEventsHandler(
      eventsRequest(runId, { cookie: bobCookie }),
      { params: Promise.resolve({ runId }) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND');
  });

  it('returns 404 for a missing run', async () => {
    const res = await getEventsHandler(
      eventsRequest('run_does_not_exist', { cookie: aliceCookie }),
      { params: Promise.resolve({ runId: 'run_does_not_exist' }) },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('RUN_NOT_FOUND');
  });

  it('requires a session', async () => {
    const res = await getEventsHandler(eventsRequest('run_anything'), {
      params: Promise.resolve({ runId: 'run_anything' }),
    });
    expect(res.status).toBe(401);
  });

  it('replays a long history in bounded batches before closing', async () => {
    process.env.SSE_REPLAY_LIMIT = '2';
    try {
      const runId = await makeRun();
      for (let i = 1; i <= 5; i += 1) await publish(runId, 'specialist.progress', { index: i });
      await markTerminal(runId, 'completed');

      const res = await getEventsHandler(eventsRequest(runId, { cookie: aliceCookie }), {
        params: Promise.resolve({ runId }),
      });
      expect(res.status).toBe(200);
      expect(await readAllSequences(res)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      delete process.env.SSE_REPLAY_LIMIT;
    }
  });

  it('emits heartbeats that do not alter the event sequence', async () => {
    const runId = await makeRun();
    await publish(runId, 'run.queued');
    await publish(runId, 'run.started');

    const res = await getEventsHandler(eventsRequest(runId, { cookie: aliceCookie }), {
      params: Promise.resolve({ runId }),
    });
    expect(res.status).toBe(200);

    const reader = new FrameReader(res.body as ReadableStream<Uint8Array>);
    expect(await reader.nextDataSequence()).toBe(1);
    expect(await reader.nextDataSequence()).toBe(2);

    const heartbeat = await reader.nextHeartbeat();
    expect(heartbeat).toContain('heartbeat');

    await markTerminal(runId, 'completed');
    await reader.waitClose();
  });
});
