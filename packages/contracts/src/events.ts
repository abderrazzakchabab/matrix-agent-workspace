import { z } from 'zod';

/** All allowed event types across all phases. */
export const RUN_EVENT_TYPES = [
  // Phase B
  'run.queued',
  'run.started',
  'specialist.started',
  'specialist.progress',
  'specialist.completed',
  'specialist.failed',
  'run.partial',
  'run.checkpointed',
  'run.retry_scheduled',
  'run.cancellation_requested',
  'run.cancelled',
  'run.completed',
  'run.failed',
  // Phase C
  'approval.requested',
  'approval.recorded',
  'mutation.queued',
  'mutation.completed',
  'mutation.failed',
] as const;

/** Phase B event types that must be supported at the backend-first gate. */
export const ALLOWED_PHASE_B_EVENT_TYPES: readonly string[] = [
  'run.queued',
  'run.started',
  'specialist.started',
  'specialist.progress',
  'specialist.completed',
  'specialist.failed',
  'run.partial',
  'run.checkpointed',
  'run.retry_scheduled',
  'run.cancellation_requested',
  'run.cancelled',
  'run.completed',
  'run.failed',
];

export type RunEventTypeLiteral = (typeof RUN_EVENT_TYPES)[number];

export const RunEvent = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  type: z.enum(RUN_EVENT_TYPES),
  version: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  visibility: z.enum(['room_and_owner']),
  payload: z.record(z.unknown()),
});

export type RunEventType = z.infer<typeof RunEvent>;
