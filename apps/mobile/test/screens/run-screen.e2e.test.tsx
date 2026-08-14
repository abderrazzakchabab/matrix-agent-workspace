// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { RunScreen } from '../../src/screens/RunScreen';
import { createRunStore } from '../../src/state/run-store';
import type { RunEventClient } from '../../src/api/run-events';

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

function terminal(runId: string, sequence: number, type: string) {
  return {
    id: `evt_${runId}_${sequence}`,
    runId,
    sequence,
    type,
    version: 1,
    occurredAt: '2026-08-12T12:00:00.000Z',
    payload: type === 'run.failed'
      ? { code: 'PROVIDER_UNAVAILABLE', detail: 'sensitive provider detail' }
      : {},
  };
}

describe('RunScreen flow', () => {
  it('keeps replaying after cancellation and renders one correlated Matrix terminal confirmation', async () => {
    const store = createRunStore();
    const dispose = vi.fn();
    const eventClient: RunEventClient = { connect: vi.fn(() => ({ dispose })) };
    const cancelRun = vi.fn(async () => ({ runId: 'run-1', status: 'cancellation_requested' as const }));
    const getRunMatrixDeliveries = vi.fn(async () => ({
      runId: 'run-1',
      deliveries: [{ sequence: 9, status: 'delivered' as const }],
    }));
    const screen = render(
      <RunScreen
        runId="run-1"
        mode="parallel"
        specialistIds={['repo-reader', 'issue-reader']}
        specialistNames={{ 'repo-reader': 'Repository reader', 'issue-reader': 'Issue reader' }}
        store={store}
        eventClient={eventClient}
        controlPlane={{ cancelRun, getRunMatrixDeliveries }}
      />,
    );

    expect(eventClient.connect).toHaveBeenCalledWith('run-1');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(await screen.findByText('Cancellation requested')).toBeTruthy();
    expect(dispose).not.toHaveBeenCalled();

    expect(store.addEvent({
      ...terminal('run-1', 8, 'run.cancelled'),
      payload: undefined,
    })).toBe(false);
    expect(screen.queryByLabelText('Run Cancelled')).toBeNull();
    expect(store.addEvent(terminal('run-1', 9, 'run.cancelled'))).toBe(true);
    expect(store.addEvent(terminal('run-1', 9, 'run.cancelled'))).toBe(false);

    await waitFor(() => {
      expect(screen.getAllByLabelText('Run Cancelled')).toHaveLength(1);
      expect(screen.getAllByText('Delivered to Matrix')).toHaveLength(1);
    });
    expect(getRunMatrixDeliveries).toHaveBeenCalledWith('run-1');
    expect(screen.getAllByRole('status')).toHaveLength(2); // cancellation request + terminal result
  });

  it('offers a safe retry when cancellation fails and never exposes raw failure detail', async () => {
    const store = createRunStore();
    const cancelRun = vi
      .fn()
      .mockRejectedValueOnce(new Error('network contained sensitive transport detail'))
      .mockResolvedValueOnce({ runId: 'run-2', status: 'cancellation_requested' as const });
    const screen = render(
      <RunScreen
        runId="run-2"
        mode="sequential"
        specialistIds={['repo-reader']}
        specialistNames={{ 'repo-reader': 'Repository reader' }}
        store={store}
        eventClient={{ connect: () => ({ dispose: vi.fn() }) }}
        controlPlane={{
          cancelRun,
          getRunMatrixDeliveries: async () => ({ runId: 'run-2', deliveries: [] }),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Unable to request cancellation');
    expect(screen.queryByText(/sensitive transport detail/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByText('Cancellation requested')).toBeTruthy();
    expect(cancelRun).toHaveBeenCalledTimes(2);

    store.addEvent(terminal('run-2', 3, 'run.failed'));
    await waitFor(() => expect(screen.getByText('Code: PROVIDER_UNAVAILABLE')).toBeTruthy());
    expect(screen.queryByText(/sensitive provider detail/)).toBeNull();
  });
});
