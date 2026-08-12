/**
 * Durable specialist run workflow.
 *
 * `executeRun` is the pure orchestration core: it depends only on injectable
 * services (provider, checkpoints, run store, event sink, cancellation) and is
 * safe to re-invoke after a crash — it resumes from the last committed
 * checkpoint and never reruns completed specialists or duplicates completed
 * outputs or terminal events.
 *
 * The Inngest function (`inngest/functions/run-requested.ts`) wires the
 * PostgreSQL-backed implementations; deterministic tests inject in-memory
 * implementations and a fixture provider.
 *
 * Safety properties:
 * - parallel mode: every specialist receives the same immutable initial input
 *   and results are joined per specialist;
 * - sequential mode: each specialist receives typed `prior_results` in
 *   declared order plus the explicit failure policy;
 * - retries: only typed transient provider failures, bounded with capped
 *   exponential backoff; attempts and the next retry are persisted before
 *   sleeping;
 * - absolute run deadline, cooperative cancellation (one terminal
 *   `run.cancelled` event), and prompt-injection policy (fail_run/exclude_span).
 */
import { createHash, randomUUID } from 'node:crypto';
import type {
  SpecialistRuntimeInput,
  PriorSpecialistResult,
  SpecialistDefinition,
  SpecialistProfile,
  ReadOnlyToolName,
} from '../agents/agent-config';
import {
  validateSpecialistProfiles,
  resolveExecutionOrder,
  InvalidSpecialistConfigurationError,
  SpecialistOutputInvalidError,
} from '../agents/agent-config';
import {
  applyPromptInjectionPolicy,
  PromptInjectionDetectedError,
  type UntrustedSpan,
  type PromptInjectionMode,
  type InjectionFinding,
} from '../agents/prompt-envelope';
import {
  isTransientProviderError,
  ProviderTimeoutError,
  ProviderPermanentError,
  type SpecialistProvider,
} from '../agents/provider';
import { repositoryReader } from '../agents/specialists/repository-reader';
import { issueReader } from '../agents/specialists/issue-reader';
import { prReader } from '../agents/specialists/pr-reader';
import { withTenant } from '../db/client';
import { appendEvent, listEvents } from '../db/repositories/event-repository';
import type { TenantContext } from '../db/repositories/run-repository';
import type { CheckpointStore } from './checkpoint-service';
import type { CancellationController } from './cancellation';

export type TerminalRunStatus = 'completed' | 'partial' | 'failed' | 'cancelled';
export type SpecialistRunStatus = 'queued' | 'running' | 'retrying' | 'completed' | 'failed';

const TERMINAL_STATUSES: readonly string[] = ['completed', 'partial', 'failed', 'cancelled'];

export function isTerminalStatus(
  status: string | null | undefined,
): status is TerminalRunStatus {
  return status !== null && status !== undefined && TERMINAL_STATUSES.includes(status);
}

export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: true,
};

export type SpecialistFailurePolicy = 'fail_run' | 'partial';

// ── Persisted state interfaces ─────────────────────────────────────────────

export interface PersistedSpecialistResult {
  specialistId: string;
  ordinal: number;
  status: SpecialistRunStatus;
  attemptCount: number;
  output?: Record<string, unknown>;
  errorCode?: string | null;
  startedAt?: number;
  completedAt?: number;
}

/** Run-level persisted state with guarded transitions (terminal exactly once). */
export interface WorkflowRunStore {
  getStatus(runId: string): Promise<string | null>;
  /** queued → running; returns the new status or null when not queued. */
  beginRun(runId: string): Promise<string | null>;
  setCancelling(runId: string): Promise<void>;
  /** Guarded terminal transition; returns null when already terminal. */
  finalize(
    runId: string,
    status: TerminalRunStatus,
    summary?: Record<string, unknown> | null,
  ): Promise<string | null>;
  saveSpecialistResult(runId: string, result: PersistedSpecialistResult): Promise<void>;
  loadSpecialistResults(runId: string): Promise<PersistedSpecialistResult[]>;
  getSummary(runId: string): Promise<Record<string, unknown> | null>;
}

