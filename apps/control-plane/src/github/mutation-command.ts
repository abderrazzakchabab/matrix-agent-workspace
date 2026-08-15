/**
 * Phase C idempotent GitHub mutation commands. The command table is keyed by
 * idempotency key: duplicate enqueues and worker retries return the existing
 * command, the provider result is persisted before the command is marked
 * complete, and exactly one provider mutation happens per logical command.
 *
 * Only explicit operations with validated arguments are allowed; Octokit (or
 * the injected mutation client) is called only after authorization passes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { withTenant } from '../db/client';
import { GITHUB_MUTATION_COMMANDS } from '../db/schema/mutations';
import { AUDIT_RECORDS } from '../db/schema/audit';
import { REDACTED, redact } from '../security/redaction';
import type { GithubFetch, GithubFetchResponse } from './read-client';
import {
  authorizeWriteScope,
  type WriteGrantStore,
  type WriteScope,
} from './write-authorization';
import type { ApprovalService } from './approval-service';
import type { MutationWorker } from './mutation-worker';

export const MUTATION_OPERATIONS = [
  'create_issue',
  'update_issue',
  'comment_issue',
  'create_pr_comment',
] as const;
export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];

const createIssueArgumentsSchema = z.object({
  title: z.string().min(1).max(500),
  body: z.string().max(65_536).optional(),
});
const updateIssueArgumentsSchema = z.object({
  issueNumber: z.number().int().positive(),
  title: z.string().max(500).optional(),
  body: z.string().max(65_536).optional(),
  state: z.enum(['open', 'closed']).optional(),
});
const commentIssueArgumentsSchema = z.object({
  issueNumber: z.number().int().positive(),
  body: z.string().min(1).max(65_536),
});
const createPrCommentArgumentsSchema = z.object({
  pullNumber: z.number().int().positive(),
  body: z.string().min(1).max(65_536),
});

export const MUTATION_ARGUMENT_SCHEMAS = {
  create_issue: createIssueArgumentsSchema,
  update_issue: updateIssueArgumentsSchema,
  comment_issue: commentIssueArgumentsSchema,
  create_pr_comment: createPrCommentArgumentsSchema,
} as const;

export type MutationArguments = z.infer<typeof createIssueArgumentsSchema> &
  z.infer<typeof updateIssueArgumentsSchema> &
  z.infer<typeof commentIssueArgumentsSchema> &
  z.infer<typeof createPrCommentArgumentsSchema>;

export class CommandNotAllowedError extends Error {
  readonly code = 'COMMAND_NOT_ALLOWED';
  readonly status = 422;
  constructor(message = 'The mutation command is not allowed') {
    super(message);
    this.name = 'CommandNotAllowedError';
  }
}

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Split `owner/repo` and reject anything that is not a plain repository name. */
export function parseRepository(repository: string): { owner: string; repo: string } {
  if (!REPOSITORY_PATTERN.test(repository)) throw new CommandNotAllowedError();
  const [owner, repo] = repository.split('/');
  return { owner: owner!, repo: repo! };
}

export function isMutationOperation(value: unknown): value is MutationOperation {
  return (
    typeof value === 'string' && (MUTATION_OPERATIONS as readonly string[]).includes(value)
  );
}

/** Validate the operation and its arguments; throws `COMMAND_NOT_ALLOWED`. */
export function validateMutationCommand(input: {
  operation: string;
  arguments: unknown;
}): { operation: MutationOperation; arguments: Record<string, unknown> } {
  if (!isMutationOperation(input.operation)) {
    throw new CommandNotAllowedError(`Operation ${JSON.stringify(input.operation)} is not allowed`);
  }
  const parsed = MUTATION_ARGUMENT_SCHEMAS[input.operation].safeParse(input.arguments);
  if (!parsed.success) {
    throw new CommandNotAllowedError(`Invalid arguments for ${input.operation}`);
  }
  return { operation: input.operation, arguments: parsed.data as Record<string, unknown> };
}

