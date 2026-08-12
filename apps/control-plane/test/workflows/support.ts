/**
 * Hermetic, deterministic workflow test support.
 *
 * Workflow tests never touch Postgres or a model gateway: every service is an
 * in-memory implementation of the same interfaces the Inngest function wires
 * to PostgreSQL, and the provider is a deterministic fixture that records
 * every request it receives.
 */
import { randomUUID } from 'node:crypto';
import type {
  SpecialistProfile,
  SpecialistRuntimeInput,
  PriorSpecialistResult,
} from '../../src/agents/agent-config';
import type {
  SpecialistProvider,
  SpecialistProviderRequest,
  SpecialistProviderResult,
} from '../../src/agents/provider';
import type { UntrustedSpan } from '../../src/agents/prompt-envelope';
import { InMemoryCheckpointStore } from '../../src/workflows/checkpoint-service';
import {
  InMemoryWorkflowRunStore,
  InMemoryWorkflowEventSink,
  type WorkflowOptions,
  type WorkflowServices,
  type ScheduledSpecialist,
  type WorkflowOutcome,
} from '../../src/workflows/run-workflow';
import { InMemoryCancellationController } from '../../src/workflows/cancellation';

export function newRunId(): string {
  return `run_${randomUUID()}`;
}

/** Error thrown to simulate a process crash; not a typed provider error. */
export class SimulatedCrash extends Error {
  readonly crash = true;
  constructor(message = 'simulated crash') {
    super(message);
  }
}

export interface ProviderCallRecord {
  runId: string;
  specialistId: string;
  system: string;
  prompt: string;
  tools: string[];
  startedAt: number;
  finishedAt: number;
}

/**
 * Deterministic provider fixture. `program(specialistId, handler)` installs a
 * canned response (a JSON string) or a typed error per specialist. Every call
 * is recorded with the tools the workflow granted.
 */
export class DeterministicProvider implements SpecialistProvider {
  readonly name = 'deterministic-fixture';
  calls: ProviderCallRecord[] = [];
  aborted: string[] = [];
  private handlers = new Map<string, (req: SpecialistProviderRequest) => string | Error>();
  private tick = 0;
  private barrier:
    | { releaseSecond: () => void; first: Promise<void> }
    | undefined;

  /** Make the first call wait until the second call starts (concurrency proof). */
  startBarrier(): void {
    let releaseSecond: () => void = () => undefined;
    const first = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    this.barrier = { releaseSecond, first };
  }

  program(
    specialistId: string,
    handler: (req: SpecialistProviderRequest) => string | Error,
  ): void {
    this.handlers.set(specialistId, handler);
  }

