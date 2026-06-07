import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument } from '../../../src/openapi/document';

describe('OpenAPI document', () => {
  const doc = buildOpenApiDocument() as any;

  it('is OpenAPI 3.1 with API info', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('CharmShot API');
    expect(typeof doc.info.version).toBe('string');
  });

  it('documents every public route', () => {
    expect(Object.keys(doc.paths).sort()).toEqual(
      [
        '/health',
        '/v1/generations',
        '/v1/generations/{jobId}',
        '/v1/me/entitlements',
        '/v1/presets',
        '/v1/uploads/presign',
        '/v1/webhooks/razorpay',
      ].sort(),
    );
  });

  it('declares bearer and webhook security schemes', () => {
    expect(doc.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.components.securitySchemes.webhookAuth).toMatchObject({ type: 'apiKey', in: 'header' });
  });

  it('requires Firebase bearer auth on authed endpoints', () => {
    expect(doc.paths['/v1/uploads/presign'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/v1/me/entitlements'].get.security).toEqual([{ bearerAuth: [] }]);
  });

  it('uses the webhook signature scheme (not bearer) for the webhook', () => {
    expect(doc.paths['/v1/webhooks/razorpay'].post.security).toEqual([{ webhookAuth: [] }]);
  });

  it('documents the 503 payments-disabled response on the webhook', () => {
    const responses = doc.paths['/v1/webhooks/razorpay'].post.responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['200', '401', '503']));
  });

  it('leaves /health unauthenticated', () => {
    expect(doc.paths['/health'].get.security).toEqual([]);
  });

  it('models the generation create responses (201 + credit/validation errors)', () => {
    const responses = doc.paths['/v1/generations'].post.responses;
    expect(Object.keys(responses)).toEqual(expect.arrayContaining(['201', '400', '401', '402', '403']));
  });

  it('models a path parameter for job status', () => {
    const params = doc.paths['/v1/generations/{jobId}'].get.parameters ?? [];
    expect(params.some((p: any) => p.name === 'jobId' && p.in === 'path' && p.required)).toBe(true);
  });

  it('exposes reusable request + response component schemas', () => {
    const schemas = Object.keys(doc.components.schemas);
    expect(schemas).toEqual(
      expect.arrayContaining([
        'PresignRequest',
        'CreateGenerationRequest',
        'RazorpayWebhook',
        'JobStatusResponse',
        'ErrorResponse',
        'PresetsResponse',
      ]),
    );
  });

  it('restricts presign uploads to the allowed image content types', () => {
    const schema = doc.components.schemas.PresignRequest;
    const contentType = schema.properties.contentType;
    expect(contentType.enum).toEqual(['image/jpeg', 'image/png', 'image/webp']);
  });
});
