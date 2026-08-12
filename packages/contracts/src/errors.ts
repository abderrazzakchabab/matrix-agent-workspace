import { z } from 'zod';

/** Structured API error returned by every control-plane endpoint. */
export const ApiError = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.unknown()).optional(),
  }),
});

export type ApiErrorType = z.infer<typeof ApiError>;
