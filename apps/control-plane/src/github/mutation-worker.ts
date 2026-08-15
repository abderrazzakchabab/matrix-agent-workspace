/**
 * Phase C mutation worker. Executes an idempotent mutation command exactly
 * once logically:
 *
 * - completed commands return their persisted result (worker retries never
 *   duplicate);
 * - commands with a persisted provider result but no completion (crash between
 *   persist and complete) are finalized from the stored result;
 * - otherwise the grant and the exact unexpired approval are re-checked
 *   immediately before the provider call, the provider result is persisted
 *   BEFORE the command is marked complete, and one audit row records the
 *   outcome.
 *
 * Authorization failures mark the command failed, record an audit denial, and
 * never reach GitHub.
 */
import { REDACTED } from '../security/redaction';
import { ApprovalNotFoundError, type ApprovalService } from './approval-service';
import {
  scopeForOperation,
  type GithubMutationClient,
  type AuditStore,
  type MutationCommand,
  type MutationCommandStore,
} from './mutation-command';
import { authorizeWriteScope, type WriteGrantStore } from './write-authorization';

export class MutationCommandNotFoundError extends Error {
  readonly code = 'MUTATION_COMMAND_NOT_FOUND';
  readonly status = 404;
  constructor() {
    super('Mutation command not found');
    this.name = 'MutationCommandNotFoundError';
  }
}

export interface MutationWorker {
  process(commandId: string): Promise<MutationCommand | null>;
}

export interface MutationWorkerDeps {
  commandStore: MutationCommandStore;
  grantStore: WriteGrantStore;
  approvalService: ApprovalService;
  auditStore: AuditStore;
  client: GithubMutationClient;
  now?: () => number;
}

async function executeWithClient(
  client: GithubMutationClient,
  command: MutationCommand,
): Promise<Record<string, unknown>> {
  switch (command.operation) {
    case 'create_issue': {
      const result = await client.createIssue(command.repository, {
        title: String(command.arguments.title ?? ''),
        ...(command.arguments.body === undefined ? {} : { body: String(command.arguments.body) }),
      });
      return { ...result, operation: command.operation };
    }
    case 'update_issue': {
      const result = await client.updateIssue(command.repository, {
        issueNumber: Number(command.arguments.issueNumber),
        ...(command.arguments.title === undefined ? {} : { title: String(command.arguments.title) }),
        ...(command.arguments.body === undefined ? {} : { body: String(command.arguments.body) }),
        ...(command.arguments.state === undefined
          ? {}
          : { state: command.arguments.state as 'open' | 'closed' }),
      });
      return { ...result, operation: command.operation };
    }
    case 'comment_issue': {
      const result = await client.commentIssue(command.repository, {
        issueNumber: Number(command.arguments.issueNumber),
        body: String(command.arguments.body),
      });
      return { ...result, operation: command.operation };
    }
    case 'create_pr_comment': {
      const result = await client.createPullRequestComment(command.repository, {
        pullNumber: Number(command.arguments.pullNumber),
        body: String(command.arguments.body),
      });
      return { ...result, operation: command.operation };
    }
  }
}

export function createMutationWorker(deps: MutationWorkerDeps): MutationWorker {
  return {
    async process(commandId) {
      const command = await deps.commandStore.getCommand(commandId);
      if (!command) throw new MutationCommandNotFoundError();

      // Idempotent replay: completed commands never call the provider again.
      if (command.status === 'completed') return command;

      // Crash recovery: the provider result was persisted before the crash;
      // finalize the command from the stored result without a provider call.
      if (command.providerResult) {
        const completed = await deps.commandStore.markCompleted(commandId, command.providerResult);
        if (!completed) return deps.commandStore.getCommand(commandId);
        await deps.auditStore
          .record({
            workspaceId: command.workspaceId,
            actorUserId: command.userId,
            scope: scopeForOperation(command.operation),
            repository: command.repository,
            operation: command.operation,
            argumentsHash: command.argumentsHash,
            approvalId: command.approvalId,
            commandId,
            outcome: 'completed',
            details: { arguments: REDACTED, providerResult: REDACTED },
          })
          .catch(() => undefined);
        return completed;
      }

      const scope = scopeForOperation(command.operation);

      // Re-authorize immediately before the mutation: an expired/revoked
      // grant or approval stops the provider call mid-flight.
      try {
        await authorizeWriteScope(
          {
            userId: command.userId,
            workspaceId: command.workspaceId,
            repository: command.repository,
            scope,
            now: deps.now,
          },
          deps.grantStore,
        );
        if (!command.approvalId) throw new ApprovalNotFoundError();
        await deps.approvalService.checkApproval({
          approvalId: command.approvalId,
          workspaceId: command.workspaceId,
          runId: command.runId,
          userId: command.userId,
          scope,
          commandHash: command.argumentsHash,
          now: deps.now?.(),
        });
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'MUTATION_FAILED';
        await deps.commandStore.markFailed(commandId, code);
        await deps.auditStore
          .record({
            workspaceId: command.workspaceId,
            actorUserId: command.userId,
            scope,
            repository: command.repository,
            operation: command.operation,
            argumentsHash: command.argumentsHash,
            approvalId: command.approvalId,
            commandId,
            outcome: 'denied',
            details: { errorCode: code },
          })
          .catch(() => undefined);
        throw error;
      }

      let providerResult: Record<string, unknown>;
      try {
        providerResult = await executeWithClient(deps.client, command);
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'MUTATION_FAILED';
        await deps.commandStore.markFailed(commandId, code);
        await deps.auditStore
          .record({
            workspaceId: command.workspaceId,
            actorUserId: command.userId,
            scope,
            repository: command.repository,
            operation: command.operation,
            argumentsHash: command.argumentsHash,
            approvalId: command.approvalId,
            commandId,
            outcome: 'failed',
            details: { errorCode: code },
          })
          .catch(() => undefined);
        throw error;
      }

      // Persist the provider result BEFORE marking complete: a crash between
      // these two writes is recovered by the idempotent branch above.
      await deps.commandStore.persistProviderResult(commandId, providerResult);
      const completed = await deps.commandStore.markCompleted(commandId, providerResult);
      if (!completed) return deps.commandStore.getCommand(commandId);
      await deps.auditStore
        .record({
          workspaceId: command.workspaceId,
          actorUserId: command.userId,
          scope,
          repository: command.repository,
          operation: command.operation,
          argumentsHash: command.argumentsHash,
          approvalId: command.approvalId,
          commandId,
          outcome: 'completed',
          details: { arguments: REDACTED, providerResult: REDACTED },
        })
        .catch(() => undefined);
      return completed;
    },
  };
}
