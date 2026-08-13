// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-random-uuid' }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RunComposerScreen } from '../../src/screens/RunComposerScreen';

afterEach(cleanup);

const binding = {
  roomId: '!room:example.test',
  workspaceId: 'ws_1',
};
const specialists = [
  { id: 'repo-reader', name: 'Repository reader' },
  { id: 'issue-reader', name: 'Issue reader' },
];

describe('RunComposerScreen', () => {
  it('requires a bound room, prompt, specialist, and explicit execution mode', () => {
    const controlPlane = { launchRun: vi.fn() };
    const screen = render(
      <RunComposerScreen
        binding={null}
        controlPlane={controlPlane}
        specialists={specialists}
        createIdempotencyKey={() => 'mobile-fixed'}
      />,
    );

    const startButton = screen.getByRole('button', { name: 'Start run' });
    expect(startButton.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'Bind a room before starting a run',
    );

    screen.rerender(
      <RunComposerScreen
        binding={binding}
        controlPlane={controlPlane}
        specialists={specialists}
        createIdempotencyKey={() => 'mobile-fixed'}
      />,
    );
    fireEvent.change(screen.getByLabelText('Run prompt'), {
      target: { value: 'Review the repository' },
    });
    expect(startButton.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Repository reader' }));
    expect(startButton.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: 'Parallel' }));
    expect(startButton.getAttribute('aria-disabled')).toBeNull();
  });

  it('submits the exact run request with an idempotency key', async () => {
    const controlPlane = {
      launchRun: vi.fn(async () => ({
        runId: 'run_1',
        status: 'queued' as const,
        roomId: '!room:example.test',
        nextSequence: 1,
      })),
    };
    const screen = render(
      <RunComposerScreen
        binding={binding}
        controlPlane={controlPlane}
        specialists={specialists}
        createIdempotencyKey={() => 'mobile-fixed'}
      />,
    );

    fireEvent.change(screen.getByLabelText('Run prompt'), {
      target: { value: 'Review the repository' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repository reader' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Sequential' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => {
      expect(controlPlane.launchRun).toHaveBeenCalledWith(
        'ws_1',
        {
          prompt: 'Review the repository',
          mode: 'sequential',
          specialistIds: ['repo-reader'],
          roomId: '!room:example.test',
        },
        'mobile-fixed',
      );
    });
    expect((await screen.findByRole('status')).textContent).toContain('Run queued');
  });

  it('preserves the idempotency key when a launch is retried', async () => {
    const controlPlane = {
      launchRun: vi
        .fn()
        .mockRejectedValueOnce(new Error('Control plane unavailable'))
        .mockResolvedValueOnce({
          runId: 'run_1',
          status: 'queued' as const,
          roomId: '!room:example.test',
          nextSequence: 1,
        }),
    };
    const screen = render(
      <RunComposerScreen
        binding={binding}
        controlPlane={controlPlane}
        specialists={specialists}
        createIdempotencyKey={() => 'mobile-retry'}
      />,
    );

    fireEvent.change(screen.getByLabelText('Run prompt'), {
      target: { value: 'Review the repository' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repository reader' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Parallel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Control plane unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(controlPlane.launchRun).toHaveBeenCalledTimes(2));
    expect(controlPlane.launchRun.mock.calls.map((call) => call[2])).toEqual([
      'mobile-retry',
      'mobile-retry',
    ]);
  });

  it('rotates the idempotency key after a successful launch', async () => {
    const controlPlane = {
      launchRun: vi.fn(async (
        _workspaceId: string,
        request: { prompt: string },
        _idempotencyKey: string,
      ) => ({
        runId: request.prompt === 'First request' ? 'run_1' : 'run_2',
        status: 'queued' as const,
        roomId: '!room:example.test',
        nextSequence: 1,
      })),
    };
    const createIdempotencyKey = vi
      .fn()
      .mockReturnValueOnce('mobile-first')
      .mockReturnValueOnce('mobile-second')
      .mockReturnValue('mobile-unexpected');
    const screen = render(
      <RunComposerScreen
        binding={binding}
        controlPlane={controlPlane}
        specialists={specialists}
        createIdempotencyKey={createIdempotencyKey}
      />,
    );

    fireEvent.change(screen.getByLabelText('Run prompt'), {
      target: { value: 'First request' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Repository reader' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Sequential' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));
    await waitFor(() => expect(controlPlane.launchRun).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Run prompt'), {
      target: { value: 'Second request' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }));

    await waitFor(() => expect(controlPlane.launchRun).toHaveBeenCalledTimes(2));
    expect(controlPlane.launchRun.mock.calls.map((call) => call[2])).toEqual([
      'mobile-first',
      'mobile-second',
    ]);
    expect(createIdempotencyKey).toHaveBeenCalledTimes(2);
  });
});
