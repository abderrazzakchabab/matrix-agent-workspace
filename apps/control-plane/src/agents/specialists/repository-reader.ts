/**
 * Repository Reader specialist.
 *
 * Reads repository metadata through the read-only `read_repository` tool and
 * returns a typed summary. It has no GitHub mutation tool and can never gain
 * one: its tool allowlist is validated against the Phase B read-only registry.
 */
import { z } from 'zod';
import { defineSpecialist, type SpecialistProfile } from '../agent-config';
import { buildPromptEnvelope } from '../prompt-envelope';
import type { UntrustedSpan } from '../prompt-envelope';

export const repositoryReaderProfile: SpecialistProfile = {
  id: 'repo-reader',
  name: 'Repository Reader',
  model: 'gpt-4o-mini',
  gatewayProvider: 'openai',
  systemPolicy:
    'You are the repository reader. Inspect repository metadata using ONLY the read_repository tool. Never modify anything on GitHub.',
  toolsAllowlist: ['read_repository'],
  timeoutMs: 60_000,
  maxOutputTokens: 2048,
  enabled: true,
};

export const repositoryReaderInputSchema = z.object({
  prompt: z.string().min(1),
  githubContext: z
    .object({ repository: z.string().min(1).optional() })
    .optional(),
  priorResults: z
    .array(
      z.object({
        specialistId: z.string(),
        status: z.enum(['completed', 'failed']).optional(),
        output: z.record(z.string(), z.unknown()).optional(),
        errorCode: z.string().optional(),
      }),
    )
    .optional(),
});

export const repositoryReaderOutputSchema = z.object({
  summary: z.string().min(1),
  files: z.array(z.string()).default([]),
});

export type RepositoryReaderOutput = z.infer<typeof repositoryReaderOutputSchema>;

export const repositoryReader = defineSpecialist({
  profile: repositoryReaderProfile,
  inputSchema: repositoryReaderInputSchema,
  outputSchema: repositoryReaderOutputSchema,
  composePrompt(input, untrusted: UntrustedSpan[]) {
    const repository = input.githubContext?.repository ?? '(none provided)';
    const task = [
      `Read the repository "${repository}" using the read_repository tool.`,
      `Original request: ${input.prompt}`,
      'Respond with a JSON object matching this schema:',
      '{"summary": string, "files": string[]}',
    ].join('\n');
    const envelope = buildPromptEnvelope({
      task,
      untrusted,
      toolAllowlist: repositoryReaderProfile.toolsAllowlist,
    });
    return {
      system: `${repositoryReaderProfile.systemPolicy}\n\n${envelope.system}`,
      prompt: envelope.prompt,
    };
  },
});