  async complete(req: SpecialistProviderRequest): Promise<SpecialistProviderResult> {
    const startedAt = this.tick++;
    if (this.barrier) {
      if (startedAt === 0) {
        await Promise.race([
          this.barrier.first,
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      } else {
        this.barrier.releaseSecond();
      }
    }
    const handler = this.handlers.get(req.specialistId);
    let text = '';
    let error: Error | undefined;
    if (handler) {
      const result = handler(req);
      if (result instanceof Error) error = result;
      else text = result;
    } else {
      text = JSON.stringify({ result: `${req.specialistId}-result` });
    }
    // Record every call, including ones that fail, so tests can assert
    // attempt counts for retry/crash scenarios.
    this.calls.push({
      runId: req.runId,
      specialistId: req.specialistId,
      system: req.system,
      prompt: req.prompt,
      tools: [...req.tools],
      startedAt,
      finishedAt: this.tick++,
    });
    if (error) throw error;
    return { text };
  }

  abort(runId: string): void {
    this.aborted.push(runId);
  }

  callsFor(specialistId: string): ProviderCallRecord[] {
    return this.calls.filter((c) => c.specialistId === specialistId);
  }
}

export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

export function makeClock(start = 1_000_000): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

export interface TestServices {
  provider: DeterministicProvider;
  checkpoints: InMemoryCheckpointStore;
  runStore: InMemoryWorkflowRunStore;
  events: InMemoryWorkflowEventSink;
  cancellation: InMemoryCancellationController;
  clock: TestClock;
  sleeps: number[];
}

export function makeServices(runId: string): TestServices {
  const clock = makeClock();
  const sleeps: number[] = [];
  return {
    provider: new DeterministicProvider(),
    checkpoints: new InMemoryCheckpointStore(),
    runStore: new InMemoryWorkflowRunStore('queued'),
    events: new InMemoryWorkflowEventSink(runId),
    cancellation: new InMemoryCancellationController(),
    clock,
    sleeps,
  };
}

export interface MakeSpecialistOptions {
  output?: Record<string, unknown>;
  profile?: Partial<SpecialistProfile>;
  recordInput?: (input: SpecialistRuntimeInput) => void;
}

/** Build a scheduled specialist with a canned JSON output for the provider. */
export function makeSpecialist(
  id: string,
  opts: MakeSpecialistOptions = {},
): Omit<ScheduledSpecialist, 'ordinal'> {
  const profile: SpecialistProfile = {
    id,
    name: `Fixture ${id}`,
    model: 'fixture-model',
    gatewayProvider: 'openai',
    systemPolicy: 'Fixture specialist policy.',
    toolsAllowlist: [],
    timeoutMs: 10_000,
    maxOutputTokens: 256,
    enabled: true,
    ...opts.profile,
  };
  return {
    specialistId: id,
    profile,
    composePrompt(input: SpecialistRuntimeInput, untrusted: UntrustedSpan[]) {
      opts.recordInput?.(input);
      const untrustedBlock = untrusted
        .map((span) => `${span.text}`)
        .join('\n');
      return {
        system: `${profile.systemPolicy}\nuntrusted spans: ${untrusted.length}`,
        prompt: `task: ${input.prompt}${untrustedBlock ? `\nuntrusted:\n${untrustedBlock}` : ''}`,
      };
    },
    parseOutput(text: string): Record<string, unknown> {
      return opts.output ?? JSON.parse(text);
    },
  };
}

export interface RunWorkflowOptions {
  runId?: string;
  mode: 'parallel' | 'sequential';
  specialists: Array<Omit<ScheduledSpecialist, 'ordinal'>>;
  prompt?: string;
  untrusted?: UntrustedSpan[];
  promptInjectionMode?: 'exclude_span' | 'fail_run';
  failurePolicy?: 'fail_run' | 'partial';
  runTimeoutMs?: number;
  retry?: WorkflowOptions['retry'];
  services?: TestServices;
}

/** Assemble workflow options around the test services. */
export function buildWorkflowOptions(opts: RunWorkflowOptions): {
  options: WorkflowOptions;
  services: TestServices;
} {
  const runId = opts.runId ?? newRunId();
  const services = opts.services ?? makeServices(runId);
  const specialists = opts.specialists.map((spec, index) => ({
    ...spec,
    ordinal: index,
  }));
  const prompt = opts.prompt ?? 'summarize';
  const workflowServices: WorkflowServices = {
    provider: services.provider,
    checkpoints: services.checkpoints,
    runStore: services.runStore,
    events: services.events,
    cancellation: services.cancellation,
    now: services.clock.now,
    sleep: async (ms: number) => {
      services.sleeps.push(ms);
      services.clock.advance(ms);
    },
  };
  const options: WorkflowOptions = {
    runId,
    executionKey: `exec_${runId}`,
    mode: opts.mode,
    prompt,
    promptHash: `hash_${prompt}`,
    untrusted: opts.untrusted ?? [],
    promptInjectionMode: opts.promptInjectionMode ?? 'fail_run',
    specialists,
    failurePolicy: opts.failurePolicy ?? 'fail_run',
    runTimeoutMs: opts.runTimeoutMs ?? 15 * 60 * 1000,
    retry: opts.retry ?? { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 8, jitter: false },
    services: workflowServices,
  };
  return { options, services };
}

/** A prior-result helper matching the typed `prior_results` contract. */
export function prior(
  specialistId: string,
  output: Record<string, unknown>,
): PriorSpecialistResult {
  return { specialistId, status: 'completed', output };
}

export function eventsOfType(
  events: { type: string; payload: Record<string, unknown> }[],
  type: string,
): Record<string, unknown>[] {
  return events.filter((e) => e.type === type).map((e) => e.payload);
}

export function collectOutcome(services: TestServices, outcome: WorkflowOutcome) {
  return { services, outcome };
}
