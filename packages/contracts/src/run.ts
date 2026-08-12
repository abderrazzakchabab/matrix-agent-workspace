import { z } from 'zod';

export const RunRequest = z.object({
  prompt: z.string().min(1, 'Prompt must not be empty'),
  mode: z.enum(['parallel', 'sequential'], {
    message: 'Mode must be "parallel" or "sequential"',
  }),
  specialistIds: z.array(z.string().min(1)).min(1, 'At least one specialist is required'),
  roomId: z.string().min(1).optional(),
  githubContext: z
    .object({
      repository: z.string().min(1),
    })
    .optional(),
});

export type RunRequestType = z.infer<typeof RunRequest>;

export const RunResponse = z.object({
  runId: z.string().min(1),
  status: z.enum([
    'queued',
    'running',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
    'partial',
  ]),
  roomId: z.string().min(1).optional(),
  nextSequence: z.number().int().nonnegative(),
});

export type RunResponseType = z.infer<typeof RunResponse>;
