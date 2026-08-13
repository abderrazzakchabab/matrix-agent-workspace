// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RoomBindingScreen } from '../../src/screens/RoomBindingScreen';

afterEach(cleanup);

const rooms = [
  {
    roomId: '!room:example.test',
    homeserverUrl: 'https://matrix.example.test',
    displayName: 'Agent room',
    workspaceId: null,
  },
  {
    roomId: '!other:example.test',
    homeserverUrl: 'https://matrix.example.test',
    displayName: 'Other room',
    workspaceId: null,
  },
];

describe('RoomBindingScreen', () => {
  it('requires explicit room and workspace selection and binds exactly those values', async () => {
    const controlPlane = {
      getRooms: vi.fn(async () => rooms),
      bindRoom: vi.fn(async () => ({
        roomId: '!room:example.test',
        workspaceId: 'ws_1',
      })),
    };
    const onBound = vi.fn();
    const screen = render(
      <RoomBindingScreen controlPlane={controlPlane} onBound={onBound} />,
    );

    expect(await screen.findByRole('button', { name: 'Select room Agent room' })).toBeTruthy();
    const bindButton = screen.getByRole('button', { name: 'Bind room' });
    expect(bindButton.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByLabelText('Workspace ID'), {
      target: { value: 'ws_1' },
    });
    expect(bindButton.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Select room Agent room' }));
    expect(bindButton.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(bindButton);

    await waitFor(() => {
      expect(controlPlane.bindRoom).toHaveBeenCalledWith('!room:example.test', 'ws_1');
    });
    expect(onBound).toHaveBeenCalledWith({
      roomId: '!room:example.test',
      workspaceId: 'ws_1',
    });
  });

  it('refreshes a successful empty-room response with loading feedback', async () => {
    let resolveRefresh: (value: typeof rooms) => void = () => undefined;
    const controlPlane = {
      getRooms: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockImplementationOnce(
          () => new Promise<typeof rooms>((resolve) => {
            resolveRefresh = resolve;
          }),
        ),
      bindRoom: vi.fn(),
    };
    const screen = render(
      <RoomBindingScreen controlPlane={controlPlane} onBound={vi.fn()} />,
    );

    expect(await screen.findByText('No joined rooms are available. Join a Matrix room, then refresh.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rooms' }));

    expect(await screen.findByRole('progressbar', { name: 'Loading rooms' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Refresh rooms' })).toBeNull();

    await act(async () => resolveRefresh(rooms));

    expect(await screen.findByRole('button', { name: 'Select room Agent room' })).toBeTruthy();
    expect(controlPlane.getRooms).toHaveBeenCalledTimes(2);
  });

  it('shows an actionable room-loading error', async () => {
    const controlPlane = {
      getRooms: vi.fn(async () => {
        throw new Error('Control plane unavailable');
      }),
      bindRoom: vi.fn(),
    };
    const screen = render(
      <RoomBindingScreen controlPlane={controlPlane} onBound={vi.fn()} />,
    );

    expect((await screen.findByRole('alert')).textContent).toContain('Control plane unavailable');
    expect(screen.getByRole('button', { name: 'Retry loading rooms' })).toBeTruthy();
  });
});
