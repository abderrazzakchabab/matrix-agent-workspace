import React, { useState } from 'react';
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
import type { MatrixClient } from '../matrix/client';

interface LoginScreenProps {
  matrixClient: MatrixClient;
  onAuthenticated(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to sign in. Check your details and retry.';
}

export function LoginScreen({ matrixClient, onAuthenticated }: LoginScreenProps) {
  const [homeserverUrl, setHomeserverUrl] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = homeserverUrl.trim().length > 0 && accessToken.length > 0 && !loading;

  async function submit() {
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      await matrixClient.login({ homeserverUrl, accessToken });
      setAccessToken('');
      onAuthenticated();
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
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.header}>
            <Text style={styles.eyebrow}>Matrix Agent Workspace</Text>
            <Text style={styles.title}>Connect your Matrix account</Text>
            <Text style={styles.body}>
              Your Matrix token is exchanged for an opaque control-plane session and is not stored on this device.
            </Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.label}>Homeserver URL</Text>
            <TextInput
              accessibilityLabel="Homeserver URL"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              placeholder="https://matrix.example.com"
              style={styles.input}
              value={homeserverUrl}
              onChangeText={setHomeserverUrl}
            />
            <Text style={styles.label}>Matrix access token</Text>
            <TextInput
              accessibilityLabel="Matrix access token"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              placeholder="Access token"
              style={styles.input}
              value={accessToken}
              onChangeText={setAccessToken}
            />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityState={{ disabled: !canSubmit, busy: loading }}
              disabled={!canSubmit}
              onPress={submit}
              style={({ pressed }) => [
                styles.primaryButton,
                !canSubmit && styles.disabled,
                pressed && canSubmit && styles.pressed,
              ]}
            >
              {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.primaryText}>Sign in</Text>}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  safeArea: { flex: 1, backgroundColor: '#f7f7f5' },
  content: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 32 },
  header: { gap: 10 },
  eyebrow: { color: '#425b50', fontSize: 13, fontWeight: '700', letterSpacing: 0.8, textTransform: 'uppercase' },
  title: { color: '#17201c', fontSize: 30, fontWeight: '700', lineHeight: 36 },
  body: { color: '#58615d', fontSize: 16, lineHeight: 23 },
  form: { gap: 10 },
  label: { color: '#26312c', fontSize: 14, fontWeight: '600', marginTop: 6 },
  input: { backgroundColor: '#ffffff', borderColor: '#cbd1ce', borderRadius: 10, borderWidth: 1, color: '#17201c', fontSize: 16, paddingHorizontal: 14, paddingVertical: 13 },
  error: { color: '#a12c2c', fontSize: 14, lineHeight: 20, marginTop: 4 },
  primaryButton: { alignItems: 'center', backgroundColor: '#225c45', borderRadius: 10, justifyContent: 'center', marginTop: 12, minHeight: 50, paddingHorizontal: 18 },
  primaryText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.82 },
});
