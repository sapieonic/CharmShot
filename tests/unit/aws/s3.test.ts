import { describe, expect, it } from 'vitest';
import { keyBelongsToUser, resultKey, uploadKey } from '../../../src/aws/s3';

describe('uploadKey', () => {
  it('builds a user-scoped key from uid/scope/fileName', () => {
    expect(uploadKey('uid-1', 'abc123', 'selfie.jpg')).toBe('uid-1/abc123/selfie.jpg');
  });
});

describe('resultKey', () => {
  it('builds a user-scoped result key with index and default webp extension', () => {
    expect(resultKey('uid-1', 'job_xyz', 0)).toBe('uid-1/job_xyz/0.webp');
  });

  it('honours a custom extension', () => {
    expect(resultKey('uid-1', 'job_xyz', 3, 'png')).toBe('uid-1/job_xyz/3.png');
  });
});

describe('keyBelongsToUser', () => {
  it('returns true for the exact uid or the uid prefix', () => {
    expect(keyBelongsToUser('uid', 'uid')).toBe(true);
    expect(keyBelongsToUser('uid/uploads/abc/file.jpg', 'uid')).toBe(true);
  });

  it('returns false for another user key', () => {
    expect(keyBelongsToUser('other/uploads/file.jpg', 'uid')).toBe(false);
  });

  it('rejects prefix-spoofing (uid-evil must not match uid)', () => {
    expect(keyBelongsToUser('uid-evil/uploads/file.jpg', 'uid')).toBe(false);
    expect(keyBelongsToUser('uidX', 'uid')).toBe(false);
  });
});