/** The write scope an operation requires. */
export function scopeForOperation(operation: MutationOperation): WriteScope {
  return operation === 'create_pr_comment' ? 'pull_requests:write' : 'issues:write';
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable hash of the operation + canonical arguments (the command's identity). */
export function computeCommandHash(operation: string, argumentsValue: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ operation, arguments: argumentsValue })))
    .digest('hex');
}

export type MutationCommandStatus = 'queued' | 'completed' | 'failed';

export interface MutationCommand {
  id: string;
  workspaceId: string;
  runId: string | null;
  userId: string;
  idempotencyKey: string;
  approvalId: string | null;
  repository: string;
  operation: MutationOperation;
  argumentsHash: string;
  arguments: Record<string, unknown>;
  status: MutationCommandStatus;
  providerResult: Record<string, unknown> | null;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertCommandResult {
  command: MutationCommand;
  replayed: boolean;
}

export interface MutationCommandStore {
  /** Idempotent by (workspace, idempotency key): returns the existing command. */
  insertCommand(input: {
    userId: string;
    id: string;
    workspaceId: string;
    runId: string | null;
    idempotencyKey: string;
    approvalId: string | null;
    repository: string;
    operation: MutationOperation;
    argumentsHash: string;
    arguments: Record<string, unknown>;
  }): Promise<InsertCommandResult>;
  getCommand(commandId: string): Promise<MutationCommand | null>;
  findCommandByKey(input: {
    userId?: string;
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<MutationCommand | null>;
  persistProviderResult(
    commandId: string,
    providerResult: Record<string, unknown>,
  ): Promise<MutationCommand | null>;
  markCompleted(
    commandId: string,
    providerResult: Record<string, unknown>,
  ): Promise<MutationCommand | null>;
  markFailed(commandId: string, errorCode: string): Promise<MutationCommand | null>;
}

function newCommand(
  input: Parameters<MutationCommandStore['insertCommand']>[0],
): MutationCommand {
  const now = new Date().toISOString();
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    runId: input.runId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    approvalId: input.approvalId,
    repository: input.repository,
    operation: input.operation,
    argumentsHash: input.argumentsHash,
    arguments: input.arguments,
    status: 'queued',
    providerResult: null,
    attempts: 0,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** In-memory command store for hermetic tests. */
export class InMemoryMutationCommandStore implements MutationCommandStore {
  private readonly rows = new Map<string, MutationCommand>();

  private findByKey(workspaceId: string, idempotencyKey: string): MutationCommand | undefined {
    for (const row of this.rows.values()) {
      if (row.workspaceId === workspaceId && row.idempotencyKey === idempotencyKey) return row;
    }
    return undefined;
  }

  async insertCommand(input: {
    userId: string;
    id: string;
    workspaceId: string;
    runId: string | null;
    idempotencyKey: string;
    approvalId: string | null;
    repository: string;
    operation: MutationOperation;
    argumentsHash: string;
    arguments: Record<string, unknown>;
  }): Promise<InsertCommandResult> {
    const existing = this.findByKey(input.workspaceId, input.idempotencyKey);
    if (existing) return { command: existing, replayed: true };
    const command = newCommand(input);
    this.rows.set(command.id, command);
    return { command, replayed: false };
  }

  async getCommand(commandId: string): Promise<MutationCommand | null> {
    return this.rows.get(commandId) ?? null;
  }

  async findCommandByKey(input: {
    userId?: string;
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<MutationCommand | null> {
    return this.findByKey(input.workspaceId, input.idempotencyKey) ?? null;
  }

  async persistProviderResult(
    commandId: string,
    providerResult: Record<string, unknown>,
  ): Promise<MutationCommand | null> {
    const row = this.rows.get(commandId);
    if (!row) return null;
    const updated: MutationCommand = {
      ...row,
      providerResult,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(commandId, updated);
    return updated;
  }

  async markCompleted(
    commandId: string,
    providerResult: Record<string, unknown>,
  ): Promise<MutationCommand | null> {
    const row = this.rows.get(commandId);
    if (!row) return null;
    const updated: MutationCommand = {
      ...row,
      status: 'completed',
      providerResult,
      attempts: row.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(commandId, updated);
    return updated;
  }

  async markFailed(commandId: string, errorCode: string): Promise<MutationCommand | null> {
    const row = this.rows.get(commandId);
    if (!row) return null;
    const updated: MutationCommand = {
      ...row,
      status: 'failed',
      errorCode,
      attempts: row.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(commandId, updated);
    return updated;
  }
}

/** Preserve sub-millisecond precision: `String(Date)` drops milliseconds, so
 * round-tripping through `String(row.created_at)` would truncate timestamps
 * to whole seconds and break keyset cursors that order by (created_at, id). */
function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function mapCommandRow(row: Record<string, unknown>): MutationCommand {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    runId: (row.run_id as string | null) ?? null,
    userId: String(row.user_id),
    idempotencyKey: String(row.idempotency_key),
    approvalId: (row.approval_id as string | null) ?? null,
    repository: String(row.repository),
    operation: row.operation as MutationOperation,
    argumentsHash: String(row.arguments_hash),
    arguments: (row.arguments as Record<string, unknown> | null) ?? {},
    status: row.status as MutationCommandStatus,
    providerResult: (row.provider_result as Record<string, unknown> | null) ?? null,
    attempts: Number(row.attempts ?? 0),
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
}

/** PostgreSQL-backed command store; RLS isolates commands by workspace. The
 * worker only knows a command id, so it uses `createDatabaseMutationCommandStore`
 * with a security-definer tenant resolver; the enqueue path (which knows the
 * session user) uses `insertCommand` directly. */
const databaseMutationCommandStoreBase = {
  async insertCommand(input: {
    userId: string;
    id: string;
    workspaceId: string;
    runId: string | null;
    idempotencyKey: string;
    approvalId: string | null;
    repository: string;
    operation: MutationOperation;
    argumentsHash: string;
    arguments: Record<string, unknown>;
  }): Promise<InsertCommandResult> {
    return withTenant(input.userId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${GITHUB_MUTATION_COMMANDS.table}
           (${GITHUB_MUTATION_COMMANDS.id}, ${GITHUB_MUTATION_COMMANDS.workspaceId},
            ${GITHUB_MUTATION_COMMANDS.runId}, ${GITHUB_MUTATION_COMMANDS.userId},
            ${GITHUB_MUTATION_COMMANDS.idempotencyKey}, ${GITHUB_MUTATION_COMMANDS.approvalId},
            ${GITHUB_MUTATION_COMMANDS.repository}, ${GITHUB_MUTATION_COMMANDS.operation},
            ${GITHUB_MUTATION_COMMANDS.argumentsHash}, ${GITHUB_MUTATION_COMMANDS.arguments})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
         RETURNING *`,
        [
          input.id,
          input.workspaceId,
          input.runId,
          input.userId,
          input.idempotencyKey,
          input.approvalId,
          input.repository,
          input.operation,
          input.argumentsHash,
          JSON.stringify(input.arguments),
        ],
      );
      if (inserted.rows[0]) {
        return { command: mapCommandRow(inserted.rows[0] as Record<string, unknown>), replayed: false };
      }
      const existing = await client.query(
        `SELECT * FROM ${GITHUB_MUTATION_COMMANDS.table}
          WHERE ${GITHUB_MUTATION_COMMANDS.workspaceId} = $1
            AND ${GITHUB_MUTATION_COMMANDS.idempotencyKey} = $2
          LIMIT 1`,
        [input.workspaceId, input.idempotencyKey],
      );
      return { command: mapCommandRow(existing.rows[0] as Record<string, unknown>), replayed: true };
    });
  },

  async findCommandByKey(input: {
    userId?: string;
    workspaceId: string;
    idempotencyKey: string;
  }): Promise<MutationCommand | null> {
    if (!input.userId) throw new Error('databaseMutationCommandStore.findCommandByKey requires userId');
    return withTenant(input.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM ${GITHUB_MUTATION_COMMANDS.table}
          WHERE ${GITHUB_MUTATION_COMMANDS.workspaceId} = $1
            AND ${GITHUB_MUTATION_COMMANDS.idempotencyKey} = $2
          LIMIT 1`,
        [input.workspaceId, input.idempotencyKey],
      );
      return rows[0] ? mapCommandRow(rows[0] as Record<string, unknown>) : null;
    });
  },
};

/**
 * Database command store with a security-definer tenant resolver: the worker
 * only knows a command id, so `mutation_command_tenant(id)` (defined in the
 * migration) returns the owning user/workspace before `withTenant` re-enters.
 */
export function createDatabaseMutationCommandStore(
  resolveTenant: (commandId: string) => Promise<{ userId: string; workspaceId: string } | null>,
): MutationCommandStore {
  async function withCommandTenant<T>(
    commandId: string,
    run: (input: { userId: string; workspaceId: string; client: import('pg').PoolClient }) => Promise<T>,
  ): Promise<T | null> {
    const tenant = await resolveTenant(commandId);
    if (!tenant) return null;
    return withTenant(tenant.userId, (client) => run({ ...tenant, client }));
  }

  return {
    ...databaseMutationCommandStoreBase,

    async getCommand(commandId) {
      return withCommandTenant(commandId, async ({ client }) => {
        const { rows } = await client.query(
          `SELECT * FROM ${GITHUB_MUTATION_COMMANDS.table} WHERE ${GITHUB_MUTATION_COMMANDS.id} = $1`,
          [commandId],
        );
        return rows[0] ? mapCommandRow(rows[0] as Record<string, unknown>) : null;
      });
    },

    async persistProviderResult(commandId, providerResult) {
      return withCommandTenant(commandId, async ({ client }) => {
        const { rows } = await client.query(
          `UPDATE ${GITHUB_MUTATION_COMMANDS.table}
              SET ${GITHUB_MUTATION_COMMANDS.providerResult} = $2,
                  ${GITHUB_MUTATION_COMMANDS.updatedAt} = now()
            WHERE ${GITHUB_MUTATION_COMMANDS.id} = $1
            RETURNING *`,
          [commandId, JSON.stringify(providerResult)],
        );
        return rows[0] ? mapCommandRow(rows[0] as Record<string, unknown>) : null;
      });
    },

    async markCompleted(commandId, providerResult) {
      return withCommandTenant(commandId, async ({ client }) => {
        const { rows } = await client.query(
          `UPDATE ${GITHUB_MUTATION_COMMANDS.table}
              SET ${GITHUB_MUTATION_COMMANDS.status} = 'completed',
                  ${GITHUB_MUTATION_COMMANDS.providerResult} = $2,
                  ${GITHUB_MUTATION_COMMANDS.attempts} = ${GITHUB_MUTATION_COMMANDS.attempts} + 1,
                  ${GITHUB_MUTATION_COMMANDS.errorCode} = NULL,
                  ${GITHUB_MUTATION_COMMANDS.updatedAt} = now()
            WHERE ${GITHUB_MUTATION_COMMANDS.id} = $1
            RETURNING *`,
          [commandId, JSON.stringify(providerResult)],
        );
        return rows[0] ? mapCommandRow(rows[0] as Record<string, unknown>) : null;
      });
    },

    async markFailed(commandId, errorCode) {
      return withCommandTenant(commandId, async ({ client }) => {
        const { rows } = await client.query(
          `UPDATE ${GITHUB_MUTATION_COMMANDS.table}
              SET ${GITHUB_MUTATION_COMMANDS.status} = 'failed',
                  ${GITHUB_MUTATION_COMMANDS.errorCode} = $2,
                  ${GITHUB_MUTATION_COMMANDS.attempts} = ${GITHUB_MUTATION_COMMANDS.attempts} + 1,
                  ${GITHUB_MUTATION_COMMANDS.updatedAt} = now()
            WHERE ${GITHUB_MUTATION_COMMANDS.id} = $1
            RETURNING *`,
          [commandId, errorCode],
        );
        return rows[0] ? mapCommandRow(rows[0] as Record<string, unknown>) : null;
      });
    },
  };
}

// ── Audit records ───────────────────────────────────────────────────────────

export interface AuditRecordInput {
  workspaceId: string;
  actorUserId: string;
  actorMatrixId?: string | null;
  scope?: string | null;
  repository?: string | null;
  operation?: string | null;
  argumentsHash?: string | null;
  approvalId?: string | null;
  commandId?: string | null;
  outcome: string;
  details?: Record<string, unknown>;
}

export interface AuditRecord extends AuditRecordInput {
  id: string;
  createdAt: string;
  details: Record<string, unknown>;
}

export interface AuditListResult {
  items: AuditRecord[];
  nextCursor?: string;
}

export interface AuditStore {
  record(input: AuditRecordInput): Promise<AuditRecord>;
  list(input: {
    userId?: string;
    workspaceId: string;
    cursor?: string;
    limit?: number;
  }): Promise<AuditListResult>;
}

/** In-memory audit store for hermetic tests (append-only, workspace-scoped). */
export class InMemoryAuditStore implements AuditStore {
  private readonly records: AuditRecord[] = [];
  private nextId = 1;
  private lastTimestamp = 0;

  async record(input: AuditRecordInput): Promise<AuditRecord> {
    // Monotonic timestamps keep ordering deterministic within one clock tick.
    this.lastTimestamp = Math.max(this.lastTimestamp + 1, Date.now());
    const record: AuditRecord = {
      ...input,
      id: `aud_${this.nextId++}`,
      createdAt: new Date(this.lastTimestamp).toISOString(),
      details: redact(input.details ?? {}),
    };
    this.records.push(record);
    return record;
  }

  async list(input: {
    userId?: string;
    workspaceId: string;
    cursor?: string;
    limit?: number;
  }): Promise<AuditListResult> {
    const limit = input.limit ?? 50;
    const rows = this.records
      .filter((r) => r.workspaceId === input.workspaceId)
      .sort((a, b) => (a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt)));
    const start = input.cursor ? Number.parseInt(Buffer.from(input.cursor, 'base64url').toString('utf8'), 10) || 0 : 0;
    const items = rows.slice(start, start + limit);
    const nextCursor =
      start + items.length < rows.length
        ? Buffer.from(String(start + items.length)).toString('base64url')
        : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }
}

function mapAuditRow(row: Record<string, unknown>): AuditRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    actorUserId: String(row.actor_user_id ?? ''),
    actorMatrixId: (row.actor_matrix_id as string | null) ?? null,
    scope: (row.scope as string | null) ?? null,
    repository: (row.repository as string | null) ?? null,
    operation: (row.operation as string | null) ?? null,
    argumentsHash: (row.arguments_hash as string | null) ?? null,
    approvalId: (row.approval_id as string | null) ?? null,
    commandId: (row.command_id as string | null) ?? null,
    outcome: String(row.outcome),
    details: (row.details as Record<string, unknown> | null) ?? {},
    createdAt: toIsoTimestamp(row.created_at),
  };
}

export class InvalidAuditCursorError extends Error {
  readonly code = 'VALIDATION_ERROR';
  readonly status = 400;
  constructor() {
    super('Invalid audit cursor');
    this.name = 'InvalidAuditCursorError';
  }
}

export function encodeAuditCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`).toString('base64url');
}

export function decodeAuditCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidAuditCursorError();
  }
  return { createdAt, id };
}

/** PostgreSQL-backed audit store; rows are append-only (INSERT + SELECT only).
 * `record` runs under the actor's tenant; `list` runs under the caller's. */
export const databaseAuditStore: AuditStore = {
  async record(input) {
    return withTenant(input.actorUserId, async (client) => {
      let actorMatrixId = input.actorMatrixId ?? null;
      if (!actorMatrixId) {
        const { rows: userRows } = await client.query(
          'SELECT matrix_user_id FROM users WHERE id = $1',
          [input.actorUserId],
        );
        actorMatrixId = (userRows[0]?.matrix_user_id as string | null) ?? null;
      }
      const id = `aud_${randomUUID()}`;
      const { rows } = await client.query(
        `INSERT INTO ${AUDIT_RECORDS.table}
           (${AUDIT_RECORDS.id}, ${AUDIT_RECORDS.workspaceId}, ${AUDIT_RECORDS.actorUserId},
            ${AUDIT_RECORDS.actorMatrixId}, ${AUDIT_RECORDS.scope}, ${AUDIT_RECORDS.repository},
            ${AUDIT_RECORDS.operation}, ${AUDIT_RECORDS.argumentsHash},
            ${AUDIT_RECORDS.approvalId}, ${AUDIT_RECORDS.commandId}, ${AUDIT_RECORDS.outcome},
            ${AUDIT_RECORDS.details})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          id,
          input.workspaceId,
          input.actorUserId,
          actorMatrixId,
          input.scope ?? null,
          input.repository ?? null,
          input.operation ?? null,
          input.argumentsHash ?? null,
          input.approvalId ?? null,
          input.commandId ?? null,
          input.outcome,
          JSON.stringify(redact(input.details ?? {})),
        ],
      );
      return mapAuditRow(rows[0] as Record<string, unknown>);
    });
  },

  async list({ userId, workspaceId, cursor, limit }) {
    if (!userId) throw new Error('databaseAuditStore.list requires userId');
    return withTenant(userId, async (client) => {
      const requested = Number.isFinite(limit) ? (limit as number) : 50;
      const pageSize = Math.min(Math.max(requested, 1), 200);
      const params: unknown[] = [workspaceId];
      let where = `WHERE ${AUDIT_RECORDS.workspaceId} = $1`;
      if (cursor) {
        const { createdAt, id } = decodeAuditCursor(cursor);
        where += ` AND (${AUDIT_RECORDS.createdAt}, ${AUDIT_RECORDS.id}) < ($2::timestamptz, $3)`;
        params.push(createdAt, id);
      }
      const { rows } = await client.query(
        `SELECT *, to_char(${AUDIT_RECORDS.createdAt} AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __cursor_created_at
          FROM ${AUDIT_RECORDS.table}
          ${where}
          ORDER BY ${AUDIT_RECORDS.createdAt} DESC, ${AUDIT_RECORDS.id} DESC
          LIMIT ${pageSize}`,
        params,
      );
      const items = rows.map((row) => mapAuditRow(row as Record<string, unknown>));
      let nextCursor: string | undefined;
      if (items.length === pageSize && items.length > 0) {
        // Encode the cursor from the raw column value (microsecond
        // precision): a JS Date cannot represent the sub-millisecond digits
        // Postgres stores, so rows sharing a millisecond would otherwise
        // collide on the cursor key and silently drop from the next page.
        const last = items[items.length - 1]!;
        const rawCreatedAt = (rows[items.length - 1] as Record<string, unknown>)
          .__cursor_created_at as string | undefined;
        nextCursor = encodeAuditCursor(rawCreatedAt ?? last.createdAt, last.id);
      }
      return { items, ...(nextCursor ? { nextCursor } : {}) };
    });
  },
};

