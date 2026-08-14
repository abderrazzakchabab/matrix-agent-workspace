import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPROVAL_DEFAULT_TTL_MS,
  InMemoryApprovalStore,
  createApprovalService,
} from '../../src/github/approval-service';
import { InMemoryWriteGrantStore } from '../../src/github/write-authorization';
import {
  InMemoryAuditStore,
  InMemoryMutationCommandStore,
  computeCommandHash,
  createGithubMutationClient,
  enqueueMutationCommand,
  type AuditRecord,
  type AuditStore,
  type EnqueueMutationDeps,
  type EnqueueMutationInput,
} from '../../src/github/mutation-command';
import { createMutationWorker } from '../../src/github/mutation-worker';
import { startGithubFixture, type GithubFixture } from './support';

const DEFAULT_ARGS = { title: 'Fix the widget', body: 'See details' };

function commandInput(overrides: Partial<EnqueueMutationInput> = {}): EnqueueMutationInput {
  return {
    userId: 'user-a',
    workspaceId: 'workspace-a',
    runId: 'run-1',
    idempotencyKey: 'cmd_key_1',
    approvalId: 'apr_1',
    repository: 'acme/widget',
    operation: 'create_issue',
    arguments: DEFAULT_ARGS,
    ...overrides,
  };
}

async function setup(
  fixture: GithubFixture,
  options: { approvalArguments?: Record<string, unknown> } = {},
): Promise<{
  deps: EnqueueMutationDeps;
  auditStore: AuditStore;
  approvalId: string;
  actorMatrixId: string;
}> {
  const approvalArguments = options.approvalArguments ?? DEFAULT_ARGS;
  const clock = { now: Date.parse('2026-08-12T12:00:00Z') };
  const grantStore = new InMemoryWriteGrantStore();
  const grant = await grantStore.createGrant({
    id: 'grant-1',
    workspaceId: 'workspace-a',
    grantedBy: 'user-a',
    repository: 'acme/widget',
    scope: 'issues:write',
  });
  await grantStore.setGrantStatus({ id: grant.id, workspaceId: 'workspace-a', status: 'approved' });

  const approvalStore = new InMemoryApprovalStore();
  const approvalService = createApprovalService({ store: approvalStore, now: () => clock.now });
  const approval = await approvalStore.createApproval({
    id: 'apr_1',
    workspaceId: 'workspace-a',
    runId: 'run-1',
    userId: 'user-a',
    scope: 'issues:write',
    commandHash: computeCommandHash('create_issue', approvalArguments),
    decision: 'approved',
    confirmationText: 'Create the reported issue',
    expiresAt: new Date(clock.now + APPROVAL_DEFAULT_TTL_MS).toISOString(),
  });

  const commandStore = new InMemoryMutationCommandStore();
  const auditStore = new InMemoryAuditStore();
  const worker = createMutationWorker({
    commandStore,
    grantStore,
    approvalService,
    auditStore,
    client: createGithubMutationClient({
      baseUrl: fixture.baseUrl,
      token: 'ghs_fixture_write_token',
    }),
    now: () => clock.now,
  });
  const deps: EnqueueMutationDeps = {
    grantStore,
    approvalService,
    commandStore,
    auditStore,
    worker,
    now: () => clock.now,
  };
  return { deps, auditStore, approvalId: approval.id, actorMatrixId: '@alice:example.test' };
}

let fixture: GithubFixture;

beforeAll(async () => {
  fixture = await startGithubFixture();
});

afterAll(async () => {
  await fixture.close();
});

