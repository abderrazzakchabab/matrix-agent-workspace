/**
 * Specialist provider interface and the Vercel AI SDK / AI Gateway adapter.
 *
 * The workflow depends only on the injectable `SpecialistProvider` interface;
 * tests inject a deterministic fixture. The production adapter calls the
 * Vercel AI SDK against the AI Gateway (an OpenAI-compatible endpoint) using
 * the specialist's pinned model/provider configuration.
 *
 * The tools handed to the model are derived ONLY from the validated profile
 * allowlist (`ReadOnlyToolName`), never from prompt text, so no injection can
 * grant a tool. No GitHub mutation tool exists in Phase B.
 */
import { generateText, tool, type LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { APICallError } from '@ai-sdk/provider';
import { z } from 'zod';
import type { SpecialistProfile, ReadOnlyToolName } from './agent-config';

export interface SpecialistProviderRequest {
  runId: string;
  specialistId: string;
  profile: SpecialistProfile;
  system: string;
  prompt: string;
  /** Validated read-only allowlist; the only tools this call may receive. */
  tools: ReadOnlyToolName[];
  executionKey: string;
}

export interface SpecialistProviderResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface SpecialistProvider {
  readonly name: string;
  complete(request: SpecialistProviderRequest): Promise<SpecialistProviderResult>;
  /** Cooperative cancellation: abort in-flight calls for the run. */
  abort?(runId: string): void;
}

/** Retryable network/429/5xx failure. Bounded backoff applies. */
export class ProviderTransientError extends Error {
  readonly retryable = true;
  readonly statusCode?: number;
  constructor(message: string, opts?: { statusCode?: number; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderTransientError';
    this.statusCode = opts?.statusCode;
  }
}

export class ProviderTimeoutError extends Error {
  readonly retryable = false;
  readonly code = 'PROVIDER_TIMEOUT';
  constructor(message = 'provider call timed out') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** Non-retryable provider failure (4xx, invalid configuration, etc.). */
export class ProviderPermanentError extends Error {
  readonly retryable = false;
  readonly code = 'PROVIDER_PERMANENT';
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderPermanentError';
  }
}

export class ProviderConfigurationError extends Error {
  readonly retryable = false;
  readonly code = 'PROVIDER_CONFIGURATION';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigurationError';
  }
}

export function isTransientProviderError(error: unknown): error is ProviderTransientError {
  return error instanceof ProviderTransientError && error.retryable === true;
}

export function getAiGatewayBaseUrl(): string {
  return (
    process.env.AI_GATEWAY_BASE_URL ??
    'https://gateway.ai.cloudflare.com/v1/local/development'
  );
}

export function getAiGatewayApiKey(): string | undefined {
  return process.env.AI_GATEWAY_API_KEY;
}

/** Injectable executor seam for the read-only tools (wired to GitHub in Task 6). */
export type ReadOnlyToolExecutor = (args: unknown) => Promise<unknown>;

const toolExecutors = new Map<ReadOnlyToolName, ReadOnlyToolExecutor>();

export function setReadOnlyToolExecutors(
  executors: Partial<Record<ReadOnlyToolName, ReadOnlyToolExecutor>>,
): void {
  for (const [name, executor] of Object.entries(executors)) {
    toolExecutors.set(name as ReadOnlyToolName, executor);
  }
}

export function clearReadOnlyToolExecutors(): void {
  toolExecutors.clear();
}

const READ_ONLY_TOOL_DESCRIPTIONS: Record<ReadOnlyToolName, string> = {
  read_repository: 'Read repository metadata (files, default branch) read-only.',
  read_issue: 'Read a single GitHub issue by number. Read-only.',
  read_pull_request: 'Read a single GitHub pull request by number. Read-only.',
};

interface GatewayAdapter {
  model(modelId: string): LanguageModel;
}

/**
 * The Vercel AI SDK provider for AI Gateway. Each specialist's
 * `gatewayProvider` selects the gateway route ('openai' or 'anthropic').
 */
export function createVercelAiGatewayProvider(opts?: {
  baseUrl?: string;
  apiKey?: string;
  name?: string;
}): SpecialistProvider {
  const baseUrl = opts?.baseUrl ?? getAiGatewayBaseUrl();
  const apiKey = opts?.apiKey ?? getAiGatewayApiKey();
  const name = opts?.name ?? 'ai-gateway';
  const controllers = new Map<string, Set<AbortController>>();

  const openai = createOpenAICompatible({
    name: `${name}-openai`,
    baseURL: `${baseUrl.replace(/\/$/, '')}/openai`,
    apiKey: apiKey ?? '',
  });
  const anthropic = createAnthropic({
    baseURL: `${baseUrl.replace(/\/$/, '')}/anthropic`,
    apiKey: apiKey ?? '',
  });

  const adapters: Record<SpecialistProfile['gatewayProvider'], GatewayAdapter> = {
    openai: { model: (modelId) => openai.chatModel(modelId) as unknown as LanguageModel },
    anthropic: {
      model: (modelId) => anthropic(modelId) as unknown as LanguageModel,
    },
  };

  return {
    name,
    async complete(request: SpecialistProviderRequest): Promise<SpecialistProviderResult> {
      const adapter = adapters[request.profile.gatewayProvider];
      if (!adapter) {
        throw new ProviderConfigurationError(
          `No gateway adapter for provider "${request.profile.gatewayProvider}"`,
        );
      }
      const controller = new AbortController();
      let controllersForRun = controllers.get(request.runId);
      if (!controllersForRun) {
        controllersForRun = new Set();
        controllers.set(request.runId, controllersForRun);
      }
      controllersForRun.add(controller);
      const timeout = setTimeout(
        () => controller.abort(new ProviderTimeoutError()),
        request.profile.timeoutMs,
      );
      try {
        // Tools are derived only from the validated read-only allowlist.
        const tools = Object.fromEntries(
          request.tools.map((toolName) => [
            toolName,
            tool({
              description: READ_ONLY_TOOL_DESCRIPTIONS[toolName],
              inputSchema: toolInputSchema(toolName),
              execute: async (args: unknown) => {
                const executor = toolExecutors.get(toolName);
                if (!executor) {
                  throw new ProviderPermanentError(
                    `Read-only tool "${toolName}" is not wired to a data source`,
                  );
                }
                return executor(args);
              },
            }),
          ]),
        );
        const result = await generateText({
          model: adapter.model(request.profile.model),
          system: request.system,
          prompt: request.prompt,
          tools,
          maxOutputTokens: request.profile.maxOutputTokens,
          abortSignal: controller.signal,
        });
        return {
          text: result.text,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens,
        };
      } catch (error) {
        if (error instanceof ProviderTimeoutError) throw error;
        if (isAbortError(error)) throw new ProviderTimeoutError();
        if (APICallError.isInstance(error)) {
          const retryable =
            error.isRetryable || error.statusCode === 429 || (error.statusCode ?? 0) >= 500;
          if (retryable) {
            throw new ProviderTransientError(
              `provider HTTP ${error.statusCode ?? 'error'}`,
              { statusCode: error.statusCode, cause: error },
            );
          }
          throw new ProviderPermanentError(
            `provider rejected request (HTTP ${error.statusCode})`,
            { cause: error },
          );
        }
        if (error instanceof ProviderPermanentError) throw error;
        throw new ProviderPermanentError('provider call failed', { cause: error });
      } finally {
        clearTimeout(timeout);
        controllersForRun.delete(controller);
        if (controllersForRun.size === 0) controllers.delete(request.runId);
      }
    },
    abort(runId: string): void {
      const controllersForRun = controllers.get(runId);
      if (!controllersForRun) return;
      for (const controller of controllersForRun) {
        controller.abort(new Error('run cancelled'));
      }
      controllers.delete(runId);
    },
  };
}

function toolInputSchema(toolName: ReadOnlyToolName): z.ZodTypeAny {
  switch (toolName) {
    case 'read_issue':
    case 'read_pull_request':
      return z.object({
        repository: z.string().min(1),
        number: z.number().int().positive(),
      });
    case 'read_repository':
      return z.object({ repository: z.string().min(1) });
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ABORT_ERR')
  );
}

let defaultProvider: SpecialistProvider | undefined;

/** The process-wide provider used by the Inngest workflow. */
export function getSpecialistProvider(): SpecialistProvider {
  if (!defaultProvider) defaultProvider = createVercelAiGatewayProvider();
  return defaultProvider;
}

/** Test seam: replace the default provider (used by fixture-free tests). */
export function setSpecialistProvider(provider: SpecialistProvider): void {
  defaultProvider = provider;
}