// ── GitHub mutation client (the only place Octokit-compatible calls happen) ──

export interface GithubMutationClient {
  createIssue(
    repository: string,
    args: { title: string; body?: string },
  ): Promise<{ issueNumber: number; url: string }>;
  updateIssue(
    repository: string,
    args: { issueNumber: number; title?: string; body?: string; state?: 'open' | 'closed' },
  ): Promise<{ issueNumber: number; url: string }>;
  commentIssue(
    repository: string,
    args: { issueNumber: number; body: string },
  ): Promise<{ commentId: number; url: string }>;
  createPullRequestComment(
    repository: string,
    args: { pullNumber: number; body: string },
  ): Promise<{ commentId: number; url: string }>;
}

export class GithubMutationError extends Error {
  readonly code = 'GITHUB_MUTATION_FAILED';
  readonly status = 502;
  constructor() {
    super('GitHub mutation request failed');
    this.name = 'GithubMutationError';
  }
}

export interface GithubMutationClientOptions {
  token: string | (() => Promise<string>);
  baseUrl?: string;
  fetch?: GithubFetch;
}

export function createGithubMutationClient(
  options: GithubMutationClientOptions,
): GithubMutationClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(
    /\/$/,
    '',
  );

  async function request(method: 'POST' | 'PATCH', path: string, body: unknown): Promise<unknown> {
    const token = typeof options.token === 'string' ? options.token : await options.token();
    let response: GithubFetchResponse;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'matrix-agent-workspace-control-plane',
          'x-github-api-version': '2022-11-28',
        },
        body: JSON.stringify(body),
        redirect: 'error',
      });
    } catch {
      throw new GithubMutationError();
    }
    if (!response.ok) throw new GithubMutationError();
    try {
      return await response.json();
    } catch {
      throw new GithubMutationError();
    }
  }

  function reposPath(repository: string): string {
    const { owner, repo } = parseRepository(repository);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  return {
    async createIssue(repository, args) {
      const data = (await request('POST', `${reposPath(repository)}/issues`, {
        title: args.title,
        ...(args.body === undefined ? {} : { body: args.body }),
      })) as { number?: unknown; html_url?: unknown };
      if (typeof data.number !== 'number' || typeof data.html_url !== 'string') {
        throw new GithubMutationError();
      }
      return { issueNumber: data.number, url: data.html_url };
    },

    async updateIssue(repository, args) {
      const data = (await request('PATCH', `${reposPath(repository)}/issues/${args.issueNumber}`, {
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.body === undefined ? {} : { body: args.body }),
        ...(args.state === undefined ? {} : { state: args.state }),
      })) as { number?: unknown; html_url?: unknown };
      if (typeof data.number !== 'number' || typeof data.html_url !== 'string') {
        throw new GithubMutationError();
      }
      return { issueNumber: data.number, url: data.html_url };
    },

    async commentIssue(repository, args) {
      const data = (await request('POST', `${reposPath(repository)}/issues/${args.issueNumber}/comments`, {
        body: args.body,
      })) as { id?: unknown; html_url?: unknown };
      if (typeof data.id !== 'number' || typeof data.html_url !== 'string') {
        throw new GithubMutationError();
      }
      return { commentId: data.id, url: data.html_url };
    },

    async createPullRequestComment(repository, args) {
      const data = (await request('POST', `${reposPath(repository)}/pulls/${args.pullNumber}/comments`, {
        body: args.body,
      })) as { id?: unknown; html_url?: unknown };
      if (typeof data.id !== 'number' || typeof data.html_url !== 'string') {
        throw new GithubMutationError();
      }
      return { commentId: data.id, url: data.html_url };
    },
  };
}

