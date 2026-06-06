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
 * RevenueCat webhook envelope. We validate only the fields we rely on and pass
 * the rest through; RevenueCat may add fields over time.
 */
export const revenueCatWebhookSchema = z.object({
  event: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    app_user_id: z.string().min(1),
    // Optional fields used to map plan/credits
    product_id: z.string().optional(),
    entitlement_ids: z.array(z.string()).optional(),
    entitlement_id: z.string().optional(),
    period_type: z.string().optional(),
    expiration_at_ms: z.number().optional(),
    aliases: z.array(z.string()).optional(),
    original_app_user_id: z.string().optional(),
  }),
  api_version: z.string().optional(),
});
export type RevenueCatWebhook = z.infer<typeof revenueCatWebhookSchema>;

/** Parses with zod and throws a uniform validation error on failure. */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw Errors.invalidInput('Request validation failed', details);
  }
  return result.data;
}
