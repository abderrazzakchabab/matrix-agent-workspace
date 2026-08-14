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

import { GitHubReadPanel } from '../../src/components/GitHubReadPanel';
import { GitHubWorkspaceScreen } from '../../src/screens/GitHubWorkspaceScreen';

afterEach(cleanup);

const repository = {
  id: 101,
  name: 'widget',
  fullName: 'acme/widget',
  owner: 'acme',
  private: true,
  defaultBranch: 'main',
  description: 'Private widget',
  htmlUrl: 'https://github.example/acme/widget',
  archived: false,
};
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
const issue7 = {
  id: 7001,
  number: 7,
  title: 'Cursor issue',
  state: 'open',
  author: 'alice-gh',
  labels: ['help wanted'],
  htmlUrl: 'https://github.example/acme/widget/issues/7',
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-04T00:00:00.000Z',
};
const pullRequest11 = {
  id: 11001,
  number: 11,
  title: 'Safer widget',
  state: 'open',
  draft: false,
  author: 'bob-gh',
  head: 'safe-widget',
  base: 'main',
  htmlUrl: 'https://github.example/acme/widget/pull/11',
  createdAt: '2026-08-05T00:00:00.000Z',
  updatedAt: '2026-08-06T00:00:00.000Z',
};

function createReadApi(overrides: Record<string, unknown> = {}) {
  return {
    listGithubRepositories: vi.fn(async () => ({ items: [repository] })),
    listGithubIssues: vi.fn(async (input: { cursor?: string }) =>
      input.cursor === 'p2'
        ? { items: [issue7] }
        : { items: [issue6], nextCursor: 'p2' }),
    listGithubPullRequests: vi.fn(async () => ({ items: [pullRequest11] })),
    requestGithubWriteGrant: vi.fn(async () => ({
      grantId: 'grt_1',
      status: 'pending' as const,
      repository: 'acme/widget',
      scope: 'issues:write' as const,
    })),
    createRunApproval: vi.fn(),
    enqueueGithubMutation: vi.fn(),
    listAuditRecords: vi.fn(async () => ({ items: [] })),
    ...overrides,
  };
}

describe('GitHubReadPanel', () => {
  it('renders repository, issue, and pull-request read data without raw links', () => {
    const screen = render(
      <GitHubReadPanel
        repository="acme/widget"
        issues={[issue6, issue7]}
        pullRequests={[pullRequest11]}
      />,
    );

    expect(screen.getByText('acme/widget')).toBeTruthy();
    expect(screen.getByText('Issue #6')).toBeTruthy();
    expect(screen.getByText('First issue')).toBeTruthy();
    expect(screen.getByText('Issue #7')).toBeTruthy();
    expect(screen.getByText('Pull request #11')).toBeTruthy();
    expect(screen.getByText('Safer widget')).toBeTruthy();
    // Read panel never renders raw provider URLs or token-shaped values.
    expect(screen.queryByText(/github\.example/)).toBeNull();
    expect(screen.container.textContent).not.toMatch(/ghp_|ghs_|gho_/);
  });

  it('announces loading and read failures accessibly without leaking error detail', () => {
    const loading = render(
      <GitHubReadPanel repository="acme/widget" issues={[]} pullRequests={[]} loading />,
    );
    expect(loading.getAllByRole('progressbar').length).toBeGreaterThan(0);
    loading.unmount();

    const failed = render(
      <GitHubReadPanel
        repository="acme/widget"
        issues={[]}
        pullRequests={[]}
        error="Unable to load GitHub data. Check your connection and retry."
      />,
    );
    expect(failed.getByRole('alert').textContent).toContain('Unable to load GitHub data');
  });
});

describe('GitHubWorkspaceScreen read data', () => {
  it('renders Phase B repository, issue, and pull-request data across pages with no mutation control', async () => {
    const api = createReadApi();
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
      />,
    );

    expect(await screen.findByText('acme/widget')).toBeTruthy();
    expect(await screen.findByText('Issue #6')).toBeTruthy();
    expect(await screen.findByText('Issue #7')).toBeTruthy();
    expect(screen.getByText('Pull request #11')).toBeTruthy();
    await waitFor(() => expect(api.listGithubIssues).toHaveBeenCalledTimes(2));
    expect(api.listGithubIssues).toHaveBeenLastCalledWith(
      expect.objectContaining({ owner: 'acme', repo: 'widget', cursor: 'p2' }),
    );

    // No mutation control exists before a separate write grant is pending/approved.
    expect(screen.queryByLabelText('Issue title')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review create issue' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm create issue' })).toBeNull();
    // Opening the screen never implies an approval or a mutation.
    expect(api.createRunApproval).not.toHaveBeenCalled();
    expect(api.enqueueGithubMutation).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toMatch(/ghp_|ghs_|gho_/);
  });

  it('reveals the mutation composer only after an explicit write-grant request, without inferring approval', async () => {
    const api = createReadApi();
    const screen = render(
      <GitHubWorkspaceScreen
        workspaceId="ws_1"
        runId="run_1"
        repository="acme/widget"
        installationId="42"
        controlPlane={api}
      />,
    );
    expect(await screen.findByText('Issue #6')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Request write access' }));

    expect(await screen.findByText('acme/widget · issues:write')).toBeTruthy();
    expect(api.requestGithubWriteGrant).toHaveBeenCalledWith('ws_1', 'acme/widget', 'issues:write');
    expect(screen.getByLabelText('Issue title')).toBeTruthy();
    // A pending grant reveals the composer but never sends an approval by itself.
    expect(api.createRunApproval).not.toHaveBeenCalled();
    expect(api.enqueueGithubMutation).not.toHaveBeenCalled();
  });

  it('shows a generic alert when read data fails and never renders the raw error detail', async () => {
    const api = createReadApi({
      listGithubIssues: vi.fn(async () => {
        throw new Error('sensitive transport detail with ghp_secret_token');
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

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Unable to load GitHub data');
    expect(screen.queryByText(/ghp_secret_token/)).toBeNull();
    expect(screen.queryByText(/sensitive transport detail/)).toBeNull();
  });
});
