import { describe, it, expect } from 'vitest';
import { executeRun } from '../../src/workflows/run-workflow';
import { ProviderPermanentError } from '../../src/agents/provider';
import {
  makeServices,
  makeSpecialist,
  buildWorkflowOptions,
  newRunId,
} from './support';

describe('parallel run mode', () => {
  it('starts independent specialists concurrently and joins typed results', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    services.provider.startBarrier();
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b', { output: { summary: 'b-result' } });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a, b],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    expect(outcome.results.map((r) => r.specialistId).sort()).toEqual(['a', 'b']);
    // Typed outputs joined separately per specialist.
    expect(outcome.results.find((r) => r.specialistId === 'a')?.output).toEqual({
      summary: 'a-result',
    });
    expect(outcome.results.find((r) => r.specialistId === 'b')?.output).toEqual({
      summary: 'b-result',
    });
    expect(
      outcome.results.find((r) => r.specialistId === 'a')?.output,
    ).not.toBe(outcome.results.find((r) => r.specialistId === 'b')?.output);

    // Concurrency proof: each specialist started before the other finished.
    const callA = services.provider.callsFor('a')[0];
    const callB = services.provider.callsFor('b')[0];
    expect(services.provider.calls.length).toBe(2);
    expect(callA.finishedAt).toBeGreaterThan(callB.startedAt);
    expect(callB.finishedAt).toBeGreaterThan(callA.startedAt);
  });

  it('gives every specialist the same immutable initial input', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const seenInputs: unknown[] = [];
    const a = makeSpecialist('a', { recordInput: (i) => seenInputs.push(i) });
    const b = makeSpecialist('b', { recordInput: (i) => seenInputs.push(i) });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      prompt: 'identical input',
      specialists: [a, b],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    expect(seenInputs).toHaveLength(2);
    // Same object identity: a single frozen input shared by all specialists.
    expect(seenInputs[0]).toBe(seenInputs[1]);
    expect(Object.isFrozen(seenInputs[0])).toBe(true);
  });

  it('fails the run when a specialist fails and failurePolicy is fail_run', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b');
    services.provider.program(
      'b',
      () => new ProviderPermanentError('provider rejected request'),
    );
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a, b],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('failed');
    const failed = outcome.results.find((r) => r.specialistId === 'b');
    expect(failed?.status).toBe('failed');
    expect(failed?.errorCode).toBe('PROVIDER_PERMANENT');
    // A failed specialist never silently becomes a successful answer.
    const types = (await services.events.list()).map((e) => e.type);
    expect(types).toContain('run.failed');
    expect(types).toContain('specialist.failed');
    expect(types).not.toContain('run.completed');
    expect(types).not.toContain('run.partial');
  });

  it('joins successful results and reports partial when policy permits', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result' } });
    const b = makeSpecialist('b');
    services.provider.program(
      'b',
      () => new ProviderPermanentError('provider rejected request'),
    );
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'parallel',
      specialists: [a, b],
      failurePolicy: 'partial',
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('partial');
    expect(
      outcome.results.find((r) => r.specialistId === 'a')?.status,
    ).toBe('completed');
    expect(
      outcome.results.find((r) => r.specialistId === 'b')?.status,
    ).toBe('failed');
    const types = (await services.events.list()).map((e) => e.type);
    expect(types).toContain('run.partial');
    expect(types).not.toContain('run.completed');
  });
});
