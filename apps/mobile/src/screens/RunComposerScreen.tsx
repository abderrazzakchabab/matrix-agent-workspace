import React, { useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RunRequestType, RunResponseType } from '@matrix/contracts';
import type { ControlPlaneApi, RoomBinding } from '../api/control-plane';

export interface SpecialistOption {
  id: string;
  name: string;
}

interface RunComposerScreenProps {
  binding: RoomBinding | null;
  controlPlane: Pick<ControlPlaneApi, 'launchRun'>;
  specialists: SpecialistOption[];
  createIdempotencyKey?: () => string;
  onRunStarted?(run: RunResponseType, request: RunRequestType): void;
}

type ExecutionMode = RunRequestType['mode'];

const defaultIdempotencyKey = () => `mobile_${Crypto.randomUUID()}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to start the run. Check the form and retry.';
}

function requestFingerprint(workspaceId: string, request: RunRequestType): string {
  return JSON.stringify({ workspaceId, request });
}

export function RunComposerScreen({
  binding,
  controlPlane,
  specialists,
  createIdempotencyKey = defaultIdempotencyKey,
  onRunStarted,
}: RunComposerScreenProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [mode, setMode] = useState<ExecutionMode | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queuedRun, setQueuedRun] = useState<RunResponseType | null>(null);
  const pendingLaunch = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  const canSubmit = Boolean(
    binding && prompt.trim().length > 0 && selectedIds.length > 0 && mode && !loading,
  );

  function toggleSpecialist(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id],
    );
  }

  async function submit() {
    if (!canSubmit || !binding || !mode) return;
    setLoading(true);
    setError(null);
    setQueuedRun(null);
    const request: RunRequestType = {
      prompt: prompt.trim(),
      mode,
      specialistIds: selectedIds,
      roomId: binding.roomId,
    };
    try {
      const fingerprint = requestFingerprint(binding.workspaceId, request);
      const requestIdempotencyKey = pendingLaunch.current?.fingerprint === fingerprint
        ? pendingLaunch.current.idempotencyKey
        : createIdempotencyKey();
      pendingLaunch.current = { fingerprint, idempotencyKey: requestIdempotencyKey };
      const run = await controlPlane.launchRun(binding.workspaceId, request, requestIdempotencyKey);
      pendingLaunch.current = null;
      setQueuedRun(run);
      onRunStarted?.(run, request);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <Text style={styles.title}>Start a specialist run</Text>
            <Text style={styles.body}>Choose the work and how the read-only specialists should execute.</Text>
          </View>

          {!binding ? (
            <Text accessibilityRole="alert" style={styles.errorPanel}>
              Bind a room before starting a run.
            </Text>
          ) : (
            <View style={styles.bindingCard}>
              <Text style={styles.bindingLabel}>Bound destination</Text>
              <Text style={styles.bindingValue}>{binding.roomId}</Text>
              <Text style={styles.bindingMeta}>{binding.workspaceId}</Text>
            </View>
          )}

          <View style={styles.section}>
            <Text style={styles.label}>Prompt</Text>
            <TextInput
              accessibilityLabel="Run prompt"
              multiline
              placeholder="Describe what the specialists should investigate"
              style={[styles.input, styles.promptInput]}
              textAlignVertical="top"
              value={prompt}
              onChangeText={setPrompt}
            />
          </View>

          <View style={styles.section} accessibilityRole="radiogroup">
            <Text style={styles.sectionTitle}>Execution mode</Text>
            <View style={styles.modeRow}>
              {(['parallel', 'sequential'] as const).map((value) => {
                const selected = mode === value;
                const label = value === 'parallel' ? 'Parallel' : 'Sequential';
                return (
                  <Pressable
                    key={value}
                    accessibilityRole="radio"
                    accessibilityLabel={label}
                    accessibilityState={{ checked: selected }}
                    onPress={() => setMode(value)}
                    style={({ pressed }) => [styles.modeChoice, selected && styles.choiceSelected, pressed && styles.pressed]}
                  >
                    <Text style={[styles.modeText, selected && styles.modeTextSelected]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Specialists</Text>
            {specialists.map((specialist) => {
              const checked = selectedIds.includes(specialist.id);
              return (
                <Pressable
                  key={specialist.id}
                  accessibilityRole="checkbox"
                  accessibilityLabel={specialist.name}
                  accessibilityState={{ checked }}
                  onPress={() => toggleSpecialist(specialist.id)}
                  style={({ pressed }) => [styles.specialistChoice, checked && styles.choiceSelected, pressed && styles.pressed]}
                >
                  <View style={[styles.checkbox, checked && styles.checkboxSelected]}>
                    <Text style={styles.checkmark}>{checked ? '✓' : ''}</Text>
                  </View>
                  <View>
                    <Text style={styles.choiceTitle}>{specialist.name}</Text>
                    <Text style={styles.choiceMeta}>{specialist.id}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          {error ? <Text accessibilityRole="alert" style={styles.errorPanel}>{error}</Text> : null}
          {queuedRun ? (
            <Text role="status" style={styles.statusPanel}>Run queued: {queuedRun.runId}</Text>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start run"
            accessibilityState={canSubmit ? undefined : { disabled: true, busy: loading }}
            disabled={!canSubmit}
            onPress={submit}
            style={({ pressed }) => [styles.primaryButton, !canSubmit && styles.disabled, pressed && canSubmit && styles.pressed]}
          >
            {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryText}>Start run</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#f7f7f5' },
  content: { padding: 20, paddingBottom: 36, gap: 22 },
  header: { gap: 8 },
  title: { color: '#17201c', fontSize: 28, fontWeight: '700' },
  body: { color: '#58615d', fontSize: 15, lineHeight: 22 },
  bindingCard: { backgroundColor: '#eef6f1', borderColor: '#bdd2c7', borderRadius: 10, borderWidth: 1, gap: 3, padding: 12 },
  bindingLabel: { color: '#425b50', fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  bindingValue: { color: '#17201c', fontSize: 14, fontWeight: '600' },
  bindingMeta: { color: '#68716d', fontSize: 12 },
  section: { gap: 10 },
  sectionTitle: { color: '#26312c', fontSize: 18, fontWeight: '700' },
  label: { color: '#26312c', fontSize: 14, fontWeight: '600' },
  input: { backgroundColor: '#ffffff', borderColor: '#cbd1ce', borderRadius: 10, borderWidth: 1, color: '#17201c', fontSize: 16, paddingHorizontal: 14, paddingVertical: 13 },
  promptInput: { minHeight: 132 },
  modeRow: { flexDirection: 'row', gap: 10 },
  modeChoice: { alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 10, borderWidth: 1, flex: 1, minHeight: 48, justifyContent: 'center' },
  modeText: { color: '#4c5651', fontSize: 15, fontWeight: '600' },
  modeTextSelected: { color: '#225c45' },
  specialistChoice: { alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 12, minHeight: 60, padding: 12 },
  choiceSelected: { backgroundColor: '#eef6f1', borderColor: '#225c45', borderWidth: 2 },
  checkbox: { alignItems: 'center', borderColor: '#8e9893', borderRadius: 4, borderWidth: 2, height: 22, justifyContent: 'center', width: 22 },
  checkboxSelected: { backgroundColor: '#225c45', borderColor: '#225c45' },
  checkmark: { color: '#ffffff', fontSize: 14, fontWeight: '700' },
  choiceTitle: { color: '#17201c', fontSize: 15, fontWeight: '600' },
  choiceMeta: { color: '#68716d', fontSize: 12, marginTop: 2 },
  errorPanel: { backgroundColor: '#fff1f0', borderRadius: 10, color: '#a12c2c', fontSize: 14, lineHeight: 20, padding: 12 },
  statusPanel: { backgroundColor: '#eef6f1', borderRadius: 10, color: '#225c45', fontSize: 14, fontWeight: '600', padding: 12 },
  primaryButton: { alignItems: 'center', backgroundColor: '#225c45', borderRadius: 10, justifyContent: 'center', minHeight: 50, paddingHorizontal: 18 },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.82 },
});