export interface WorkflowEventRecord {
  type: string;
  sequence: number;
  payload: Record<string, unknown>;
}

export interface WorkflowEventSink {
  append(type: string, payload: Record<string, unknown>): Promise<number>;
  list(): Promise<WorkflowEventRecord[]>;
}

export interface WorkflowServices {
  provider: SpecialistProvider;
  checkpoints: CheckpointStore;
  runStore: WorkflowRunStore;
  events: WorkflowEventSink;
  cancellation: CancellationController;
  now(): number;
  sleep(ms: number): Promise<void>;
}

// ── Specialist scheduling ───────────────────────────────────────────────────

export interface SpecialistPromptCompositionLike {
  system: string;
  prompt: string;
}

export interface ScheduledSpecialist {
  specialistId: string;
  ordinal: number;
  profile: SpecialistProfile;
  composePrompt(
    input: SpecialistRuntimeInput,
    untrusted: UntrustedSpan[],
  ): SpecialistPromptCompositionLike;
  parseOutput(text: string): Record<string, unknown>;
}

/** Phase B specialist registry: profile id → typed implementation. */
export const SPECIALIST_REGISTRY: Record<string, SpecialistDefinition> = {
  [repositoryReader.profile.id]: repositoryReader,
  [issueReader.profile.id]: issueReader,
  [prReader.profile.id]: prReader,
};

/** Rebuild the declared specialist schedule from the immutable config snapshot. */
export function resolveScheduledSpecialists(
  configSnapshot: Record<string, unknown>,
): ScheduledSpecialist[] {
  const rawProfiles =
    (configSnapshot.specialists as Array<Record<string, unknown>> | undefined) ?? [];
  const profiles = validateSpecialistProfiles(rawProfiles);
  const declaredIds =
    (configSnapshot.specialistIds as string[] | undefined) ?? profiles.map((p) => p.id);
  const ordered = resolveExecutionOrder(declaredIds, profiles);
  return ordered.map((profile, ordinal) => {
    const definition = SPECIALIST_REGISTRY[profile.id];
    if (!definition) {
      throw new InvalidSpecialistConfigurationError(
        `No specialist implementation registered for "${profile.id}"`,
      );
    }
    return {
      specialistId: profile.id,
      ordinal,
      profile,
      composePrompt: (input, untrusted) =>
        definition.composePrompt(input as never, untrusted),
      parseOutput: (text) => definition.parseOutput(text) as Record<string, unknown>,
    };
  });
}

// ── Deterministic hashes ────────────────────────────────────────────────────

export function computePromptHash(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}

export function hashConfigSnapshot(snapshot: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(snapshot)).digest('hex');
}

/**
 * Deterministic execution key: stable for the (run, prompt, config snapshot)
 * triple across process restarts and Inngest retries, so a resume must carry
 * the same key the run was created with.
 */
export function computeExecutionKey(
  runId: string,
  promptHash: string,
  configSnapshot: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(JSON.stringify([runId, promptHash, hashConfigSnapshot(configSnapshot)]))
    .digest('hex');
}

export function computeBackoff(attempt: number, policy: RetryPolicy): number {
  const base = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  if (!policy.jitter) return capped;
  return capped + Math.floor(Math.random() * capped * 0.25);
}

// ── Workflow options and outcome ────────────────────────────────────────────

export interface WorkflowOptions {
  runId: string;
  executionKey: string;
  mode: 'parallel' | 'sequential';
  prompt: string;
  promptHash: string;
  untrusted: UntrustedSpan[];
  promptInjectionMode: PromptInjectionMode;
  specialists: ScheduledSpecialist[];
  failurePolicy: SpecialistFailurePolicy;
  runTimeoutMs: number;
  retry: RetryPolicy;
  githubContext?: { repository?: string };
  services: WorkflowServices;
}

export interface SpecialistOutcome {
  specialistId: string;
  ordinal: number;
  status: 'completed' | 'failed';
  output?: Record<string, unknown>;
  errorCode?: string;
  attempts: number;
}

