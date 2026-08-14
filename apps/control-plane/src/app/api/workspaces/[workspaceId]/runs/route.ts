/**
 * `POST /api/workspaces/:workspaceId/runs` — launch a specialist run.
 *
 * Validates the mode, specialist configuration, prompt, and the explicit
 * room binding; snapshots the specialist profiles and workspace policy;
 * writes the run with a prompt hash and idempotency key; emits the
 * `run.queued` event; dispatches `agent.run.requested` to Inngest; and
 * returns `202` with the run id and sequence cursor.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { RunRequest } from '@matrix/contracts';
import {
  requireSession,
  toErrorResponse,
  withTenant,
  assertWorkspaceAccess,
  ValidationError,
} from '../../../../../auth/authorization';
import { createRun } from '../../../../../db/repositories/run-repository';
import { publishEvent } from '../../../../../events/event-service';
import {
  validateSpecialistProfiles,
  resolveExecutionOrder,
} from '../../../../../agents/agent-config';
import {
  DEFAULT_PROMPT_INJECTION_MODE,
  type PromptInjectionMode,
} from '../../../../../agents/prompt-envelope';
import {
  computePromptHash,
  computeExecutionKey,
  DEFAULT_RUN_TIMEOUT_MS,
  DEFAULT_RETRY_POLICY,
} from '../../../../../workflows/run-workflow';
import { dispatchRunRequested } from '../../../../../inngest/client';

class RoomNotBoundError extends Error {
  readonly code = 'ROOM_NOT_BOUND';
  readonly status = 409;
  constructor() {
    super('The room is not bound to this workspace');
    this.name = 'RoomNotBoundError';
  }
}

const CreateRunBody = RunRequest.extend({
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ workspaceId: string }> },
): Promise<NextResponse> {
  const requestId = `req_${randomUUID()}`;
  try {
    const { workspaceId } = await context.params;
    const auth = await requireSession(request);
    const json = await request.json().catch(() => null);
    const parsed = CreateRunBody.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues[0]?.message ?? 'Invalid run request',
            requestId,
          },
        },
        { status: 422 },
      );
    }
    const body = parsed.data;
    if (!body.roomId) {
      throw new ValidationError('roomId is required to launch a run');
    }

    // 1. Workspace membership (RLS-enforced).
    await withTenant(auth.userId, async (client) => {
      await assertWorkspaceAccess(client, workspaceId);
    });

    // 2. Explicit room binding: the room must be bound to this workspace by
    //    this user. A room id in the request is not authorization by itself.
    await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT 1 FROM room_bindings WHERE room_id = $1 AND user_id = $2 AND workspace_id = $3',
        [body.roomId, auth.userId, workspaceId],
      );
      if (rows.length === 0) throw new RoomNotBoundError();
    });

    // 3. Idempotency replay: the same key returns the existing run.
    if (body.idempotencyKey) {
      const existing = await withTenant(auth.userId, async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM runs WHERE workspace_id = $1 AND idempotency_key = $2',
          [workspaceId, body.idempotencyKey],
        );
        return rows[0] ?? null;
      });
      if (existing) {
        const lastSequence = await withTenant(auth.userId, async (client) => {
          const { rows } = await client.query(
            'SELECT COALESCE(MAX(sequence), 0)::int AS last FROM run_events WHERE run_id = $1',
            [existing.id],
          );
          return rows[0].last as number;
        });
        return NextResponse.json(
          {
            requestId,
            runId: existing.id,
            status: existing.status,
            roomId: existing.room_id ?? undefined,
            nextSequence: lastSequence + 1,
          },
          { status: 200 },
        );
      }
    }

    // 4. Specialist configuration snapshot (validated, in declared order).
    const profileRows = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, model, gateway_provider, system_policy, tools_allowlist,
                timeout_ms, enabled
           FROM specialist_agents
          WHERE workspace_id = $1 AND id = ANY($2)`,
        [workspaceId, body.specialistIds],
      );
      return rows;
    });
    const profiles = profileRows.map((r) => ({
      id: r.id as string,
      name: r.name as string,
      model: r.model as string,
      gatewayProvider: r.gateway_provider as string,
      systemPolicy:
        typeof r.system_policy === 'object' && r.system_policy !== null
          ? ((r.system_policy as Record<string, unknown>).systemPolicy as string) ??
            'Specialist policy.'
          : 'Specialist policy.',
      toolsAllowlist: Array.isArray(r.tools_allowlist)
        ? (r.tools_allowlist as string[])
        : [],
      timeoutMs: r.timeout_ms as number,
      maxOutputTokens: 2048,
      enabled: r.enabled === undefined ? true : Boolean(r.enabled),
    }));
    const validated = validateSpecialistProfiles(profiles);
    const ordered = resolveExecutionOrder(body.specialistIds, validated);

    // 5. Workspace policy: prompt-injection mode and failure policy.
    const workspacePolicy = await withTenant(auth.userId, async (client) => {
      const { rows } = await client.query(
        'SELECT policy FROM workspaces WHERE id = $1',
        [workspaceId],
      );
      return (rows[0]?.policy ?? {}) as Record<string, unknown>;
    });
    const promptInjectionMode: PromptInjectionMode =
      workspacePolicy.promptInjectionMode === 'exclude_span' ||
      workspacePolicy.promptInjectionMode === 'fail_run'
        ? (workspacePolicy.promptInjectionMode as PromptInjectionMode)
        : DEFAULT_PROMPT_INJECTION_MODE;
    const failurePolicy =
      workspacePolicy.failurePolicy === 'partial' ? 'partial' : 'fail_run';

    // 6. Immutable snapshot + prompt hash before emitting the workflow event.
    const promptHash = computePromptHash(body.prompt);
    const configSnapshot: Record<string, unknown> = {
      mode: body.mode,
      specialistIds: body.specialistIds,
      specialists: ordered.map((p) => ({
        id: p.id,
        name: p.name,
        model: p.model,
        gatewayProvider: p.gatewayProvider,
        systemPolicy: p.systemPolicy,
        toolsAllowlist: p.toolsAllowlist,
        timeoutMs: p.timeoutMs,
        maxOutputTokens: p.maxOutputTokens,
      })),
      promptInjectionMode,
      failurePolicy,
      runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      retry: DEFAULT_RETRY_POLICY,
      ...(body.githubContext === undefined ? {} : { githubContext: body.githubContext }),
    };

    const runId = `run_${randomUUID()}`;
    const run = await createRun(
      { userId: auth.userId, workspaceId },
      {
        id: runId,
        roomId: body.roomId,
        promptHash,
        mode: body.mode,
        configSnapshot,
        idempotencyKey: body.idempotencyKey ?? null,
      },
    );

    // 7. Persist specialist ordinals and the queued event.
    await withTenant(auth.userId, async (client) => {
      for (const [ordinal, spec] of ordered.entries()) {
        await client.query(
          'INSERT INTO run_specialists (run_id, specialist_id, ordinal, status) VALUES ($1, $2, $3, $4)',
          [runId, spec.id, ordinal, 'queued'],
        );
      }
    });
    await publishEvent(
      { userId: auth.userId, workspaceId },
      runId,
      {
        id: `evt_${randomUUID()}`,
        type: 'run.queued',
        version: 1,
        payload: { mode: body.mode, promptHash },
      },
    );

    // 8. Durable dispatch with the deterministic execution key.
    const executionKey = computeExecutionKey(runId, promptHash, configSnapshot);
    await dispatchRunRequested({
      name: 'agent.run.requested',
      data: {
        runId,
        workspaceId,
        userId: auth.userId,
        executionKey,
        prompt: body.prompt,
        untrusted: [],
        configSnapshot,
      },
    });

    return NextResponse.json(
      {
        requestId,
        runId: run.id,
        status: 'queued',
        roomId: body.roomId,
        nextSequence: 1,
      },
      { status: 202 },
    );
  } catch (error) {
    return toErrorResponse(error, requestId);
  }
}
