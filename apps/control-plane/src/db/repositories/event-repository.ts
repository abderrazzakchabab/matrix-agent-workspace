import { withTenant } from '../client';
import { RUN_EVENTS, type RunEventRow } from '../schema/events';
import type { TenantContext } from './run-repository';

export interface AppendEventInput {
  id: string;
  type: string;
  version: number;
  payload: Record<string, unknown>;
  visibility?: string;
}

function mapEventRow(row: Record<string, unknown>): RunEventRow {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    sequence: Number(row.sequence),
    eventType: row.event_type as string,
    eventVersion: Number(row.event_version),
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    visibility: row.visibility as string,
    createdAt: row.created_at as string,
  };
}

/**
 * Append an event inside a transaction, allocating the next per-run sequence
 * via `append_run_event` (which locks the run row and checks tenant access).
 * Returns the allocated sequence number.
 */
export async function appendEvent(
  tenant: TenantContext,
  runId: string,
  input: AppendEventInput,
): Promise<number> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      'SELECT append_run_event($1, $2, $3, $4, $5, $6) AS sequence',
      [
        runId,
        input.id,
        input.type,
        input.version,
        JSON.stringify(input.payload),
        input.visibility ?? 'room_and_owner',
      ],
    );
    return Number(rows[0].sequence);
  });
}

/** List a run's events with sequence greater than `afterSequence` (RLS-scoped). */
export async function listEvents(
  tenant: TenantContext,
  runId: string,
  afterSequence = 0,
): Promise<RunEventRow[]> {
  return withTenant(tenant.userId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM ${RUN_EVENTS.table}
        WHERE ${RUN_EVENTS.runId} = $1 AND ${RUN_EVENTS.sequence} > $2
        ORDER BY ${RUN_EVENTS.sequence} ASC`,
      [runId, afterSequence],
    );
    return rows.map(mapEventRow);
  });
}
