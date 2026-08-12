import { withTenant } from '../client';
import { RUNS, type RunRow, type RunMode, type RunStatus } from '../schema/runs';

/**
 * Tenant context required by every repository call. `userId` is the internal
 * `users.id`; `workspaceId` is the workspace the operation targets. All queries
 * run inside `withTenant(userId)`, so PostgreSQL RLS enforces cross-user and
 * cross-workspace denial on top of the explicit workspace filter.
 */
export interface TenantContext {
  userId: string;
  workspaceId: string;
}

export interface CreateRunInput {
  id: string;
  roomId: string | null;
  promptHash: string;
  mode: RunMode;
  status?: RunStatus;
  configSnapshot?: Record<string, unknown>;
  idempotencyKey?: string | null;
}

function mapRunRow(row: Record<string, unknown>): RunRow {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    ownerId: row.owner_id as string,
    roomId: (row.room_id as string | null) ?? null,
    promptHash: row.prompt_hash as string,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    configSnapshot: (row.config_snapshot as Record<string, unknown> | null) ?? {},
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    cancelRequestedAt: (row.cancel_requested_at as string | null) ?? null,
    terminalSummary: (row.terminal_summary as Record<string, unknown> | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

/** Create a run owned by the tenant user in their workspace (RLS-enforced). */
export async function createRun(
  tenant: TenantContext,
  input: CreateRunInput,
): Promise<RunRow> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO ${RUNS.table}
         (${RUNS.id}, ${RUNS.workspaceId}, ${RUNS.ownerId}, ${RUNS.roomId},
          ${RUNS.promptHash}, ${RUNS.mode}, ${RUNS.status}, ${RUNS.configSnapshot},
          ${RUNS.idempotencyKey})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.id,
        tenant.workspaceId,
        tenant.userId,
        input.roomId,
        input.promptHash,
        input.mode,
        input.status ?? 'queued',
        JSON.stringify(input.configSnapshot ?? {}),
        input.idempotencyKey ?? null,
      ],
    );
    return mapRunRow(rows[0]);
  });
}

/** Load a run; returns `null` when the tenant cannot access it (RLS-filtered). */
export async function getRun(tenant: TenantContext, runId: string): Promise<RunRow | null> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${RUNS.table} WHERE ${RUNS.id} = $1 AND ${RUNS.workspaceId} = $2`,
      [runId, tenant.workspaceId],
    );
    return rows[0] ? mapRunRow(rows[0]) : null;
  });
}

/** List runs in the tenant's workspace. */
export async function listRuns(tenant: TenantContext): Promise<RunRow[]> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${RUNS.table} WHERE ${RUNS.workspaceId} = $1 ORDER BY ${RUNS.createdAt} DESC`,
      [tenant.workspaceId],
    );
    return rows.map(mapRunRow);
  });
}

/** Transition a run's status; returns the updated row or `null` if not visible. */
export async function updateRunStatus(
  tenant: TenantContext,
  runId: string,
  status: RunStatus,
  terminalSummary?: Record<string, unknown> | null,
): Promise<RunRow | null> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `UPDATE ${RUNS.table}
          SET ${RUNS.status} = $1,
              ${RUNS.terminalSummary} = COALESCE($2, ${RUNS.terminalSummary}),
              ${RUNS.updatedAt} = now()
        WHERE ${RUNS.id} = $3 AND ${RUNS.workspaceId} = $4
        RETURNING *`,
      [status, terminalSummary ? JSON.stringify(terminalSummary) : null, runId, tenant.workspaceId],
    );
    return rows[0] ? mapRunRow(rows[0]) : null;
  });
}
