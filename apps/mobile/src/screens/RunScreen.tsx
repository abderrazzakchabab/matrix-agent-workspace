import React, { useCallback, useEffect, useSyncExternalStore, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ControlPlaneApi } from '../api/control-plane';
import type { RunEventClient } from '../api/run-events';
import { RunTimeline } from '../components/RunTimeline';
import { TerminalResult, terminalEvent } from '../components/TerminalResult';
import type { MatrixDeliveryMarker, RunStore } from '../state/run-store';

interface RunScreenProps {
  runId: string;
  mode: 'parallel' | 'sequential';
  specialistIds: readonly string[];
  specialistNames: Readonly<Record<string, string>>;
  store: RunStore;
  eventClient: RunEventClient;
  controlPlane: Pick<ControlPlaneApi, 'cancelRun' | 'getRunMatrixDeliveries'>;
  matrixDeliveryMarkers?: readonly MatrixDeliveryMarker[];
}

type CancellationState = 'idle' | 'pending' | 'requested' | 'error';

const MATRIX_DELIVERY_POLL_MS = 1_000;

export function RunScreen({
  runId,
  mode,
  specialistIds,
  specialistNames,
  store,
  eventClient,
  controlPlane,
  matrixDeliveryMarkers = [],
}: RunScreenProps) {
  const subscribe = useCallback((listener: () => void) => store.subscribe(runId, listener), [runId, store]);
  const getSnapshot = useCallback(() => store.get(runId), [runId, store]);
  const run = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [cancellation, setCancellation] = useState<CancellationState>('idle');
  const terminal = terminalEvent(run);

  useEffect(() => {
    const connection = eventClient.connect(runId);
    return () => connection.dispose();
  }, [eventClient, runId]);

  useEffect(() => {
    for (const marker of matrixDeliveryMarkers) {
      if (marker.runId === runId) store.markMatrixDelivered(marker);
    }
  }, [matrixDeliveryMarkers, runId, store]);

  useEffect(() => {
    let disposed = false;
    let pollHandle: ReturnType<typeof setTimeout> | undefined;

    async function poll(): Promise<void> {
      let terminalDeliverySettled = false;
      try {
        const response = await controlPlane.getRunMatrixDeliveries(runId);
        if (disposed) return;
        if (response.runId === runId) {
          for (const delivery of response.deliveries) {
            if (delivery.status === 'delivered') {
              store.markMatrixDelivered({ runId, sequence: delivery.sequence });
            }
          }
          const currentTerminal = terminalEvent(store.get(runId));
          const terminalDelivery = currentTerminal
            ? response.deliveries.find((delivery) => delivery.sequence === currentTerminal.sequence)
            : undefined;
          terminalDeliverySettled = terminalDelivery !== undefined
            && terminalDelivery.status !== 'pending';
        }
      } catch {
        terminalDeliverySettled = false;
      }
      if (!disposed && !terminalDeliverySettled) {
        pollHandle = setTimeout(() => void poll(), MATRIX_DELIVERY_POLL_MS);
      }
    }

    void poll();
    return () => {
      disposed = true;
      if (pollHandle !== undefined) clearTimeout(pollHandle);
    };
  }, [controlPlane, runId, store]);

  async function requestCancellation(): Promise<void> {
    if (cancellation === 'pending' || cancellation === 'requested' || terminal) return;
    setCancellation('pending');
    try {
      await controlPlane.cancelRun(runId);
      setCancellation('requested');
    } catch {
      setCancellation('error');
    }
  }

  const cancelLabel = cancellation === 'error' ? 'Retry cancellation' : 'Cancel run';
  const cancelDisabled = cancellation === 'pending' || cancellation === 'requested' || terminal !== null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Matrix agent run</Text>
          <Text style={styles.title}>Live progress</Text>
          <Text style={styles.runId}>Run {runId}</Text>
          <Text style={styles.description}>
            Replaying durable events for {specialistIds.length} specialist{specialistIds.length === 1 ? '' : 's'}.
          </Text>
        </View>

        <RunTimeline run={run} mode={mode} specialistNames={specialistNames} />
        <TerminalResult run={run} />

        {cancellation === 'requested' ? (
          <Text role="status" style={styles.requested}>Cancellation requested</Text>
        ) : null}
        {cancellation === 'error' ? (
          <Text role="alert" style={styles.error}>
            Unable to request cancellation. Check your connection and retry.
          </Text>
        ) : null}

        {!terminal ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            accessibilityState={{ disabled: cancelDisabled, busy: cancellation === 'pending' }}
            disabled={cancelDisabled}
            onPress={requestCancellation}
            style={({ pressed }) => [styles.cancelButton, cancelDisabled && styles.disabled, pressed && !cancelDisabled && styles.pressed]}
          >
            {cancellation === 'pending'
              ? <ActivityIndicator color="#8a2525" />
              : <Text style={styles.cancelText}>{cancelLabel}</Text>}
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: '#f7f7f5', flex: 1 },
  content: { gap: 22, padding: 20, paddingBottom: 38 },
  header: { gap: 6 },
  eyebrow: { color: '#4c675a', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  title: { color: '#17201c', fontSize: 30, fontWeight: '800' },
  runId: { color: '#365547', fontFamily: 'monospace', fontSize: 13, fontWeight: '700' },
  description: { color: '#58615d', fontSize: 15, lineHeight: 22, marginTop: 3 },
  requested: { backgroundColor: '#fff7df', borderRadius: 10, color: '#725016', fontSize: 14, fontWeight: '700', padding: 12 },
  error: { backgroundColor: '#fff1f0', borderRadius: 10, color: '#a12c2c', fontSize: 14, lineHeight: 20, padding: 12 },
  cancelButton: { alignItems: 'center', borderColor: '#b95b5b', borderRadius: 10, borderWidth: 1, justifyContent: 'center', minHeight: 48, paddingHorizontal: 18 },
  cancelText: { color: '#8a2525', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
});