describe('GitHub mutation audit records', () => {
  it('records actor, scope, repository, operation, arguments hash, approval id, outcome, timestamps, and redacted details', async () => {
    const argumentsWithSecret = {
      title: 'Fix the widget',
      body: 'contains ghp_super_secret_token and syt_matrix_secret',
    };
    const { deps, auditStore, approvalId, actorMatrixId } = await setup(fixture, {
      approvalArguments: argumentsWithSecret,
    });
    const { command } = await enqueueMutationCommand(
      commandInput({ arguments: argumentsWithSecret, actorMatrixId }),
      deps,
    );
    expect(command.status).toBe('completed');

    const records = (await auditStore.list({ workspaceId: 'workspace-a' })).items;
    const completed = records.find((r) => r.outcome === 'completed' && r.commandId === command.id);
    const queued = records.find((r) => r.outcome === 'queued' && r.commandId === command.id);

    expect(completed).toMatchObject({
      actorUserId: 'user-a',
      scope: 'issues:write',
      repository: 'acme/widget',
      operation: 'create_issue',
      argumentsHash: command.argumentsHash,
      approvalId,
      commandId: command.id,
      outcome: 'completed',
    });
    // The session-facing enqueue record carries the Matrix actor identity.
    expect(queued).toMatchObject({
      actorUserId: 'user-a',
      actorMatrixId: '@alice:example.test',
      commandId: command.id,
      outcome: 'queued',
    });
    expect(completed?.createdAt).toBeTruthy();
    expect(new Date(completed!.createdAt).getTime()).not.toBeNaN();

    // Redacted details: the payload is never stored, only its redaction marker.
    expect(queued?.details).toMatchObject({ arguments: '[REDACTED]' });
    expect(completed?.details).toMatchObject({ arguments: '[REDACTED]' });

    // Secrets and private content never appear anywhere in the audit trail.
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('ghp_super_secret_token');
    expect(serialized).not.toContain('syt_matrix_secret');
    expect(serialized).not.toContain('contains');
    expect(serialized).not.toContain('Create the reported issue');
    expect(serialized).not.toContain('confirmationText');
  });

  it('a second workspace cannot read the audit records', async () => {
    const { deps, auditStore, approvalId } = await setup(fixture);
    await enqueueMutationCommand(commandInput({ approvalId, idempotencyKey: 'audit_key_2' }), deps);
    expect((await auditStore.list({ workspaceId: 'workspace-a' })).items.length).toBeGreaterThan(0);

    // Workspace B sees zero rows from workspace A (RLS/tenant isolation).
    const outsider = await auditStore.list({ workspaceId: 'workspace-b' });
    expect(outsider.items).toHaveLength(0);
    expect(outsider.nextCursor).toBeUndefined();
  });

  it('audit rows are append-only and immutable', async () => {
    const { deps, auditStore, approvalId } = await setup(fixture);
    await enqueueMutationCommand(commandInput({ approvalId, idempotencyKey: 'audit_key_3' }), deps);
    const first = await auditStore.list({ workspaceId: 'workspace-a' });
    const before = first.items.length;

    await enqueueMutationCommand(commandInput({ approvalId, idempotencyKey: 'audit_key_4' }), deps);
    const second = await auditStore.list({ workspaceId: 'workspace-a' });
    expect(second.items.length).toBeGreaterThan(before);
    // Earlier rows are byte-identical: nothing is ever rewritten.
    const byId = new Map(second.items.map((r) => [r.id, r]));
    for (const record of first.items) {
      expect(byId.get(record.id)).toEqual(record);
    }
  });

  it('records denials without persisting the attempted payload', async () => {
    const { deps, auditStore, approvalId } = await setup(fixture);
    const before = (await auditStore.list({ workspaceId: 'workspace-a' })).items.length;

    await expect(
      enqueueMutationCommand(
        commandInput({ approvalId, arguments: { title: 'Changed title', body: 'ghp_denied_secret' } }),
        deps,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_MISMATCH' });

    const after = (await auditStore.list({ workspaceId: 'workspace-a' })).items;
    expect(after.length).toBe(before + 1);
    const denial = after[after.length - 1]!;
    expect(denial).toMatchObject({
      outcome: 'denied',
      details: { errorCode: 'APPROVAL_MISMATCH' },
    });
    expect(denial.argumentsHash).toBeTruthy();
    expect(JSON.stringify(denial)).not.toContain('ghp_denied_secret');
    expect(JSON.stringify(denial)).not.toContain('Changed title');
  });

  it('lists records newest-first with a keyset cursor', async () => {
    const { deps, auditStore, approvalId } = await setup(fixture);
    for (const key of ['audit_cursor_1', 'audit_cursor_2', 'audit_cursor_3', 'audit_cursor_4']) {
      await enqueueMutationCommand(commandInput({ approvalId, idempotencyKey: key }), deps);
    }
    const all = (await auditStore.list({ workspaceId: 'workspace-a' })).items;
    const page = await auditStore.list({ workspaceId: 'workspace-a', limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTruthy();
    const page2 = await auditStore.list({
      workspaceId: 'workspace-a',
      cursor: page.nextCursor,
      limit: 2,
    });
    expect(page2.items).toHaveLength(2);
    // No overlap between pages; ids are unique and newest-first.
    const ids = new Set([...page.items, ...page2.items].map((r) => r.id));
    expect(ids.size).toBe(4);
    expect(all[0]!.createdAt >= all[all.length - 1]!.createdAt).toBe(true);
  });

  it('audit records expose no approval payload or provider token', async () => {
    const { deps, auditStore, approvalId } = await setup(fixture);
    const token = 'ghs_fixture_write_token';
    await enqueueMutationCommand(commandInput({ approvalId, idempotencyKey: 'audit_key_5' }), deps);
    const serialized = JSON.stringify((await auditStore.list({ workspaceId: 'workspace-a' })).items);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('authorization');
    // Redaction marker is present for payload fields.
    expect(serialized).toContain('[REDACTED]');
  });
});
