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
  grantStore: InMemoryWriteGrantStore;
  advanceClock(ms: number): void;
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
  return { deps, worker, commandStore, approvalId: approval.id, grantStore, advanceClock(ms: number) { clock.now += ms; } };
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

/**
 * Wraps a store so concurrent readers of the same command all observe the
 * pre-race state before any of them finalizes it, and both finalizers then
 * race — the interleaving a real database shows under two concurrent
 * same-key replays. Gates are one-shot: later calls (e.g. the losing
 * finalizer re-fetching the winner's state) pass through immediately.
 */
function concurrentBarrierStore(store: MutationCommandStore): MutationCommandStore {
  const released = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  function gate(method: string, n: number): Promise<void> {
    if (released.has(method)) return Promise.resolve();
    return new Promise((resolve) => {
      const queue = queues.get(method) ?? [];
      queue.push(resolve);
      queues.set(method, queue);
      if (queue.length >= n) {
        released.add(method);
        queues.delete(method);
        for (const release of queue) release();
      }
    });
  }
  return new Proxy(store, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'getCommand') {
        return async (commandId: string) => {
          await gate('getCommand', 2);
          return Reflect.apply(value, target, [commandId]);
        };
      }
      if (prop === 'markCompleted') {
        return async (commandId: string, providerResult: Record<string, unknown>) => {
          await gate('markCompleted', 2);
          return Reflect.apply(value, target, [commandId, providerResult]);
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

  it('returns the existing command for a retry after the approval TTL or grant revocation', async () => {
    const { deps, approvalId, grantStore, advanceClock } = await setup(fixture);
    const input = commandInput({ approvalId, idempotencyKey: 'expiry_retry_key' });
    const first = await enqueueMutationCommand(input, deps);
    expect(first.command.status).toBe('completed');
    expect(fixture.state().mutationRequests).toHaveLength(1);

    // The approval TTL passes: a retry with the same key still returns the
    // existing command/result instead of failing with APPROVAL_EXPIRED.
    advanceClock(APPROVAL_DEFAULT_TTL_MS + 1);
    const retried = await enqueueMutationCommand(input, deps);
    expect(retried.replayed).toBe(true);
    expect(retried.command.id).toBe(first.command.id);
    expect(retried.command.status).toBe('completed');
    expect(fixture.state().mutationRequests).toHaveLength(1);

    // A revoked grant does not block the replay either.
    const grant = (await grantStore.findGrant({
      workspaceId: 'workspace-a',
      repository: 'acme/widget',
      scope: 'issues:write',
    }))!;
    await grantStore.setGrantStatus({
      id: grant.id,
      workspaceId: 'workspace-a',
      status: 'revoked',
      now: deps.now,
    });
    const afterRevoke = await enqueueMutationCommand(input, deps);
    expect(afterRevoke.replayed).toBe(true);
    expect(afterRevoke.command.id).toBe(first.command.id);
    expect(fixture.state().mutationRequests).toHaveLength(1);

    // Replays never record denial audits or duplicate audit rows.
    const audits = (await deps.auditStore.list({ workspaceId: 'workspace-a' })).items;
    expect(audits.filter((a) => a.outcome === 'denied')).toHaveLength(0);
    expect(
      audits.filter((a) => a.commandId === first.command.id && a.outcome === 'completed'),
    ).toHaveLength(1);
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

  it('finalizes a crashed command exactly once under concurrent duplicate replays', async () => {
    fixture.reset();
    const { deps, commandStore, approvalId } = await setup(fixture, { worker: false });
    const input = commandInput({ approvalId, idempotencyKey: 'concurrent_recovery_key' });

    // Crash after the provider result is persisted (markCompleted throws once),
    // leaving the command queued with a stored provider result.
    const crashing = failOnce<MutationCommandStore>(commandStore, 'markCompleted');
    const crashingWorker = createMutationWorker({
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
    const { command } = await enqueueMutationCommand(input, { ...deps, worker: null });
    await expect(crashingWorker.process(command.id)).rejects.toThrow(/simulated crash/);
    const afterCrash = await deps.commandStore.getCommand(command.id);
    expect(afterCrash?.status).toBe('queued');
    expect(afterCrash?.providerResult).toMatchObject({ issueNumber: 42 });
    expect(fixture.state().mutationRequests).toHaveLength(1);

    // Two concurrent duplicate replays both read the queued-with-result state
    // before either finalizes it, then race to complete the command.
    const healthyWorker = createMutationWorker({
      commandStore: concurrentBarrierStore(deps.commandStore),
      grantStore: deps.grantStore,
      approvalService: deps.approvalService,
      auditStore: deps.auditStore,
      client: createGithubMutationClient({
        baseUrl: fixture.baseUrl,
        token: 'ghs_fixture_write_token',
      }),
      now: deps.now,
    });
    const recoverDeps: EnqueueMutationDeps = { ...deps, worker: healthyWorker };
    const [first, second] = await Promise.all([
      enqueueMutationCommand(input, recoverDeps),
      enqueueMutationCommand(input, recoverDeps),
    ]);

    expect(first.replayed).toBe(true);
    expect(second.replayed).toBe(true);
    expect(first.command.id).toBe(command.id);
    expect(second.command.id).toBe(command.id);
    expect(first.command.status).toBe('completed');
    expect(second.command.status).toBe('completed');

    const final = await deps.commandStore.getCommand(command.id);
    expect(final?.status).toBe('completed');
    expect(final?.attempts).toBe(1);

    // Exactly one provider mutation and exactly one completion audit row.
    expect(fixture.state().mutationRequests).toHaveLength(1);
    const audits = (await deps.auditStore.list({ workspaceId: 'workspace-a' })).items;
    const completedAudits = audits.filter(
      (row) => row.commandId === command.id && row.outcome === 'completed',
    );
    expect(completedAudits).toHaveLength(1);
  });
});
