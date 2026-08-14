/**
 * Regression + smoke coverage for the PostgreSQL-backed Phase C stores.
 *
 * Regression: `mapAuditRow`/`mapCommandRow` previously rounded Postgres
 * timestamps through `String(Date)` (which drops milliseconds), truncating
 * every `createdAt` to whole seconds. That broke the (created_at, id) keyset
 * cursor: two audit records created within the same second collapsed to the
 * same cursor key, and `list` silently skipped the remaining rows on the next
 * page. This test seeds two rows sharing a millisecond and proves the cursor
 * still finds the second row and that responses carry millisecond precision.
 *
 * Requires the live Postgres fixture (same as test/db/*.test.ts).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getAdminPool,
  runMigrations,
  withTenant,
} from '../../src/db/client';
import {
  databaseAuditStore,
  createDatabaseMutationCommandStore,
  computeCommandHash,
} from '../../src/github/mutation-command';

const USER_A = 'reg_user_a';
const USER_B = 'reg_user_b';
const WS_A = 'reg_ws_a';
const WS_B = 'reg_ws_b';

beforeAll(async () => {
  await runMigrations();
  const owner = getAdminPool();
  await owner.query(
    'TRUNCATE audit_records, github_mutation_commands, mutation_approvals, github_write_grants, rooms, users CASCADE',
  );
  await owner.query(
    `INSERT INTO users (id, matrix_user_id, homeserver_url) VALUES
       ('${USER_A}', '@reg_a:example.test', 'https://hs.example.test'),
       ('${USER_B}', '@reg_b:example.test', 'https://hs.example.test')`,
  );
  await owner.query(
    `INSERT INTO workspaces (id, name, owner_id, policy, status) VALUES
       ('${WS_A}', 'Reg A', '${USER_A}', '{}', 'active'),
       ('${WS_B}', 'Reg B', '${USER_B}', '{}', 'active')`,
  );
  await owner.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
       ('${WS_A}', '${USER_A}', 'owner'), ('${WS_B}', '${USER_B}', 'owner')`,
  );
});

describe('databaseAuditStore keyset cursor precision', () => {
  it('pages across audit rows that share the same millisecond without skipping', async () => {
    // Two rows whose full-precision timestamps fall in the same millisecond
    // (a burst like a queued+completed pair). The keyset cursor must keep
    // them distinct; truncating to seconds would collapse them.
    const t = '2026-08-14T12:00:00';
    await getAdminPool().query(
      `INSERT INTO audit_records (id, workspace_id, actor_user_id, actor_matrix_id, scope, repository, operation, arguments_hash, approval_id, command_id, outcome, details, created_at)
       VALUES ('reg_aud_1', '${WS_A}', '${USER_A}', '@reg_a:example.test', 'issues:write', 'acme/widget', 'create_issue', 'h1', 'apr_1', 'gcmd_1', 'queued', '{"arguments":"[REDACTED]"}'::jsonb, '${t}.123456+00'::timestamptz),
              ('reg_aud_2', '${WS_A}', '${USER_A}', '@reg_a:example.test', 'issues:write', 'acme/widget', 'create_issue', 'h1', 'apr_1', 'gcmd_1', 'completed', '{"arguments":"[REDACTED]"}'::jsonb, '${t}.123789+00'::timestamptz)`,
    );

    const page1 = await databaseAuditStore.list({
      userId: USER_A,
      workspaceId: WS_A,
      limit: 1,
    });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0]!.id).toBe('reg_aud_2'); // newest first
    expect(page1.items[0]!.createdAt).toBe('2026-08-14T12:00:00.123Z'); // ms preserved
    expect(page1.nextCursor).toBeTruthy();

    const page2 = await databaseAuditStore.list({
      userId: USER_A,
      workspaceId: WS_A,
      cursor: page1.nextCursor!,
      limit: 1,
    });
    // The regression: the second row must not be skipped by the cursor.
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).toBe('reg_aud_1');

    // Millisecond precision survives the map; never a whole-second .000Z.
    expect(page1.items[0]!.createdAt).not.toBe('2026-08-14T12:00:00.000Z');
  });

  it('keeps rows tenant-isolated through the database store', async () => {
    const outsider = await databaseAuditStore.list({
      userId: USER_B,
      workspaceId: WS_B,
    });
    expect(outsider.items).toHaveLength(0);
  });

  it('redacts token-shaped content in persisted audit rows', async () => {
    // Callers persist payload fields as [REDACTED] markers; defense-in-depth
    // additionally scrubs any token-shaped substring that reaches `record`.
    await databaseAuditStore.record({
      workspaceId: WS_A,
      actorUserId: USER_A,
      actorMatrixId: '@reg_a:example.test',
      scope: 'issues:write',
      repository: 'acme/widget',
      operation: 'create_issue',
      argumentsHash: 'h2',
      approvalId: 'apr_1',
      commandId: 'gcmd_2',
      outcome: 'queued',
      details: { arguments: '[REDACTED]', notes: 'token ghp_regression_secret and syt_matrix_tok leaked?' },
    });
    const serialized = JSON.stringify(
      (await databaseAuditStore.list({ userId: USER_A, workspaceId: WS_A, limit: 50 })).items,
    );
    expect(serialized).not.toContain('ghp_regression_secret');
    expect(serialized).not.toContain('syt_matrix_tok');
    expect(serialized).toContain('[REDACTED]');
  });

  it('DB command store is idempotent by (workspace, idempotency key) through the tenant resolver', async () => {
    const owner = getAdminPool();
    const resolveTenant = async (commandId: string) => {
      const { rows } = await owner.query(
        'SELECT user_id, workspace_id FROM mutation_command_tenant($1)',
        [commandId],
      );
      return rows[0] ? { userId: rows[0].user_id, workspaceId: rows[0].workspace_id } : null;
    };
    const store = createDatabaseMutationCommandStore(resolveTenant);
    const args = { title: 'reg issue' };
    const input = {
      userId: USER_A,
      id: `gcmd_${randomUUID()}`,
      workspaceId: WS_A,
      runId: null,
      idempotencyKey: 'reg_idem_key',
      approvalId: null,
      repository: 'acme/widget',
      operation: 'create_issue' as const,
      argumentsHash: computeCommandHash('create_issue', args),
      arguments: args,
    };
    const first = await store.insertCommand(input);
    expect(first.replayed).toBe(false);
    const dup = await store.insertCommand(input);
    expect(dup.replayed).toBe(true);
    expect(dup.command.id).toBe(first.command.id);

    // Worker-path methods resolve the tenant via mutation_command_tenant and
    // persist the provider result before completion.
    const persisted = await store.persistProviderResult(first.command.id, { issueNumber: 42 });
    expect(persisted?.providerResult).toMatchObject({ issueNumber: 42 });
    const completed = await store.markCompleted(first.command.id, persisted!.providerResult!);
    expect(completed?.status).toBe('completed');
    expect(completed?.createdAt).toMatch(/\.\d{3}Z$/); // ms precision preserved
    await withTenant(USER_A, async (client) => {
      const { rows } = await client.query(
        'SELECT provider_result, status, arguments FROM github_mutation_commands WHERE id = $1',
        [first.command.id],
      );
      expect(rows[0].status).toBe('completed');
      expect(rows[0].provider_result).toEqual({ issueNumber: 42 });
    });
  });
});
