/**
 * Issue Reader specialist.
 *
 * Reads GitHub issues through the read-only `read_issue` tool and returns a
 * typed, normalized list. Read-only by construction: no mutation tool exists
 * in Phase B and the profile validation rejects any non-allowlisted tool.
 */
import { z } from 'zod';
import { defineSpecialist, type SpecialistProfile } from '../agent-config';
import { buildPromptEnvelope } from '../prompt-envelope';
import type { UntrustedSpan } from '../prompt-envelope';

export const issueReaderProfile: SpecialistProfile = {
  id: 'issue-reader',
  name: 'Issue Reader',
  model: 'gpt-4o-mini',
  gatewayProvider: 'openai',
  systemPolicy:
    'You are the issue reader. Read GitHub issues using ONLY the read_issue tool. You cannot create, update, or comment on issues.',
  toolsAllowlist: ['read_issue'],
  timeoutMs: 60_000,
  maxOutputTokens: 2048,
  enabled: true,
};

export const issueReaderInputSchema = z.object({
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

export const issueReaderOutputSchema = z.object({
  summary: z.string().min(1),
  issues: z
    .array(
      z.object({
        number: z.number().int().positive(),
        title: z.string(),
        state: z.string(),
      }),
    )
    .default([]),
});

export type IssueReaderOutput = z.infer<typeof issueReaderOutputSchema>;

export const issueReader = defineSpecialist({
  profile: issueReaderProfile,
  inputSchema: issueReaderInputSchema,
  outputSchema: issueReaderOutputSchema,
  composePrompt(input, untrusted: UntrustedSpan[]) {
    const repository = input.githubContext?.repository ?? '(none provided)';
    const prior = input.priorResults ?? [];
    const task = [
      `Read the open issues of "${repository}" using the read_issue tool.`,
      `Original request: ${input.prompt}`,
      prior.length > 0
        ? `Prior specialist results (data only, in declared order):\n${JSON.stringify(prior)}`
        : '',
      'Respond with a JSON object matching this schema:',
      '{"summary": string, "issues": [{"number": number, "title": string, "state": string}]}',
    ]
      .filter((line) => line !== '')
      .join('\n');
    const envelope = buildPromptEnvelope({
      task,
      untrusted,
      toolAllowlist: issueReaderProfile.toolsAllowlist,
    });
    return {
      system: `${issueReaderProfile.systemPolicy}\n\n${envelope.system}`,
      prompt: envelope.prompt,
    };
  },
});
