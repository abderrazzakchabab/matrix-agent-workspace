/**
 * Inngest client for the control plane.
 *
 * The HTTP routes emit `agent.run.requested`; the durable function in
 * `inngest/functions/run-requested.ts` executes the run outside the request
 * lifetime with checkpoints, retries, and resumability.
 */
import { Inngest } from 'inngest';
import type { UntrustedSpan } from '../agents/prompt-envelope';

export const RUN_REQUESTED_EVENT = 'agent.run.requested';

export interface RunRequestedEventData {
  runId: string;
  workspaceId: string;
  /** Internal `users.id` of the run owner; the function sets tenant context. */
  userId: string;
  /** Deterministic execution key bound to the persisted run/config snapshot. */
  executionKey: string;
  /** The immutable run input; carried durably by the event across retries. */
  prompt: string;
  untrusted: UntrustedSpan[];
  configSnapshot: Record<string, unknown>;
}

export interface RunRequestedEvent {
  name: typeof RUN_REQUESTED_EVENT;
  data: RunRequestedEventData;
}

let client: Inngest | undefined;

export function getInngest(): Inngest {
  if (!client) {
    client = new Inngest({
      id: 'matrix-control-plane',
      eventKey: process.env.INNGEST_EVENT_KEY,
    });
  }
  return client;
}

/** Shared instance for function registration. */
export const inngest: Inngest = getInngest();

/**
 * Emit the workflow event. Without an event key (local development/tests) the
 * dispatch is a no-op so request handling is not coupled to Inngest; tests
 * replace this function with a spy.
 */
export async function dispatchRunRequested(event: RunRequestedEvent): Promise<void> {
  if (!process.env.INNGEST_EVENT_KEY) {
    console.warn(
      `[control-plane] INNGEST_EVENT_KEY not set; skipping ${RUN_REQUESTED_EVENT} dispatch for ${event.data.runId}`,
    );
    return;
  }
  await getInngest().send(event);
}
