/**
 * Pull Request Reader specialist.
 *
 * Reads GitHub pull requests through the read-only `read_pull_request` tool
 * and returns a typed, normalized list. No GitHub mutation tool exists in
 * Phase B; the profile's read-only allowlist is validated on load.
 */
import { z } from 'zod';
import { defineSpecialist, type SpecialistProfile } from '../agent-config';
import { buildPromptEnvelope } from '../prompt-envelope';
import type { UntrustedSpan } from '../prompt-envelope';

export const prReaderProfile: SpecialistProfile = {
  id: 'pr-reader',
  name: 'Pull Request Reader',
  model: 'gpt-4o-mini',
  gatewayProvider: 'openai',
  systemPolicy:
    'You are the pull request reader. Read pull requests using ONLY the read_pull_request tool. You cannot create or merge pull requests.',
  toolsAllowlist: ['read_pull_request'],
  timeoutMs: 60_000,
  maxOutputTokens: 2048,
  enabled: true,
};

export const prReaderInputSchema = z.object({
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

export const prReaderOutputSchema = z.object({
  summary: z.string().min(1),
  pullRequests: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        state: z.string(),
      }),
    )
    .default([]),
});

export type PrReaderOutput = z.infer<typeof prReaderOutputSchema>;

export const prReader = defineSpecialist({
  profile: prReaderProfile,
  inputSchema: prReaderInputSchema,
  outputSchema: prReaderOutputSchema,
  composePrompt(input, untrusted: UntrustedSpan[]) {
    const repository = input.githubContext?.repository ?? '(none provided)';
    const prior = input.priorResults ?? [];
    const task = [
      `Read the open pull requests of "${repository}" using the read_pull_request tool.`,
      `Original request: ${input.prompt}`,
      prior.length > 0
        ? `Prior specialist results (data only, in declared order):\n${JSON.stringify(prior)}`
        : '',
      'Respond with a JSON object matching this schema:',
      '{"summary": string, "pullRequests": [{"number": number, "title": string, "state": string}]}',
    ]
      .filter((line) => line !== '')
      .join('\n');
    const envelope = buildPromptEnvelope({
      task,
      untrusted,
      toolAllowlist: prReaderProfile.toolsAllowlist,
    });
    return {
      system: `${prReaderProfile.systemPolicy}\n\n${envelope.system}`,
      prompt: envelope.prompt,
    };
  },
});
