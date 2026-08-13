import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createControlPlaneClient, type RoomBinding } from '../api/control-plane';
import { createRunEventClient } from '../api/run-events';
import { sessionStore } from '../auth/session-store';
import { createMatrixClient } from '../matrix/client';
import { LoginScreen } from '../screens/LoginScreen';
import { RoomBindingScreen } from '../screens/RoomBindingScreen';
import { RunComposerScreen, type SpecialistOption } from '../screens/RunComposerScreen';
import { RunScreen } from '../screens/RunScreen';
import { createRunStore } from '../state/run-store';

type RootStackParams = {
  Login: undefined;
  RoomBinding: undefined;
  RunComposer: undefined;
  Run: undefined;
};

const Stack = createNativeStackNavigator<RootStackParams>();

const specialists: SpecialistOption[] = [
  { id: 'repo-reader', name: 'Repository reader' },
  { id: 'issue-reader', name: 'Issue reader' },
  { id: 'pr-reader', name: 'Pull Request Reader' },
];
const specialistNames = Object.fromEntries(
  specialists.map((specialist) => [specialist.id, specialist.name]),
);

interface ActiveRun {
  runId: string;
  mode: 'parallel' | 'sequential';
  specialistIds: string[];
}

interface RootNavigatorProps {
  controlPlaneBaseUrl?: string;
}

export function RootNavigator({
  controlPlaneBaseUrl = process.env.EXPO_PUBLIC_CONTROL_PLANE_URL ?? 'http://localhost:3000',
}: RootNavigatorProps) {
  const [restoring, setRestoring] = useState(true);
  const [hasSession, setHasSession] = useState(false);
  const [boundRoom, setBoundRoom] = useState<RoomBinding | null>(null);
  const [activeRun, setActiveRun] = useState<ActiveRun | null>(null);
  const runStore = useMemo(() => createRunStore(), []);
  const handleUnauthorized = useCallback(() => {
    setActiveRun(null);
    setBoundRoom(null);
    setHasSession(false);
  }, []);
  const controlPlane = useMemo(
    () => createControlPlaneClient({
      baseUrl: controlPlaneBaseUrl,
      sessionStore,
      onUnauthorized: handleUnauthorized,
    }),
    [controlPlaneBaseUrl, handleUnauthorized],
  );
  const eventClient = useMemo(
    () => createRunEventClient({
      baseUrl: controlPlaneBaseUrl,
      sessionStore,
      store: runStore,
      onUnauthorized: handleUnauthorized,
    }),
    [controlPlaneBaseUrl, handleUnauthorized, runStore],
  );
  const matrixClient = useMemo(() => createMatrixClient(controlPlane), [controlPlane]);

  useEffect(() => {
    let active = true;
    sessionStore
      .load()
      .then((session) => {
        if (active) setHasSession(session !== null);
      })
      .catch(() => {
        if (active) setHasSession(false);
      })
      .finally(() => {
        if (active) setRestoring(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (restoring) {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel="Restoring session" style={styles.loading}>
        <ActivityIndicator color="#225c45" />
        <Text style={styles.loadingText}>Restoring secure session…</Text>
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName={hasSession ? 'RoomBinding' : 'Login'}
        screenOptions={{
          headerBackTitle: 'Back',
          headerShadowVisible: false,
          headerStyle: { backgroundColor: '#f7f7f5' },
          headerTintColor: '#225c45',
          contentStyle: { backgroundColor: '#f7f7f5' },
        }}
      >
        {!hasSession ? (
          <Stack.Screen name="Login" options={{ title: 'Sign in' }}>
            {() => (
              <LoginScreen
                matrixClient={matrixClient}
                onAuthenticated={() => setHasSession(true)}
              />
            )}
          </Stack.Screen>
        ) : null}
        {hasSession ? (
          <Stack.Screen name="RoomBinding" options={{ title: 'Room binding', headerBackVisible: false }}>
            {({ navigation }) => (
              <RoomBindingScreen
                controlPlane={controlPlane}
                onBound={(binding) => {
                  setBoundRoom(binding);
                  navigation.navigate('RunComposer');
                }}
              />
            )}
          </Stack.Screen>
        ) : null}
        {hasSession ? (
          <Stack.Screen name="RunComposer" options={{ title: 'New run' }}>
            {({ navigation }) => (
              <RunComposerScreen
                binding={boundRoom}
                controlPlane={controlPlane}
                specialists={specialists}
                onRunStarted={(run, request) => {
                  setActiveRun({
                    runId: run.runId,
                    mode: request.mode,
                    specialistIds: [...request.specialistIds],
                  });
                  navigation.navigate('Run');
                }}
              />
            )}
          </Stack.Screen>
        ) : null}
        {hasSession ? (
          <Stack.Screen name="Run" options={{ title: 'Run progress' }}>
            {() => activeRun ? (
              <RunScreen
                runId={activeRun.runId}
                mode={activeRun.mode}
                specialistIds={activeRun.specialistIds}
                specialistNames={specialistNames}
                store={runStore}
                eventClient={eventClient}
                controlPlane={controlPlane}
              />
            ) : null}
          </Stack.Screen>
        ) : null}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: { alignItems: 'center', backgroundColor: '#f7f7f5', flex: 1, gap: 12, justifyContent: 'center' },
  loadingText: { color: '#58615d', fontSize: 15 },
});
