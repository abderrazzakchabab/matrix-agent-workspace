import { describe, it, expect } from 'vitest';
import { executeRun } from '../../src/workflows/run-workflow';
import { ProviderPermanentError } from '../../src/agents/provider';
import { makeServices, makeSpecialist, buildWorkflowOptions, newRunId } from './support';

describe('sequential run mode', () => {
  it('executes specialists in declared order with typed prior results', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { summary: 'a-result', count: 1 } });
    const b = makeSpecialist('b', { output: { summary: 'b-result', count: 2 } });
    const bInputs: unknown[] = [];
    const bRecorder = makeSpecialist('b', {
      output: { summary: 'b-result', count: 2 },
      recordInput: (i) => bInputs.push(i),
    });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, bRecorder],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    // Declared order preserved: a ran before b.
    expect(services.provider.calls.map((c) => c.specialistId)).toEqual(['a', 'b']);
    // Specialist N receives only the prior specialist's typed output, in order.
    expect(bInputs).toHaveLength(1);
    const priorResults = (bInputs[0] as { priorResults?: unknown[] }).priorResults;
    expect(priorResults).toEqual([
      { specialistId: 'a', status: 'completed', output: { summary: 'a-result', count: 1 } },
    ]);
    // And its own typed result is joined into the final outcome.
    expect(outcome.results.find((r) => r.specialistId === 'b')?.output).toEqual({
      summary: 'b-result',
      count: 2,
    });
    void b;
  });

  it('passes every prior result in declared order to later specialists', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a', { output: { step: 'a' } });
    const b = makeSpecialist('b', { output: { step: 'b' } });
    const cInputs: unknown[] = [];
    const c = makeSpecialist('c', {
      output: { step: 'c' },
      recordInput: (i) => cInputs.push(i),
    });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b, c],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('completed');
    expect(services.provider.calls.map((call) => call.specialistId)).toEqual(['a', 'b', 'c']);
    const priorResults = (cInputs[0] as { priorResults?: unknown[] }).priorResults;
    expect(priorResults).toEqual([
      { specialistId: 'a', status: 'completed', output: { step: 'a' } },
      { specialistId: 'b', status: 'completed', output: { step: 'b' } },
    ]);
  });

  it('stops the chain and fails the run under the fail_run policy', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a');
    services.provider.program(
      'a',
      () => new ProviderPermanentError('provider rejected request'),
    );
    const b = makeSpecialist('b');
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b],
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('failed');
    // b never ran: the chain stopped at the failed specialist.
    expect(services.provider.callsFor('b')).toHaveLength(0);
    expect(outcome.results.map((r) => r.specialistId)).toEqual(['a']);
    const types = (await services.events.list()).map((e) => e.type);
    expect(types).toContain('run.failed');
    expect(types).not.toContain('run.completed');
  });

  it('continues with a failure marker under the partial policy and never reports success', async () => {
    const runId = newRunId();
    const services = makeServices(runId);
    const a = makeSpecialist('a');
    services.provider.program(
      'a',
      () => new ProviderPermanentError('provider rejected request'),
    );
    const bInputs: unknown[] = [];
    const b = makeSpecialist('b', {
      output: { summary: 'b-result' },
      recordInput: (i) => bInputs.push(i),
    });
    const { options } = buildWorkflowOptions({
      runId,
      mode: 'sequential',
      specialists: [a, b],
      failurePolicy: 'partial',
      services,
    });

    const outcome = await executeRun(options);

    expect(outcome.status).toBe('partial');
    expect(services.provider.calls.map((c) => c.specialistId)).toEqual(['a', 'b']);
    // The failure is passed on explicitly, never hidden.
    const priorResults = (bInputs[0] as { priorResults?: unknown[] }).priorResults;
    expect(priorResults).toEqual([
      { specialistId: 'a', status: 'failed', errorCode: 'PROVIDER_PERMANENT' },
    ]);
    const types = (await services.events.list()).map((e) => e.type);
    expect(types).toContain('run.partial');
    expect(types).not.toContain('run.completed');
  });
});
