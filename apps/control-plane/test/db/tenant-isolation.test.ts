import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { getPool } from '../../src/db/client';
import { createRun, getRun } from '../../src/db/repositories/run-repository';
import { appendEvent, listEvents } from '../../src/db/repositories/event-repository';
import { storeMemory, searchMemories } from '../../src/db/repositories/memory-repository';
import { setupDb, createUser, createWorkspace, vec1536 } from './support';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

let aliceId: string;
let bobId: string;
let workspaceA: string;
let workspaceB: string;
let runA: string;

beforeAll(async () => {
  await setupDb();
  aliceId = await createUser('@alice:example.test');
  bobId = await createUser('@bob:example.test');
  workspaceA = await createWorkspace(aliceId, 'Alice Workspace');
  workspaceB = await createWorkspace(bobId, 'Bob Workspace');

  // Seed Alice's run, event, and vector memory.
  runA = `run_${randomUUID()}`;
  await createRun({ userId: aliceId, workspaceId: workspaceA }, {
    id: runA,
    roomId: '!alice:example.test',
    promptHash: hash('summarize'),
    mode: 'parallel',
  });
  await appendEvent({ userId: aliceId, workspaceId: workspaceA }, runA, {
    id: `evt_${randomUUID()}`,
    type: 'run.queued',
    version: 1,
    payload: { prompt: 'summarize' },
  });
  await storeMemory({ userId: aliceId, workspaceId: workspaceA }, {
    id: `mem_${randomUUID()}`,
    sourceRunId: runA,
    textHash: hash('open issues'),
    content: 'open issues',
    embedding: vec1536(1),
    classification: 'context',
  });
});

describe('tenant isolation: reads', () => {
  it('lets the owner read their own run, events, and memory', async () => {
    expect(await getRun({ userId: aliceId, workspaceId: workspaceA }, runA)).not.toBeNull();
    expect(await listEvents({ userId: aliceId, workspaceId: workspaceA }, runA)).toHaveLength(1);
    expect(
      await searchMemories({ userId: aliceId, workspaceId: workspaceA }, vec1536(1)),
    ).toHaveLength(1);
  });

  it('denies cross-workspace vector reads (RLS filters the row)', async () => {
    const results = await searchMemories(
      { userId: bobId, workspaceId: workspaceA },
      vec1536(1),
    );
    expect(results).toEqual([]);
  });

  it('denies cross-user run reads', async () => {
    expect(await getRun({ userId: bobId, workspaceId: workspaceA }, runA)).toBeNull();
  });

  it('denies cross-user event reads', async () => {
    expect(await listEvents({ userId: bobId, workspaceId: workspaceA }, runA)).toEqual([]);
  });

  it('denies all reads with no tenant context set (RLS default deny)', async () => {
    const memories = await getPool().query('SELECT * FROM agent_memories');
    expect(memories.rows).toHaveLength(0);
    const runs = await getPool().query('SELECT * FROM runs');
    expect(runs.rows).toHaveLength(0);
    const events = await getPool().query('SELECT * FROM run_events');
    expect(events.rows).toHaveLength(0);
  });
});

describe('tenant isolation: writes', () => {
  it('denies cross-workspace vector writes (RLS WITH CHECK)', async () => {
    await expect(
      storeMemory({ userId: bobId, workspaceId: workspaceA }, {
        id: `mem_${randomUUID()}`,
        textHash: hash('stolen'),
        content: 'stolen',
        embedding: vec1536(2),
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('denies cross-workspace run creation (RLS WITH CHECK)', async () => {
    await expect(
      createRun({ userId: bobId, workspaceId: workspaceA }, {
        id: `run_${randomUUID()}`,
        roomId: null,
        promptHash: hash('steal'),
        mode: 'sequential',
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('denies cross-user event appends', async () => {
    await expect(
      appendEvent({ userId: bobId, workspaceId: workspaceA }, runA, {
        id: `evt_${randomUUID()}`,
        type: 'run.completed',
        version: 1,
        payload: {},
      }),
    ).rejects.toThrow(/not in an accessible workspace/i);
  });

  it('still has only the owner\u2019s rows after denied writes', async () => {
    const ownerMemories = await searchMemories(
      { userId: aliceId, workspaceId: workspaceA },
      vec1536(1),
    );
    expect(ownerMemories).toHaveLength(1);
    const ownerEvents = await listEvents({ userId: aliceId, workspaceId: workspaceA }, runA);
    expect(ownerEvents).toHaveLength(1);
  });
});
