/**
 * Durable workflow checkpoints with compare-and-swap version updates.
 *
 * Checkpoint state is keyed by `(run_id, checkpoint_key)` and updated via the
 * `update_checkpoint` SECURITY DEFINER function, which bumps the version only
 * when the caller's expected version matches. On crash the Inngest retry
 * resumes from the last committed checkpoint, so completed specialists are
 * never rerun and outputs are never duplicated.
 */
import { withTenant } from '../db/client';
import type { TenantContext } from '../db/repositories/run-repository';

export interface CheckpointRecord {
  version: number;
  state: Record<string, unknown>;
}

export interface CheckpointStore {
  /**
   * Persist checkpoint state.
   *
   * - `expectedVersion === 0`: create the checkpoint. Returns `1` when this
   *   call created it, or `null` when a concurrent execution already did.
   * - otherwise: compare-and-swap against the expected version; returns the
   *   new version or `null` when the CAS lost (someone else updated first).
   */
  save(
    runId: string,
    key: string,
    state: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<number | null>;
  load(runId: string, key: string): Promise<CheckpointRecord | null>;
}

export class CheckpointVersionConflictError extends Error {
  readonly code = 'CHECKPOINT_VERSION_CONFLICT';
  constructor(key: string, expected: number, actual: number) {
    super(`checkpoint "${key}" version conflict: expected ${expected}, saw ${actual}`);
    this.name = 'CheckpointVersionConflictError';
  }
}

/** In-memory store used by deterministic workflow tests. */
export class InMemoryCheckpointStore implements CheckpointStore {
  private records = new Map<string, CheckpointRecord>();

  private mapKey(runId: string, key: string): string {
    return `${runId}\u0000${key}`;
  }

  async save(
    runId: string,
    key: string,
    state: Record<string, unknown>,
    expectedVersion: number,
  ): Promise<number | null> {
    const mapKey = this.mapKey(runId, key);
    const existing = this.records.get(mapKey);
    if (existing === undefined) {
      if (expectedVersion !== 0) {
        throw new CheckpointVersionConflictError(key, expectedVersion, 0);
      }
      this.records.set(mapKey, { version: 1, state: structuredClone(state) });
      return 1;
    }
    if (existing.version !== expectedVersion) return null;
    const next: CheckpointRecord = {
      version: existing.version + 1,
      state: structuredClone(state),
    };
    this.records.set(mapKey, next);
    return next.version;
  }

  async load(runId: string, key: string): Promise<CheckpointRecord | null> {
    const record = this.records.get(this.mapKey(runId, key));
    return record ? { version: record.version, state: structuredClone(record.state) } : null;
  }
}

/**
 * PostgreSQL checkpoint store. Runs under the workflow's explicit tenant
 * context (run owner + workspace), so RLS and the security-definer helpers
 * enforce access even though workflow code acts as a service role.
 */
export function createPostgresCheckpointStore(tenant: TenantContext): CheckpointStore {
  return {
    async save(
      runId: string,
      key: string,
      state: Record<string, unknown>,
      expectedVersion: number,
    ): Promise<number | null> {
      return withTenant(tenant.userId, async (client) => {
        if (expectedVersion === 0) {
          const inserted = await client.query(
            `INSERT INTO workflow_checkpoints (run_id, checkpoint_key, version, state)
             VALUES ($1, $2, 1, $3)
             ON CONFLICT (run_id, checkpoint_key) DO NOTHING
             RETURNING version`,
            [runId, key, JSON.stringify(state)],
          );
          if (inserted.rows.length === 0) return null;
          return Number(inserted.rows[0].version);
        }
        const applied = await client.query(
          'SELECT update_checkpoint($1, $2, $3, $4) AS applied',
          [runId, key, expectedVersion, JSON.stringify(state)],
        );
        if (!applied.rows[0].applied) return null;
        const current = await client.query(
          'SELECT version FROM workflow_checkpoints WHERE run_id = $1 AND checkpoint_key = $2',
          [runId, key],
        );
        return current.rows[0] ? Number(current.rows[0].version) : null;
      });
    },
    async load(runId: string, key: string): Promise<CheckpointRecord | null> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          'SELECT version, state FROM workflow_checkpoints WHERE run_id = $1 AND checkpoint_key = $2',
          [runId, key],
        );
        if (rows.length === 0) return null;
        return {
          version: Number(rows[0].version),
          state: (rows[0].state as Record<string, unknown> | null) ?? {},
        };
      });
    },
  };
}
