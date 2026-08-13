/**
 * Server-Sent Events frame encoding.
 *
 * Frames follow the `text/event-stream` grammar:
 *   id: <sequence>
 *   event: <type>
 *   data: <Event JSON>
 *
 * Heartbeats are comment frames (`: heartbeat`), which carry no `id`, so they
 * never advance the client's sequence cursor.
 */
import type { RunEventJson } from './event-service';

export const HEARTBEAT_FRAME = ': heartbeat\n\n';

/** Encode a run event as an SSE frame with id/event/JSON data. */
export function encodeEventFrame(event: RunEventJson): string {
  return `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/**
 * Resolve the replay cursor from the `after` query parameter or the
 * `Last-Event-ID` header (both equivalent). Non-negative integers only;
 * anything else starts from the beginning.
 */
export function parseAfterValue(raw: string | null): number {
  if (raw === null) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
