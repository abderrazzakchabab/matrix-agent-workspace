import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { RunSnapshot, NormalizedRunEvent } from '../state/run-store';

interface RunTimelineProps {
  run: RunSnapshot;
  mode: 'parallel' | 'sequential';
  specialistNames?: Readonly<Record<string, string>>;
}

type DisplayStatus = 'Queued' | 'Running' | 'Succeeded' | 'Failed' | 'Cancelled' | 'Checkpointed';

function specialistId(event: NormalizedRunEvent): string | null {
  const value = event.payload.specialistId;
  return typeof value === 'string' && value ? value : null;
}

function displayStatus(type: string): DisplayStatus {
  if (type === 'run.queued') return 'Queued';
  if (type === 'specialist.completed' || type === 'run.completed') return 'Succeeded';
  if (type === 'specialist.failed' || type === 'run.failed' || type === 'run.partial') return 'Failed';
  if (type === 'run.cancelled') return 'Cancelled';
  if (type === 'run.checkpointed') return 'Checkpointed';
  return 'Running';
}

function eventLabel(event: NormalizedRunEvent, names: Readonly<Record<string, string>>): string {
  const id = specialistId(event);
  if (id) return names[id] ?? id;
  switch (event.type) {
    case 'run.queued': return 'Run queued';
    case 'run.started': return 'Run started';
    case 'run.completed': return 'Run completed';
    case 'run.partial': return 'Run partially completed';
    case 'run.failed': return 'Run failed';
    case 'run.cancellation_requested': return 'Cancellation requested';
    case 'run.cancelled': return 'Run cancelled';
    case 'run.retry_scheduled': return 'Retry scheduled';
    case 'run.checkpointed': return 'Checkpoint saved';
    default: return 'Run update';
  }
}

export function RunTimeline({ run, mode, specialistNames = {} }: RunTimelineProps) {
  const modeLabel = mode === 'parallel' ? 'Parallel' : 'Sequential';
  return (
    <View style={styles.section}>
      <View style={styles.headingRow}>
        <Text style={styles.heading}>Progress</Text>
        <Text style={styles.mode}>{modeLabel}</Text>
      </View>
      <View role="list" accessibilityLabel={`${modeLabel} execution timeline`} style={styles.list}>
        {run.events.map((event) => {
          const label = eventLabel(event, specialistNames);
          const status = displayStatus(event.type);
          const delivered = run.matrixDeliveredSequences.has(event.sequence)
            && !['run.completed', 'run.partial', 'run.failed', 'run.cancelled'].includes(event.type);
          return (
            <View
              key={event.sequence}
              role="listitem"
              accessibilityLabel={`Sequence ${event.sequence}, ${label}, ${status}`}
              style={styles.row}
            >
              <View style={styles.sequenceBadge}>
                <Text style={styles.sequenceText}>{event.sequence}</Text>
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.eventLabel}>{label}</Text>
                <Text style={styles.eventType}>{event.type}</Text>
                {delivered ? <Text style={styles.delivered}>Delivered to Matrix</Text> : null}
              </View>
              <Text style={[styles.status, status === 'Failed' && styles.failed, status === 'Succeeded' && styles.succeeded]}>
                {status}
              </Text>
            </View>
          );
        })}
        {run.events.length === 0 ? (
          <Text style={styles.empty}>Waiting for the first replayable event…</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  headingRow: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  heading: { color: '#17201c', fontSize: 20, fontWeight: '700' },
  mode: { backgroundColor: '#e8efeb', borderRadius: 20, color: '#365547', fontSize: 12, fontWeight: '700', overflow: 'hidden', paddingHorizontal: 10, paddingVertical: 5, textTransform: 'uppercase' },
  list: { gap: 8 },
  row: { alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 12, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 70, padding: 12 },
  sequenceBadge: { alignItems: 'center', backgroundColor: '#eef3f0', borderRadius: 18, height: 36, justifyContent: 'center', width: 36 },
  sequenceText: { color: '#365547', fontSize: 13, fontWeight: '800' },
  rowBody: { flex: 1, gap: 2 },
  eventLabel: { color: '#17201c', fontSize: 15, fontWeight: '700' },
  eventType: { color: '#68716d', fontSize: 12 },
  delivered: { color: '#225c45', fontSize: 12, fontWeight: '700', marginTop: 3 },
  status: { color: '#8a5b11', fontSize: 12, fontWeight: '800' },
  failed: { color: '#a12c2c' },
  succeeded: { color: '#225c45' },
  empty: { color: '#68716d', fontSize: 14, paddingVertical: 18, textAlign: 'center' },
});
