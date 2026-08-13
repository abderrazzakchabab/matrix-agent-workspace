/**
 * Matrix message rendering.
 *
 * Progress events render as compact, redacted one-liners. Terminal events
 * render as separate, outcome-specific messages (completed, failed, partial,
 * cancelled). All payload-derived text passes through structured redaction so
 * token-shaped secrets never reach a Matrix message.
 */
import { redact, redactText } from '../security/redaction';

export const TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.partial',
  'run.cancelled',
]);

export function isTerminalEventType(type: string): boolean {
  return TERMINAL_EVENT_TYPES.has(type);
}

export interface RenderableEvent {
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

const TERMINAL_LABELS: Record<string, string> = {
  completed: 'Run completed',
  failed: 'Run failed',
  partial: 'Run partially completed',
  cancelled: 'Run cancelled',
};

function terminalStatusOf(type: string): string | null {
  switch (type) {
    case 'run.completed':
      return 'completed';
    case 'run.failed':
      return 'failed';
    case 'run.partial':
      return 'partial';
    case 'run.cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function summarizePayload(payload: Record<string, unknown>): string {
  const safe = redact(payload) as Record<string, unknown>;
  if (typeof safe.summary === 'string') return safe.summary;
  if (typeof safe.specialistId === 'string') return safe.specialistId;
  return '';
}

function summarizeTerminal(payload: Record<string, unknown>): string {
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  const safe = redact(payload) as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(safe.completedSpecialists) && safe.completedSpecialists.length > 0) {
    parts.push(`${safe.completedSpecialists.length} completed`);
  }
  if (Array.isArray(safe.failedSpecialists) && safe.failedSpecialists.length > 0) {
    parts.push(`${safe.failedSpecialists.length} failed`);
  }
  if (code && code.length > 0) {
    parts.push(`code=${code}`);
  }
  return parts.join(', ');
}

/** Outcome-specific terminal message (completed/failed/partial/cancelled). */
export function renderTerminalMessage(event: RenderableEvent): string {
  const status = terminalStatusOf(event.type) ?? 'completed';
  const label = TERMINAL_LABELS[status] ?? 'Run finished';
  const details = summarizeTerminal(event.payload);
  return `${label} — run ${event.runId}${details ? ` (${details})` : ''}`;
}

/** Redacted one-line progress message for non-terminal events. */
export function renderProgressMessage(event: RenderableEvent): string {
  const summary = summarizePayload(event.payload);
  const suffix = summary ? ` — ${redactText(summary)}` : '';
  return `Run ${event.runId} ${event.type}${suffix}`;
}

/** Render an event as a Matrix message, dispatching terminal vs progress. */
export function renderMessage(event: RenderableEvent): string {
  return isTerminalEventType(event.type)
    ? renderTerminalMessage(event)
    : renderProgressMessage(event);
}