// ── Enqueue orchestration ───────────────────────────────────────────────────

export interface EnqueueMutationInput {
  userId: string;
  workspaceId: string;
  runId?: string | null;
  idempotencyKey: string;
  approvalId: string;
  repository: string;
  operation: string;
  arguments: unknown;
  actorMatrixId?: string | null;
}

export interface EnqueueMutationDeps {
  grantStore: WriteGrantStore;
  approvalService: ApprovalService;
  commandStore: MutationCommandStore;
  auditStore: AuditStore;
  worker?: MutationWorker | null;
  now?: () => number;
}

export interface EnqueueMutationResult {
  command: MutationCommand;
  replayed: boolean;
}

/**
 * Enqueue a mutation command. A duplicate idempotency key returns the
 * existing command/result immediately — even after the approval TTL or grant
 * revocation — because the command was already gated at first enqueue and the
 * worker re-checks both gates right before the provider call. One exception:
 * a command whose worker crashed after the provider result was persisted
 * (queued with a stored result) is finalized from that stored result on
 * replay, so a crash never causes a second provider mutation. For new
 * commands the repository shape, operation/arguments, the repository+scope
 * write grant, and the exact unexpired approval are checked in order before
 * anything is inserted. Audit rows record queueing, completion, failure, and
 * denials — always with redacted payloads.
 */
