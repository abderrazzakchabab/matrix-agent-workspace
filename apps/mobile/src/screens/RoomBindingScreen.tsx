import React, { useCallback, useEffect, useState } from 'react';
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
import type { ControlPlaneApi, RoomBinding, RoomSummary } from '../api/control-plane';

interface RoomBindingScreenProps {
  controlPlane: Pick<ControlPlaneApi, 'getRooms' | 'bindRoom'>;
  onBound(binding: RoomBinding): void;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function RoomBindingScreen({ controlPlane, onBound }: RoomBindingScreenProps) {
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [workspaceId, setWorkspaceId] = useState('');
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [binding, setBinding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canBind = selectedRoomId !== null && workspaceId.trim().length > 0 && !binding;

  const loadRooms = useCallback(async () => {
    setLoadingRooms(true);
    setError(null);
    try {
      setRooms(await controlPlane.getRooms());
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to load rooms. Retry when the control plane is available.'));
    } finally {
      setLoadingRooms(false);
    }
  }, [controlPlane]);

  useEffect(() => {
    void loadRooms();
  }, [loadRooms]);

  async function submitBinding() {
    if (!canBind || !selectedRoomId) return;
    setBinding(true);
    setError(null);
    const selectedWorkspaceId = workspaceId.trim();
    try {
      const result = await controlPlane.bindRoom(selectedRoomId, selectedWorkspaceId);
      onBound({ roomId: result.roomId, workspaceId: result.workspaceId });
    } catch (cause) {
      setError(errorMessage(cause, 'Unable to bind this room. Verify membership and workspace access.'));
    } finally {
      setBinding(false);
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
            <Text style={styles.title}>Bind a Matrix room</Text>
            <Text style={styles.body}>
              Choose one room and enter the provisioned workspace it should use. Nothing is selected automatically.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Room</Text>
            {loadingRooms ? (
              <View accessibilityRole="progressbar" accessibilityLabel="Loading rooms" style={styles.loading}>
                <ActivityIndicator color="#225c45" />
                <Text style={styles.muted}>Loading your joined rooms…</Text>
              </View>
            ) : null}
            {!loadingRooms && rooms.length === 0 && !error ? (
              <View style={styles.emptyState}>
                <Text style={styles.muted}>No joined rooms are available. Join a Matrix room, then refresh.</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Refresh rooms"
                  onPress={loadRooms}
                >
                  <Text style={styles.refresh}>Refresh rooms</Text>
                </Pressable>
              </View>
            ) : null}
            {rooms.map((room) => {
              const selected = selectedRoomId === room.roomId;
              const name = room.displayName ?? room.roomId;
              return (
                <Pressable
                  key={room.roomId}
                  accessibilityRole="button"
                  accessibilityLabel={`Select room ${name}`}
                  accessibilityState={{ selected }}
                  onPress={() => setSelectedRoomId(room.roomId)}
                  style={({ pressed }) => [
                    styles.choice,
                    selected && styles.choiceSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={[styles.radioMark, selected && styles.radioMarkSelected]} />
                  <View style={styles.choiceText}>
                    <Text style={styles.choiceTitle}>{name}</Text>
                    <Text style={styles.roomId}>{room.roomId}</Text>
                  </View>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Workspace</Text>
            <Text style={styles.label}>Workspace ID</Text>
            <TextInput
              accessibilityLabel="Workspace ID"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws_…"
              style={styles.input}
              value={workspaceId}
              onChangeText={setWorkspaceId}
            />
          </View>

          {error ? (
            <View style={styles.errorPanel}>
              <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
              {rooms.length === 0 ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Retry loading rooms" onPress={loadRooms}>
                  <Text style={styles.retry}>Retry loading rooms</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Bind room"
            accessibilityState={canBind ? undefined : { disabled: true, busy: binding }}
            disabled={!canBind}
            onPress={submitBinding}
            style={({ pressed }) => [styles.primaryButton, !canBind && styles.disabled, pressed && canBind && styles.pressed]}
          >
            {binding ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryText}>Bind room</Text>}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#f7f7f5' },
  content: { padding: 20, paddingBottom: 36, gap: 24 },
  header: { gap: 8 },
  title: { color: '#17201c', fontSize: 28, fontWeight: '700' },
  body: { color: '#58615d', fontSize: 15, lineHeight: 22 },
  section: { gap: 10 },
  sectionTitle: { color: '#26312c', fontSize: 18, fontWeight: '700' },
  label: { color: '#26312c', fontSize: 14, fontWeight: '600' },
  input: { backgroundColor: '#ffffff', borderColor: '#cbd1ce', borderRadius: 10, borderWidth: 1, color: '#17201c', fontSize: 16, paddingHorizontal: 14, paddingVertical: 13 },
  loading: { alignItems: 'center', flexDirection: 'row', gap: 10, paddingVertical: 12 },
  muted: { color: '#68716d', fontSize: 14, lineHeight: 20 },
  emptyState: { gap: 8 },
  refresh: { color: '#225c45', fontSize: 14, fontWeight: '700' },
  choice: { alignItems: 'center', backgroundColor: '#ffffff', borderColor: '#d7dcda', borderRadius: 10, borderWidth: 1, flexDirection: 'row', gap: 12, minHeight: 68, padding: 12 },
  choiceSelected: { backgroundColor: '#eef6f1', borderColor: '#225c45', borderWidth: 2 },
  radioMark: { borderColor: '#8e9893', borderRadius: 9, borderWidth: 2, height: 18, width: 18 },
  radioMarkSelected: { backgroundColor: '#225c45', borderColor: '#225c45' },
  choiceText: { flex: 1, gap: 3 },
  choiceTitle: { color: '#17201c', fontSize: 16, fontWeight: '600' },
  roomId: { color: '#68716d', fontSize: 12 },
  errorPanel: { backgroundColor: '#fff1f0', borderRadius: 10, gap: 8, padding: 12 },
  error: { color: '#a12c2c', fontSize: 14, lineHeight: 20 },
  retry: { color: '#225c45', fontSize: 14, fontWeight: '700' },
  primaryButton: { alignItems: 'center', backgroundColor: '#225c45', borderRadius: 10, justifyContent: 'center', minHeight: 50, paddingHorizontal: 18 },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.82 },
});
