import { describe, expect, it } from 'vitest';
import { hashPayload, newJobId, safeFileName } from '../../../src/shared/ids';

describe('newJobId', () => {
  it('uses the job_ prefix and has no dashes after it', () => {
    const id = newJobId();
    expect(id).toMatch(/^job_[0-9a-f]{32}$/);
  });

  it('produces unique ids across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newJobId()));
    expect(ids.size).toBe(1000);
  });
});

describe('hashPayload', () => {
  it('is stable for identical input', () => {
    expect(hashPayload('hello')).toBe(hashPayload('hello'));
  });

  it('is a 64-char hex sha256 digest', () => {
    expect(hashPayload('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to any change in input', () => {
    expect(hashPayload('hello')).not.toBe(hashPayload('hellp'));
    expect(hashPayload('a')).not.toBe(hashPayload('A'));
  });
});

describe('safeFileName', () => {
  it('strips directory traversal, keeping only the base name', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('/a/b/c/selfie.jpg')).toBe('selfie.jpg');
  });

  it('replaces unsafe characters with underscores', () => {
    expect(safeFileName('my photo!@#.jpg')).toBe('my_photo___.jpg');
    expect(safeFileName('résumé.png')).toBe('r_sum_.png');
  });

  it('preserves safe characters (alphanumerics, dot, underscore, hyphen)', () => {
    expect(safeFileName('Image_01-final.v2.jpeg')).toBe('Image_01-final.v2.jpeg');
  });

  it('caps the length at 200 characters', () => {
    const long = 'a'.repeat(500) + '.jpg';
    expect(safeFileName(long)).toHaveLength(200);
  });

  it('falls back to "file" when the result is empty', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('/some/dir/')).toBe('file');
  });
});
