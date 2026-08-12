import { describe, it, expect } from 'vitest';
import {
  executeRun,
  computeExecutionKey,
  computePromptHash,
} from '../../src/workflows/run-workflow';
import { ProviderTransientError, ProviderPermanentError } from '../../src/agents/provider';
import {
  SimulatedCrash,
  makeServices,
  makeSpecialist,
  buildWorkflowOptions,
  newRunId,
} from './support';

describe('retry, resume, cancellation, and timeouts', () => {
  it('retries a transient provider failure with bounded attempts and succeeds', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'eventually' } });
    let attempt = 0;
    services.provider.program('a', (req) => {
      attempt += 1;
      if (attempt < 3) {
        return new ProviderTransientError('upstream 503', { statusCode: 503 });
      }
      return JSON.stringify({ summary: 'eventually' });
    });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a],
      retry: { maxAttempts: 3, baseDelayMs: 4, maxDelayMs: 16, jitter: false },
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    expect(outcome.results[0].attempts).toBe(3);
    const retries = (await services.events.list())
      .filter((e) => e.type === 'run.retry_scheduled');
    expect(retries).toHaveLength(2);
    // Exponential backoff was persisted in the retry events before sleeping.
    expect(services.sleeps).toEqual([4, 8]);
    expect(retries.map((e) => e.payload.delayMs)).toEqual([4, 8]);
  });

  it('bounds retries: an always-failing provider gives up after maxAttempts', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a');
    services.provider.program(
      'a',
      () => new ProviderTransientError('upstream 503', { statusCode: 503 }),
    );
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a],
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, jitter: false },
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('failed');
    expect(outcome.results[0].status).toBe('failed');
    expect(outcome.results[0].errorCode).toBe('PROVIDER_UNAVAILABLE');
    expect(outcome.results[0].attempts).toBe(3);
    expect(services.provider.callsFor('a')).toHaveLength(3);
    expect((await services.events.list()).filter((e) => e.type === 'run.retry_scheduled')).toHaveLength(2);
  });

  it('never retries a permanent provider failure', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a');
    services.provider.program(
      'a',
      () => new ProviderPermanentError('permanent failure'),
    );
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a],
      services,
    });

    const outcome = await executeRun(options);
    expect(outcome.status).toBe('failed');
    expect(services.provider.callsFor('a')).toHaveLength(1);
    expect((await services.events.list()).filter((e) => e.type === 'run.retry_scheduled')).toHaveLength(0);
  });

  it('resumes from the last checkpoint after a crash without duplicating output', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b', { output: { summary: 'b-result' } });
    services.provider.program('b', () => new SimulatedCrash('crash before b persisted'));
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b],
      services,
    });

    // First execution: a completes and checkpoints, then the process crashes.
    await expect(executeRun(options)).rejects.toThrow(SimulatedCrash);
    expect(services.provider.callsFor('a')).toHaveLength(1);
    expect(services.provider.callsFor('b')).toHaveLength(1);

    // Second execution (Inngest retry): resume after the last checkpoint.
    services.provider.program('b', () => JSON.stringify({ summary: 'b-result' }));
    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    expect(outcome.results.map((r) => r.specialistId).sort()).toEqual(['a', 'b']);
    // Completed specialists are not rerun: one provider call for a across both executions.
    expect(services.provider.callsFor('a')).toHaveLength(1);
    // One completed output per specialist, no duplicates after resume.
    const completed = (await services.events.list())
      .filter((e) => e.type === 'specialist.completed');
    expect(completed.map((e) => e.payload.specialistId)).toEqual(['a', 'b']);
    expect(completed).toHaveLength(2);
    expect(services.runStore.results.size).toBe(2);
  });

  it('emits exactly one terminal cancellation event for a run cancelled before start', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a');
    services.cancellation.cancel(runId);
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('cancelled');
    expect(services.provider.calls).toHaveLength(0);
    const cancelled = (await services.events.list()).filter((e) => e.type === 'run.cancelled');
    expect(cancelled).toHaveLength(1);
    expect((await services.events.list()).filter((e) => e.type === 'run.completed')).toHaveLength(0);
  });

  it('cooperatively cancels a running workflow and aborts the provider', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b');
    services.provider.program('a', () => {
      // Cancel while the workflow is running, before b starts.
      services.cancellation.cancel(runId);
      return JSON.stringify({ summary: 'a-result' });
    });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('cancelled');
    // b never started: cancellation is checked between steps.
    expect(services.provider.callsFor('b')).toHaveLength(0);
    expect(services.provider.aborted).toContain(runId);
    const cancelled = (await services.events.list()).filter((e) => e.type === 'run.cancelled');
    expect(cancelled).toHaveLength(1);
    expect((await services.events.list()).filter((e) => e.type === 'run.completed')).toHaveLength(0);
  });

  it('enforces the absolute run deadline with a failed terminal state', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b');
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b],
      runTimeoutMs: 1000,
      services,
    });

    // The deadline passes after the first specialist completes.
    services.provider.program('a', () => {
      services.clock.advance(2000);
      return JSON.stringify({ summary: 'a-result' });
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('failed');
    expect(services.provider.callsFor('b')).toHaveLength(0);
    const failed = (await services.events.list()).find((e) => e.type === 'run.failed');
    expect(failed?.payload.code).toBe('RUN_TIMEOUT');
  });

  it('derives a deterministic execution key and rejects a mismatched resume', async () => {
    const runId = newRunId();
    const prompt = 'summarize issues';
    const promptHash = computePromptHash(prompt);
    const snapshot = {
      mode: 'parallel',
      specialists: [{ id: 'a', model: 'm', timeoutMs: 1000 }],
    };
    const sameKeyDifferentOrder = computeExecutionKey(runId, promptHash, {
      specialists: snapshot.specialists,
      mode: snapshot.mode,
    });
    expect(computeExecutionKey(runId, promptHash, snapshot)).toBe(sameKeyDifferentOrder);
    expect(
      computeExecutionKey(runId, promptHash, { ...snapshot, mode: 'sequential' }),
    ).not.toBe(sameKeyDifferentOrder);

    // Resume with a different execution key must fail without rerunning work.
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a],
      prompt,
      services,
    });
    services.provider.program('a', () => new SimulatedCrash('crash before a persisted'));
    await expect(executeRun(options)).rejects.toThrow(SimulatedCrash);

    const tampered = { ...options, executionKey: 'tampered-key' };
    const outcome = await executeRun(tampered);
    expect(outcome.status).toBe('failed');
    const failed = (await services.events.list()).find((e) => e.type === 'run.failed');
    expect(failed?.payload.code).toBe('EXECUTION_KEY_MISMATCH');
  });
});
