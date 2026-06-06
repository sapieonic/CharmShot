import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRevenueCatWebhook } from '../../helpers/fakes';

const { recordWebhookEventOnce, applyEntitlementUpdate, audit } = vi.hoisted(() => ({
  // Always treat each event as new so we exercise the mapping branch.
  recordWebhookEventOnce: vi.fn(async () => true),
  applyEntitlementUpdate: vi.fn(async () => ({})),
  audit: vi.fn(async () => undefined),
}));
vi.mock('../../../src/repositories/webhookEventRepository', () => ({ recordWebhookEventOnce }));
vi.mock('../../../src/repositories/entitlementRepository', () => ({ applyEntitlementUpdate }));
vi.mock('../../../src/repositories/auditLogRepository', () => ({ audit }));

import { processRevenueCatEvent } from '../../../src/services/webhookService';
import { rootLogger } from '../../../src/shared/logger';
import type { RevenueCatWebhook } from '../../../src/validation/schemas';

async function run(overrides: Partial<RevenueCatWebhook['event']>): Promise<void> {
  const payload = buildRevenueCatWebhook(overrides);
  await processRevenueCatEvent(payload, JSON.stringify(payload), rootLogger);
}

const ACTIVATING = ['INITIAL_PURCHASE', 'RENEWAL', 'UNCANCELLATION', 'PRODUCT_CHANGE', 'NON_RENEWING_PURCHASE'];
const DOWNGRADING = ['EXPIRATION', 'BILLING_ISSUE', 'SUBSCRIPTION_PAUSED'];

describe('webhookService plan mapping', () => {
  beforeEach(() => vi.clearAllMocks());

  for (const type of ACTIVATING) {
    it(`${type}: activates entitlement and grants paid credits`, async () => {
      await run({ type, entitlement_ids: ['pro'] });
      expect(applyEntitlementUpdate).toHaveBeenCalledWith(
        'uid-test-123',
        expect.objectContaining({ plan: 'pro', entitlementActive: true, setCredits: 200 }),
      );
    });
  }

  it('classifies a premium entitlement as the premium plan with 1000 credits', async () => {
    await run({ type: 'INITIAL_PURCHASE', entitlement_ids: ['premium_yearly'] });
    expect(applyEntitlementUpdate).toHaveBeenCalledWith(
      'uid-test-123',
      expect.objectContaining({ plan: 'premium', setCredits: 1000 }),
    );
  });

  for (const type of DOWNGRADING) {
    it(`${type}: downgrades to the free plan and deactivates`, async () => {
      await run({ type });
      expect(applyEntitlementUpdate).toHaveBeenCalledWith(
        'uid-test-123',
        expect.objectContaining({ plan: 'free', entitlementActive: false }),
      );
    });
  }

  it('CANCELLATION: makes no entitlement change (access continues until expiry)', async () => {
    await run({ type: 'CANCELLATION' });
    expect(applyEntitlementUpdate).not.toHaveBeenCalled();
  });

  it('TRANSFER: makes no entitlement change', async () => {
    await run({ type: 'TRANSFER' });
    expect(applyEntitlementUpdate).not.toHaveBeenCalled();
  });

  it('unknown event type: does not throw and makes no entitlement change', async () => {
    await expect(run({ type: 'SOME_FUTURE_EVENT' })).resolves.toBeUndefined();
    expect(applyEntitlementUpdate).not.toHaveBeenCalled();
  });

  it('every processed event is recorded in the audit log', async () => {
    await run({ type: 'INITIAL_PURCHASE' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ uid: 'uid-test-123', action: 'webhook.revenuecat' }),
    );
  });
});
