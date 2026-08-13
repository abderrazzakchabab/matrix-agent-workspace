import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { NormalizedRunEvent, RunSnapshot } from '../state/run-store';

interface TerminalResultProps {
  run: RunSnapshot;
}

const TERMINAL: Readonly<Record<string, { title: string; action: string }>> = {
  'run.completed': {
    title: 'Completed',
    action: 'The final result is available in this run and the bound Matrix room.',
  },
  'run.partial': {
    title: 'Partially completed',
    action: 'Review the failed specialists before using the available results.',
  },
  'run.failed': {
    title: 'Failed',
    action: 'Retry the run. If it fails again, check the specialist configuration or service status.',
  },
  'run.cancelled': {
    title: 'Cancelled',
    action: 'Start a new run when you are ready to continue.',
  },
};

export function terminalEvent(run: RunSnapshot): NormalizedRunEvent | null {
  return run.events.find((event) => TERMINAL[event.type] !== undefined) ?? null;
}

function safeFailureCode(event: NormalizedRunEvent): string | null {
  const candidate = event.payload.code ?? event.payload.errorCode;
  if (typeof candidate !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(candidate)) return null;
  return candidate;
}

function failedCount(event: NormalizedRunEvent): number {
  return Array.isArray(event.payload.failedSpecialists) ? event.payload.failedSpecialists.length : 0;
}

export function TerminalResult({ run }: TerminalResultProps) {
  const event = terminalEvent(run);
  if (!event) return null;
  const presentation = TERMINAL[event.type];
  if (!presentation) return null;
  const code = event.type === 'run.failed' ? safeFailureCode(event) : null;
  const failures = event.type === 'run.partial' ? failedCount(event) : 0;
  const matrixDelivered = run.matrixDeliveredSequences.has(event.sequence);

  return (
    <View role="status" accessibilityLabel={`Run ${presentation.title}`} style={styles.card}>
      <Text style={styles.eyebrow}>Terminal result</Text>
      <Text style={styles.title}>{presentation.title}</Text>
      {failures > 0 ? (
        <Text style={styles.detail}>{failures} specialist{failures === 1 ? '' : 's'} failed.</Text>
      ) : null}
      {code ? <Text style={styles.code}>Code: {code}</Text> : null}
      <Text style={styles.action}>{presentation.action}</Text>
      {matrixDelivered ? (
        <Text accessibilityLabel={`Sequence ${event.sequence} delivered to Matrix`} style={styles.delivery}>
          Delivered to Matrix
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#eef6f1', borderColor: '#a9c4b7', borderRadius: 14, borderWidth: 1, gap: 8, padding: 18 },
  eyebrow: { color: '#4c675a', fontSize: 11, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: '#17201c', fontSize: 24, fontWeight: '800' },
  detail: { color: '#3f4944', fontSize: 14 },
  code: { color: '#8a2525', fontFamily: 'monospace', fontSize: 13, fontWeight: '700' },
  action: { color: '#3f4944', fontSize: 14, lineHeight: 20 },
  delivery: { color: '#225c45', fontSize: 13, fontWeight: '800', marginTop: 4 },
});
