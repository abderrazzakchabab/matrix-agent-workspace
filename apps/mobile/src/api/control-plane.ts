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

export interface WorkspaceSelection {
  workspaceId: string;
  name: string;
  ownerId: string;
  status: string;
  createdAt: string;
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
    credentials?: 'include';
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

export interface CancellationResponse {
  runId: string;
  status: 'cancellation_requested';
}

export type MatrixDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface RunMatrixDeliveriesResponse {
  runId: string;
  deliveries: Array<{ sequence: number; status: MatrixDeliveryStatus }>;
}

export type GithubWriteScope = 'issues:write' | 'pull_requests:write';

export type GithubMutationOperation =
  | 'create_issue'
  | 'update_issue'
  | 'comment_issue'
  | 'create_pr_comment';

export interface GithubPage<T> {
  items: T[];
  nextCursor?: string;
}

export interface GithubRepositorySummary {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  htmlUrl: string;
  archived: boolean;
}

export interface GithubIssueSummary {
  id: number;
  number: number;
  title: string;
  state: string;
  author: string | null;
  labels: string[];
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubPullRequestSummary {
  id: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string | null;
  head: string;
  base: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubWriteGrantResult {
  grantId: string;
  status: 'pending' | 'approved' | 'revoked';
  repository: string;
  scope: GithubWriteScope;
}

export interface RunApprovalResult {
  approvalId: string;
  status: 'approved' | 'denied';
  expiresAt: string;
  scope: GithubWriteScope;
}

export interface GithubMutationResult {
  commandId: string;
  status: 'queued' | 'completed' | 'failed';
  /** True when the idempotency key was already processed (HTTP 200 replay). */
  replayed: boolean;
}

export interface AuditRecordItem {
  id: string;
  actorMatrixId: string | null;
  scope: string | null;
  repository: string | null;
  operation: string | null;
  approvalId: string | null;
  commandId: string | null;
  outcome: string;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface ControlPlaneApi {
  createMatrixSession(homeserverUrl: string, accessToken: string): Promise<MatrixSessionResponse>;
  createWorkspace(name: string): Promise<WorkspaceSelection>;
  getRooms(): Promise<RoomSummary[]>;
  bindRoom(roomId: string, workspaceId: string): Promise<RoomBinding>;
  launchRun(
    workspaceId: string,
    request: RunRequestType,
    idempotencyKey: string,
  ): Promise<RunResponseType>;
  cancelRun(runId: string): Promise<CancellationResponse>;
  getRunMatrixDeliveries(runId: string): Promise<RunMatrixDeliveriesResponse>;
  listGithubRepositories(input: {
    workspaceId: string;
    installationId: string;
    cursor?: string;
  }): Promise<GithubPage<GithubRepositorySummary>>;
  listGithubIssues(input: {
    workspaceId: string;
    installationId: string;
    owner: string;
    repo: string;
    cursor?: string;
  }): Promise<GithubPage<GithubIssueSummary>>;
  listGithubPullRequests(input: {
    workspaceId: string;
    installationId: string;
    owner: string;
    repo: string;
    cursor?: string;
  }): Promise<GithubPage<GithubPullRequestSummary>>;
  requestGithubWriteGrant(
    workspaceId: string,
    repository: string,
    scope: GithubWriteScope,
  ): Promise<GithubWriteGrantResult>;
  createRunApproval(
    runId: string,
    input: {
      scope: GithubWriteScope;
      decision: 'approved' | 'denied';
      confirmationText: string;
      commandHash: string;
    },
  ): Promise<RunApprovalResult>;
  enqueueGithubMutation(
    workspaceId: string,
    input: {
      idempotencyKey: string;
      approvalId: string;
      repository: string;
      runId?: string;
      operation: GithubMutationOperation;
      arguments: Record<string, unknown>;
    },
  ): Promise<GithubMutationResult>;
  listAuditRecords(
    workspaceId: string,
    cursor?: string,
  ): Promise<GithubPage<AuditRecordItem>>;
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

export async function expireControlPlaneSession(
  sessionStore: SessionStore,
  onUnauthorized?: () => void,
): Promise<void> {
  try {
    await sessionStore.clear();
  } finally {
    onUnauthorized?.();
  }
}

export function createControlPlaneClient(options: {
  baseUrl: string;
  sessionStore: SessionStore;
  fetch?: FetchImplementation;
  onUnauthorized?(): void;
  /** Uses the browser's HttpOnly cookie jar; enabled only by the Phase A web fixture. */
  browserCookieSession?: boolean;
}): ControlPlaneApi {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as FetchImplementation);

  async function invalidateSession(): Promise<void> {
    await expireControlPlaneSession(options.sessionStore, options.onUnauthorized);
  }

  async function authenticatedRaw(path: string, init?: {
    method?: string;
    body?: unknown;
  }): Promise<FetchResponse> {
    const session = await options.sessionStore.load();
    if (!session) {
      await invalidateSession();
      throw new ControlPlaneError('Sign in again to continue', 401, 'SESSION_REQUIRED');
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: init?.method ?? 'GET',
      credentials: options.browserCookieSession ? 'include' : undefined,
      headers: {
        Accept: 'application/json',
        ...(options.browserCookieSession ? {} : { Cookie: session.cookie }),
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status === 401) await invalidateSession();
    return response;
  }

  async function authenticatedRequest<T>(path: string, init?: {
    method?: string;
    body?: unknown;
  }): Promise<T> {
    return readResponse<T>(await authenticatedRaw(path, init));
  }

  function githubReadPath(
    workspaceId: string,
    installationId: string,
    suffix: string,
    cursor?: string,
  ): string {
    const params = new URLSearchParams({ workspaceId, installationId });
    if (cursor) params.set('cursor', cursor);
    return `${suffix}?${params.toString()}`;
  }

  return {
    async createMatrixSession(homeserverUrl, accessToken) {
      const response = await fetchImpl(`${baseUrl}/api/auth/matrix/session`, {
        method: 'POST',
        credentials: options.browserCookieSession ? 'include' : undefined,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ homeserverUrl, accessToken }),
      });
      const body = await readResponse<MatrixSessionResponse>(response);
      const cookie = options.browserCookieSession
        ? 'browser-managed-http-only-session'
        : sessionCookieFrom(response.headers);
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

    async createWorkspace(name) {
      return authenticatedRequest<WorkspaceSelection>('/api/workspaces', {
        method: 'POST',
        body: {
          name: name.trim(),
          policy: {
            readOnly: true,
            failurePolicy: 'partial',
            promptInjectionMode: 'fail_run',
          },
        },
      });
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

    async cancelRun(runId) {
      return authenticatedRequest<CancellationResponse>(
        `/api/runs/${encodeURIComponent(runId)}/cancel`,
        { method: 'POST' },
      );
    },

    async getRunMatrixDeliveries(runId) {
      const body = await authenticatedRequest<{
        runId: string;
        matrixDeliveries: RunMatrixDeliveriesResponse['deliveries'];
      }>(`/api/runs/${encodeURIComponent(runId)}`);
      return { runId: body.runId, deliveries: body.matrixDeliveries };
    },

    async listGithubRepositories({ workspaceId, installationId, cursor }) {
      return authenticatedRequest<GithubPage<GithubRepositorySummary>>(
        githubReadPath(workspaceId, installationId, '/api/github/repositories', cursor),
      );
    },

    async listGithubIssues({ workspaceId, installationId, owner, repo, cursor }) {
      return authenticatedRequest<GithubPage<GithubIssueSummary>>(
        githubReadPath(
          workspaceId,
          installationId,
          `/api/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
          cursor,
        ),
      );
    },

    async listGithubPullRequests({ workspaceId, installationId, owner, repo, cursor }) {
      return authenticatedRequest<GithubPage<GithubPullRequestSummary>>(
        githubReadPath(
          workspaceId,
          installationId,
          `/api/github/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
          cursor,
        ),
      );
    },

    async requestGithubWriteGrant(workspaceId, repository, scope) {
      return authenticatedRequest<GithubWriteGrantResult>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/github-grants`,
        { method: 'POST', body: { repository, scope } },
      );
    },

    async createRunApproval(runId, input) {
      return authenticatedRequest<RunApprovalResult>(
        `/api/runs/${encodeURIComponent(runId)}/approvals`,
        {
          method: 'POST',
          body: {
            approvalType: 'github_mutation',
            scope: input.scope,
            decision: input.decision,
            confirmationText: input.confirmationText,
            commandHash: input.commandHash,
          },
        },
      );
    },

    async enqueueGithubMutation(workspaceId, input) {
      const response = await authenticatedRaw(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/github/mutations`,
        {
          method: 'POST',
          body: {
            idempotencyKey: input.idempotencyKey,
            approvalId: input.approvalId,
            repository: input.repository,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            operation: input.operation,
            arguments: input.arguments,
          },
        },
      );
      const body = await readResponse<{ commandId: string; status: GithubMutationResult['status'] }>(
        response,
      );
      // 202 = newly queued command; 200 = idempotent replay of the same key.
      return { commandId: body.commandId, status: body.status, replayed: response.status === 200 };
    },

    async listAuditRecords(workspaceId, cursor) {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      const suffix = params.size > 0 ? `?${params.toString()}` : '';
      return authenticatedRequest<GithubPage<AuditRecordItem>>(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/audit${suffix}`,
      );
    },
  };
}
