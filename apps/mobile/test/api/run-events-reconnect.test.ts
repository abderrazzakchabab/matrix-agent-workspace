import { describe, expect, it, vi } from 'vitest';

const expoFetch = vi.hoisted(() => vi.fn());

vi.mock('expo/fetch', () => ({ fetch: expoFetch }));

import { createRunEventClient, type RunEventsFetch } from '../../src/api/run-events';
import { createRunStore } from '../../src/state/run-store';

function event(sequence: number, type = 'specialist.progress', payload: Record<string, unknown> = {}) {
  return {
    id: `evt_run-1_${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    version: 1,
    occurredAt: '2026-08-12T12:00:00.000Z',
    visibility: 'room_and_owner',
    payload,
  };
}

function response(chunks: string[], status = 200) {
  let index = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        async read() {
          const chunk = chunks[index++];
          return chunk === undefined
            ? { done: true as const, value: undefined }
            : { done: false as const, value: new TextEncoder().encode(chunk) };
        },
      }),
    },
    text: async () => chunks.join(''),
  };
}

async function eventually(assertion: () => void) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 29) throw error;
      await Promise.resolve();
    }
  }
}

describe('mobile run event replay', () => {
  it('uses Expo fetch and consumes native response chunks before the stream closes', async () => {
    const store = createRunStore();
    let readCount = 0;
    let finishStream: (() => void) | undefined;
    let streamClosed = false;
    expoFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            readCount += 1;
            if (readCount === 1) {
              return {
                done: false as const,
                value: new TextEncoder().encode(
                  `id: 1\nevent: specialist.progress\ndata: ${JSON.stringify(event(1))}\n\n`,
                ),
              };
            }
            return new Promise<{ done: true; value: undefined }>((resolve) => {
              finishStream = () => {
                streamClosed = true;
                resolve({ done: true, value: undefined });
              };
            });
          },
        }),
      },
      text: async () => '',
    }));
    const client = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear: vi.fn() },
      store,
    });

    const connection = client.connect('run-1');
    await eventually(() => expect(store.get('run-1').highestSequence).toBe(1));

    expect(expoFetch).toHaveBeenCalledOnce();
    expect(streamClosed).toBe(false);
    finishStream?.();
    connection.dispose();
  });

  it('parses multiline SSE and reconnects from the highest sequence without duplicates', async () => {
    const requests: Array<{ input: string; init?: { headers?: Record<string, string> } }> = [];
    const fetch = vi.fn<RunEventsFetch>(async (input, init) => {
      requests.push({ input, init });
      if (requests.length === 1) {
        return response([
          `id: 7\nevent: specialist.progress\ndata: ${JSON.stringify(event(7, 'specialist.progress', { summary: 'half' }))}\n\n`,
        ]);
      }
      const duplicate = JSON.stringify(event(7));
      const multiline = JSON.stringify(
        event(8, 'specialist.completed', { specialistId: 'repo-reader' }),
        null,
        2,
      ).split('\n').map((line) => `data: ${line}`).join('\n');
      return response([
        `id: 7\nevent: specialist.progress\ndata: ${duplicate}\n\n`,
        `id: 8\nevent: specialist.completed\n${multiline}\n\n`,
      ]);
    });
    const scheduled: Array<() => void> = [];
    const store = createRunStore();
    for (let sequence = 1; sequence <= 6; sequence += 1) store.addEvent(event(sequence));
    const client = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear: vi.fn() },
      store,
      fetch,
      random: () => 0,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
    });

    const connection = client.connect('run-1');
    await eventually(() => expect(scheduled).toHaveLength(1));
    scheduled.shift()?.();
    await eventually(() => expect(store.get('run-1').highestSequence).toBe(8));

    expect(requests[1]?.init?.headers?.['Last-Event-ID']).toBe('7');
    expect(new URL(requests[1]?.input ?? '').searchParams.get('after')).toBe('7');
    expect(store.get('run-1').events.map((item) => item.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(store.get('run-1').events.at(-1)?.payload).toEqual({ specialistId: 'repo-reader' });
    connection.dispose();
  });

  it('ignores a rejected terminal frame and stores a later valid terminal exactly once', async () => {
    const malformedTerminal = { ...event(9, 'run.completed'), payload: undefined };
    const fetch = vi.fn<RunEventsFetch>(async () => response([
      `id: 9\nevent: run.completed\ndata: ${JSON.stringify(malformedTerminal)}\n\n`,
      `id: 10\nevent: run.completed\ndata: ${JSON.stringify(event(10, 'run.completed'))}\n\n`,
    ]));
    const store = createRunStore();
    const client = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear: vi.fn() },
      store,
      fetch,
    });

    const connection = client.connect('run-1');
    await eventually(() => expect(store.get('run-1').highestSequence).toBe(10));

    expect(store.get('run-1').events).toHaveLength(1);
    expect(store.get('run-1').events[0]).toMatchObject({
      id: 'evt_run-1_10',
      runId: 'run-1',
      sequence: 10,
      type: 'run.completed',
      payload: {},
    });
    expect(fetch).toHaveBeenCalledOnce();
    connection.dispose();
  });

  it('rejects conflicting wire and body types before accepting a valid terminal event', async () => {
    const fetch = vi.fn<RunEventsFetch>(async () => response([
      `id: 9\nevent: run.completed\ndata: ${JSON.stringify(event(9, 'specialist.progress'))}\n\n`,
      `id: 10\nevent: run.completed\ndata: ${JSON.stringify(event(10, 'run.completed'))}\n\n`,
    ]));
    const store = createRunStore();
    const client = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear: vi.fn() },
      store,
      fetch,
    });

    const connection = client.connect('run-1');
    await eventually(() => expect(store.get('run-1').highestSequence).toBe(10));

    expect(store.get('run-1').events).toHaveLength(1);
    expect(store.get('run-1').events[0]).toMatchObject({
      sequence: 10,
      type: 'run.completed',
    });
    expect(fetch).toHaveBeenCalledOnce();
    connection.dispose();
  });

  it('isolates runs, ignores malformed events, and retains unknown future event types', () => {
    const store = createRunStore();
    expect(store.addEvent(event(2))).toBe(true);
    expect(store.addEvent({ ...event(1), runId: 'run-2' })).toBe(true);
    expect(store.addEvent(event(2))).toBe(false);
    expect(store.addEvent({ ...event(3), sequence: Number.NaN })).toBe(false);
    expect(store.addEvent(event(3, 'future.specialist.observed'))).toBe(true);

    expect(store.get('run-1').events.map((item) => item.type)).toEqual([
      'specialist.progress',
      'future.specialist.observed',
    ]);
    expect(store.get('run-2').highestSequence).toBe(1);
  });

  it('uses the shared session-expiry boundary and disposal prevents reconnect', async () => {
    const clear = vi.fn(async () => undefined);
    const onUnauthorized = vi.fn();
    const scheduled: Array<() => void> = [];
    const fetch = vi.fn<RunEventsFetch>(async () => response([], 401));
    const client = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear },
      store: createRunStore(),
      fetch,
      onUnauthorized,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
    });

    const connection = client.connect('run-1');
    await eventually(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    expect(clear).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(0);
    connection.dispose();

    const liveFetch = vi.fn<RunEventsFetch>(async () => response([]));
    const disposableClient = createRunEventClient({
      baseUrl: 'https://control.example.test',
      sessionStore: { load: async () => ({ cookie: 'opaque-session' }), save: vi.fn(), clear: vi.fn() },
      store: createRunStore(),
      fetch: liveFetch,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
    });
    const disposable = disposableClient.connect('run-2');
    await eventually(() => expect(scheduled).toHaveLength(1));
    disposable.dispose();
    scheduled.shift()?.();
    await Promise.resolve();
    expect(liveFetch).toHaveBeenCalledOnce();
  });
});
