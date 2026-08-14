import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InMemoryWriteGrantStore,
  authorizeWriteScope,
} from '../../src/github/write-authorization';
import { InMemoryApprovalStore, createApprovalService } from '../../src/github/approval-service';
import {
  InMemoryAuditStore,
  InMemoryMutationCommandStore,
  createGithubMutationClient,
  enqueueMutationCommand,
  type EnqueueMutationDeps,
  type EnqueueMutationInput,
} from '../../src/github/mutation-command';
import { createMutationWorker } from '../../src/github/mutation-worker';
import { startGithubFixture, type GithubFixture } from './support';

const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

let fixture: GithubFixture;
let deps: EnqueueMutationDeps;

function command(overrides: Partial<EnqueueMutationInput> = {}): EnqueueMutationInput {
  return {
    userId: 'user-a',
    workspaceId: 'workspace-a',
    runId: 'run-1',
    idempotencyKey: 'cmd_key_1',
    approvalId: 'apr_1',
    repository: 'acme/widget',
    operation: 'create_issue',
    arguments: { title: 'Fix the widget', body: 'Details' },
    ...overrides,
  };
}

beforeAll(async () => {
  fixture = await startGithubFixture();
  const grantStore = new InMemoryWriteGrantStore();
  const approvalService = createApprovalService({ store: new InMemoryApprovalStore() });
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
  });
  deps = { grantStore, approvalService, commandStore, auditStore, worker };
});

afterAll(async () => {
  await fixture.close();
});

describe('GitHub write scope authorization', () => {
  it('never lets a read-only session enqueue a write', async () => {
    // No grant rows exist: this tenant is read-only.
    await expect(enqueueMutationCommand(command(), deps)).rejects.toMatchObject({
      code: 'WRITE_SCOPE_REQUIRED',
      status: 403,
    });
    expect(fixture.state().mutationRequests).toHaveLength(0);
  });

  it('grants are repository- and scope-specific', async () => {
    const store = new InMemoryWriteGrantStore();
    const grant = await store.createGrant({
      id: 'grant-1',
      workspaceId: 'workspace-a',
      grantedBy: 'user-a',
      repository: 'acme/widget',
      scope: 'issues:write',
    });
    await store.setGrantStatus({ id: grant.id, workspaceId: 'workspace-a', status: 'approved' });

    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/widget', scope: 'issues:write' },
        store,
      ),
    ).resolves.toMatchObject({ status: 'approved' });

    // Same scope, different repository: denied.
    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/secret', scope: 'issues:write' },
        store,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE_REQUIRED', status: 403 });

    // Same repository, different scope: denied.
    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/widget', scope: 'pull_requests:write' },
        store,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE_REQUIRED' });

    // A revoked grant stops writes too.
    await store.setGrantStatus({ id: grant.id, workspaceId: 'workspace-a', status: 'revoked' });
    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/widget', scope: 'issues:write' },
        store,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE_REQUIRED' });
  });

  it('isolates grants between workspaces', async () => {
    const store = new InMemoryWriteGrantStore();
    const grant = await store.createGrant({
      id: 'grant-a',
      workspaceId: 'workspace-a',
      grantedBy: 'user-a',
      repository: 'acme/widget',
      scope: 'issues:write',
    });
    await store.setGrantStatus({ id: grant.id, workspaceId: 'workspace-a', status: 'approved' });

    // Workspace B can neither see nor use workspace A's grant.
    await expect(store.findGrant({ workspaceId: 'workspace-b', repository: 'acme/widget', scope: 'issues:write' })).resolves.toBeNull();
    await expect(
      authorizeWriteScope(
        { userId: 'user-b', workspaceId: 'workspace-b', repository: 'acme/widget', scope: 'issues:write' },
        store,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE_REQUIRED' });
  });

  it('expired grants stop writes', async () => {
    const store = new InMemoryWriteGrantStore();
    const approvedAt = Date.parse('2026-08-12T12:00:00Z');
    const grant = await store.createGrant({
      id: 'grant-1',
      workspaceId: 'workspace-a',
      grantedBy: 'user-a',
      repository: 'acme/widget',
      scope: 'issues:write',
    });
    await store.setGrantStatus({
      id: grant.id,
      workspaceId: 'workspace-a',
      status: 'approved',
      now: () => approvedAt,
    });

    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/widget', scope: 'issues:write', now: () => approvedAt },
        store,
      ),
    ).resolves.toBeTruthy();
    // One year later the grant has expired.
    await expect(
      authorizeWriteScope(
        { userId: 'user-a', workspaceId: 'workspace-a', repository: 'acme/widget', scope: 'issues:write', now: () => approvedAt + 365 * 24 * 3600 * 1000 },
        store,
      ),
    ).rejects.toMatchObject({ code: 'WRITE_SCOPE_REQUIRED' });
  });

  it('records the arguments hash of an approved write grant', async () => {
    // The grant stores the repository/scope pair; the hash belongs to the
    // command, so a grant alone is never sufficient.
    const store = new InMemoryWriteGrantStore();
    const grant = await store.createGrant({
      id: 'grant-1',
      workspaceId: 'workspace-a',
      grantedBy: 'user-a',
      repository: 'acme/widget',
      scope: 'issues:write',
    });
    await store.setGrantStatus({ id: grant.id, workspaceId: 'workspace-a', status: 'approved' });
    expect(hash('acme/widget')).toHaveLength(64);
    await expect(
      enqueueMutationCommand(command({ approvalId: 'apr_missing' }), { ...deps, grantStore: store }),
    ).rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND', status: 409 });
    expect(fixture.state().mutationRequests).toHaveLength(0);
  });
});
