/**
 * Durable execution of `agent.run.requested`.
 *
 * The event payload carries the immutable run input; the function loads the
 * persisted run and config snapshot, verifies the deterministic execution
 * key, and runs `executeRun` inside a single durable step. Function-level
 * retries cover process crashes only: transient provider failures are
 * retried (bounded) inside the workflow itself, and `executeRun` resumes
 * from the last committed checkpoint, so a retry never reruns completed
 * specialists or duplicates completed outputs.
 */
import { inngest, type RunRequestedEventData } from '../client';
import { getRun } from '../../db/repositories/run-repository';
import {
  executeRun,
  computeExecutionKey,
  createPostgresWorkflowRunStore,
  createPostgresWorkflowEventSink,
  resolveScheduledSpecialists,
  DEFAULT_RETRY_POLICY,
  DEFAULT_RUN_TIMEOUT_MS,
  type WorkflowServices,
  type RetryPolicy,
} from '../../workflows/run-workflow';
import { createPostgresCheckpointStore } from '../../workflows/checkpoint-service';
import { createPostgresCancellationController } from '../../workflows/cancellation';
import { getSpecialistProvider } from '../../agents/provider';
import type { PromptInjectionMode } from '../../agents/prompt-envelope';

export const runRequested = inngest.createFunction(
  {
    id: 'agent-run-requested',
    // Crash retries only; transient provider failures retry inside executeRun.
    retries: 3,
    timeouts: { finish: '30m' },
    triggers: [{ event: 'agent.run.requested' }],
  },
  async ({ event, step }) => {
    const data = event.data as RunRequestedEventData;
    return step.run('execute-durable-run', async () => {
      const tenant = { userId: data.userId, workspaceId: data.workspaceId };
      const run = await getRun(tenant, data.runId);
      if (!run) {
        throw new Error(
          `run ${data.runId} not visible in workspace ${data.workspaceId}`,
        );
      }
      const runStore = createPostgresWorkflowRunStore(tenant);
      const events = createPostgresWorkflowEventSink(tenant, data.runId);

      // The dispatched execution key must match the persisted prompt hash and
      // config snapshot; a mismatch fails the run without executing anything.
      const expectedKey = computeExecutionKey(run.id, run.promptHash, run.configSnapshot);
      if (expectedKey !== data.executionKey) {
        await runStore.finalize(
          run.id,
          'failed',
          { code: 'EXECUTION_KEY_MISMATCH' },
          { type: 'run.failed', payload: { code: 'EXECUTION_KEY_MISMATCH', untrusted: false } },
        );
        return { status: 'failed', code: 'EXECUTION_KEY_MISMATCH' };
      }

      const snapshot = run.configSnapshot;
      const services: WorkflowServices = {
        provider: getSpecialistProvider(),
        checkpoints: createPostgresCheckpointStore(tenant),
        runStore,
        events,
        cancellation: createPostgresCancellationController(tenant),
        now: () => Date.now(),
        sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      };

      const outcome = await executeRun({
        runId: run.id,
        executionKey: data.executionKey,
        mode: run.mode,
        prompt: data.prompt,
        promptHash: run.promptHash,
        untrusted: data.untrusted ?? [],
        promptInjectionMode:
          (snapshot.promptInjectionMode as PromptInjectionMode | undefined) ?? 'fail_run',
        specialists: resolveScheduledSpecialists(snapshot),
        failurePolicy:
          snapshot.failurePolicy === 'partial' ? 'partial' : 'fail_run',
        runTimeoutMs:
          (snapshot.runTimeoutMs as number | undefined) ?? DEFAULT_RUN_TIMEOUT_MS,
        retry: (snapshot.retry as RetryPolicy | undefined) ?? DEFAULT_RETRY_POLICY,
        githubContext: snapshot.githubContext as { repository?: string } | undefined,
        services,
      });
      return { status: outcome.status, specialistResults: outcome.results.length };
    });
  },
);
