/**
 * OpenAPI 3.1 document for the CharmShot API.
 *
 * The document is generated from the SAME zod schemas used to validate
 * requests (src/validation/schemas.ts), so the published contract can't drift
 * from runtime validation. Response schemas are declared here to mirror the
 * service return shapes.
 *
 * Consumed by:
 *   - the Fastify swagger plugin (served at /docs and /openapi.json)
 *   - scripts/export-openapi.ts (writes docs/openapi.{json,yaml})
 */

import { z } from 'zod';
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import {
  ALLOWED_CONTENT_TYPES,
  createGenerationSchema,
  jobIdParamSchema,
  presignRequestSchema,
  revenueCatWebhookSchema,
} from '../validation/schemas';

// Patch zod with `.openapi()` once for this module's schema metadata.
extendZodWithOpenApi(z);

const JOB_STATUSES = ['PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED'] as const;

// ---- Response schemas (mirror the service return shapes) ------------------

const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'INVALID_INPUT' }),
      message: z.string().openapi({ example: 'Request validation failed' }),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorResponse');

const PresignResponse = z
  .object({
    uploadUrl: z.string().url().openapi({ description: 'Short-lived presigned S3 PUT URL' }),
    s3Key: z.string().openapi({ example: 'uid123/uploads/abc/selfie.jpg' }),
  })
  .openapi('PresignResponse');

const GenerationCreatedResponse = z
  .object({
    jobId: z.string().openapi({ example: 'job_5f2c...' }),
    status: z.literal('PENDING'),
  })
  .openapi('GenerationCreatedResponse');

const JobResult = z
  .object({
    index: z.number().int().openapi({ example: 0 }),
    url: z.string().url().openapi({ description: 'Short-lived presigned S3 GET URL' }),
  })
  .openapi('JobResult');

