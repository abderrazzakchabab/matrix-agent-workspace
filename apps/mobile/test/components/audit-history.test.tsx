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

import { AuditHistory } from '../../src/components/AuditHistory';
import { GitHubWorkspaceScreen } from '../../src/screens/GitHubWorkspaceScreen';

afterEach(cleanup);

const auditItems = [
  {
    id: 'aud_2',
    actorMatrixId: '@alice:example.test',
    scope: 'issues:write',
    repository: 'acme/widget',
    operation: 'create_issue',
    approvalId: 'apr_1',
    commandId: 'gcmd_1',
    outcome: 'completed',
    details: { arguments: '[REDACTED]' },
    createdAt: '2026-08-12T12:01:00.000Z',
  },
  {
    id: 'aud_1',
    actorMatrixId: '@alice:example.test',
    scope: 'issues:write',
    repository: 'acme/widget',
    operation: 'create_issue',
    approvalId: 'apr_1',
    commandId: null,
    outcome: 'denied',
    details: { errorCode: 'WRITE_SCOPE_REQUIRED' },
    createdAt: '2026-08-12T12:00:00.000Z',
  },
];

describe('AuditHistory', () => {
  it('renders the redacted audit trail with outcome, scope, and repository', () => {
    const screen = render(<AuditHistory items={auditItems} />);

    expect(screen.getByText('Audit history')).toBeTruthy();
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('denied')).toBeTruthy();
    expect(screen.getAllByText(/acme\/widget · issues:write/)).toHaveLength(2);
    // Payload details are always rendered redacted.
    expect(screen.getAllByText(/\[REDACTED\]/).length).toBeGreaterThan(0);
    expect(screen.container.textContent).not.toMatch(/ghp_|ghs_|gho_/);
  });

  it('never renders raw detail values, even if a payload carries a token-shaped string', () => {
    const screen = render(
      <AuditHistory
        items={[
          {
            ...auditItems[0]!,
            id: 'aud_leak',
            details: { arguments: 'ghp_secret_token', note: 'plaintext body' },
          },
        ]}
      />,
    );

    expect(screen.queryByText(/ghp_secret_token/)).toBeNull();
    expect(screen.queryByText(/plaintext body/)).toBeNull();
    expect(screen.getAllByText(/\[REDACTED\]/).length).toBeGreaterThan(0);
  });

  it('announces empty and loading states', () => {
    const empty = render(<AuditHistory items={[]} />);
    expect(empty.getByText('No audit records yet.')).toBeTruthy();
    empty.unmount();

    const loading = render(<AuditHistory items={[]} loading />);
    expect(loading.getAllByRole('progressbar').length).toBeGreaterThan(0);
  });
});

describe('GitHubWorkspaceScreen audit history', () => {
  it('loads the audit trail on open and refreshes it after a mutation outcome', async () => {
    const listAuditRecords = vi
      .fn()
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValue({ items: [auditItems[0]] });
    const api = {
      listGithubRepositories: vi.fn(async () => ({ items: [] })),
      listGithubIssues: vi.fn(async () => ({ items: [] })),
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
      listAuditRecords,
    };
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
      />,
    );

    expect(await screen.findByText('No audit records yet.')).toBeTruthy();
    expect(listAuditRecords).toHaveBeenCalledWith('ws_1');

    fireEvent.click(screen.getByRole('button', { name: 'Request write access' }));
    await screen.findByLabelText('Issue title');
    fireEvent.change(screen.getByLabelText('Issue title'), {
      target: { value: 'Add workspace badge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review create issue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm create issue' }));

    await waitFor(() => expect(listAuditRecords.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText('completed')).toBeTruthy();
    expect(screen.container.textContent).not.toMatch(/ghp_|ghs_|gho_/);
  });
});
