// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { RunTimeline } from '../../src/components/RunTimeline';
import { TerminalResult } from '../../src/components/TerminalResult';
import { createRunStore } from '../../src/state/run-store';

afterEach(cleanup);

function add(
  store: ReturnType<typeof createRunStore>,
  sequence: number,
  type: string,
  payload: Record<string, unknown> = {},
) {
  store.addEvent({
    id: `evt_run-1_${sequence}`,
    runId: 'run-1',
    sequence,
    type,
    version: 1,
    occurredAt: `2026-08-12T12:00:0${sequence}.000Z`,
    payload,
  });
}

describe('RunTimeline', () => {
  it.each(['parallel', 'sequential'] as const)(
    'renders one accessible sequenced row with clear status for every %s event',
    (mode) => {
      const store = createRunStore();
      add(store, 1, 'run.started', { mode });
      add(store, 2, 'specialist.started', { specialistId: 'repo-reader' });
      add(store, 3, 'specialist.completed', { specialistId: 'repo-reader', summary: 'done' });
      add(store, 4, 'specialist.failed', { specialistId: 'issue-reader', errorCode: 'PROVIDER_UNAVAILABLE' });

      const screen = render(
        <RunTimeline
          mode={mode}
          run={store.get('run-1')}
          specialistNames={{ 'repo-reader': 'Repository reader', 'issue-reader': 'Issue reader' }}
        />,
      );

      expect(screen.getByLabelText(`${mode === 'parallel' ? 'Parallel' : 'Sequential'} execution timeline`)).toBeTruthy();
      expect(screen.getAllByRole('listitem')).toHaveLength(4);
      expect(screen.getByLabelText('Sequence 2, Repository reader, Running')).toBeTruthy();
      expect(screen.getByLabelText('Sequence 3, Repository reader, Succeeded')).toBeTruthy();
      expect(screen.getByLabelText('Sequence 4, Issue reader, Failed')).toBeTruthy();
    },
  );

  it.each([
    ['run.completed', 'Completed'],
    ['run.partial', 'Partially completed'],
    ['run.failed', 'Failed'],
    ['run.cancelled', 'Cancelled'],
  ])('renders exactly one terminal result for %s', (type, label) => {
    const store = createRunStore();
    add(store, 1, type, {
      code: type === 'run.failed' ? 'PROVIDER_UNAVAILABLE' : undefined,
      failedSpecialists: type === 'run.partial' ? ['issue-reader'] : undefined,
    });
    store.markMatrixDelivered({ runId: 'run-1', sequence: 1 });

    const screen = render(<TerminalResult run={store.get('run-1')} />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getAllByText('Delivered to Matrix')).toHaveLength(1);
    if (type === 'run.failed') {
      expect(screen.getByText('Code: PROVIDER_UNAVAILABLE')).toBeTruthy();
      expect(screen.getByText(/retry the run/i)).toBeTruthy();
    }
  });

  it('keeps completed copy neutral until Matrix delivery is confirmed', () => {
    const store = createRunStore();
    add(store, 1, 'run.completed');

    const screen = render(<TerminalResult run={store.get('run-1')} />);

    expect(screen.getByText('The final result is available for this run.')).toBeTruthy();
    expect(screen.queryByText(/bound Matrix room/i)).toBeNull();
    expect(screen.queryByText('Delivered to Matrix')).toBeNull();
  });

  it('correlates a Matrix marker that arrives before its SSE event', () => {
    const store = createRunStore();
    store.get('run-1');
    expect(store.markMatrixDelivered({ runId: 'run-1', sequence: 1 })).toBe(false);
    add(store, 1, 'run.completed');

    const screen = render(<TerminalResult run={store.get('run-1')} />);
    expect(screen.getAllByText('Delivered to Matrix')).toHaveLength(1);
  });

  it('does not turn a Matrix marker into a second result or attach it to another run', () => {
    const store = createRunStore();
    add(store, 1, 'run.completed');
    expect(store.markMatrixDelivered({ runId: 'other-run', sequence: 1 })).toBe(false);
    expect(store.markMatrixDelivered({ runId: 'run-1', sequence: 2 })).toBe(false);
    expect(store.markMatrixDelivered({ runId: 'run-1', sequence: 1 })).toBe(true);

    const screen = render(<TerminalResult run={store.get('run-1')} />);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getAllByText('Completed')).toHaveLength(1);
    expect(screen.getAllByText('Delivered to Matrix')).toHaveLength(1);
  });
});
