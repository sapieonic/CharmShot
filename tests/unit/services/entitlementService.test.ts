import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildEntitlement } from '../../helpers/fakes';

const { getOrCreateEntitlement } = vi.hoisted(() => ({
  getOrCreateEntitlement: vi.fn(),
}));
vi.mock('../../../src/repositories/entitlementRepository', () => ({ getOrCreateEntitlement }));

import { getEntitlements } from '../../../src/services/entitlementService';

describe('getEntitlements', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps an entitlement record to the client view with an ISO timestamp', async () => {
    const record = buildEntitlement({
      plan: 'pro',
      creditsRemaining: 42,
      entitlementActive: true,
      lastSyncedAt: new Date('2026-02-03T04:05:06Z'),
    });
    getOrCreateEntitlement.mockResolvedValue(record);

    const view = await getEntitlements('uid-test-123');
    expect(getOrCreateEntitlement).toHaveBeenCalledWith('uid-test-123');
    expect(view).toEqual({
      plan: 'pro',
      creditsRemaining: 42,
      entitlementActive: true,
      lastSyncedAt: '2026-02-03T04:05:06.000Z',
    });
  });
});
