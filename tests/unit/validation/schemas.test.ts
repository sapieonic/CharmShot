import { describe, expect, it } from 'vitest';
import {
  createGenerationSchema,
  jobIdParamSchema,
  parseOrThrow,
  presignRequestSchema,
  revenueCatWebhookSchema,
} from '../../../src/validation/schemas';
import { AppError } from '../../../src/shared/errors';

/** Helper: run parseOrThrow and capture the thrown AppError. */
function expectInvalid(schema: Parameters<typeof parseOrThrow>[0], data: unknown): AppError {
  try {
    parseOrThrow(schema, data);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error('expected parseOrThrow to throw');
}

describe('parseOrThrow error shape', () => {
  it('throws AppError with code INVALID_INPUT and field-path details', () => {
    const err = expectInvalid(presignRequestSchema, { contentType: 'image/gif', fileName: '' });
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.statusCode).toBe(400);
    expect(Array.isArray(err.details)).toBe(true);
    const paths = (err.details as { path: string; message: string }[]).map((d) => d.path);
    expect(paths).toContain('contentType');
    expect(paths).toContain('fileName');
  });
});

describe('presignRequestSchema', () => {
  it('accepts a valid request and allows omitting contentLength', () => {
    const parsed = parseOrThrow(presignRequestSchema, { contentType: 'image/png', fileName: 'a.png' });
    expect(parsed).toEqual({ contentType: 'image/png', fileName: 'a.png' });
  });

  it('accepts each allowed content type', () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(parseOrThrow(presignRequestSchema, { contentType: ct, fileName: 'f' }).contentType).toBe(ct);
    }
  });

  it('rejects a content length above the configured maximum', () => {
    const err = expectInvalid(presignRequestSchema, {
      contentType: 'image/png',
      fileName: 'f',
      contentLength: 10 * 1024 * 1024 + 1,
    });
    expect((err.details as { path: string }[])[0]?.path).toBe('contentLength');
  });

  it('rejects an over-long file name', () => {
    expectInvalid(presignRequestSchema, { contentType: 'image/png', fileName: 'a'.repeat(256) });
  });
});

describe('createGenerationSchema', () => {
  const base = { referenceImageKeys: ['k1'], presetId: 'casual-smart', count: 1 };

  it('applies the default aspect ratio and leaves optional fields out', () => {
    const parsed = parseOrThrow(createGenerationSchema, base);
    expect(parsed.aspectRatio).toBe('1:1');
    expect(parsed.modelId).toBeUndefined();
    expect(parsed.seed).toBeUndefined();
  });

  it('accepts optional seed and modelId', () => {
    const parsed = parseOrThrow(createGenerationSchema, { ...base, seed: 7, modelId: 'nano-banana', aspectRatio: '16:9' });
    expect(parsed.seed).toBe(7);
    expect(parsed.modelId).toBe('nano-banana');
    expect(parsed.aspectRatio).toBe('16:9');
  });

  it('enforces count bounds 1..8', () => {
    expect(parseOrThrow(createGenerationSchema, { ...base, count: 1 }).count).toBe(1);
    expect(parseOrThrow(createGenerationSchema, { ...base, count: 8 }).count).toBe(8);
    expectInvalid(createGenerationSchema, { ...base, count: 0 });
    expectInvalid(createGenerationSchema, { ...base, count: 9 });
    expectInvalid(createGenerationSchema, { ...base, count: 1.5 });
  });

  it('enforces referenceImageKeys length 1..10 and non-empty entries', () => {
    expect(parseOrThrow(createGenerationSchema, { ...base, referenceImageKeys: Array(10).fill('k') }).referenceImageKeys).toHaveLength(10);
    expectInvalid(createGenerationSchema, { ...base, referenceImageKeys: [] });
    expectInvalid(createGenerationSchema, { ...base, referenceImageKeys: Array(11).fill('k') });
    expectInvalid(createGenerationSchema, { ...base, referenceImageKeys: [''] });
  });

  it('rejects a negative seed and an unknown aspect ratio', () => {
    expectInvalid(createGenerationSchema, { ...base, seed: -1 });
    expectInvalid(createGenerationSchema, { ...base, aspectRatio: '5:5' });
  });
});

describe('revenueCatWebhookSchema', () => {
  it('accepts a minimal valid envelope', () => {
    const parsed = parseOrThrow(revenueCatWebhookSchema, {
      event: { id: 'e1', type: 'INITIAL_PURCHASE', app_user_id: 'u1' },
    });
    expect(parsed.event.id).toBe('e1');
  });

  it('rejects an envelope missing required event fields', () => {
    const err = expectInvalid(revenueCatWebhookSchema, { event: { id: 'e1' } });
    const paths = (err.details as { path: string }[]).map((d) => d.path);
    expect(paths).toContain('event.type');
    expect(paths).toContain('event.app_user_id');
  });
});

describe('jobIdParamSchema', () => {
  it('accepts a valid jobId', () => {
    expect(parseOrThrow(jobIdParamSchema, { jobId: 'job_abc' }).jobId).toBe('job_abc');
  });

  it('rejects an empty or missing jobId', () => {
    expectInvalid(jobIdParamSchema, { jobId: '' });
    expectInvalid(jobIdParamSchema, {});
  });
});
