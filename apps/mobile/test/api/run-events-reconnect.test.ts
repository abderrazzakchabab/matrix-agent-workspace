import { describe, expect, it, vi } from 'vitest';
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
