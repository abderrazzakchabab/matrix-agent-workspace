import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  withTenant: vi.fn(),
  assertWorkspaceAccess: vi.fn(),
  listAudit: vi.fn(),
}));

vi.mock('../../src/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/auth/authorization')>();
  return {
    ...actual,
    requireSession: mocks.requireSession,
    withTenant: mocks.withTenant,
    assertWorkspaceAccess: mocks.assertWorkspaceAccess,
  };
});

vi.mock('../../src/github/mutation-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/github/mutation-command')>();
  return {
    ...actual,
    databaseAuditStore: { list: mocks.listAudit },
  };
});

import { GET } from '../../src/app/api/workspaces/[workspaceId]/audit/route';

const AUTH = {
  userId: 'user-a',
  matrixUserId: '@alice:example.test',
  homeserverUrl: 'http://hs.test',
  accessToken: 'syt_token',
  sessionOpaqueId: 'sess_1',
};

function request(querystring: string): NextRequest {
  return new NextRequest(`http://audit.test/api/workspaces/w-a/audit${querystring}`);
}

const CONTEXT = { params: Promise.resolve({ workspaceId: 'w-a' }) };

describe('GET /api/workspaces/:workspaceId/audit pagination validation', () => {
  beforeEach(() => {
    mocks.requireSession.mockResolvedValue(AUTH);
    mocks.withTenant.mockImplementation(
      async (_userId: string, run: (client: unknown) => Promise<unknown>) => run({}),
    );
    mocks.assertWorkspaceAccess.mockResolvedValue(undefined);
    mocks.listAudit.mockResolvedValue({ items: [] });
  });

  it('rejects a malformed limit with 400 VALIDATION_ERROR without calling the store', async () => {
    for (const limit of ['abc', '0', '-1', '1.5', 'Infinity', 'NaN']) {
      mocks.listAudit.mockClear();
      const response = await GET(request(`?limit=${limit}`), CONTEXT);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('VALIDATION_ERROR');
      expect(mocks.listAudit).not.toHaveBeenCalled();
    }
  });

  it('rejects a malformed cursor with 400 VALIDATION_ERROR without calling the store', async () => {
    const response = await GET(request('?cursor=not-a-cursor'), CONTEXT);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(mocks.listAudit).not.toHaveBeenCalled();
  });

  it('passes a validated limit and cursor through to the store', async () => {
    const cursor = Buffer.from('2026-08-12T12:00:00.000Z|aud_1').toString('base64url');
    const response = await GET(request(`?limit=10&cursor=${cursor}`), CONTEXT);
    expect(response.status).toBe(200);
    expect(mocks.listAudit).toHaveBeenCalledWith({
      userId: 'user-a',
      workspaceId: 'w-a',
      cursor,
      limit: 10,
    });
  });
});
