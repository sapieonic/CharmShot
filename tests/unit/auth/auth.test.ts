import { describe, expect, it, vi } from 'vitest';

// Mock repositories so authenticate() never touches MongoDB.
const { upsertUser, getOrCreateEntitlement } = vi.hoisted(() => ({
  upsertUser: vi.fn(async (u: unknown) => u),
  getOrCreateEntitlement: vi.fn(async () => ({})),
}));
vi.mock('../../../src/repositories/userRepository', () => ({ upsertUser, findUser: vi.fn() }));
vi.mock('../../../src/repositories/entitlementRepository', () => ({ getOrCreateEntitlement }));

import { extractBearerToken } from '../../../src/auth/firebase';
import { authenticate } from '../../../src/services/authService';
import { AppError } from '../../../src/shared/errors';
import type { AuthenticatedUser, TokenVerifier } from '../../../src/auth/firebase';

describe('extractBearerToken', () => {
  it('extracts the token from a Bearer header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer XYZ')).toBe('XYZ');
  });

  it('rejects a missing header', () => {
    expect(() => extractBearerToken(undefined)).toThrowError(AppError);
  });

  it('rejects a malformed header', () => {
    expect(() => extractBearerToken('Token abc')).toThrowError(/Bearer/);
  });
});

describe('authenticate', () => {
  const fakeUser: AuthenticatedUser = { uid: 'uid-123', email: 'a@b.com', name: 'Ada' };
  const okVerifier: TokenVerifier = { verifyIdToken: vi.fn(async () => fakeUser) };

  it('verifies the token and upserts the user + entitlement', async () => {
    const user = await authenticate('valid-token', okVerifier);
    expect(user).toEqual(fakeUser);
    expect(okVerifier.verifyIdToken).toHaveBeenCalledWith('valid-token');
    expect(upsertUser).toHaveBeenCalledWith(fakeUser);
    expect(getOrCreateEntitlement).toHaveBeenCalledWith('uid-123');
  });

  it('propagates verification failures', async () => {
    const badVerifier: TokenVerifier = {
      verifyIdToken: vi.fn(async () => {
        throw new AppError('UNAUTHORIZED', 'bad token');
      }),
    };
    await expect(authenticate('bad', badVerifier)).rejects.toThrowError(AppError);
  });
});
