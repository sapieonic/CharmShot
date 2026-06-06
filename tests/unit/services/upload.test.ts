import { describe, expect, it, vi } from 'vitest';

// Capture presignUpload calls while keeping the real key-building helpers.
const { presignUpload } = vi.hoisted(() => ({
  presignUpload: vi.fn(async (p: { key: string; contentType: string }) => ({
    uploadUrl: `https://s3.example.com/${p.key}?sig=test`,
    s3Key: p.key,
  })),
}));
vi.mock('../../../src/aws/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/aws/s3')>();
  return { ...actual, presignUpload };
});

import { createPresignedUpload } from '../../../src/services/uploadService';
import { presignRequestSchema, parseOrThrow } from '../../../src/validation/schemas';
import { AppError } from '../../../src/shared/errors';

describe('presigned upload flow', () => {
  it('produces a user-scoped key and a signed URL', async () => {
    const result = await createPresignedUpload('uid-abc', {
      contentType: 'image/jpeg',
      fileName: 'selfie.jpg',
    });
    expect(result.s3Key.startsWith('uid-abc/')).toBe(true);
    expect(result.s3Key.endsWith('/selfie.jpg')).toBe(true);
    expect(result.uploadUrl).toContain('https://');
    expect(presignUpload).toHaveBeenCalledWith(
      expect.objectContaining({ contentType: 'image/jpeg' }),
    );
  });

  it('sanitises unsafe file names and prevents path traversal', async () => {
    const result = await createPresignedUpload('uid-abc', {
      contentType: 'image/png',
      fileName: '../../etc/passwd',
    });
    expect(result.s3Key).not.toContain('..');
    expect(result.s3Key.startsWith('uid-abc/')).toBe(true);
  });

  it('accepts only jpeg/png/webp content types', () => {
    expect(() => parseOrThrow(presignRequestSchema, { contentType: 'image/gif', fileName: 'x.gif' })).toThrowError(
      AppError,
    );
    expect(parseOrThrow(presignRequestSchema, { contentType: 'image/webp', fileName: 'x.webp' })).toEqual({
      contentType: 'image/webp',
      fileName: 'x.webp',
    });
  });

  it('rejects files over the size limit when contentLength is declared', () => {
    try {
      parseOrThrow(presignRequestSchema, {
        contentType: 'image/jpeg',
        fileName: 'big.jpg',
        contentLength: 11 * 1024 * 1024,
      });
      throw new Error('expected validation to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const details = (err as AppError).details as { path: string; message: string }[];
      expect(details.some((d) => d.path === 'contentLength' && /maximum/i.test(d.message))).toBe(true);
    }
  });
});