export interface WorkflowOutcome {
  status: TerminalRunStatus;
  results: SpecialistOutcome[];
  startedAt: number;
  completedAt: number;
  terminalSummary: Record<string, unknown>;
}

export class RunTimeoutError extends Error {
  readonly code = 'RUN_TIMEOUT';
  constructor(deadline: number, now: number) {
    super(`run deadline exceeded (deadline ${deadline}, now ${now})`);
    this.name = 'RunTimeoutError';
  }
}

export class WorkflowCancelledSignal extends Error {
  readonly code = 'WORKFLOW_CANCELLED';
  constructor() {
    super('workflow cancelled');
    this.name = 'WorkflowCancelledSignal';
  }
}

// ── Execution core ──────────────────────────────────────────────────────────

function assertDeadline(startedAt: number, timeoutMs: number, now: number): void {
  if (now - startedAt > timeoutMs) {
    throw new RunTimeoutError(startedAt + timeoutMs, now);
  }
}

function summarizeOutput(output: Record<string, unknown> | undefined): string {
  if (!output) return '';
  return typeof output.summary === 'string' ? output.summary : '';
}

function errorCodeOf(error: Error | undefined): string {
  if (error instanceof ProviderTimeoutError) return 'PROVIDER_TIMEOUT';
  if (error instanceof ProviderPermanentError) return 'PROVIDER_PERMANENT';
  if (error instanceof SpecialistOutputInvalidError) return 'SPECIALIST_OUTPUT_INVALID';
  return 'PROVIDER_PERMANENT';
}

function buildTerminalSummary(
  opts: WorkflowOptions,
  results: SpecialistOutcome[],
  status: TerminalRunStatus,
  completedAt: number,
): Record<string, unknown> {
  return {
    mode: opts.mode,
    status,
    completedSpecialists: results
      .filter((r) => r.status === 'completed')
      .map((r) => r.specialistId),
    failedSpecialists: results
      .filter((r) => r.status === 'failed')
      .map((r) => ({ specialistId: r.specialistId, errorCode: r.errorCode })),
    completedAt,
  };
}

async function persistSpecialistResult(
  opts: WorkflowOptions,
  spec: ScheduledSpecialist,
  outcome: SpecialistOutcome,
): Promise<void> {
  await opts.services.runStore.saveSpecialistResult(opts.runId, {
    specialistId: spec.specialistId,
    ordinal: spec.ordinal,
    status: outcome.status,
    attemptCount: outcome.attempts,
    output: outcome.output,
    errorCode: outcome.errorCode ?? null,
    startedAt: opts.services.now(),
    completedAt: opts.services.now(),
  });
  // Checkpoint CAS after the result so a resume skips this specialist.
  await opts.services.checkpoints.save(
    opts.runId,
    `specialist:${spec.specialistId}`,
    {
      status: outcome.status,
      output: outcome.output ?? null,
      errorCode: outcome.errorCode ?? null,
      attempts: outcome.attempts,
    },
    0,
  );
  await opts.services.events.append('run.checkpointed', {
    checkpoint: `specialist:${spec.specialistId}`,
  });
}

async function resumeOutcome(
  opts: WorkflowOptions,
  status: TerminalRunStatus,
): Promise<WorkflowOutcome> {
  const { services, runId } = opts;
  const persisted = await services.runStore.loadSpecialistResults(runId);
  const results: SpecialistOutcome[] = persisted.map((r) => ({
    specialistId: r.specialistId,
    ordinal: r.ordinal,
    status: r.status === 'failed' ? 'failed' : 'completed',
    output: r.output,
    errorCode: r.errorCode ?? undefined,
    attempts: r.attemptCount,
  }));
  const summary = (await services.runStore.getSummary(runId)) ?? {};
  const startedAt =
    typeof summary.startedAt === 'number' ? summary.startedAt : services.now();
  return {
    status,
    results,
    startedAt,
    completedAt: services.now(),
    terminalSummary: summary,
  };
}

/**
 * Guarded terminal finalization: the run store's CAS-like `finalize` wins
 * exactly once, so the terminal event is emitted exactly once — including
 * across a crash/resume or a race with the cancel route.
 */
