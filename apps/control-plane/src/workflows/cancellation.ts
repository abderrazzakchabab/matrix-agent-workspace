/**
 * Cooperative run cancellation.
 *
 * Cancellation records intent immediately (`cancel_requested_at`), prevents
 * new specialist steps, aborts in-flight provider calls, and lets the
 * workflow emit exactly one terminal `run.cancelled` event. Recording the
 * intent is idempotent: only the first caller's write wins.
 */
import { withTenant } from '../db/client';
import type { TenantContext } from '../db/repositories/run-repository';

export interface CancellationController {
  isCancelled(runId: string): Promise<boolean>;
  /** Record the cancellation intent; returns true only when this call recorded it. */
  recordCancellation(runId: string): Promise<boolean>;
}

/** In-memory controller used by deterministic workflow tests. */
export class InMemoryCancellationController implements CancellationController {
  private cancelledRuns = new Set<string>();

  async isCancelled(runId: string): Promise<boolean> {
    return this.cancelledRuns.has(runId);
  }

  async recordCancellation(runId: string): Promise<boolean> {
    if (this.cancelledRuns.has(runId)) return false;
    this.cancelledRuns.add(runId);
    return true;
  }

  /** Test convenience: mark a run as cancelled. */
  cancel(runId: string): void {
    this.cancelledRuns.add(runId);
  }
}

/**
 * PostgreSQL controller reading the persisted `cancel_requested_at` column,
 * which the cancel API route writes. The workflow polls it between steps and
 * at provider boundaries.
 */
export function createPostgresCancellationController(
  tenant: TenantContext,
): CancellationController {
  return {
    async isCancelled(runId: string): Promise<boolean> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          'SELECT cancel_requested_at IS NOT NULL AS cancelled FROM runs WHERE id = $1',
          [runId],
        );
        return rows[0] ? Boolean(rows[0].cancelled) : false;
      });
    },
    async recordCancellation(runId: string): Promise<boolean> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          `UPDATE runs
              SET cancel_requested_at = COALESCE(cancel_requested_at, now()),
                  updated_at = now()
            WHERE id = $1
              AND cancel_requested_at IS NULL
            RETURNING id`,
          [runId],
        );
        return rows.length > 0;
      });
    },
  };
}