const JobStatusResponse = z
  .object({
    jobId: z.string(),
    status: z.enum(JOB_STATUSES),
    presetId: z.string(),
    count: z.number().int(),
    modelUsed: z.string().optional(),
    results: z.array(JobResult),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
    createdAt: z.string().openapi({ format: 'date-time' }),
    updatedAt: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('JobStatusResponse');

const Preset = z
  .object({
    id: z.string().openapi({ example: 'business-elite' }),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    promptTemplate: z.string(),
  })
  .openapi('Preset');

const PresetsResponse = z.object({ presets: z.array(Preset) }).openapi('PresetsResponse');

const EntitlementsResponse = z
  .object({
    plan: z.string().openapi({ example: 'free' }),
    creditsRemaining: z.number().openapi({ example: 10 }),
    entitlementActive: z.boolean(),
    lastSyncedAt: z.string().openapi({ format: 'date-time' }),
  })
  .openapi('EntitlementsResponse');

const WebhookResponse = z
  .object({ status: z.enum(['processed', 'duplicate']) })
  .openapi('WebhookResponse');

const HealthResponse = z.object({ status: z.literal('ok') }).openapi('HealthResponse');

// ---- Document assembly ----------------------------------------------------

function jsonContent(schema: z.ZodTypeAny) {
  return { 'application/json': { schema } };
}

function errorRes(description: string) {
  return { description, content: jsonContent(ErrorResponse) };
}

/** Build the OpenAPI document. Pure — safe to call from the server or scripts. */
export function buildOpenApiDocument(): Record<string, unknown> {
  const registry = new OpenAPIRegistry();

  // Security schemes.
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Firebase ID token: `Authorization: Bearer <token>`',
  });
  registry.registerComponent('securitySchemes', 'webhookAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'authorization',
    description: 'Shared secret configured in RevenueCat (REVENUECAT_WEBHOOK_AUTH).',
  });

  // Register reusable request-schema components (response schemas are emitted
  // automatically because they carry `.openapi('Name')` and are referenced in
  // the path definitions below).
  registry.register('PresignRequest', presignRequestSchema);
  registry.register('CreateGenerationRequest', createGenerationSchema);
  registry.register('RevenueCatWebhook', revenueCatWebhookSchema);

  const bearer = [{ bearerAuth: [] as string[] }];

  registry.registerPath({
    method: 'post',
    path: '/v1/uploads/presign',
    tags: ['Uploads'],
    summary: 'Create a presigned upload URL',
    description: `Returns a short-lived S3 PUT URL scoped to the caller. Only ${ALLOWED_CONTENT_TYPES.join(', ')} are allowed, max 10MB. The client PUTs the bytes directly to \`uploadUrl\` with a matching Content-Type.`,
    security: bearer,
    request: { body: { required: true, content: jsonContent(presignRequestSchema) } },
    responses: {
      200: { description: 'Presigned upload URL', content: jsonContent(PresignResponse) },
      400: errorRes('Validation error'),
      401: errorRes('Missing or invalid Firebase token'),
      415: errorRes('Unsupported content type'),
      429: errorRes('Rate limit exceeded'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/generations',
    tags: ['Generations'],
    summary: 'Create a generation job',
    description:
      'Reserves credits (1 per requested image) and enqueues an async generation job. Returns immediately with a PENDING job; poll GET /v1/generations/{jobId} for status.',
    security: bearer,
    request: { body: { required: true, content: jsonContent(createGenerationSchema) } },
    responses: {
      201: { description: 'Job accepted', content: jsonContent(GenerationCreatedResponse) },
      400: errorRes('Validation error'),
      401: errorRes('Missing or invalid Firebase token'),
      402: errorRes('Insufficient credits'),
      403: errorRes('Reference key not owned by caller'),
      429: errorRes('Rate limit exceeded'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/generations/{jobId}',
    tags: ['Generations'],
    summary: 'Get generation job status',
    description: 'Returns job status and, when SUCCEEDED, short-lived presigned URLs for the results.',
    security: bearer,
    request: { params: jobIdParamSchema },
    responses: {
      200: { description: 'Job status', content: jsonContent(JobStatusResponse) },
      401: errorRes('Missing or invalid Firebase token'),
      404: errorRes('Job not found'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/presets',
    tags: ['Presets'],
    summary: 'List style presets',
    security: bearer,
    responses: {
      200: { description: 'Available presets', content: jsonContent(PresetsResponse) },
      401: errorRes('Missing or invalid Firebase token'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/v1/me/entitlements',
    tags: ['Entitlements'],
    summary: 'Get current plan and remaining credits',
    security: bearer,
    responses: {
      200: { description: 'Entitlement', content: jsonContent(EntitlementsResponse) },
      401: errorRes('Missing or invalid Firebase token'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/v1/webhooks/revenuecat',
    tags: ['Webhooks'],
    summary: 'RevenueCat billing webhook',
    description:
      'Idempotent webhook authenticated by a shared-secret Authorization header (NOT Firebase). Updates plan/credits by event type.',
    security: [{ webhookAuth: [] }],
    request: { body: { required: true, content: jsonContent(revenueCatWebhookSchema) } },
    responses: {
      200: { description: 'Processed (or duplicate, ignored)', content: jsonContent(WebhookResponse) },
      401: errorRes('Invalid webhook secret'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/health',
    tags: ['System'],
    summary: 'Health check',
    security: [],
    responses: { 200: { description: 'OK', content: jsonContent(HealthResponse) } },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      // API contract version — intentionally decoupled from the package/release
      // version (which is managed by semantic-release). Bump this when the API
      // surface changes in a way clients care about.
      title: 'CharmShot API',
      version: '1.0.0',
      description:
        'Identity-preserving AI image generation. Users upload reference selfies and receive enhanced photos. All endpoints except the webhook require a Firebase ID token.',
    },
    servers: [
      { url: '/', description: 'Current host' },
      { url: 'http://localhost:8080', description: 'Local development' },
    ],
    tags: [
      { name: 'Uploads' },
      { name: 'Generations' },
      { name: 'Presets' },
      { name: 'Entitlements' },
      { name: 'Webhooks' },
      { name: 'System' },
    ],
  }) as unknown as Record<string, unknown>;
}