async function finalizeTerminal(
  opts: WorkflowOptions,
  status: TerminalRunStatus,
  results: SpecialistOutcome[],
  startedAt: number,
  eventType: string,
  eventPayload: Record<string, unknown>,
): Promise<WorkflowOutcome> {
  await opts.services.provider.abort?.(opts.runId);
  const completedAt = opts.services.now();
  const summary = buildTerminalSummary(opts, results, status, completedAt);
  const applied = await opts.services.runStore.finalize(opts.runId, status, summary);
  if (applied === null) {
    // Another execution (or the cancel route) already finalized this run:
    // never emit a second terminal event.
    const existing = await opts.services.runStore.getStatus(opts.runId);
    return resumeOutcome(opts, isTerminalStatus(existing) ? existing : status);
  }
  await opts.services.events.append(eventType, eventPayload);
  await opts.services.checkpoints.save(
    opts.runId,
    'workflow:done',
    { status, completedAt },
    0,
  );
  return {
    status,
    results,
    startedAt,
    completedAt,
    terminalSummary: summary,
  };
}

export async function executeRun(opts: WorkflowOptions): Promise<WorkflowOutcome> {
  const { services, runId } = opts;

  // Terminal fast path: the run already ended; load persisted results only.
  const currentStatus = await services.runStore.getStatus(runId);
  if (currentStatus === null) {
    throw new Error(`run ${runId} not found`);
  }
  if (isTerminalStatus(currentStatus)) {
    return resumeOutcome(opts, currentStatus);
  }

  // Cancellation recorded before this execution started: never begin work.
  if (await services.cancellation.isCancelled(runId)) {
    return finalizeTerminal(opts, 'cancelled', [], services.now(), 'run.cancelled', {
      cancelledAt: services.now(),
      untrusted: false,
    });
  }

  // Init checkpoint: resume verification against the deterministic key.
  let init = await services.checkpoints.load(runId, 'workflow:init');
  if (init) {
    if (init.state.executionKey !== opts.executionKey) {
      return finalizeTerminal(opts, 'failed', [], services.now(), 'run.failed', {
        code: 'EXECUTION_KEY_MISMATCH',
        expected: opts.executionKey,
        recorded: init.state.executionKey,
        untrusted: false,
      });
    }
  } else {
    const began = await services.runStore.beginRun(runId);
    if (began === null) {
      const raced = await services.runStore.getStatus(runId);
      if (raced !== null && isTerminalStatus(raced)) return resumeOutcome(opts, raced);
      if (await services.cancellation.isCancelled(runId)) {
        return finalizeTerminal(opts, 'cancelled', [], services.now(), 'run.cancelled', {
          cancelledAt: services.now(),
          untrusted: false,
        });
      }
      // Another execution began the run; continue below as resumed.
    }
    const created = await services.checkpoints.save(
      runId,
      'workflow:init',
      {
        executionKey: opts.executionKey,
        promptHash: opts.promptHash,
        startedAt: services.now(),
      },
      0,
    );
    if (created === null) {
      const winner = await services.checkpoints.load(runId, 'workflow:init');
      if (!winner || winner.state.executionKey !== opts.executionKey) {
        return finalizeTerminal(opts, 'failed', [], services.now(), 'run.failed', {
          code: 'EXECUTION_KEY_MISMATCH',
          expected: opts.executionKey,
          recorded: winner?.state.executionKey ?? null,
          untrusted: false,
        });
      }
    } else if (began !== null) {
      await services.events.append('run.started', {
        mode: opts.mode,
        executionKey: opts.executionKey,
        untrusted: false,
      });
    }
    init = await services.checkpoints.load(runId, 'workflow:init');
  }
  const startedAt = (init?.state.startedAt as number | undefined) ?? services.now();

  // Prompt-injection policy before any provider call.
  let effectiveUntrusted: UntrustedSpan[];
  try {
    const policy = applyPromptInjectionPolicy({
      task: opts.prompt,
      untrusted: opts.untrusted,
      mode: opts.promptInjectionMode,
    });
    effectiveUntrusted = policy.keptUntrusted;
    if (policy.findings.length > 0) {
      // Safety event, emitted exactly once per run (create-wins marker).
      const marker = await services.checkpoints.save(
        runId,
        'workflow:injection',
        { detected: policy.findings.length, mode: opts.promptInjectionMode },
        0,
      );
      if (marker !== null) {
        await services.events.append('run.checkpointed', {
          safety: 'prompt_injection_detected',
          excludedSpanSources: policy.excludedSpanSources,
          untrusted: true,
        });
      }
    }
  } catch (error) {
    if (error instanceof PromptInjectionDetectedError) {
      const findings = error.findings.map((f: InjectionFinding) => ({
        source: f.source,
        sourceId: f.sourceId,
        matchedPattern: f.matchedPattern,
      }));
      return finalizeTerminal(opts, 'failed', [], startedAt, 'run.failed', {
        code: 'PROMPT_INJECTION_DETECTED',
        findings,
        untrusted: true,
      });
    }
    throw error;
  }

  // Resume: load completed specialists from their checkpoints; never rerun.
  const outcomes: SpecialistOutcome[] = [];
  const pending: ScheduledSpecialist[] = [];
  for (const spec of opts.specialists) {
    const cp = await services.checkpoints.load(runId, `specialist:${spec.specialistId}`);
    if (cp && (cp.state.status === 'completed' || cp.state.status === 'failed')) {
      outcomes.push({
        specialistId: spec.specialistId,
        ordinal: spec.ordinal,
        status: cp.state.status,
        output: (cp.state.output as Record<string, unknown> | undefined) ?? undefined,
        errorCode: (cp.state.errorCode as string | undefined) ?? undefined,
        attempts: Number(cp.state.attempts ?? 1),
      });
    } else {
      pending.push(spec);
    }
  }
  outcomes.sort((a, b) => a.ordinal - b.ordinal);

  const runSpecialist = async (
    spec: ScheduledSpecialist,
    input: SpecialistRuntimeInput,
  ): Promise<SpecialistOutcome> => {
    if (await services.cancellation.isCancelled(runId)) {
      throw new WorkflowCancelledSignal();
    }
    assertDeadline(startedAt, opts.runTimeoutMs, services.now());
    const composition = spec.composePrompt(input, effectiveUntrusted);
    await services.events.append('specialist.started', {
      specialistId: spec.specialistId,
      ordinal: spec.ordinal,
      attempt: 1,
      untrusted: false,
    });

    let attempts = 0;
    let lastError: Error | undefined;
    let exhaustedTransient = false;
    while (attempts < opts.retry.maxAttempts) {
      if (await services.cancellation.isCancelled(runId)) {
        throw new WorkflowCancelledSignal();
      }
      assertDeadline(startedAt, opts.runTimeoutMs, services.now());
      attempts += 1;
      try {
        const raw = await services.provider.complete({
          runId,
          specialistId: spec.specialistId,
          profile: spec.profile,
          system: composition.system,
          prompt: composition.prompt,
          tools: spec.profile.toolsAllowlist as ReadOnlyToolName[],
          executionKey: opts.executionKey,
        });
        const output = spec.parseOutput(raw.text);
        const outcome: SpecialistOutcome = {
          specialistId: spec.specialistId,
          ordinal: spec.ordinal,
          status: 'completed',
          output,
          attempts,
        };
        await persistSpecialistResult(opts, spec, outcome);
        await services.events.append('specialist.completed', {
          specialistId: spec.specialistId,
          ordinal: spec.ordinal,
          status: 'completed',
          attempt: attempts,
          summary: summarizeOutput(output),
          untrusted: false,
        });
        return outcome;
      } catch (error) {
        if (isTransientProviderError(error)) {
          exhaustedTransient = true;
          lastError = error;
          if (attempts < opts.retry.maxAttempts) {
            const delayMs = computeBackoff(attempts, opts.retry);
            // Persist the attempt and the next retry before sleeping.
            await services.runStore.saveSpecialistResult(runId, {
              specialistId: spec.specialistId,
              ordinal: spec.ordinal,
              status: 'retrying',
              attemptCount: attempts,
              errorCode: 'PROVIDER_TRANSIENT',
              startedAt: services.now(),
            });
            await services.events.append('run.retry_scheduled', {
              specialistId: spec.specialistId,
              ordinal: spec.ordinal,
              attempt: attempts,
              nextAttempt: attempts + 1,
              delayMs,
              untrusted: false,
            });
            await services.sleep(delayMs);
            continue;
          }
          break;
        }
        if (
          error instanceof ProviderTimeoutError ||
          error instanceof ProviderPermanentError ||
          error instanceof SpecialistOutputInvalidError
        ) {
          exhaustedTransient = false;
          lastError = error;
          break;
        }
        throw error; // crash: Inngest retries the function from checkpoints
      }
    }

    const errorCode = exhaustedTransient ? 'PROVIDER_UNAVAILABLE' : errorCodeOf(lastError);
    const failed: SpecialistOutcome = {
      specialistId: spec.specialistId,
      ordinal: spec.ordinal,
      status: 'failed',
      errorCode,
      attempts,
    };
    await persistSpecialistResult(opts, spec, failed);
    await services.events.append('specialist.failed', {
      specialistId: spec.specialistId,
      ordinal: spec.ordinal,
      status: 'failed',
      errorCode,
      attempts,
      untrusted: false,
    });
    return failed;
  };

  try {
    if (opts.mode === 'parallel') {
      // Identical immutable initial input for every specialist.
      const baseInput = Object.freeze({
        prompt: opts.prompt,
        githubContext: opts.githubContext
          ? Object.freeze({ ...opts.githubContext })
          : undefined,
        priorResults: [],
      } satisfies SpecialistRuntimeInput);
      const settled = await Promise.allSettled(
        pending.map((spec) => runSpecialist(spec, baseInput)),
      );
      for (const item of settled) {
        if (item.status === 'rejected') {
          if (item.reason instanceof WorkflowCancelledSignal) {
            return finalizeTerminal(opts, 'cancelled', outcomes, startedAt, 'run.cancelled', {
              cancelledAt: services.now(),
              untrusted: false,
            });
          }
          if (item.reason instanceof RunTimeoutError) {
            return finalizeTerminal(opts, 'failed', outcomes, startedAt, 'run.failed', {
              code: 'RUN_TIMEOUT',
              startedAt,
              timedOutAt: services.now(),
              untrusted: false,
            });
          }
          throw item.reason; // crash
        }
        outcomes.push(item.value);
      }
    } else {
      const priorResults: PriorSpecialistResult[] = outcomes
        .filter((o) => o.status === 'completed')
        .map((o) => ({
          specialistId: o.specialistId,
          status: 'completed',
          output: o.output,
        }));
      for (const spec of pending) {
        if (await services.cancellation.isCancelled(runId)) {
          return finalizeTerminal(opts, 'cancelled', outcomes, startedAt, 'run.cancelled', {
            cancelledAt: services.now(),
            untrusted: false,
          });
        }
        assertDeadline(startedAt, opts.runTimeoutMs, services.now());
        const input: SpecialistRuntimeInput = {
          prompt: opts.prompt,
          githubContext: opts.githubContext ? { ...opts.githubContext } : undefined,
          priorResults: priorResults.map((p) => ({ ...p })),
        };
        const outcome = await runSpecialist(spec, input);
        outcomes.push(outcome);
        if (outcome.status === 'completed') {
          priorResults.push({
            specialistId: outcome.specialistId,
            status: 'completed',
            output: outcome.output,
          });
        } else {
          priorResults.push({
            specialistId: outcome.specialistId,
            status: 'failed',
            errorCode: outcome.errorCode,
          });
        }
        if (outcome.status === 'failed' && opts.failurePolicy === 'fail_run') {
          return finalizeTerminal(opts, 'failed', outcomes, startedAt, 'run.failed', {
            code: 'SPECIALIST_FAILED',
            failedSpecialists: [
              { specialistId: outcome.specialistId, errorCode: outcome.errorCode },
            ],
            untrusted: false,
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof WorkflowCancelledSignal) {
      return finalizeTerminal(opts, 'cancelled', outcomes, startedAt, 'run.cancelled', {
        cancelledAt: services.now(),
        untrusted: false,
      });
    }
    if (error instanceof RunTimeoutError) {
      return finalizeTerminal(opts, 'failed', outcomes, startedAt, 'run.failed', {
        code: 'RUN_TIMEOUT',
        startedAt,
        timedOutAt: services.now(),
        untrusted: false,
      });
    }
    throw error;
  }

  // Join results: a failed specialist never silently becomes a success.
  const failedOutcomes = outcomes.filter((o) => o.status === 'failed');
  if (failedOutcomes.length > 0) {
    if (opts.failurePolicy === 'fail_run') {
      return finalizeTerminal(opts, 'failed', outcomes, startedAt, 'run.failed', {
        code: 'SPECIALIST_FAILED',
        failedSpecialists: failedOutcomes.map((o) => ({
          specialistId: o.specialistId,
          errorCode: o.errorCode,
        })),
        untrusted: false,
      });
    }
    return finalizeTerminal(opts, 'partial', outcomes, startedAt, 'run.partial', {
      completedSpecialists: outcomes
        .filter((o) => o.status === 'completed')
        .map((o) => o.specialistId),
      failedSpecialists: failedOutcomes.map((o) => ({
        specialistId: o.specialistId,
        errorCode: o.errorCode,
      })),
      untrusted: false,
    });
  }
  return finalizeTerminal(opts, 'completed', outcomes, startedAt, 'run.completed', {
    completedSpecialists: outcomes.map((o) => o.specialistId),
    untrusted: false,
  });
}

// ── In-memory implementations (deterministic tests) ─────────────────────────

export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  status: string;
  summary: Record<string, unknown> | null = null;
  results = new Map<string, PersistedSpecialistResult>();

  constructor(initialStatus = 'queued') {
    this.status = initialStatus;
  }

  async getStatus(): Promise<string | null> {
    return this.status;
  }

  async beginRun(): Promise<string | null> {
    if (this.status === 'queued') {
      this.status = 'running';
      return 'running';
    }
    return null;
  }

  async setCancelling(): Promise<void> {
    if (!isTerminalStatus(this.status) && this.status !== 'cancelling') {
      this.status = 'cancelling';
    }
  }

  async finalize(
    _runId: string,
    status: TerminalRunStatus,
    summary?: Record<string, unknown> | null,
  ): Promise<string | null> {
    if (isTerminalStatus(this.status)) return null;
    this.status = status;
    this.summary = summary ?? null;
    return status;
  }

  async saveSpecialistResult(
    _runId: string,
    result: PersistedSpecialistResult,
  ): Promise<void> {
    this.results.set(result.specialistId, structuredClone(result));
  }

  async loadSpecialistResults(): Promise<PersistedSpecialistResult[]> {
    return [...this.results.values()].sort((a, b) => a.ordinal - b.ordinal);
  }

  async getSummary(): Promise<Record<string, unknown> | null> {
    return this.summary;
  }
}

export class InMemoryWorkflowEventSink implements WorkflowEventSink {
  private records: WorkflowEventRecord[] = [];
  private sequence = 0;
  private readonly runId: string;

  constructor(runId: string) {
    this.runId = runId;
  }

  async append(type: string, payload: Record<string, unknown>): Promise<number> {
    this.sequence += 1;
    this.records.push({
      type,
      sequence: this.sequence,
      payload: structuredClone(payload),
    });
    return this.sequence;
  }

  async list(): Promise<WorkflowEventRecord[]> {
    return [...this.records];
  }
}

// ── PostgreSQL implementations (Inngest wiring) ─────────────────────────────

export function createPostgresWorkflowRunStore(tenant: TenantContext): WorkflowRunStore {
  const terminalList = "'completed', 'partial', 'failed', 'cancelled'";
  return {
    async getStatus(runId: string): Promise<string | null> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          'SELECT status FROM runs WHERE id = $1 AND workspace_id = $2',
          [runId, tenant.workspaceId],
        );
        return rows[0] ? (rows[0].status as string) : null;
      });
    },
    async beginRun(runId: string): Promise<string | null> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          `UPDATE runs SET status = 'running', updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND status = 'queued'
            RETURNING status`,
          [runId, tenant.workspaceId],
        );
        return rows[0] ? (rows[0].status as string) : null;
      });
    },
    async setCancelling(runId: string): Promise<void> {
      await withTenant(tenant.userId, async (client) => {
        await client.query(
          `UPDATE runs SET status = 'cancelling', updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND status NOT IN (${terminalList})`,
          [runId, tenant.workspaceId],
        );
      });
    },
    async finalize(
      runId: string,
      status: TerminalRunStatus,
      summary?: Record<string, unknown> | null,
    ): Promise<string | null> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          `UPDATE runs
              SET status = $1,
                  terminal_summary = COALESCE($2, terminal_summary),
                  updated_at = now()
            WHERE id = $3 AND workspace_id = $4
              AND status NOT IN (${terminalList})
            RETURNING status`,
          [status, summary ? JSON.stringify(summary) : null, runId, tenant.workspaceId],
        );
        return rows[0] ? (rows[0].status as string) : null;
      });
    },
    async saveSpecialistResult(
      runId: string,
      result: PersistedSpecialistResult,
    ): Promise<void> {
      await withTenant(tenant.userId, async (client) => {
        await client.query(
          `INSERT INTO run_specialists
             (run_id, specialist_id, ordinal, status, attempt_count, output,
              error_code, started_at, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
                   CASE WHEN $8::bigint IS NULL THEN NULL ELSE to_timestamp($8 / 1000.0) END,
                   CASE WHEN $9::bigint IS NULL THEN NULL ELSE to_timestamp($9 / 1000.0) END)
           ON CONFLICT (run_id, specialist_id)
           DO UPDATE SET status = EXCLUDED.status,
                         attempt_count = EXCLUDED.attempt_count,
                         output = EXCLUDED.output,
                         error_code = EXCLUDED.error_code,
                         started_at = COALESCE(EXCLUDED.started_at, run_specialists.started_at),
                         completed_at = COALESCE(EXCLUDED.completed_at, run_specialists.completed_at)`,
          [
            runId,
            result.specialistId,
            result.ordinal,
            result.status,
            result.attemptCount,
            result.output ? JSON.stringify(result.output) : null,
            result.errorCode ?? null,
            result.startedAt ?? null,
            result.completedAt ?? null,
          ],
        );
      });
    },
    async loadSpecialistResults(runId: string): Promise<PersistedSpecialistResult[]> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          `SELECT specialist_id, ordinal, status, attempt_count, output, error_code
             FROM run_specialists WHERE run_id = $1 ORDER BY ordinal`,
          [runId],
        );
        return rows.map((r) => ({
          specialistId: r.specialist_id as string,
          ordinal: Number(r.ordinal),
          status: r.status as SpecialistRunStatus,
          attemptCount: Number(r.attempt_count),
          output: (r.output as Record<string, unknown> | null) ?? undefined,
          errorCode: (r.error_code as string | null) ?? null,
        }));
      });
    },
    async getSummary(runId: string): Promise<Record<string, unknown> | null> {
      return withTenant(tenant.userId, async (client) => {
        const { rows } = await client.query(
          'SELECT terminal_summary FROM runs WHERE id = $1 AND workspace_id = $2',
          [runId, tenant.workspaceId],
        );
        return (rows[0]?.terminal_summary as Record<string, unknown> | null) ?? null;
      });
    },
  };
}

export function createPostgresWorkflowEventSink(
  tenant: TenantContext,
  runId: string,
): WorkflowEventSink {
  return {
    async append(type: string, payload: Record<string, unknown>): Promise<number> {
      return appendEvent(tenant, runId, {
        id: `evt_${randomUUID()}`,
        type,
        version: 1,
        payload,
        visibility: 'room_and_owner',
      });
    },
    async list(): Promise<WorkflowEventRecord[]> {
      const rows = await listEvents(tenant, runId);
      return rows.map((r) => ({
        type: r.eventType,
        sequence: r.sequence,
        payload: r.payload,
      }));
    },
  };
}
