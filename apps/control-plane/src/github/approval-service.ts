/**
 * Phase C approval gate for GitHub mutations. An approval is bound to the
 * exact workspace, run, user, scope, and command hash; it expires after a
 * short TTL. Denied, changed, expired, or mismatched approvals never reach
 * GitHub. Approvals can only be created with explicit confirmation text from
 * an authenticated session — Matrix prompt text can never approve a mutation.
 */
import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/client';
import { MUTATION_APPROVALS } from '../db/schema/approvals';
import type { WriteScope } from './write-authorization';

/** Default lifetime of an approval. */
export const APPROVAL_DEFAULT_TTL_MS = 15 * 60 * 1000;

export type ApprovalDecision = 'approved' | 'denied';

export interface MutationApproval {
  id: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  scope: WriteScope;
  commandHash: string;
  decision: ApprovalDecision;
  confirmationText: string;
  expiresAt: string;
  createdAt: string;
}

export class ApprovalNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND';
  readonly status = 409;
  constructor() {
    super('Approval not found');
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalDeniedError extends Error {
  readonly code = 'APPROVAL_DENIED';
  readonly status = 409;
  constructor() {
    super('The approval was denied');
    this.name = 'ApprovalDeniedError';
  }
}

export class ApprovalExpiredError extends Error {
  readonly code = 'APPROVAL_EXPIRED';
  readonly status = 409;
  constructor() {
    super('The approval has expired');
    this.name = 'ApprovalExpiredError';
  }
}

export class ApprovalMismatchError extends Error {
  readonly code = 'APPROVAL_MISMATCH';
  readonly status = 409;
  constructor() {
    super('The approval does not match this command');
    this.name = 'ApprovalMismatchError';
  }
}

export class ApprovalConfirmationRequiredError extends Error {
  readonly code = 'APPROVAL_CONFIRMATION_REQUIRED';
  readonly status = 422;
  constructor() {
    super('Explicit confirmation text is required to approve a mutation');
    this.name = 'ApprovalConfirmationRequiredError';
  }
}

export interface CreateApprovalInput {
  id?: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  scope: WriteScope;
  commandHash: string;
  decision: ApprovalDecision;
  confirmationText: string;
  expiresAt: string;
}

export interface ApprovalStore {
  createApproval(input: CreateApprovalInput): Promise<MutationApproval>;
  findApproval(input: { id: string; userId?: string }): Promise<MutationApproval | null>;
}

export interface ApproveInput {
  workspaceId: string;
  runId: string | null;
  userId: string;
  scope: WriteScope;
  commandHash: string;
  decision: ApprovalDecision;
  confirmationText: string;
  now?: number;
}

export interface CheckApprovalInput {
  approvalId: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  scope: WriteScope;
  commandHash: string;
  now?: number;
}

export interface ApprovalService {
  approve(input: ApproveInput): Promise<MutationApproval>;
  checkApproval(input: CheckApprovalInput): Promise<MutationApproval>;
}

export interface ApprovalServiceDeps {
  store: ApprovalStore;
  ttlMs?: number;
  now?: () => number;
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const ttlMs = deps.ttlMs ?? APPROVAL_DEFAULT_TTL_MS;
  return {
    async approve(input) {
      if (input.decision === 'approved' && input.confirmationText.trim().length === 0) {
        throw new ApprovalConfirmationRequiredError();
      }
      const now = (deps.now ?? Date.now)();
      const approval = await deps.store.createApproval({
        id: `apr_${randomUUID()}`,
        workspaceId: input.workspaceId,
        runId: input.runId,
        userId: input.userId,
        scope: input.scope,
        commandHash: input.commandHash,
        decision: input.decision,
        confirmationText: input.confirmationText,
        expiresAt: new Date(now + ttlMs).toISOString(),
      });
      return approval;
    },

    async checkApproval(input) {
      const now = input.now ?? (deps.now ?? Date.now)();
      const approval = await deps.store.findApproval({ id: input.approvalId, userId: input.userId });
      if (!approval) throw new ApprovalNotFoundError();
      if (approval.decision !== 'approved') throw new ApprovalDeniedError();
      if (now > Date.parse(approval.expiresAt)) throw new ApprovalExpiredError();
      const exact =
        approval.workspaceId === input.workspaceId &&
        approval.runId === input.runId &&
        approval.userId === input.userId &&
        approval.scope === input.scope &&
        approval.commandHash === input.commandHash;
      if (!exact) throw new ApprovalMismatchError();
      return approval;
    },
  };
}

/** In-memory approval store for hermetic tests. */
export class InMemoryApprovalStore implements ApprovalStore {
  private readonly rows = new Map<string, MutationApproval>();

  async createApproval(input: CreateApprovalInput): Promise<MutationApproval> {
    const approval: MutationApproval = {
      id: input.id ?? `apr_${randomUUID()}`,
      workspaceId: input.workspaceId,
      runId: input.runId,
      userId: input.userId,
      scope: input.scope,
      commandHash: input.commandHash,
      decision: input.decision,
      confirmationText: input.confirmationText,
      expiresAt: input.expiresAt,
      createdAt: new Date().toISOString(),
    };
    this.rows.set(approval.id, approval);
    return approval;
  }

  async findApproval(input: { id: string; userId?: string }): Promise<MutationApproval | null> {
    return this.rows.get(input.id) ?? null;
  }
}

function mapApprovalRow(row: Record<string, unknown>): MutationApproval {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: (row.run_id as string | null) ?? null,
    userId: String(row.user_id),
    scope: row.scope as WriteScope,
    commandHash: String(row.command_hash),
    decision: row.decision as ApprovalDecision,
    confirmationText: String(row.confirmation_text ?? ''),
    expiresAt: new Date(String(row.expires_at)).toISOString(),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/** PostgreSQL-backed approval store; RLS isolates approvals by workspace. */
export const databaseApprovalStore: ApprovalStore = {
  async createApproval(input) {
    return withTenant(input.userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ${MUTATION_APPROVALS.table}
           (${MUTATION_APPROVALS.id}, ${MUTATION_APPROVALS.workspaceId},
            ${MUTATION_APPROVALS.runId}, ${MUTATION_APPROVALS.userId},
            ${MUTATION_APPROVALS.scope}, ${MUTATION_APPROVALS.commandHash},
            ${MUTATION_APPROVALS.decision}, ${MUTATION_APPROVALS.confirmationText},
            ${MUTATION_APPROVALS.expiresAt})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.id ?? `apr_${randomUUID()}`,
          input.workspaceId,
          input.runId,
          input.userId,
          input.scope,
          input.commandHash,
          input.decision,
          input.confirmationText,
          input.expiresAt,
        ],
      );
      return mapApprovalRow(rows[0] as Record<string, unknown>);
    });
  },

  async findApproval({ id, userId }) {
    if (!userId) throw new Error('databaseApprovalStore.findApproval requires userId');
    return withTenant(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ${MUTATION_APPROVALS.table} WHERE ${MUTATION_APPROVALS.id} = $1`,
        [id],
      );
      return rows[0] ? mapApprovalRow(rows[0] as Record<string, unknown>) : null;
    });
  },
};