export async function enqueueMutationCommand(
  input: EnqueueMutationInput,
  deps: EnqueueMutationDeps,
): Promise<EnqueueMutationResult> {
  parseRepository(input.repository);
  const validated = validateMutationCommand({ operation: input.operation, arguments: input.arguments });
  const scope = scopeForOperation(validated.operation);
  const commandHash = computeCommandHash(validated.operation, validated.arguments);

  const existing = await deps.commandStore.findCommandByKey({
    userId: input.userId,
    workspaceId: input.workspaceId,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing) {
    // Crash recovery on replay: the provider result was persisted before the
    // crash, so the worker finalizes from the stored result without issuing
    // another provider mutation. A completed command (or one still queued
    // with no provider result) is returned as recorded.
    if (existing.status === 'queued' && existing.providerResult && deps.worker) {
      const resumed = await deps.worker.process(existing.id);
      return { command: resumed ?? existing, replayed: true };
    }
    return { command: existing, replayed: true };
  }

  try {
    await authorizeWriteScope(
      {
        userId: input.userId,
        workspaceId: input.workspaceId,
        repository: input.repository,
        scope,
        now: deps.now,
      },
      deps.grantStore,
    );
    await deps.approvalService.checkApproval({
      approvalId: input.approvalId,
      workspaceId: input.workspaceId,
      runId: input.runId ?? null,
      userId: input.userId,
      scope,
      commandHash,
      now: deps.now?.(),
    });
  } catch (error) {
    const code = (error as { code?: string }).code ?? 'MUTATION_DENIED';
    await deps.auditStore.record({
      workspaceId: input.workspaceId,
      actorUserId: input.userId,
      actorMatrixId: input.actorMatrixId ?? null,
      scope,
      repository: input.repository,
      operation: validated.operation,
      argumentsHash: commandHash,
      approvalId: input.approvalId,
      outcome: 'denied',
      details: { errorCode: code },
    }).catch(() => undefined);
    throw error;
  }

  const inserted = await deps.commandStore.insertCommand({
    userId: input.userId,
    id: `gcmd_${randomUUID()}`,
    workspaceId: input.workspaceId,
    runId: input.runId ?? null,
    idempotencyKey: input.idempotencyKey,
    approvalId: input.approvalId,
    repository: input.repository,
    operation: validated.operation,
    argumentsHash: commandHash,
    arguments: validated.arguments,
  });
  if (inserted.replayed) return { command: inserted.command, replayed: true };

  await deps.auditStore.record({
    workspaceId: input.workspaceId,
    actorUserId: input.userId,
    actorMatrixId: input.actorMatrixId ?? null,
    scope,
    repository: input.repository,
    operation: validated.operation,
    argumentsHash: commandHash,
    approvalId: input.approvalId,
    commandId: inserted.command.id,
    outcome: 'queued',
    details: { arguments: REDACTED },
  });

  if (deps.worker) {
    await deps.worker.process(inserted.command.id);
  }
  const current = await deps.commandStore.getCommand(inserted.command.id);
  return { command: current ?? inserted.command, replayed: false };
}
