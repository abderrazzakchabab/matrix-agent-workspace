import { fetch as expoFetch } from 'expo/fetch';
import type { SessionStore } from '../auth/session-store';
import { expireControlPlaneSession } from './control-plane';
import type { RunStore } from '../state/run-store';

export interface RunEventsResponse {
  ok: boolean;
  status: number;
  body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
    };
  } | null;
  text(): Promise<string>;
}

export type RunEventsFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    credentials?: 'include';
    signal?: AbortSignal;
  },
) => Promise<RunEventsResponse>;

export interface RunEventConnection {
  dispose(): void;
}

export interface RunEventClient {
  connect(runId: string): RunEventConnection;
}

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

const TERMINAL_TYPES = new Set([
  'run.completed',
  'run.partial',
  'run.failed',
  'run.cancelled',
]);

function normalizedBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '');
  if (!value) throw new Error('EXPO_PUBLIC_CONTROL_PLANE_URL is required');
  return value;
}

export function parseSseFrame(rawFrame: string): SseFrame | null {
  let id: string | null = null;
  let event: string | null = null;
  const data: string[] = [];
  for (const rawLine of rawFrame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    const separator = rawLine.indexOf(':');
    const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
    let value = separator === -1 ? '' : rawLine.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}

function eventFromFrame(frame: SseFrame, expectedRunId: string): Record<string, unknown> | null {
  if (frame.id === null || !/^\d+$/.test(frame.id)) return null;
  const sequence = Number(frame.id);
  if (!Number.isSafeInteger(sequence)) return null;
  try {
    const body = JSON.parse(frame.data) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (record.runId !== expectedRunId) return null;
    if (record.sequence !== undefined && record.sequence !== sequence) return null;
    const type = frame.event || record.type;
    if (typeof type !== 'string' || !type) return null;
    return { ...record, sequence, type };
  } catch {
    return null;
  }
}

export function createRunEventClient(options: {
  baseUrl: string;
  sessionStore: SessionStore;
  store: RunStore;
  fetch?: RunEventsFetch;
  onUnauthorized?(): void;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
}): RunEventClient {
  const baseUrl = normalizedBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? (expoFetch as unknown as RunEventsFetch);
  const random = options.random ?? Math.random;
  const baseDelayMs = Math.max(100, options.baseDelayMs ?? 500);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 8_000);
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  return {
    connect(runId) {
      let disposed = false;
      let terminalReceived = false;
      let reconnectAttempt = 0;
      let reconnectHandle: unknown;
      let abortController: AbortController | null = null;

      function queueReconnect(): void {
        if (disposed || terminalReceived || reconnectHandle !== undefined) return;
        const exponential = Math.min(maxDelayMs, baseDelayMs * (2 ** reconnectAttempt));
        const jittered = exponential * (0.5 + Math.min(1, Math.max(0, random())) * 0.5);
        const delay = Math.min(maxDelayMs, Math.max(100, Math.round(jittered)));
        reconnectAttempt = Math.min(reconnectAttempt + 1, 30);
        reconnectHandle = schedule(() => {
          reconnectHandle = undefined;
          if (!disposed) void open();
        }, delay);
      }

      function consumeFrame(rawFrame: string): void {
        if (terminalReceived || disposed) return;
        const frame = parseSseFrame(rawFrame);
        if (!frame) return;
        const candidate = eventFromFrame(frame, runId);
        if (!candidate) return;
        if (options.store.addEvent(candidate)) reconnectAttempt = 0;
        if (typeof candidate.type === 'string' && TERMINAL_TYPES.has(candidate.type)) {
          terminalReceived = true;
        }
      }

      function consumeText(text: string, flush: boolean, state: { buffer: string }): void {
        state.buffer += text.replace(/\r\n/g, '\n');
        let boundary = state.buffer.indexOf('\n\n');
        while (boundary >= 0) {
          consumeFrame(state.buffer.slice(0, boundary));
          state.buffer = state.buffer.slice(boundary + 2);
          boundary = state.buffer.indexOf('\n\n');
        }
        if (flush && state.buffer.trim()) {
          consumeFrame(state.buffer);
          state.buffer = '';
        }
      }

      async function open(): Promise<void> {
        if (disposed || terminalReceived) return;
        const session = await options.sessionStore.load();
        if (disposed) return;
        if (!session) {
          await expireControlPlaneSession(options.sessionStore, options.onUnauthorized);
          return;
        }
        const after = options.store.get(runId).highestSequence;
        const url = `${baseUrl}/api/runs/${encodeURIComponent(runId)}/events?after=${after}`;
        abortController = new AbortController();
        try {
          const response = await fetchImpl(url, {
            method: 'GET',
            credentials: 'include',
            headers: {
              Accept: 'text/event-stream',
              Cookie: session.cookie,
              ...(after > 0 ? { 'Last-Event-ID': String(after) } : {}),
            },
            signal: abortController.signal,
          });
          if (disposed) return;
          if (response.status === 401) {
            await expireControlPlaneSession(options.sessionStore, options.onUnauthorized);
            return;
          }
          if (!response.ok) {
            if (response.status === 429 || response.status >= 500) queueReconnect();
            return;
          }

          const state = { buffer: '' };
          if (response.body?.getReader) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (!disposed && !terminalReceived) {
              const chunk = await reader.read();
              if (chunk.done) break;
              if (chunk.value) consumeText(decoder.decode(chunk.value, { stream: true }), false, state);
            }
            consumeText(decoder.decode(), true, state);
          } else {
            consumeText(await response.text(), true, state);
          }
          if (!disposed && !terminalReceived) queueReconnect();
        } catch (error) {
          if (!disposed && !(error instanceof Error && error.name === 'AbortError')) queueReconnect();
        }
      }

      void open();
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          abortController?.abort();
          if (reconnectHandle !== undefined) {
            cancelSchedule(reconnectHandle);
            reconnectHandle = undefined;
          }
        },
      };
    },
  };
}
