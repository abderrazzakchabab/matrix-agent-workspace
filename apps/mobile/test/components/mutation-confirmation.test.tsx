// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'test-random-uuid',
  digestStringAsync: async () => 'test-command-hash',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
}));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { MutationConfirmation } from '../../src/components/MutationConfirmation';
import { GitHubWorkspaceScreen } from '../../src/screens/GitHubWorkspaceScreen';
import { ControlPlaneError } from '../../src/api/control-plane';

afterEach(cleanup);

const issue6 = {
  id: 6001,
  number: 6,
  title: 'First issue',
  state: 'closed',
  author: 'octo',
  labels: ['bug'],
  htmlUrl: 'https://github.example/acme/widget/issues/6',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    repository: 'acme/widget',
    scope: 'issues:write' as const,
    operation: 'create_issue' as const,
    argumentsSummary: [
      { name: 'title', value: 'Add workspace badge' },
      { name: 'body', value: 'Body text' },
    ],
    status: 'idle' as const,
    onConfirm: vi.fn(),
    ...overrides,
  };
}

describe('MutationConfirmation', () => {
  it('shows the exact scope, repository, and normalized-argument summary before any mutation', () => {
    const screen = render(<MutationConfirmation {...baseProps()} />);

    expect(screen.getByText('acme/widget · issues:write')).toBeTruthy();
    expect(screen.getByText('Create issue')).toBeTruthy();
    expect(screen.getByText('title')).toBeTruthy();
    expect(screen.getByText('Add workspace badge')).toBeTruthy();
    expect(screen.getByText('body')).toBeTruthy();
    expect(
      screen.getByText('I confirm create issue on acme/widget (issues:write)'),
    ).toBeTruthy();
  });

  it('requires an explicit confirm press and disables confirmation after submission', () => {
    const onConfirm = vi.fn();
    const idle = render(<MutationConfirmation {...baseProps({ onConfirm })} />);
    const confirm = idle.getByRole('button', { name: 'Confirm create issue' });
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    idle.unmount();

    const submitting = render(
      <MutationConfirmation {...baseProps({ onConfirm, status: 'submitting' })} />,
    );
    const busy = submitting.getByRole('button', { name: 'Confirm create issue' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(busy);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('keeps confirmation disabled after success and offers an explicit recorded-result check', () => {
    const onConfirm = vi.fn();
    const onVerify = vi.fn();
    const screen = render(
      <MutationConfirmation
        {...baseProps({ onConfirm, onVerify, status: 'succeeded', commandId: 'gcmd_1' })}
      />,
    );

    const confirm = screen.getByRole('button', { name: 'Confirm create issue' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Mutation completed');
    expect(screen.getByRole('status').textContent).toContain('gcmd_1');

    fireEvent.click(screen.getByRole('button', { name: 'Verify recorded result' }));
    expect(onVerify).toHaveBeenCalledTimes(1);
  });

  it('announces denial, expiry, failure, and duplicate outcomes accessibly and allows retry', () => {
    const cases = [
      { status: 'denied' as const, pattern: /Mutation denied/i },
      { status: 'expired' as const, pattern: /approval expired/i },
      { status: 'failed' as const, pattern: /mutation failed/i },
      { status: 'duplicate' as const, pattern: /already submitted/i },
    ];
    for (const { status, pattern } of cases) {
      const screen = render(<MutationConfirmation {...baseProps({ status })} />);
      const message = status === 'duplicate'
        ? screen.getByRole('status')
        : screen.getByRole('alert');
      expect(message.textContent).toMatch(pattern);
      // Failure states keep the confirmation action available for an explicit retry.
      const confirm = screen.getByRole('button', { name: 'Confirm create issue' });
      expect(confirm.getAttribute('aria-disabled')).toBeNull();
      screen.unmount();
    }
  });
});

function createMutationApi(overrides: Record<string, unknown> = {}) {
  return {
    listGithubRepositories: vi.fn(async () => ({ items: [] })),
    listGithubIssues: vi.fn(async () => ({ items: [issue6] })),
    listGithubPullRequests: vi.fn(async () => ({ items: [] })),
    requestGithubWriteGrant: vi.fn(async () => ({
      grantId: 'grt_1',
      status: 'approved' as const,
      repository: 'acme/widget',
      scope: 'issues:write' as const,
    })),
    createRunApproval: vi.fn(async () => ({
      approvalId: 'apr_1',
      status: 'approved' as const,
      expiresAt: '2026-08-12T12:15:00.000Z',
      scope: 'issues:write' as const,
    })),
    enqueueGithubMutation: vi.fn(async () => ({
      commandId: 'gcmd_1',
      status: 'completed' as const,
      replayed: false,
    })),
    listAuditRecords: vi.fn(async () => ({ items: [] })),
    ...overrides,
  };
}

async function openReview(screen: ReturnType<typeof render>) {
  expect(await screen.findByText('Issue #6')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Request write access' }));
  await screen.findByLabelText('Issue title');
  fireEvent.change(screen.getByLabelText('Issue title'), {
    target: { value: 'Add workspace badge' },
  });
  fireEvent.change(screen.getByLabelText('Issue body'), {
    target: { value: 'Details' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Review create issue' }));
  await screen.findByRole('button', { name: 'Confirm create issue' });
}

describe('GitHubWorkspaceScreen confirmation flow', () => {
  it('sends approval and an idempotent mutation only after the exact confirmation action', async () => {
    const api = createMutationApi();
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
        createIdempotencyKey={() => 'mutation-key-1'}
        computeCommandHash={async () => 'cmdhash123'}
      />,
    );
    await openReview(screen);

    // The review shows the exact scope, repository, and normalized arguments
    // before anything is sent.
    expect(screen.getAllByText('acme/widget · issues:write').length).toBeGreaterThan(0);
    expect(screen.getByText('Add workspace badge')).toBeTruthy();
    expect(api.createRunApproval).not.toHaveBeenCalled();
    expect(api.enqueueGithubMutation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm create issue' }));

    await waitFor(() =>
      expect(api.createRunApproval).toHaveBeenCalledWith('run_1', {
        scope: 'issues:write',
        decision: 'approved',
        confirmationText: 'I confirm create issue on acme/widget (issues:write)',
        commandHash: 'cmdhash123',
      }),
    );
    expect(api.enqueueGithubMutation).toHaveBeenCalledWith('ws_1', {
      idempotencyKey: 'mutation-key-1',
      approvalId: 'apr_1',
      repository: 'acme/widget',
      runId: 'run_1',
      operation: 'create_issue',
      arguments: { title: 'Add workspace badge', body: 'Details' },
    });

    // Confirmation is disabled after submission and the command status is shown.
    const confirm = screen.getByRole('button', { name: 'Confirm create issue' });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    expect((await screen.findAllByText(/Mutation completed/)).length).toBeGreaterThan(0);
    expect(screen.container.textContent).toContain('gcmd_1');
    expect(screen.container.textContent).not.toMatch(/ghp_|ghs_|gho_/);
  });

  it('maps a missing write grant to an accessible denial without rendering server detail', async () => {
    const api = createMutationApi({
      enqueueGithubMutation: vi.fn(async () => {
        throw new ControlPlaneError(
          'A separate write grant is required; ghp_leaked detail',
          403,
          'WRITE_SCOPE_REQUIRED',
        );
      }),
    });
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
        createIdempotencyKey={() => 'mutation-key-1'}
        computeCommandHash={async () => 'cmdhash123'}
      />,
    );
    await openReview(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create issue' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Mutation denied/i);
    expect(screen.queryByText(/ghp_leaked/)).toBeNull();
    // A denial leaves the confirmation action available for an explicit retry.
    expect(
      screen.getByRole('button', { name: 'Confirm create issue' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  it('shows an accessible expired message when the approval expired', async () => {
    const api = createMutationApi({
      enqueueGithubMutation: vi.fn(async () => {
        throw new ControlPlaneError('Approval expired', 403, 'APPROVAL_EXPIRED');
      }),
    });
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
      />,
    );
    await openReview(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create issue' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/approval expired/i);
  });

  it('shows a duplicate message when the idempotency key was already processed', async () => {
    const api = createMutationApi({
      enqueueGithubMutation: vi.fn(async () => ({
        commandId: 'gcmd_1',
        status: 'completed' as const,
        replayed: true,
      })),
    });
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
      />,
    );
    await openReview(screen);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm create issue' }));

    expect((await screen.findByRole('status')).textContent).toMatch(/already submitted/i);
    expect(screen.container.textContent).toContain('gcmd_1');
  });
});
