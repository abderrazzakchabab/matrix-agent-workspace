/**
 * `POST /api/workspaces/:workspaceId/github/mutations` — enqueue an
 * approval-gated, idempotent GitHub mutation command.
 *
 * The write gate checks the repository+scope grant (`WRITE_SCOPE_REQUIRED`),
 * the exact unexpired approval (`APPROVAL_*`), and the operation/arguments
 * allowlist (`COMMAND_NOT_ALLOWED`) before anything is persisted. Commands
 * are keyed by idempotency key: a duplicate enqueue returns the existing
 * command. Octokit is only ever reached through the mutation worker after
 * authorization passes.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getPool } from '../../../../../../db/client';
import {
  requireSession,
  toErrorResponse,
  withTenant,
  assertWorkspaceAccess,
} from '../../../../../../auth/authorization';
import {
  createApprovalService,
  databaseApprovalStore,
} from '../../../../../../github/approval-service';
import {
  createDatabaseMutationCommandStore,
  createGithubMutationClient,
  databaseAuditStore,
  enqueueMutationCommand,
  type MutationCommandStore,
} from '../../../../../../github/mutation-command';
import { createMutationWorker, type MutationWorker } from '../../../../../../github/mutation-worker';
import { databaseWriteGrantStore } from '../../../../../../github/write-authorization';

const CreateMutationBody = z.object({
  idempotencyKey: z.string().min(1).max(200),
  approvalId: z.string().min(1).max(200),
  repository: z.string().min(1).max(200),
  runId: z.string().min(1).max(200).optional(),
  operation: z.string().min(1).max(100),
  arguments: z.unknown(),
});

/**
 * Resolve a command's owning tenant via the security-definer helper
 * (`mutation_command_tenant`, granted to the app role): the worker knows only
 * a command id and must re-enter `withTenant` as the command owner.
 */
async function resolveMutationCommandTenant(commandId: string): Promise<{
  userId: string;
  workspaceId: string;
} | null> {
  const { rows } = await getPool().query(
    'SELECT user_id, workspace_id FROM mutation_command_tenant($1)',
    [commandId],
  );
  const row = rows[0] as { user_id?: unknown; workspace_id?: unknown } | undefined;
  return row && row.user_id && row.workspace_id
    ? { userId: String(row.user_id), workspaceId: String(row.workspace_id) }
    : null;
}

const commandStore: MutationCommandStore = createDatabaseMutationCommandStore(
  resolveMutationCommandTenant,
);

const approvalService = createApprovalService({ store: databaseApprovalStore });

// The production deployment supplies a write-scoped installation token;
// tests and fixtures run against the deterministic GitHub fixture.
const mutationClient = createGithubMutationClient({
  token: () => Promise.resolve(process.env.GITHUB_WRITE_TOKEN ?? 'ghs_fixture_write_token'),
});

const worker: MutationWorker = createMutationWorker({
  commandStore,
  grantStore: databaseWriteGrantStore,
  approvalService,
  auditStore: databaseAuditStore,
  client: mutationClient,
});

/**
 * Test-only deterministic crash control (enabled by PHASE_C_FIXTURE_MODE):
 * the first request whose idempotency key carries the marker runs a worker
 * that persists the provider result and then crashes before acknowledging
 * the command, simulating a worker crash between provider response and ack.
 * One-shot per key per server process, so the idempotent retry uses the
 * healthy worker and resumes from the persisted provider result.
 */
const CRASH_AFTER_PROVIDER_MARKER = '[fixture:crash-after-provider]';
const crashedFixtureKeys = new Set<string>();

function workerForRequest(idempotencyKey: string): MutationWorker {
  if (
    process.env.PHASE_C_FIXTURE_MODE !== '1' ||
    !idempotencyKey.includes(CRASH_AFTER_PROVIDER_MARKER) ||
    crashedFixtureKeys.has(idempotencyKey)
  ) {
    return worker;
  }
  crashedFixtureKeys.add(idempotencyKey);
  let armed = true;
  const crashingStore: MutationCommandStore = new Proxy(commandStore, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'markCompleted' && armed) {
        armed = false;
        return async () => {
          throw new Error('simulated Phase C mutation worker crash after provider result');
        };
      }
      return value;
    },
  });
  return createMutationWorker({
    commandStore: crashingStore,
    grantStore: databaseWriteGrantStore,
    approvalService,
    auditStore: databaseAuditStore,
    client: mutationClient,
  });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { workspaceId } = await context.params;
    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = CreateMutationBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid mutation request',
            requestId,
          },
        },
        { status: 422 },
      );
    }
    const body = parsed.data;

    await withTenant(auth.userId, async (client) => {
      await assertWorkspaceAccess(client, workspaceId);
    });

    // The run must exist in the caller's workspace (RLS-enforced); an
    // inaccessible or missing run looks identical.
    if (body.runId) {
      const runWorkspaceId = await withTenant(auth.userId, async (client) => {
        const { rows } = await client.query('SELECT workspace_id FROM runs WHERE id = $1', [
          body.runId,
        ]);
        if (rows.length === 0) {
          throw Object.assign(new Error('Run not found'), {
            code: 'RUN_NOT_FOUND',
            status: 404,
          });
        }
        return rows[0].workspace_id as string;
      });
      if (runWorkspaceId !== workspaceId) {
        throw Object.assign(new Error('Run not found'), {
          code: 'RUN_NOT_FOUND',
          status: 404,
        });
      }
    }

    const result = await enqueueMutationCommand(
      {
        userId: auth.userId,
        workspaceId,
        runId: body.runId ?? null,
        idempotencyKey: body.idempotencyKey,
        approvalId: body.approvalId,
        repository: body.repository,
        operation: body.operation,
        arguments: body.arguments,
        actorMatrixId: auth.matrixUserId,
      },
      {
        grantStore: databaseWriteGrantStore,
        approvalService,
        commandStore,
        auditStore: databaseAuditStore,
        worker: workerForRequest(body.idempotencyKey),
      },
    );

    return NextResponse.json(
      {
        requestId,
        commandId: result.command.id,
        status: result.command.status,
      },
      { status: result.replayed ? 200 : 202 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
