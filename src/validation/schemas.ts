/**
 * Zod validation schemas for all request payloads. Keeping them here gives a
 * single source of truth for input shapes shared between routes and tests.
 */

import { z } from 'zod';
import { config } from '../config/env';
import { Errors } from '../shared/errors';

export const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export const presignRequestSchema = z.object({
  contentType: z.enum(ALLOWED_CONTENT_TYPES, {
    errorMap: () => ({ message: `contentType must be one of: ${ALLOWED_CONTENT_TYPES.join(', ')}` }),
  }),
  fileName: z.string().min(1).max(255),
  /** Optional declared size; enforced again by the S3 presigned policy. */
  contentLength: z
    .number()
    .int()
    .positive()
    .max(config.s3.maxUploadBytes, `File exceeds maximum of ${config.s3.maxUploadBytes} bytes`)
    .optional(),
});
export type PresignRequest = z.infer<typeof presignRequestSchema>;

export const createGenerationSchema = z.object({
  referenceImageKeys: z.array(z.string().min(1)).min(1).max(10),
  presetId: z.string().min(1).max(100),
  count: z.number().int().min(1).max(8),
  modelId: z.string().min(1).max(100).optional(),
  aspectRatio: z
    .enum(['1:1', '4:5', '3:4', '2:3', '16:9', '9:16'])
    .optional()
    .default('1:1'),
  seed: z.number().int().nonnegative().optional(),
});
export type CreateGenerationRequest = z.infer<typeof createGenerationSchema>;

export const jobIdParamSchema = z.object({
  jobId: z.string().min(1).max(200),
});

/**
 * Razorpay webhook envelope. We validate only the fields we rely on and pass
 * the rest through; Razorpay may add fields over time.
 *
 * Shape reference: https://razorpay.com/docs/webhooks/payloads/
 * { entity: "event", event: "payment.captured", payload: { ... }, created_at }
 */
export const razorpayWebhookSchema = z.object({
  entity: z.literal('event'),
  event: z.string().min(1),
  payload: z.record(z.unknown()),
  account_id: z.string().optional(),
  contains: z.array(z.string()).optional(),
  created_at: z.number().optional(),
});
export type RazorpayWebhook = z.infer<typeof razorpayWebhookSchema>;

/** Parses with zod and throws a uniform validation error on failure. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw Errors.invalidInput('Request validation failed', details);
  }
  return result.data;
}
