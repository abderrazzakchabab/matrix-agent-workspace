/**
 * Specialist profile validation and execution configuration.
 *
 * A specialist profile pins the model, AI Gateway provider, per-specialist
 * timeout, output limits, and a read-only tool allowlist. Validation rejects
 * anything outside the Phase B read-only tool registry — no GitHub mutation
 * tool exists in Phase B and none can be configured.
 */
import { z } from 'zod';
import type { UntrustedSpan } from './prompt-envelope';

/** The complete Phase B read-only tool registry. Nothing else may be granted. */
export const READ_ONLY_TOOL_ALLOWLIST = [
  'read_repository',
  'read_issue',
  'read_pull_request',
] as const;

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_ALLOWLIST)[number];

/**
 * Phase B has no GitHub mutation tool. This list is intentionally empty and is
 * asserted by tests so a mutation tool can never exist in this phase.
 */
export const GITHUB_MUTATION_TOOLS: readonly string[] = [];

export class InvalidSpecialistConfigurationError extends Error {
  readonly code = 'INVALID_SPECIALIST_CONFIGURATION';
  readonly status = 422;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSpecialistConfigurationError';
  }
}

const MAX_TIMEOUT_MS = 600_000; // 10 minutes per specialist

export const SpecialistProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  model: z.string().min(1),
  gatewayProvider: z.enum(['openai', 'anthropic']),
  systemPolicy: z.string().min(1),
  toolsAllowlist: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().min(1000).max(MAX_TIMEOUT_MS),
  maxOutputTokens: z.number().int().min(64).max(65536).default(4096),
  enabled: z.boolean().default(true),
});

export type SpecialistProfile = z.infer<typeof SpecialistProfileSchema>;

function isReadOnlyTool(tool: string): tool is ReadOnlyToolName {
  return (READ_ONLY_TOOL_ALLOWLIST as readonly string[]).includes(tool);
}

/** Validate a single profile; rejects unknown or mutation tools. */
export function validateSpecialistProfile(input: unknown): SpecialistProfile {
  const parsed = SpecialistProfileSchema.safeParse(input);
  if (!parsed.success) {
    throw new InvalidSpecialistConfigurationError(
      `Invalid specialist profile: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  for (const tool of parsed.data.toolsAllowlist) {
    if (!isReadOnlyTool(tool)) {
      throw new InvalidSpecialistConfigurationError(
        `Tool "${tool}" is not in the read-only allowlist; no mutation tool exists in Phase B`,
      );
    }
  }
  if (!parsed.data.enabled) {
    throw new InvalidSpecialistConfigurationError(
      `Specialist "${parsed.data.id}" is disabled`,
    );
  }
  return parsed.data;
}

/** Validate a list of profiles; rejects duplicate specialist ids. */
export function validateSpecialistProfiles(inputs: unknown[]): SpecialistProfile[] {
  const profiles = inputs.map(validateSpecialistProfile);
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) {
      throw new InvalidSpecialistConfigurationError(
        `Duplicate specialist id "${profile.id}"`,
      );
    }
    ids.add(profile.id);
  }
  return profiles;
}

/**
 * Order profiles by the run's declared specialist ids. Throws when a declared
 * id is missing or duplicated, so a run can never silently execute a different
 * specialist than the one declared.
 */
export function resolveExecutionOrder(
  declaredIds: string[],
  profiles: SpecialistProfile[],
): SpecialistProfile[] {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const seen = new Set<string>();
  for (const id of declaredIds) {
    if (seen.has(id)) {
      throw new InvalidSpecialistConfigurationError(
        `Specialist "${id}" is declared more than once`,
      );
    }
    seen.add(id);
    if (!byId.has(id)) {
      throw new InvalidSpecialistConfigurationError(
        `Specialist "${id}" is not configured for this workspace`,
      );
    }
  }
  if (declaredIds.length === 0) {
    throw new InvalidSpecialistConfigurationError('At least one specialist is required');
  }
  return declaredIds.map((id) => byId.get(id) as SpecialistProfile);
}

/** Typed result of one prior specialist, passed forward in sequential mode. */
export interface PriorSpecialistResult {
  specialistId: string;
  status: 'completed' | 'failed';
  output?: Record<string, unknown>;
  errorCode?: string;
}

/** The runtime input every specialist receives. */
export interface SpecialistRuntimeInput {
  prompt: string;
  githubContext?: { repository?: string };
  priorResults?: PriorSpecialistResult[];
}

export interface SpecialistPromptComposition {
  system: string;
  prompt: string;
}

export class SpecialistOutputInvalidError extends Error {
  readonly code = 'SPECIALIST_OUTPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'SpecialistOutputInvalidError';
  }
}

/** A validated specialist: profile + typed task/output contracts. */
export interface SpecialistDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
  OSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  profile: SpecialistProfile;
  inputSchema: TSchema;
  outputSchema: OSchema;
  composePrompt(
    input: z.infer<TSchema>,
    untrusted: UntrustedSpan[],
  ): SpecialistPromptComposition;
  /** Parse provider text into the typed output; throws SpecialistOutputInvalidError. */
  parseOutput(text: string): z.infer<OSchema>;
}

export function defineSpecialist<
  TSchema extends z.ZodTypeAny,
  OSchema extends z.ZodTypeAny,
>(def: {
  profile: SpecialistProfile;
  inputSchema: TSchema;
  outputSchema: OSchema;
  composePrompt(
    input: z.infer<TSchema>,
    untrusted: UntrustedSpan[],
  ): SpecialistPromptComposition;
}): SpecialistDefinition<TSchema, OSchema> {
  const profile = validateSpecialistProfile(def.profile);
  return {
    ...def,
    profile,
    parseOutput(text: string): z.infer<OSchema> {
      const parsed = extractJsonObject(text);
      if (parsed === null) {
        throw new SpecialistOutputInvalidError(
          `Specialist "${profile.id}" did not return a JSON object`,
        );
      }
      const result = def.outputSchema.safeParse(parsed);
      if (!result.success) {
        throw new SpecialistOutputInvalidError(
          `Specialist "${profile.id}" output failed validation: ${result.error.issues
            .map((i) => i.message)
            .join('; ')}`,
        );
      }
      return result.data;
    },
  };
}

/** Extract the first JSON object from model text (tolerates fences/prose). */
export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to extraction
  }
  const fenced = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(trimmed);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      return null;
    }
  }
  const first = trimmed.indexOf('{');
  if (first === -1) return null;
  const last = trimmed.lastIndexOf('}');
  if (last <= first) return null;
  try {
    return JSON.parse(trimmed.slice(first, last + 1));
  } catch {
    return null;
  }
}
