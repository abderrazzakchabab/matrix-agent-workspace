/**
 * Phase C write-scope authorization. A separate `github_write_grants` row —
 * repository- and scope-specific — is required before any mutation can be
 * enqueued. Read-only Phase B access never implies write access: a session
 * without an approved grant for the exact repository+scope is rejected with
 * `WRITE_SCOPE_REQUIRED`.
 */
import { withTenant } from '../db/client';
import { GITHUB_WRITE_GRANTS } from '../db/schema/write-grants';

/** The only write scopes the control plane can grant. */
export const WRITE_SCOPES = ['issues:write', 'pull_requests:write'] as const;
export type WriteScope = (typeof WRITE_SCOPES)[number];

export type WriteGrantStatus = 'pending' | 'approved' | 'revoked';

/** Default lifetime of an approved write grant. */
export const GRANT_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface GithubWriteGrant {
  id: string;
  workspaceId: string;
  grantedBy: string;
  repository: string;
  scope: WriteScope;
  status: WriteGrantStatus;
  approvedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class WriteScopeRequiredError extends Error {
  readonly code = 'WRITE_SCOPE_REQUIRED';
  readonly status = 403;
  constructor() {
    super('A separate write grant is required for this repository and scope');
    this.name = 'WriteScopeRequiredError';
  }
}

/** Tenant-scoped grant store; every read/write is isolated by workspace. The
 * database store requires `userId` (the `withTenant` context); in-memory
 * stores ignore it. */
export interface WriteGrantStore {
  findGrant(input: {
    userId?: string;
    workspaceId: string;
    repository: string;
    scope: WriteScope;
  }): Promise<GithubWriteGrant | null>;
  createGrant(input: {
    userId?: string;
    id: string;
    workspaceId: string;
    grantedBy: string;
    repository: string;
    scope: WriteScope;
  }): Promise<GithubWriteGrant>;
  setGrantStatus(input: {
    userId?: string;
    id: string;
    workspaceId: string;
    status: WriteGrantStatus;
    now?: () => number;
  }): Promise<GithubWriteGrant | null>;
}

/**
 * Require an approved, unexpired write grant for the exact repository and
 * scope. Checked on enqueue and re-checked immediately before the provider
 * call, so a revoked or expired grant stops mutations mid-flight.
 */
export async function authorizeWriteScope(
  input: {
    userId: string;
    workspaceId: string;
    repository: string;
    scope: WriteScope;
    now?: () => number;
  },
  store: WriteGrantStore,
): Promise<GithubWriteGrant> {
  const grant = await store.findGrant({
    userId: input.userId,
    workspaceId: input.workspaceId,
    repository: input.repository,
    scope: input.scope,
  });
  const now = input.now ?? Date.now;
  if (!grant || grant.status !== 'approved') throw new WriteScopeRequiredError();
  if (grant.expiresAt && now() > Date.parse(grant.expiresAt)) {
    throw new WriteScopeRequiredError();
  }
  return grant;
}

/** In-memory grant store for hermetic tests (tenant-keyed like the SQL rows). */
export class InMemoryWriteGrantStore implements WriteGrantStore {
  private readonly rows = new Map<string, GithubWriteGrant>();

  private key(workspaceId: string, repository: string, scope: WriteScope): string {
    return `${workspaceId}|${repository.toLowerCase()}|${scope}`;
  }

  async findGrant(input: {
    userId?: string;
    workspaceId: string;
    repository: string;
    scope: WriteScope;
  }): Promise<GithubWriteGrant | null> {
    return this.rows.get(this.key(input.workspaceId, input.repository, input.scope)) ?? null;
  }

  async createGrant(input: {
    userId?: string;
    id: string;
    workspaceId: string;
    grantedBy: string;
    repository: string;
    scope: WriteScope;
  }): Promise<GithubWriteGrant> {
    const key = this.key(input.workspaceId, input.repository, input.scope);
    const existing = this.rows.get(key);
    if (existing) return existing;
    const now = new Date().toISOString();
    const grant: GithubWriteGrant = {
      id: input.id,
      workspaceId: input.workspaceId,
      grantedBy: input.grantedBy,
      repository: input.repository,
      scope: input.scope,
      status: 'pending',
      approvedAt: null,
      expiresAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(key, grant);
    return grant;
  }

  async setGrantStatus(input: {
    userId?: string;
    id: string;
    workspaceId: string;
    status: WriteGrantStatus;
    now?: () => number;
  }): Promise<GithubWriteGrant | null> {
    for (const [key, grant] of this.rows) {
      if (grant.id !== input.id || grant.workspaceId !== input.workspaceId) continue;
      const nowMs = (input.now ?? Date.now)();
      const updated: GithubWriteGrant = {
        ...grant,
        status: input.status,
        approvedAt: input.status === 'approved' ? new Date(nowMs).toISOString() : grant.approvedAt,
        expiresAt:
          input.status === 'approved'
            ? new Date(nowMs + GRANT_DEFAULT_TTL_MS).toISOString()
            : grant.expiresAt,
        updatedAt: new Date(nowMs).toISOString(),
      };
      this.rows.set(key, updated);
      return updated;
    }
    return null;
  }
}

function mapGrantRow(row: Record<string, unknown>): GithubWriteGrant {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    grantedBy: String(row.granted_by),
    repository: String(row.repository),
    scope: row.scope as WriteScope,
    status: row.status as WriteGrantStatus,
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    expiresAt: row.expires_at ? new Date(String(row.expires_at)).toISOString() : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

/** PostgreSQL-backed grant store; RLS isolates grants between workspaces. */
export const databaseWriteGrantStore: WriteGrantStore = {
  async findGrant({ userId, workspaceId, repository, scope }) {
    if (!userId) throw new Error('databaseWriteGrantStore requires userId');
    return withTenant(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ${GITHUB_WRITE_GRANTS.table}
          WHERE ${GITHUB_WRITE_GRANTS.workspaceId} = $1
            AND lower(${GITHUB_WRITE_GRANTS.repository}) = lower($2)
            AND ${GITHUB_WRITE_GRANTS.scope} = $3
          LIMIT 1`,
        [workspaceId, repository, scope],
      );
      return rows[0] ? mapGrantRow(rows[0] as Record<string, unknown>) : null;
    });
  },

  async createGrant({ userId, id, workspaceId, grantedBy, repository, scope }) {
    if (!userId) throw new Error('databaseWriteGrantStore requires userId');
    return withTenant(userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${GITHUB_WRITE_GRANTS.table}
           (${GITHUB_WRITE_GRANTS.id}, ${GITHUB_WRITE_GRANTS.workspaceId},
            ${GITHUB_WRITE_GRANTS.grantedBy}, ${GITHUB_WRITE_GRANTS.repository},
            ${GITHUB_WRITE_GRANTS.scope})
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, repository, scope) DO NOTHING
         RETURNING *`,
        [id, workspaceId, grantedBy, repository, scope],
      );
      if (inserted.rows[0]) return mapGrantRow(inserted.rows[0] as Record<string, unknown>);
      const existing = await client.query(
        `SELECT * FROM ${GITHUB_WRITE_GRANTS.table}
          WHERE ${GITHUB_WRITE_GRANTS.workspaceId} = $1
            AND lower(${GITHUB_WRITE_GRANTS.repository}) = lower($2)
            AND ${GITHUB_WRITE_GRANTS.scope} = $3
          LIMIT 1`,
        [workspaceId, repository, scope],
      );
      return mapGrantRow(existing.rows[0] as Record<string, unknown>);
    });
  },

  async setGrantStatus({ userId, id, workspaceId, status, now }) {
    if (!userId) throw new Error('databaseWriteGrantStore requires userId');
    return withTenant(userId, async (client) => {
      const nowMs = (now ?? Date.now)();
      const { rows } = await client.query(
        `UPDATE ${GITHUB_WRITE_GRANTS.table}
            SET ${GITHUB_WRITE_GRANTS.status} = $1,
                ${GITHUB_WRITE_GRANTS.approvedAt} =
                  CASE WHEN $1 = 'approved' THEN to_timestamp($2 / 1000.0)
                       ELSE ${GITHUB_WRITE_GRANTS.approvedAt} END,
                ${GITHUB_WRITE_GRANTS.expiresAt} =
                  CASE WHEN $1 = 'approved'
                       THEN to_timestamp(($2 + $3) / 1000.0)
                       ELSE ${GITHUB_WRITE_GRANTS.expiresAt} END,
                ${GITHUB_WRITE_GRANTS.updatedAt} = now()
          WHERE ${GITHUB_WRITE_GRANTS.id} = $4 AND ${GITHUB_WRITE_GRANTS.workspaceId} = $5
          RETURNING *`,
        [status, nowMs, GRANT_DEFAULT_TTL_MS, id, workspaceId],
      );
      return rows[0] ? mapGrantRow(rows[0] as Record<string, unknown>) : null;
    });
  },
};
