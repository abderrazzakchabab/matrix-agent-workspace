// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

const secureStore = vi.hoisted(() => ({
  getItemAsync: vi.fn(async () => 'matrix_session=expired'),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('expo-secure-store', () => secureStore);
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-random-uuid' }));
vi.mock('expo/fetch', () => ({
  fetch: (input: string, init?: RequestInit) => globalThis.fetch(input, init),
}));
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

  it('selects Pull Request Reader and submits it through the composer', async () => {
    const fetchMock = vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const path = new URL(input).pathname;
      if (path === '/api/rooms' && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            rooms: [{
              roomId: '!room:example.test',
              homeserverUrl: 'https://matrix.example.test',
              displayName: 'Agent room',
              workspaceId: null,
            }],
          }),
        };
      }
      if (path === '/api/rooms/!room%3Aexample.test/binding' && init?.method === 'POST') {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ roomId: '!room:example.test', workspaceId: 'ws_1' }),
        };
      }
      if (path === '/api/workspaces/ws_1/runs' && init?.method === 'POST') {
        return {
          ok: true,
          status: 202,
          headers: { get: () => null },
          json: async () => ({
            runId: 'run_1',
            status: 'queued',
            roomId: '!room:example.test',
            nextSequence: 1,
          }),
        };
      }
      if (path === '/api/runs/run_1' && (!init?.method || init.method === 'GET')) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            runId: 'run_1',
            matrixDeliveries: [{ sequence: 1, status: 'delivered' }],
          }),
        };
      }
      if (path === '/api/runs/run_1/events' && init?.method === 'GET') {
        const event = {
          id: 'evt_run_1_1',
          runId: 'run_1',
          sequence: 1,
          type: 'run.completed',
          version: 1,
          occurredAt: '2026-08-12T12:00:00.000Z',
          visibility: 'room_and_owner',
          payload: {},
        };
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          body: null,
          text: async () => `id: 1\nevent: run.completed\ndata: ${JSON.stringify(event)}\n\n`,
          json: async () => ({}),
        };
      }
      throw new Error(`Unexpected request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const screen = render(
      <RootNavigator controlPlaneBaseUrl="https://control.example.test" />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Select room Agent room' }));
    fireEvent.change(screen.getByLabelText('Workspace ID'), { target: { value: 'ws_1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Bind room' }));

    fireEvent.change(await screen.findByLabelText('Run prompt'), {
      target: { value: 'Review open pull requests' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pull Request Reader' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Sequential' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => {
      const launch = fetchMock.mock.calls.find(([input]) =>
        new URL(input).pathname === '/api/workspaces/ws_1/runs',
      );
      expect(launch).toBeDefined();
      expect(JSON.parse(launch?.[1]?.body ?? '{}')).toEqual({
        prompt: 'Review open pull requests',
        mode: 'sequential',
        specialistIds: ['pr-reader'],
        roomId: '!room:example.test',
        idempotencyKey: 'mobile_test-random-uuid',
      });
    });
    expect(await screen.findByText('Live progress')).toBeTruthy();
    expect(await screen.findByLabelText('Run Completed')).toBeTruthy();
    expect(await screen.findAllByText('Delivered to Matrix')).toHaveLength(1);
  });
});
