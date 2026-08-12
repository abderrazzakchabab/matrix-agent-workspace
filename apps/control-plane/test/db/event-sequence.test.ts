import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { withTenant } from '../../src/db/client';
import { createRun } from '../../src/db/repositories/run-repository';
import { appendEvent, listEvents } from '../../src/db/repositories/event-repository';
import { setupDb, createUser, createWorkspace } from './support';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

let userId: string;
let workspaceId: string;
let runId: string;

beforeAll(async () => {
  await setupDb();
  userId = await createUser('@alice:example.test');
  workspaceId = await createWorkspace(userId, 'Sequence Workspace');
  runId = `run_${randomUUID()}`;
  await createRun({ userId, workspaceId }, {
    id: runId,
    roomId: '!alice:example.test',
    promptHash: hash('parallel summarize'),
    mode: 'parallel',
  });
});

describe('transactional run-event sequence allocation', () => {
  it('allocates unique contiguous sequences under concurrency', async () => {
    const count = 20;
    const appends = Array.from({ length: count }, (_, i) =>
      appendEvent({ userId, workspaceId }, runId, {
        id: `evt_${randomUUID()}`,
        type: 'specialist.progress',
        version: 1,
        payload: { index: i },
      }),
    );
    const sequences = (await Promise.all(appends)).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  });

  it('persists unique contiguous sequences without gaps or duplicates', async () => {
    const rows = await listEvents({ userId, workspaceId }, runId);
    const sequences = rows.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(sequences).size).toBe(20);
  });

  it('enforces the unique (run_id, sequence) constraint', async () => {
    await expect(
      withTenant(userId, (client) =>
        client.query(
          `INSERT INTO run_events
             (id, run_id, sequence, event_type, event_version, payload, visibility)
           VALUES ($1, $2, 1, 'run.queued', 1, '{}'::jsonb, 'room_and_owner')`,
          [`evt_dup_${randomUUID()}`, runId],
        ),
      ),
    ).rejects.toThrow(/run_events_run_sequence_unique|duplicate key/i);
  });

  it('allocates sequences independently per run', async () => {
    const secondRun = `run_${randomUUID()}`;
    await createRun({ userId, workspaceId }, {
      id: secondRun,
      roomId: null,
      promptHash: hash('second run'),
      mode: 'parallel',
    });
    const first = await appendEvent({ userId, workspaceId }, secondRun, {
      id: `evt_${randomUUID()}`,
      type: 'run.queued',
      version: 1,
      payload: {},
    });
    expect(first).toBe(1);
  });
});
