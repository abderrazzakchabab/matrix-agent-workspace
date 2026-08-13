import { RunRequest, type RunRequestType, type RunResponseType } from '@matrix/contracts';
import type { SessionStore } from '../auth/session-store';

export interface RoomSummary {
  roomId: string;
  homeserverUrl: string;
  displayName: string | null;
  workspaceId: string | null;
}

export interface MatrixSessionResponse {
  user: { id: string; homeserverUrl: string };
  sessionExpiresAt: string;
}

export interface RoomBinding {
  roomId: string;
  workspaceId: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

export type FetchImplementation = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponse>;

export class ControlPlaneError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ControlPlaneError';
  }
}

export interface ControlPlaneApi {
  createMatrixSession(homeserverUrl: string, accessToken: string): Promise<MatrixSessionResponse>;
  getRooms(): Promise<RoomSummary[]>;
  bindRoom(roomId: string, workspaceId: string): Promise<RoomBinding>;
  launchRun(
    workspaceId: string,
    request: RunRequestType,
    idempotencyKey: string,
  ): Promise<RunResponseType>;
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) throw new Error('EXPO_PUBLIC_CONTROL_PLANE_URL is required');
  return normalized;
}

function sessionCookieFrom(headers: FetchResponse['headers']): string | null {
  const value = headers.get('set-cookie');
  if (!value) return null;
  const cookie = value.split(';', 1)[0]?.trim();
  return cookie || null;
}

async function readResponse<T>(response: FetchResponse): Promise<T> {
  const body = (await response.json()) as T & ApiErrorBody;
  if (!response.ok) {
    throw new ControlPlaneError(
      body.error?.message ?? `Control plane request failed (${response.status})`,
      response.status,
      body.error?.code,
    );
  }
  return body;
}

export function createControlPlaneClient(options: {
  baseUrl: string;
  sessionStore: SessionStore;
  fetch?: FetchImplementation;
}): ControlPlaneApi {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchImplementation);

  async function authenticatedRequest<T>(path: string, init?: {
    method?: string;
    body?: unknown;
  }): Promise<T> {
    const session = await options.sessionStore.load();
    if (!session) throw new ControlPlaneError('Sign in again to continue', 401, 'SESSION_REQUIRED');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        Cookie: session.cookie,
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return readResponse<T>(response);
  }

  return {
    async createMatrixSession(homeserverUrl, accessToken) {
      const response = await fetchImpl(`${baseUrl}/api/auth/matrix/session`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeserverUrl, accessToken }),
      });
      const body = await readResponse<MatrixSessionResponse>(response);
      const cookie = sessionCookieFrom(response.headers);
      if (!cookie) {
        throw new ControlPlaneError(
          'The control plane did not return a session reference',
          response.status,
          'SESSION_REFERENCE_MISSING',
        );
      }
      await options.sessionStore.save({ cookie });
      return body;
    },

    async getRooms() {
      const body = await authenticatedRequest<{ rooms: RoomSummary[] }>('/api/rooms');
      return body.rooms;
    },

    async bindRoom(roomId, workspaceId) {
      return authenticatedRequest<RoomBinding>(
        `/api/rooms/${encodeURIComponent(roomId)}/binding`,
        { method: 'POST', body: { workspaceId } },
      );
    },

    async launchRun(workspaceId, request, idempotencyKey) {
      const versionedRequest = RunRequest.parse(request);
      return authenticatedRequest<RunResponseType>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/runs`,
        {
          method: 'POST',
          body: { ...versionedRequest, idempotencyKey },
        },
      );
    },
  };
}
