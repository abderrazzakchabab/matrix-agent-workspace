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
  type EnqueueMutationDeps,
  type EnqueueMutationInput,
  type MutationCommandStore,
} from '../../src/github/mutation-command';
import { createMutationWorker, type MutationWorker } from '../../src/github/mutation-worker';
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

interface SetupResult {
  deps: EnqueueMutationDeps;
  worker: MutationWorker;
  commandStore: MutationCommandStore;
  approvalId: string;
}

async function setup(fixture: GithubFixture, options: { worker?: boolean } = {}): Promise<SetupResult> {
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
    commandHash: computeCommandHash('create_issue', DEFAULT_ARGS),
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
    worker: options.worker === false ? null : worker,
    now: () => clock.now,
  };
  return { deps, worker, commandStore, approvalId: approval.id };
}

/** Wraps a store so the wrapped method fails exactly once (crash simulation). */
function failOnce<T extends object>(store: T, method: keyof T): T {
  let armed = true;
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === method && armed) {
        armed = false;
        return async (...args: unknown[]) => {
          throw new Error(`simulated crash in ${String(method)}`);
        };
      }
      return value;
    },
  });
}

let fixture: GithubFixture;

beforeAll(async () => {
  fixture = await startGithubFixture();
});

afterAll(async () => {
  await fixture.close();
});

describe('GitHub mutation command idempotency', () => {
  it('returns the existing command for a duplicate idempotency key and mutates once', async () => {
    const { deps } = await setup(fixture);
    const [first, second] = await Promise.all([
      enqueueMutationCommand(commandInput({ idempotencyKey: 'dup_key' }), deps),
      enqueueMutationCommand(commandInput({ idempotencyKey: 'dup_key' }), deps),
    ]);

    expect(second.command.id).toBe(first.command.id);
    expect(second.replayed).toBe(true);
    expect(first.replayed).toBe(false);
    expect(first.command.status).toBe('completed');
    expect(second.command.argumentsHash).toBe(first.command.argumentsHash);
    expect(fixture.state().mutationRequests).toHaveLength(1);
  });

  it('returns the persisted result for a retried completed command (worker retries never duplicate)', async () => {
    fixture.reset();
    const { deps, worker, approvalId } = await setup(fixture);
    const { command } = await enqueueMutationCommand(commandInput({ approvalId }), deps);
    expect(fixture.state().mutationRequests).toHaveLength(1);

    const retried = await worker.process(command.id);
    expect(retried?.status).toBe('completed');
    expect(retried?.providerResult).toMatchObject({ issueNumber: 42 });
    expect(fixture.state().mutationRequests).toHaveLength(1);
  });

  it('recovers from a crash after the provider result is persisted without a second mutation', async () => {
    fixture.reset();
    const { deps, commandStore, approvalId } = await setup(fixture, { worker: false });

    // The worker crashes between persisting the provider result and marking
    // the command complete (markCompleted throws once).
    const crashing = failOnce<MutationCommandStore>(commandStore, 'markCompleted');
    const worker = createMutationWorker({
      commandStore: crashing,
      grantStore: deps.grantStore,
      approvalService: deps.approvalService,
      auditStore: deps.auditStore,
      client: createGithubMutationClient({
        baseUrl: fixture.baseUrl,
        token: 'ghs_fixture_write_token',
      }),
      now: deps.now,
    });

    const { command } = await enqueueMutationCommand(commandInput({ approvalId }), { ...deps, worker: null });
    expect(command.status).toBe('queued');
    expect(fixture.state().mutationRequests).toHaveLength(0);

    // First worker run: the provider responds, the result is persisted, and
    // the process crashes before the command is marked complete.
    await expect(worker.process(command.id)).rejects.toThrow(/simulated crash/);
    expect(fixture.state().mutationRequests).toHaveLength(1);
    const afterCrash = await deps.commandStore.getCommand(command.id);
    expect(afterCrash?.status).toBe('queued');
    expect(afterCrash?.providerResult).toMatchObject({ issueNumber: 42 });

    // The worker retry reuses the persisted provider result instead of
    // calling GitHub again: exactly one provider mutation in total.
    const recovered = await worker.process(command.id);
    expect(recovered?.status).toBe('completed');
    expect(recovered?.providerResult).toMatchObject({ issueNumber: 42 });
    expect(fixture.state().mutationRequests).toHaveLength(1);
  });

  it('persists the provider result before marking the command complete', async () => {
    const { deps, commandStore, approvalId } = await setup(fixture, { worker: false });
    const calls: string[] = [];
    const spied = new Proxy<MutationCommandStore>(commandStore, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'persistProviderResult' || prop === 'markCompleted') {
          return async (...args: unknown[]) => {
            calls.push(String(prop));
            return Reflect.apply(value, target, args);
          };
        }
        return value;
      },
    });
    const worker = createMutationWorker({
      commandStore: spied,
      grantStore: deps.grantStore,
      approvalService: deps.approvalService,
      auditStore: deps.auditStore,
      client: createGithubMutationClient({
        baseUrl: fixture.baseUrl,
        token: 'ghs_fixture_write_token',
      }),
      now: deps.now,
    });
    await enqueueMutationCommand(commandInput({ approvalId }), { ...deps, commandStore: spied, worker });
    expect(calls).toEqual(['persistProviderResult', 'markCompleted']);
  });

  it('rejects unsupported operations and invalid arguments without calling GitHub', async () => {
    const { deps, approvalId } = await setup(fixture);
    const cases: Array<Partial<EnqueueMutationInput>> = [
      { operation: 'delete_repo', arguments: { name: 'acme/widget' } },
      { operation: 'create_issue', arguments: {} },
      { operation: 'update_issue', arguments: { issueNumber: -1, title: 'x' } },
      { operation: 'comment_issue', arguments: { issueNumber: 7, body: '' } },
    ];
    for (const overrides of cases) {
      fixture.reset();
      await expect(
        enqueueMutationCommand(commandInput({ approvalId, ...overrides }), deps),
      ).rejects.toMatchObject({ code: 'COMMAND_NOT_ALLOWED', status: 422 });
      expect(fixture.state().mutationRequests).toHaveLength(0);
    }
  });

  it('records one audit trail for duplicate enqueue and retry', async () => {
    const { deps, approvalId } = await setup(fixture);
    const { command } = await enqueueMutationCommand(
      commandInput({ approvalId, idempotencyKey: 'audit_key' }),
      deps,
    );
    const before = (await deps.auditStore.list({ workspaceId: 'workspace-a' })).items.length;

    // Duplicate enqueue: no new command, no new audit rows.
    const replayed = await enqueueMutationCommand(
      commandInput({ approvalId, idempotencyKey: 'audit_key' }),
      deps,
    );
    expect(replayed.command.id).toBe(command.id);
    expect((await deps.auditStore.list({ workspaceId: 'workspace-a' })).items).toHaveLength(before);

    // Worker retry: still no new audit rows.
    await deps.worker?.process(command.id);
    expect((await deps.auditStore.list({ workspaceId: 'workspace-a' })).items).toHaveLength(before);
  });
});
