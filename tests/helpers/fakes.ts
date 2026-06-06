/**
 * Shared, dependency-free test fixtures and fakes. These are plain values and
 * functions (no `vi` usage) so they can be imported freely from both unit and
 * integration suites without interfering with mock hoisting.
 */

import type { AuthenticatedUser, EntitlementRecord, JobRecord, UserRecord } from '../../src/shared/types';
import type { TokenVerifier } from '../../src/auth/firebase';
import type { RevenueCatWebhook } from '../../src/validation/schemas';

export const TEST_UID = 'uid-test-123';

/** A Firebase token verifier that returns a fixed user without any network. */
export function fakeVerifier(user: AuthenticatedUser = { uid: TEST_UID, email: 'test@example.com', name: 'Test User' }): TokenVerifier {
  return {
    async verifyIdToken(idToken: string): Promise<AuthenticatedUser> {
      if (!idToken || idToken === 'invalid') {
        const { Errors } = await import('../../src/shared/errors');
        throw Errors.unauthorized('Invalid token');
      }
      return user;
    },
  };
}

export function buildUser(overrides: Partial<UserRecord> = {}): UserRecord {
  const now = new Date('2026-01-01T00:00:00Z');
  return { uid: TEST_UID, email: 'test@example.com', name: 'Test User', createdAt: now, updatedAt: now, ...overrides };
}

export function buildEntitlement(overrides: Partial<EntitlementRecord> = {}): EntitlementRecord {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    uid: TEST_UID,
    plan: 'free',
    creditsRemaining: 10,
    entitlementActive: true,
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function buildJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    jobId: 'job_test',
    uid: TEST_UID,
    presetId: 'casual-smart',
    modelId: 'nano-banana',
    count: 2,
    status: 'PENDING',
    referenceImageKeys: [`${TEST_UID}/uploads/abc/selfie.jpg`],
    resultKeys: [],
    creditsReserved: 2,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function buildRevenueCatWebhook(
  overrides: Partial<RevenueCatWebhook['event']> = {},
): RevenueCatWebhook {
  return {
    api_version: '1.0',
    event: {
      id: `evt-${Math.random().toString(36).slice(2)}`,
      type: 'INITIAL_PURCHASE',
      app_user_id: TEST_UID,
      entitlement_ids: ['pro'],
      ...overrides,
    },
  };
}
