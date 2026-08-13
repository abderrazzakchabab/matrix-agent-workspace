// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(async () => 'matrix_session=expired'),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-secure-store', () => secureStore);
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-random-uuid' }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@react-navigation/native', () => ({
  NavigationContainer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@react-navigation/native-stack', async () => {
  const ReactModule = await import('react');
  return {
    createNativeStackNavigator: () => ({
      Navigator: ({
        children,
        initialRouteName,
      }: {
        children: React.ReactNode;
        initialRouteName?: string;
      }) => {
        const [route, setRoute] = ReactModule.useState(initialRouteName);
        const screens = ReactModule.Children.toArray(children) as React.ReactElement<{
          name: string;
          children(args: { navigation: { navigate(name: string): void; replace(name: string): void } }): React.ReactNode;
        }>[];
        const activeScreen = screens.find((screen) => screen.props.name === route) ?? screens[0];
        const navigation = { navigate: setRoute, replace: setRoute };
        return activeScreen?.props.children({ navigation }) ?? null;
      },
      Screen: () => null,
    }),
  };
});

import { SESSION_COOKIE_KEY } from '../../src/auth/session-store';
import { RootNavigator } from '../../src/navigation/RootNavigator';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('RootNavigator', () => {
  it('clears an expired session and returns to login after an authenticated 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        headers: { get: () => null },
        json: async () => ({
          error: { code: 'SESSION_EXPIRED', message: 'Session expired' },
        }),
      })),
    );
    const screen = render(
      <RootNavigator controlPlaneBaseUrl="https://control.example.test" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Connect your Matrix account')).toBeTruthy();
    });
    expect(secureStore.deleteItemAsync).toHaveBeenCalledWith(SESSION_COOKIE_KEY);
  });
});
