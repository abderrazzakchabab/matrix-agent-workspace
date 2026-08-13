export interface NormalizedRunEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  version: number;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface MatrixDeliveryMarker {
  runId: string;
  sequence: number;
}

export interface RunSnapshot {
  runId: string;
  highestSequence: number;
  events: readonly NormalizedRunEvent[];
  matrixDeliveredSequences: ReadonlySet<number>;
}

export interface RunPersistence {
  save(run: {
    runId: string;
    highestSequence: number;
    events: readonly NormalizedRunEvent[];
    matrixDeliveredSequences: readonly number[];
  }): void | Promise<void>;
}

export interface RunStore {
  get(runId: string): RunSnapshot;
  addEvent(candidate: unknown): boolean;
  markMatrixDelivered(marker: MatrixDeliveryMarker): boolean;
  subscribe(runId: string, listener: () => void): () => void;
}

interface MutableRun {
  snapshot: RunSnapshot;
  listeners: Set<() => void>;
  pendingDeliveries: Set<number>;
}

const EMPTY_DELIVERIES = new Set<number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeEvent(candidate: unknown): NormalizedRunEvent | null {
  if (!isRecord(candidate) || !isRecord(candidate.payload)) return null;
  const { id, runId, sequence, type, version, occurredAt, payload } = candidate;
  if (
    typeof id !== 'string' || id.length === 0
    || typeof runId !== 'string' || runId.length === 0
    || typeof type !== 'string' || type.length === 0
    || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0
    || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1
    || typeof occurredAt !== 'string' || occurredAt.length === 0
  ) return null;
  return { id, runId, sequence, type, version, occurredAt, payload };
}

export function createRunStore(options: { persistence?: RunPersistence } = {}): RunStore {
  const runs = new Map<string, MutableRun>();

  function mutable(runId: string): MutableRun {
    let run = runs.get(runId);
    if (!run) {
      run = {
        snapshot: {
          runId,
          highestSequence: 0,
          events: [],
          matrixDeliveredSequences: EMPTY_DELIVERIES,
        },
        listeners: new Set(),
        pendingDeliveries: new Set(),
      };
      runs.set(runId, run);
    }
    return run;
  }

  function publish(run: MutableRun): void {
    const snapshot = run.snapshot;
    void options.persistence?.save({
      runId: snapshot.runId,
      highestSequence: snapshot.highestSequence,
      events: snapshot.events,
      matrixDeliveredSequences: [...snapshot.matrixDeliveredSequences],
    });
    for (const listener of run.listeners) listener();
  }

  return {
    get(runId) {
      return mutable(runId).snapshot;
    },

    addEvent(candidate) {
      const normalized = normalizeEvent(candidate);
      if (!normalized) return false;
      const run = mutable(normalized.runId);
      if (normalized.sequence <= run.snapshot.highestSequence) return false;
      const deliveries = run.pendingDeliveries.has(normalized.sequence)
        ? new Set([...run.snapshot.matrixDeliveredSequences, normalized.sequence])
        : run.snapshot.matrixDeliveredSequences;
      run.pendingDeliveries.delete(normalized.sequence);
      run.snapshot = {
        ...run.snapshot,
        highestSequence: normalized.sequence,
        events: [...run.snapshot.events, normalized],
        matrixDeliveredSequences: deliveries,
      };
      publish(run);
      return true;
    },

    markMatrixDelivered(marker) {
      const run = runs.get(marker.runId);
      if (!run) return false;
      if (!run.snapshot.events.some((event) => event.sequence === marker.sequence)) {
        if (Number.isSafeInteger(marker.sequence) && marker.sequence > run.snapshot.highestSequence) {
          run.pendingDeliveries.add(marker.sequence);
        }
        return false;
      }
      if (run.snapshot.matrixDeliveredSequences.has(marker.sequence)) return false;
      const deliveries = new Set(run.snapshot.matrixDeliveredSequences);
      deliveries.add(marker.sequence);
      run.snapshot = { ...run.snapshot, matrixDeliveredSequences: deliveries };
      publish(run);
      return true;
    },

    subscribe(runId, listener) {
      const run = mutable(runId);
      run.listeners.add(listener);
      return () => run.listeners.delete(listener);
    },
  };
}
