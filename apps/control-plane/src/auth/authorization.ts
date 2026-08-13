import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient } from 'pg';
import { withTenant } from '../db/client';
import { getSessionByOpaqueId, SESSION_COOKIE } from './session-service';

export { withTenant } from '../db/client';

export class AuthenticationError extends Error {
  readonly code = 'AUTHENTICATION_REQUIRED';
  readonly status = 401;
  constructor() {
    super('Authentication required');
  }
}

export class WorkspaceAccessDeniedError extends Error {
  readonly code = 'WORKSPACE_ACCESS_DENIED';
  readonly status = 403;
  constructor() {
    super('Workspace access denied');
  }
}

export class ValidationError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 422;
  constructor(message: string) {
    super(message);
  }
}

export interface AuthContext {
  userId: string;
  matrixUserId: string;
  homeserverUrl: string;
  accessToken: string;
  sessionOpaqueId: string;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Authenticate the request's opaque session cookie; throws AuthenticationError. */
export async function requireSession(request: NextRequest): Promise<AuthContext> {
  const cookies = parseCookies(request.headers.get('cookie'));
  const opaqueId = cookies[SESSION_COOKIE];
  if (!opaqueId) throw new AuthenticationError();
  try {
    const session = await getSessionByOpaqueId(opaqueId);
    return {
      userId: session.userId,
      matrixUserId: session.matrixUserId,
      homeserverUrl: session.homeserverUrl,
      accessToken: session.accessToken,
      sessionOpaqueId: session.sessionId,
    };
  } catch {
    throw new AuthenticationError();
  }
}

/** Assert workspace membership for the current tenant (must run inside withTenant). */
export async function assertWorkspaceAccess(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  const { rows } = await client.query('SELECT id FROM workspaces WHERE id = $1', [workspaceId]);
  if (rows.length === 0) throw new WorkspaceAccessDeniedError();
}

interface ApiErrorLike {
  code: string;
  status: number;
  message?: string;
}

function isApiErrorLike(error: unknown): error is ApiErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'status' in error
  );
}

/** Map a known error (or an unexpected one) to a structured API error response. */
export function toErrorResponse(error: unknown, requestId: string): NextResponse {
  if (isApiErrorLike(error)) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message ?? error.code, requestId } },
      { status: error.status },
    );
  }
  console.error('[control-plane] unhandled error', error);
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId } },
    { status: 500 },
  );
}
